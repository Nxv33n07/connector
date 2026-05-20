/**
 * sync.js — VetBuddy → RDS sync engine
 * Pulls invoices, payments, and stock from VetBuddy API and upserts into RDS.
 * Runs on server boot (checkpoint from last known date) and daily at 7 AM IST.
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

// "MM/DD/YYYY HH:MM:SS" → hour integer 0–23; defaults to 9 (morning) if unparseable
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

// YYYY-MM-DD → MM/DD/YYYY (VetBuddy date format)
function toVBDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${m}/${d}/${y}`;
}

// ── Invoices + items UPSERT ───────────────────────────────────────────────────
async function upsertInvoices(invoices) {
  for (const inv of invoices) {
    const invoiceId = inv.InvoiceDetails?.InvoiceId;
    if (!invoiceId) continue;

    const rawDate = inv.InvoiceDetails?.InvoiceDate || "";
    const mysqlDate = toMysqlDt(rawDate);
    if (!mysqlDate) continue;

    const amount = safeNum(inv.InvoiceDetails?.InvoiceAmount);
    const hour = parseHour(rawDate);
    const shift = hour >= 9 && hour < 21 ? "Day" : "Night";
    const cancelled =
      (inv.InvoiceDetails?.Cancelled || "").toUpperCase() === "TRUE" ? 1 : 0;

    // Extended invoice fields — try multiple possible paths in the VetBuddy response
    const invoiceNo =
      inv.InvoiceDetails?.InvoiceNo ||
      inv.InvoiceDetails?.InvoiceNumber ||
      null;
    const clinicId =
      inv.InvoiceDetails?.ClinicId || inv.Clinic?.ClinicID || null;
    const clinicName =
      inv.InvoiceDetails?.ClinicName || inv.Clinic?.ClinicName || null;
    const clientName =
      inv.InvoiceDetails?.ClientName ||
      inv.Client?.ClientName ||
      inv.ClientDetails?.ClientName ||
      null;
    const mobilePhone =
      inv.InvoiceDetails?.MobilePhone ||
      inv.Client?.MobilePhone ||
      inv.Client?.Mobile ||
      inv.ClientDetails?.MobilePhone ||
      null;

    await query(
      `INSERT INTO allpets_invoices
         (invoice_id, invoice_no, clinic_id, clinic_name, client_name, mobile_phone,
          invoice_date, invoice_amount, shift, cancelled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         invoice_no     = VALUES(invoice_no),
         clinic_id      = VALUES(clinic_id),
         clinic_name    = VALUES(clinic_name),
         client_name    = VALUES(client_name),
         mobile_phone   = VALUES(mobile_phone),
         invoice_date   = VALUES(invoice_date),
         invoice_amount = VALUES(invoice_amount),
         shift          = VALUES(shift),
         cancelled      = VALUES(cancelled)`,
      [
        invoiceId,
        invoiceNo,
        clinicId,
        clinicName,
        clientName,
        mobilePhone,
        mysqlDate,
        amount,
        shift,
        cancelled,
      ],
    );

    // Line items — one row per item per patient per invoice
    const patArr = toArray(inv.Patients?.Patient);
    for (const pat of patArr) {
      const patientId = pat.PatientId || "";
      const patientName = pat.PatientName || null;
      const patientSpecies =
        pat.PatientSpecies || pat.Species?.SpeciesName || null;
      const speciesGroup = getSpeciesGroup(patientSpecies);

      const itemArr = toArray(pat.Items?.Item);
      for (const item of itemArr) {
        const salesId = item.SalesID || item.ItemID || "";
        const itemTotal = safeNum(item.Total || item.ItemAmount);
        const planCat = item.PlanItem?.PlanCategory?.PlanCategoryName || null;
        const subCat =
          item.PlanItem?.PlanSubCategory?.PlanSubCategoryName || null;
        const stdCat = getStdCat(planCat || "");

        await query(
          `INSERT INTO allpets_invoice_items
             (invoice_id, invoice_date, sales_id, patient_id, patient_name,
              patient_species, species_group, plan_category_name, std_category,
              plan_sub_category_name, item_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             item_total             = VALUES(item_total),
             patient_name           = VALUES(patient_name),
             patient_species        = VALUES(patient_species),
             species_group          = VALUES(species_group),
             plan_category_name     = VALUES(plan_category_name),
             std_category           = VALUES(std_category),
             plan_sub_category_name = VALUES(plan_sub_category_name)`,
          [
            invoiceId,
            mysqlDate,
            salesId,
            patientId,
            patientName,
            patientSpecies,
            speciesGroup,
            planCat,
            stdCat,
            subCat,
            itemTotal,
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
         (payment_id, payment_date, payment_amount, returned, invoice_id, payment_type_name)
       VALUES (?, ?, ?, ?, ?, ?)
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
        p.PaymentType?.PaymentTypeName || null,
      ],
    );
  }
}

// ── Stock: full atomic refresh inside a transaction ───────────────────────────
// DELETE + re-INSERT so readers always see a complete snapshot, never partial.
async function refreshStock() {
  console.log("[Sync] Refreshing stock snapshot...");
  const stock = await vb.getStock();
  console.log(`[Sync] Fetched ${stock.length} SKUs from VetBuddy.`);

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
        getStdCat(planCat || ""),
        oh,
        th,
        cost,
        getStockStatus(oh, th),
      ]);
    }

    const chunkSize = 1000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
      await conn.execute(
        `INSERT INTO allpets_stock
           (stock_id, clinic_id, clinic_name, stock_name, plan_category_name,
            plan_sub_category_name, std_category, onhand_qty, threshold_qty,
            purchase_cost, stock_status)
         VALUES ${placeholders}`,
        chunk.flat(),
      );
      console.log(
        ` -> Stock batch: ${Math.min(i + chunkSize, rows.length)} / ${rows.length}`,
      );
    }

    await conn.commit();
    console.log(`[Sync] Stock refreshed: ${rows.length} SKUs committed.`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return stock.length;
}

// ── Sync a date range: invoices + payments ────────────────────────────────────
async function syncDateRange(fromDate, toDate) {
  const from = toVBDate(fromDate);
  const to = toVBDate(toDate);
  console.log(`[Sync] ${fromDate} → ${toDate}`);

  const invoices = await vb.getInvoices({
    startdate: from,
    enddate: to,
    max_pages: 20,
  });
  await new Promise((r) => setTimeout(r, 1000)); // brief pause between API calls
  const payments = await vb.getPayments({
    startpaymentdate: from,
    endpaymentdate: to,
    max_pages: 10,
  });

  await upsertInvoices(invoices);
  await upsertPayments(payments);

  await query(
    `INSERT INTO allpets_sync_log (sync_type, sync_date, completed_at, status, records_upserted)
     VALUES ('range', ?, NOW(), 'success', ?)
     ON DUPLICATE KEY UPDATE completed_at=NOW(), status='success', records_upserted=VALUES(records_upserted)`,
    [fromDate, invoices.length + payments.length],
  );

  console.log(
    `[Sync] Done ${fromDate}→${toDate}: ${invoices.length} invoices, ${payments.length} payments.`,
  );
}

// ── Checkpoint sync: last known DB date → today ───────────────────────────────
// Fills exactly the gap since last sync — handles 1 day or 100 days gracefully.
async function runNightlySync() {
  console.log("[Sync] Starting checkpoint sync...");
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = fmt(new Date());

  try {
    const [row] = await query(
      `SELECT DATE_FORMAT(MAX(DATE(invoice_date)), '%Y-%m-%d') AS last_date FROM allpets_invoices`,
    );
    // Fall back to 30 days ago on first run so there's immediately useful data
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

// ── Historical sync: fromDate → today in 7-day chunks ────────────────────────
// Use this once on go-live to backfill all historical data.
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

// ── Schedule daily at 7 AM IST (= 01:30 UTC) ─────────────────────────────────
function scheduleDailySync() {
  function msUntil7amIST() {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(1, 30, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }

  function loop() {
    const ms = msUntil7amIST();
    console.log(
      `[Sync] Next daily sync in ${Math.round(ms / 60000)} min (7 AM IST).`,
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
  scheduleDailySync,
  refreshStock,
};
