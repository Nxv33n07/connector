/**
 * sync.js — VetBuddy → RDS sync engine
 * All analytical tables are populated here. Run on boot and nightly at 2 AM IST.
 */

const vb = require("./vetbuddy.js");
const { pool, query, getStdCat } = require("./db.js");

// ── Utilities ─────────────────────────────────────────────────────────────────
function safeNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// "MM/DD/YYYY HH:MM:SS" → "YYYY-MM-DD HH:MM:SS" for MySQL DATETIME
function toMysqlDt(s) {
  if (!s) return null;
  const parts = s.trim().split(" ");
  const [m, d, y] = parts[0].split("/");
  if (!y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")} ${parts[1] || "00:00:00"}`;
}

// "MM/DD/YYYY HH:MM:SS" → hour integer (0–23)
function parseHour(s) {
  if (!s || !s.includes(" ")) return 9;
  const h = parseInt((s.split(" ")[1] || "00").split(":")[0], 10);
  return isNaN(h) ? 9 : h;
}

function getStockStatus(oh, th) {
  if (oh < 0) return "negative";
  if (oh === 0) return "out";
  if (th > 0 && oh <= th) return "low";
  return "adequate";
}

function getSpeciesGroup(sp) {
  const s = (sp || "").trim();
  if (s === "Canine") return "Canine";
  if (s === "Feline") return "Feline";
  return "Others";
}

// VetBuddy uses MM/DD/YYYY; db.js uses YYYY-MM-DD
function toVBDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${m}/${d}/${y}`;
}

// ── Invoices + items UPSERT ───────────────────────────────────────────────────
async function upsertInvoices(invoices, newClientIdSet) {
  for (const inv of invoices) {
    const invoiceId = inv.InvoiceDetails?.InvoiceId;
    if (!invoiceId) continue;

    const rawDate = inv.InvoiceDetails?.InvoiceDate || "";
    const mysqlDate = toMysqlDt(rawDate);
    if (!mysqlDate) continue;
    const amount = safeNum(inv.InvoiceDetails?.InvoiceAmount);
    const clientId = inv.Client?.ClientID || "";
    const hour = parseHour(rawDate);
    const shift = hour >= 9 && hour < 21 ? "Day" : "Night";
    const cancelled =
      (inv.InvoiceDetails?.Cancelled || "").toUpperCase() === "TRUE" ? 1 : 0;
    const isNew = clientId && newClientIdSet.has(clientId) ? 1 : 0;

    await query(
      `INSERT INTO allpets_invoices
         (invoice_id, invoice_date, invoice_amount, shift, cancelled, is_new_client, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         invoice_date   = VALUES(invoice_date),
         invoice_amount = VALUES(invoice_amount),
         shift          = VALUES(shift),
         cancelled      = VALUES(cancelled),
         is_new_client  = VALUES(is_new_client),
         client_id      = VALUES(client_id)`,
      [invoiceId, mysqlDate, amount, shift, cancelled, isNew, clientId],
    );

    // Line items
    const patArr = toArray(inv.Patients?.Patient);
    for (const pat of patArr) {
      const patientId = pat.PatientId || "";
      const sp = getSpeciesGroup(
        pat.PatientSpecies || pat.Species?.SpeciesName,
      );

      const itemArr = toArray(pat.Items?.Item);
      for (const item of itemArr) {
        const salesId = item.SalesID || item.ItemID || "";
        const itemTotal = safeNum(item.Total || item.ItemAmount);
        const rawCat = item.PlanItem?.PlanCategory?.PlanCategoryName || "";
        const subCat =
          item.PlanItem?.PlanSubCategory?.PlanSubCategoryName || null;
        const stdCat = getStdCat(rawCat);

        await query(
          `INSERT INTO allpets_invoice_items
             (invoice_id, invoice_date, item_total, species_group,
              std_category, plan_sub_category_name, sales_id, patient_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             item_total             = VALUES(item_total),
             species_group          = VALUES(species_group),
             std_category           = VALUES(std_category),
             plan_sub_category_name = VALUES(plan_sub_category_name)`,
          [
            invoiceId,
            mysqlDate,
            itemTotal,
            sp,
            stdCat,
            subCat,
            salesId,
            patientId,
          ],
        );
      }
    }
  }
}

// ── Payments UPSERT ───────────────────────────────────────────────────────────
async function upsertPayments(payments) {
  for (const p of payments) {
    const pid = p.PaymentID;
    if (!pid) continue;
    const returned = (p.Returned || "").toUpperCase() === "TRUE" ? 1 : 0;
    await query(
      `INSERT INTO allpets_payments
         (payment_id, payment_date, payment_amount, returned, invoice_id, client_id, payment_type_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         payment_date      = VALUES(payment_date),
         payment_amount    = VALUES(payment_amount),
         returned          = VALUES(returned),
         payment_type_name = VALUES(payment_type_name)`,
      [
        pid,
        toMysqlDt(p.PaymentDate),
        safeNum(p.PaymentAmount),
        returned,
        p.Invoice?.InvoiceID || null,
        p.Client?.ClientID || null,
        p.PaymentType?.PaymentTypeName || null,
      ],
    );
  }
}

// ── Stock: atomic swap — DELETE + re-INSERT inside a transaction ──────────────
// Using DELETE (DML) instead of TRUNCATE (DDL) so the entire swap is atomic:
// readers see either the complete old snapshot or the complete new one, never partial.
async function refreshStock() {
  console.log("[Sync] Refreshing stock snapshot...");
  // Removed max_pages cap to load all ~9200 SKUs
  const stock = await vb.getStock();
  console.log(
    `[Sync] Fetched ${stock.length} total SKUs from VetBuddy. Preparing batch insert...`,
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM allpets_stock");

    const rows = [];
    for (const s of stock) {
      const name = s.Stock?.StockName || s.StockName || null;
      const stockId = s.Stock?.StockID || s.StockID || null;
      if (!name || !stockId) continue;

      const clinicId = s.Clinic?.ClinicID || null;
      const clinicName = s.Clinic?.ClinicName || null;

      const oh = safeNum(s.OnhandQty);
      const th = safeNum(s.ThresholdQty);
      const cost = safeNum(
        s.PurchaseCost || s.Stock?.PlanItemDetails?.PlanItem?.CostPrice,
      );
      const planCat =
        s.Stock?.PlanItemDetails?.PlanItem?.PlanCategory?.PlanCategoryName ||
        null;
      const subCat =
        s.Stock?.PlanItemDetails?.PlanItem?.PlanSubCategory
          ?.PlanSubCategoryName || null;

      rows.push([
        stockId,
        clinicId,
        clinicName,
        name,
        planCat,
        subCat,
        getStdCat(planCat),
        oh,
        th,
        cost,
        getStockStatus(oh, th),
      ]);
    }

    // Performance optimization: Batch insert 1,000 items at a time to maximize speed
    const chunkSize = 1000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");
      const flatParams = chunk.flat();

      await conn.execute(
        `INSERT INTO allpets_stock
           (stock_id, clinic_id, clinic_name, stock_name, plan_category_name,
            plan_sub_category_name, std_category, onhand_qty, threshold_qty,
            purchase_cost, stock_status)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           stock_name             = VALUES(stock_name),
           clinic_name            = VALUES(clinic_name),
           onhand_qty             = VALUES(onhand_qty),
           threshold_qty          = VALUES(threshold_qty),
           purchase_cost          = VALUES(purchase_cost),
           stock_status           = VALUES(stock_status)`,
        flatParams,
      );
      console.log(
        ` -> Batched: ${Math.min(i + chunkSize, rows.length)} / ${rows.length} inserted.`,
      );
    }

    await conn.commit();
    console.log(
      `[Sync] Stock fully refreshed: ${rows.length} items committed.`,
    );
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return stock.length;
}

// ── Core: sync a date range (invoices + payments + clients) ──────────────────
async function syncDateRange(fromDate, toDate) {
  const from = toVBDate(fromDate);
  const to = toVBDate(toDate);

  console.log(`[Sync] ${fromDate} → ${toDate} ...`);

  const invoices = await vb.getInvoices({
    startdate: from,
    enddate: to,
    max_pages: 20,
  });
  await new Promise((r) => setTimeout(r, 1000));
  const payments = await vb.getPayments({
    startpaymentdate: from,
    endpaymentdate: to,
    max_pages: 10,
  });

  // Pull new clients per date group (deterministic tag)
  const dateSet = new Set(
    invoices
      .map((inv) => (inv.InvoiceDetails?.InvoiceDate || "").split(" ")[0])
      .filter(Boolean),
  );

  const newClientIdSet = new Set();
  for (const datePart of dateSet) {
    try {
      const nc = await vb.getClients({
        startdate: datePart,
        enddate: datePart,
        searchon: "firstactive",
        max_pages: 3,
      });
      for (const c of nc) if (c.ClientID) newClientIdSet.add(c.ClientID);
    } catch (_) {
      // non-fatal — is_new_client will just default to 0
    }
  }

  await upsertInvoices(invoices, newClientIdSet);
  await upsertPayments(payments);

  // Log the sync window
  await query(
    `INSERT INTO allpets_sync_log (sync_type, sync_date, completed_at, status, records_upserted)
     VALUES ('range', ?, NOW(), 'success', ?)`,
    [fromDate, invoices.length + payments.length],
  );

  console.log(
    `[Sync] Done ${fromDate}→${toDate}: ${invoices.length} invoices, ${payments.length} payments.`,
  );
}

// ── Checkpoint-based sync: from last known date in DB → today ────────────────
// Industry-standard ETL pattern: never assume a fixed window.
// The DB tells us where it left off; we fill exactly that gap.
// Handles any absence — 1 day or 100 days — with no duplicates and no gaps.
async function runNightlySync() {
  console.log("[Sync] Starting checkpoint sync...");
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = fmt(new Date());

  try {
    // Ask the DB: what is the latest invoice date we already have?
    const [row] = await query(
      `SELECT DATE_FORMAT(MAX(DATE(invoice_date)), '%Y-%m-%d') AS last_date
       FROM allpets_invoices`,
    );
    // If DB is empty fall back to 30 days ago so first-run gets useful data
    const fromDate =
      row?.last_date || fmt(new Date(Date.now() - 30 * 86400000));

    console.log(`[Sync] Checkpoint: ${fromDate} → ${today}`);
    await syncDateRange(fromDate, today);
    await refreshStock();
    console.log("[Sync] Checkpoint sync complete.");
  } catch (e) {
    console.error("[Sync] Checkpoint sync failed:", e);
  }
}

// ── Historical sync: fromDate → today in 7-day chunks ─────────────────────────
async function runHistoricalSync(fromDateStr) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = fmt(new Date());
  console.log(`[Sync] Historical sync: ${fromDateStr} → ${today}`);

  const cur = new Date(fromDateStr);
  const end = new Date(today);

  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + 6);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    try {
      await syncDateRange(fmt(cur), fmt(chunkEnd));
    } catch (e) {
      console.error(`[Sync] Chunk ${fmt(cur)} failed: ${e.message}`);
    }

    cur.setDate(cur.getDate() + 7);
    await new Promise((r) => setTimeout(r, 3000));
  }

  await refreshStock();
  console.log("[Sync] Historical sync complete.");
}

// ── Schedule nightly at 2 AM IST (UTC+5:30) ──────────────────────────────────
function scheduleNightlySync() {
  function msUntil2amIST() {
    const nowUTC = Date.now();
    const nowIST = nowUTC + 5.5 * 3600 * 1000;
    const istDate = new Date(nowIST);
    const next2am = new Date(istDate);
    next2am.setUTCHours(next2am.getUTCHours() - Math.floor(5.5)); // back to UTC reference
    // Simpler: compute next 2AM IST as UTC 20:30 (prev day) + 24h = next day 20:30 UTC
    // 2:00 IST = 20:30 UTC (previous calendar day)
    const nowD = new Date();
    const h = nowD.getUTCHours(),
      m = nowD.getUTCMinutes();
    // 2AM IST = UTC 20:30
    let msToNext;
    if (h < 20 || (h === 20 && m < 30)) {
      // today's 20:30 UTC hasn't passed yet
      const target = new Date(nowD);
      target.setUTCHours(20, 30, 0, 0);
      msToNext = target - nowD;
    } else {
      // next day's 20:30 UTC
      const target = new Date(nowD);
      target.setUTCDate(target.getUTCDate() + 1);
      target.setUTCHours(20, 30, 0, 0);
      msToNext = target - nowD;
    }
    return msToNext;
  }

  function loop() {
    const ms = msUntil2amIST();
    console.log(
      `[Sync] Next nightly sync in ${Math.round(ms / 60000)} min (2 AM IST).`,
    );
    setTimeout(async () => {
      await runNightlySync();
      loop();
    }, ms);
  }

  loop();
}

module.exports = {
  syncDateRange,
  runNightlySync,
  runHistoricalSync,
  scheduleNightlySync,
  refreshStock,
};
