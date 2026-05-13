/**
 * server.js — AllPets VetBuddy Remote MCP Server
 * ─────────────────────────────────────────────────
 * Runs as a classic SSE HTTP server (SSEServerTransport).
 * Deploy to Render → client pastes the URL into Claude Desktop.
 *
 * Claude Desktop config:
 * {
 *   "mcpServers": {
 *     "allpets": {
 *       "type": "http",
 *       "url": "https://your-render-url.onrender.com/mcp"
 *     }
 *   }
 * }
 */

require("dotenv").config();

const path = require("path");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  SSEServerTransport,
} = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");
const vb = require("./vetbuddy.js");
const db = require("./db.js");
const sync = require("./sync.js");

const activeTransports = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-session-id",
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const safeNum = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const today = () =>
  new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
};
const isoToVB = (iso) => {
  // "YYYY-MM-DD" → "MM/DD/YYYY"
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};
const vbToIso = (vb) => {
  // "MM/DD/YYYY" → "YYYY-MM-DD"
  const [m, d, y] = vb.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};
const isoAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const ok = (d) => ({
  content: [{ type: "text", text: JSON.stringify(d, null, 2) }],
});
const okText = (t) => ({ content: [{ type: "text", text: t }] });
const err = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message || e}` }],
  isError: true,
});

// ── Dashboard formatter (DB-backed) ──────────────────────────────────────────
function buildDashboardText(data, opp) {
  const W = 22;
  const SEP = "━".repeat(58);

  function bar(val, max) {
    if (!max) return "░".repeat(W);
    const n = Math.min(W, Math.round((Math.max(0, val) / max) * W));
    return "█".repeat(n) + "░".repeat(W - n);
  }
  function c(v) {
    return "₹" + Math.round(safeNum(v)).toLocaleString("en-IN");
  }
  function p(a, b) {
    return !b ? "0.0%" : ((a / b) * 100).toFixed(1) + "%";
  }
  function arr(diff) {
    return diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
  }
  function chg(a, b) {
    if (!b) return "—";
    const d = (((a - b) / b) * 100).toFixed(1);
    return (d > 0 ? "+" : "") + d + "%";
  }

  const {
    fromDate,
    toDate,
    totalRevenue,
    invoiceCount,
    totalCollected,
    dayRevenue,
    nightRevenue,
    dayInvoices,
    nightInvoices,
    species,
    catTotals,
    subCategories,
    newClients,
    returningClients,
    stock,
  } = data;

  const { thisWeek, lastWeek, thisMonth, lastMonth } = opp;

  const lines = [];

  // Header
  lines.push("# 🏥 AllPets Clinic — Analytics Dashboard");
  lines.push(
    `📅 **${isoToVB(fromDate)} → ${isoToVB(toDate)}** | **${invoiceCount} invoices**`,
  );
  lines.push("");

  // Revenue
  lines.push(SEP);
  lines.push("## 💰 REVENUE SUMMARY");
  lines.push(SEP);
  lines.push(
    `  Billed      ${bar(totalRevenue, totalRevenue)}  **${c(totalRevenue)}**`,
  );
  lines.push(
    `  Collected   ${bar(totalCollected, totalRevenue)}  **${c(totalCollected)}**  *(${p(totalCollected, totalRevenue)} collection rate)*`,
  );
  lines.push(
    `  Outstanding ${bar(totalRevenue - totalCollected, totalRevenue)}  **${c(totalRevenue - totalCollected)}**`,
  );
  lines.push(
    `  Avg Invoice : **${c(invoiceCount ? totalRevenue / invoiceCount : 0)}**  across ${invoiceCount} invoices`,
  );
  lines.push("");

  // Day / Night
  lines.push(SEP);
  lines.push("## 🌅 DAY vs NIGHT BILLING SPLIT  *(9 AM – 9 PM = Day)*");
  lines.push(SEP);
  const maxShift = Math.max(dayInvoices, nightInvoices, 1);
  lines.push(
    `  Day   ${bar(dayInvoices, maxShift)}  **${c(dayRevenue)}**  ${dayInvoices} inv  ${p(dayInvoices, invoiceCount)}`,
  );
  lines.push(
    `  Night ${bar(nightInvoices, maxShift)}  **${c(nightRevenue)}**  ${nightInvoices} inv  ${p(nightInvoices, invoiceCount)}`,
  );
  lines.push("");

  // Species
  lines.push(SEP);
  lines.push("## 🐾 SPECIES BREAKDOWN");
  lines.push(SEP);
  const totalVisits = Object.values(species).reduce((s, v) => s + v.visits, 0);
  const maxSpRev = Math.max(...Object.values(species).map((v) => v.revenue), 1);
  for (const [sp, v] of Object.entries(species)) {
    lines.push(
      `  ${sp.padEnd(7)} ${bar(v.revenue, maxSpRev)}  **${c(v.revenue)}**  ${v.visits} visits  ${p(v.visits, totalVisits)}  [Day: ${v.dayItems} | Night: ${v.nightItems}]`,
    );
  }
  lines.push("");

  // Category
  lines.push(SEP);
  lines.push("## 📊 STANDARD CATEGORY SPLIT");
  lines.push(SEP);
  const maxCat = Math.max(...Object.values(catTotals), 1);
  for (const [cat, amt] of Object.entries(catTotals).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(
      `  ${cat.padEnd(15)} ${bar(amt, maxCat)}  **${c(amt)}**  ${p(amt, totalRevenue)}`,
    );
  }
  lines.push("");

  // Sub-category
  lines.push(SEP);
  lines.push("## 🔬 SUB-CATEGORY BREAKDOWN  *(Top 12 by revenue)*");
  lines.push(SEP);
  if (subCategories.length > 0) {
    const maxSC = subCategories[0].revenue || 1;
    for (const { name, revenue } of subCategories)
      lines.push(
        `  ${name.padEnd(22)} ${bar(revenue, maxSC)}  **${c(revenue)}**  ${p(revenue, totalRevenue)}`,
      );
  } else {
    lines.push("  *(sub-category data will appear after the first sync)*");
  }
  lines.push("");

  // Customers
  lines.push(SEP);
  lines.push("## 👥 CUSTOMER COHORTS");
  lines.push(SEP);
  const maxCust = Math.max(newClients, returningClients, 1);
  lines.push(
    `  New (first visit)  ${bar(newClients, maxCust)}  **${newClients}**  ${p(newClients, newClients + returningClients)}`,
  );
  lines.push(
    `  Returning clients  ${bar(returningClients, maxCust)}  **${returningClients}**  ${p(returningClients, newClients + returningClients)}`,
  );
  lines.push("");

  // Opportunity
  lines.push(SEP);
  lines.push("## 🎯 OPPORTUNITY AREAS");
  lines.push(SEP);

  lines.push("### 📆 Week over Week  *(last 7 days vs prior 7 days)*");
  lines.push(
    `  Revenue         ${arr(thisWeek.rev - lastWeek.rev)}  ${c(lastWeek.rev)} → **${c(thisWeek.rev)}**  (${chg(thisWeek.rev, lastWeek.rev)})`,
  );
  lines.push(
    `  Invoices        ${arr(thisWeek.inv - lastWeek.inv)}  ${lastWeek.inv} → **${thisWeek.inv}**  (${chg(thisWeek.inv, lastWeek.inv)})`,
  );
  lines.push(
    `  New Clients     ${arr(thisWeek.newC - lastWeek.newC)}  ${lastWeek.newC} → **${thisWeek.newC}**  (${chg(thisWeek.newC, lastWeek.newC)})`,
  );
  lines.push(
    `  Collection Rate ${arr(thisWeek.col / (thisWeek.rev || 1) - lastWeek.col / (lastWeek.rev || 1))}  ${p(lastWeek.col, lastWeek.rev)} → **${p(thisWeek.col, thisWeek.rev)}**`,
  );

  const catOpp = Object.keys(catTotals)
    .map((cat) => ({
      cat,
      tw: thisWeek.cats[cat] || 0,
      lw: lastWeek.cats[cat] || 0,
    }))
    .filter((x) => x.lw > 0)
    .sort((a, b) => (a.tw - a.lw) / a.lw - (b.tw - b.lw) / b.lw);
  if (catOpp.length > 0) {
    const worst = catOpp[0];
    const best = catOpp[catOpp.length - 1];
    lines.push(
      `  ⚠️  Weakest: **${worst.cat}** ${c(worst.lw)} → ${c(worst.tw)}  (${chg(worst.tw, worst.lw)}) ← consider promotion`,
    );
    if (best.tw > best.lw)
      lines.push(
        `  🚀 Strongest: **${best.cat}** ${c(best.lw)} → ${c(best.tw)}  (${chg(best.tw, best.lw)})`,
      );
  }
  lines.push("");

  lines.push("### 📅 Month over Month  *(last 30 days vs prior 30 days)*");
  lines.push(
    `  Revenue     ${arr(thisMonth.rev - lastMonth.rev)}  ${c(lastMonth.rev)} → **${c(thisMonth.rev)}**  (${chg(thisMonth.rev, lastMonth.rev)})`,
  );
  lines.push(
    `  Invoices    ${arr(thisMonth.inv - lastMonth.inv)}  ${lastMonth.inv} → **${thisMonth.inv}**  (${chg(thisMonth.inv, lastMonth.inv)})`,
  );
  lines.push(
    `  New Clients ${arr(thisMonth.newC - lastMonth.newC)}  ${lastMonth.newC} → **${thisMonth.newC}**  (${chg(thisMonth.newC, lastMonth.newC)})`,
  );
  lines.push("");

  lines.push("### 🐾 Species Trend  *(this month vs last month)*");
  const maxSpTrend = Math.max(
    ...["Canine", "Feline", "Others"].map((sp) =>
      Math.max(thisMonth.spRevs[sp] || 0, lastMonth.spRevs[sp] || 0),
    ),
    1,
  );
  for (const sp of ["Canine", "Feline", "Others"]) {
    const tm = thisMonth.spRevs[sp] || 0,
      lm = lastMonth.spRevs[sp] || 0;
    lines.push(
      `  ${sp.padEnd(7)} ${bar(tm, maxSpTrend)}  **${c(tm)}**  ${arr(tm - lm)}  (${chg(tm, lm)} vs prev month)`,
    );
  }
  lines.push("");

  // Inventory
  if (stock) {
    lines.push(SEP);
    lines.push("## 📦 INVENTORY DASHBOARD");
    lines.push(SEP);
    lines.push(`  Total SKUs Tracked  : **${stock.totalItems}**`);
    lines.push(
      `  Closing Valuation   : **${c(stock.valuation)}**  *(system estimate)*`,
    );
    lines.push("");

    const tot = stock.totalItems || 1;
    lines.push(
      `  ✅ Adequate  ${bar(stock.adequateCount, tot)}  **${stock.adequateCount}** SKUs  ${p(stock.adequateCount, tot)}`,
    );
    lines.push(
      `  🟡 Low Stock ${bar(stock.lowCount, tot)}  **${stock.lowCount}** SKUs  ${p(stock.lowCount, tot)}`,
    );
    lines.push(
      `  🔴 Out Stock ${bar(stock.outCount, tot)}  **${stock.outCount}** SKUs  ${p(stock.outCount, tot)}`,
    );
    lines.push(
      `  ⚠️  Negative  ${bar(stock.negativeCount, tot)}  **${stock.negativeCount}** SKUs  ${p(stock.negativeCount, tot)}`,
    );
    lines.push("");

    if (stock.negativeItems?.length > 0) {
      lines.push(
        "### ⚠️ SYSTEM vs PHYSICAL MISMATCH  *(needs physical audit)*",
      );
      for (const item of stock.negativeItems)
        lines.push(
          `  • **${item.name}**  System qty: **${item.onhand_qty}**  [${item.cat}]  ← sold without stock entry`,
        );
      lines.push("");
    }

    if (stock.outItems?.length > 0) {
      lines.push("### 🔴 OUT OF STOCK  *(reorder immediately)*");
      for (const item of stock.outItems)
        lines.push(`  • ${item.name}  [${item.cat}]`);
      lines.push("");
    }

    if (stock.lowItems?.length > 0) {
      lines.push("### 🟡 LOW STOCK  *(below threshold)*");
      for (const item of stock.lowItems)
        lines.push(
          `  • ${item.name}  Onhand: **${item.onhand_qty}**  Threshold: ${item.threshold_qty}  [${item.cat}]`,
        );
      lines.push("");
    }

    if (stock.foodItems?.length > 0) {
      lines.push("### 🍖 FOOD CATEGORY ITEMS");
      const maxFoodVal = Math.max(...stock.foodItems.map((f) => f.value), 1);
      for (const f of stock.foodItems)
        lines.push(
          `  ${(f.name || "").padEnd(24)} ${bar(f.value, maxFoodVal)}  Qty: **${f.onhand_qty}**  Val: ${c(f.value)}`,
        );
      lines.push("");
    }

    if (stock.subCatStock?.length > 0) {
      lines.push("### 📊 SUB-CATEGORY STOCK VALUATION");
      const maxSCV = stock.subCatStock[0]?.value || 1;
      for (const row of stock.subCatStock)
        lines.push(
          `  ${(row.sub_cat || "").padEnd(24)} ${bar(row.value, maxSCV)}  **${c(row.value)}**  ${row.skus} SKUs  Qty: ${row.total_onhand}`,
        );
    }
  }

  // Payment methods
  if (data.paymentsBreakdown?.length > 0) {
    lines.push(SEP);
    lines.push("## 💳 PAYMENT METHODS");
    lines.push(SEP);
    const maxPmt = Math.max(...data.paymentsBreakdown.map((r) => r.value), 1);
    for (const r of data.paymentsBreakdown)
      lines.push(
        `  ${r.method.padEnd(18)} ${bar(r.value, maxPmt)}  **${c(r.value)}**  ${r.txns} txns`,
      );
    if (data.returnedPayments?.txns > 0)
      lines.push(
        `\n  ⚠️  Returned: **${data.returnedPayments.txns}** txns  ${c(data.returnedPayments.value)}`,
      );
    lines.push("");
  }

  // Pharmacy vs Service split
  if (data.revenueSplit) {
    lines.push(SEP);
    lines.push("## 💊 PHARMACY vs SERVICE SPLIT");
    lines.push(SEP);
    const totalSplit =
      (data.revenueSplit.Pharmacy || 0) + (data.revenueSplit.Service || 0);
    const maxSplit = Math.max(
      data.revenueSplit.Pharmacy || 0,
      data.revenueSplit.Service || 0,
      1,
    );
    lines.push(
      `  Pharmacy ${bar(data.revenueSplit.Pharmacy || 0, maxSplit)}  **${c(data.revenueSplit.Pharmacy)}**  ${p(data.revenueSplit.Pharmacy, totalSplit)}  (${data.invoiceSplit?.pharmacy || 0} invoices)`,
    );
    lines.push(
      `  Service  ${bar(data.revenueSplit.Service || 0, maxSplit)}  **${c(data.revenueSplit.Service)}**  ${p(data.revenueSplit.Service, totalSplit)}  (${data.invoiceSplit?.service || 0} invoices)`,
    );
    lines.push("");
  }

  lines.push("");
  lines.push("---");
  lines.push(
    `*AllPets VetBuddy RDS Analytics  |  Generated: ${new Date().toISOString()}*`,
  );

  return lines.join("\n");
}

// ── Dashboard query wrapper with self-hydrator ───────────────────────────────
async function getDashboard(fromIso, toIso) {
  // Self-hydrator: if no invoices exist for this range, kick off a background
  // sync and tell the user to retry rather than returning a blank dashboard.
  const countRows = await db.query(
    `SELECT COUNT(*) AS cnt FROM allpets_invoices
     WHERE DATE(invoice_date) BETWEEN ? AND ?`,
    [fromIso, toIso],
  );
  if (+countRows[0].cnt === 0) {
    sync
      .syncDateRange(fromIso, toIso)
      .catch((e) =>
        console.error("[Hydrator] Background sync failed:", e.message),
      );
    throw new Error(
      `No data in DB for ${fromIso} → ${toIso}. Background sync started — please retry in ~30 seconds.`,
    );
  }

  const [data, opp] = await Promise.all([
    db.queryDashboard(fromIso, toIso),
    db.queryOpportunity(),
  ]);
  return buildDashboardText(data, opp);
}

// ── Build MCP server ──────────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: "allpets-vetbuddy", version: "2.0.0" });

  // ── DAILY BRIEFING ──────────────────────────────────────────────────────────
  server.tool(
    "daily_briefing",
    'Full morning briefing: today\'s appointments, overdue reminders, stock alerts, yesterday\'s revenue. Use for "good morning", "what\'s today\'s status", "give me a briefing".',
    { clinic_id: z.string().optional() },
    async ({ clinic_id }) => {
      try {
        const cid = clinic_id;
        const [appts, reminders, stockRows] = await Promise.all([
          vb.getAppointments({
            startdate: today(),
            enddate: today(),
            max_pages: 2,
            ...(cid ? { clinicid: cid } : {}),
          }),
          vb.getReminders({ status: "overdue", max_pages: 2 }),
          db.query(
            `SELECT stock_name AS name, plan_category_name AS cat, onhand_qty, stock_status
             FROM allpets_stock
             WHERE stock_status IN ('negative','out','low')
             ORDER BY FIELD(stock_status,'negative','out','low'), onhand_qty ASC
             LIMIT 10`,
          ),
        ]);

        // Yesterday's revenue from DB
        const yest = isoAgo(1);
        const revRow = await db.query(
          `SELECT COALESCE(SUM(invoice_amount),0) AS rev, COUNT(*) AS inv
           FROM allpets_invoices WHERE DATE(invoice_date) = ? AND cancelled=0`,
          [yest],
        );
        const colRow = await db.query(
          `SELECT COALESCE(SUM(payment_amount),0) AS col
           FROM allpets_payments WHERE DATE(payment_date) = ? AND returned=0`,
          [yest],
        );

        const byStatus = {};
        for (const a of appts) {
          const s = a.AppointmentStatus || "unknown";
          byStatus[s] = (byStatus[s] || 0) + 1;
        }

        const negCount = stockRows.filter(
          (r) => r.stock_status === "negative",
        ).length;
        const outCount = stockRows.filter(
          (r) => r.stock_status === "out",
        ).length;
        const lowCount = stockRows.filter(
          (r) => r.stock_status === "low",
        ).length;

        return ok({
          date: today(),
          today_appointments: {
            total: appts.length,
            by_status: byStatus,
            next_pending: appts
              .filter((a) => a.AppointmentStatus === "pending")
              .slice(0, 5)
              .map((a) => ({
                time: a.AppointmentStartTime,
                patient: a.Patient?.PatientName,
                type: a.AppointmentType?.AppointmentTypeName,
                doctor: a.AppointmentResources?.Providers?.Staff?.StaffName,
              })),
          },
          overdue_reminders: {
            total: reminders.length,
            sample: reminders.slice(0, 5).map((r) => ({
              patient: r.Patient?.PatientName,
              reminder: r.ReminderName,
              due: r.DateToRemind,
              mobile: r.Client?.ClientUniqueID,
            })),
          },
          inventory_alerts: {
            negative_stock_mismatch: negCount,
            out_of_stock: outCount,
            low_stock: lowCount,
            critical_items: stockRows
              .filter((r) => r.stock_status !== "low")
              .slice(0, 8)
              .map((r) => ({
                name: r.name,
                qty: r.onhand_qty,
                status: r.stock_status,
              })),
          },
          yesterday: {
            date: yest,
            invoices: +revRow[0].inv,
            revenue: (+revRow[0].rev).toFixed(2),
            collected: (+colRow[0].col).toFixed(2),
            outstanding: (+revRow[0].rev - +colRow[0].col).toFixed(2),
          },
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── REVENUE DASHBOARD ────────────────────────────────────────────────────────
  server.tool(
    "get_revenue",
    "Revenue dashboard with Day/Night split, category distribution, collection rates.",
    {
      from_date: z.string().optional().describe("MM/DD/YYYY"),
      to_date: z.string().optional().describe("MM/DD/YYYY"),
    },
    async ({ from_date, to_date }) => {
      try {
        const fromIso = from_date ? vbToIso(from_date) : isoAgo(30);
        const toIso = to_date ? vbToIso(to_date) : isoAgo(0);
        return okText(await getDashboard(fromIso, toIso));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── PAYMENTS ─────────────────────────────────────────────────────────────────
  server.tool(
    "get_payments",
    'Payment collections — total collected, by payment method (GPay, cash, etc). Use for "how much collected today", "payment method breakdown".',
    {
      from_date: z.string().optional(),
      to_date: z.string().optional(),
      clinic_id: z.string().optional(),
      client_id: z.string().optional(),
    },
    async ({ from_date, to_date, clinic_id, client_id }) => {
      try {
        const payments = await vb.getPayments({
          startpaymentdate: from_date || today(),
          endpaymentdate: to_date || today(),
          ...(clinic_id ? { clinicid: clinic_id } : {}),
          ...(client_id ? { clientid: client_id } : {}),
        });
        let total = 0;
        const byMethod = {};
        for (const p of payments) {
          const amt = safeNum(p.PaymentAmount),
            method = p.PaymentType?.PaymentTypeName || "Unknown";
          total += amt;
          byMethod[method] = (byMethod[method] || 0) + amt;
        }
        return ok({
          period: { from: from_date || today(), to: to_date || today() },
          total_collected: total.toFixed(2),
          by_method: Object.fromEntries(
            Object.entries(byMethod).map(([k, v]) => [k, v.toFixed(2)]),
          ),
          count: payments.length,
          payments: payments.map((p) => ({
            id: p.PaymentID,
            amount: p.PaymentAmount,
            method: p.PaymentType?.PaymentTypeName,
            date: p.PaymentDate,
            client: p.Client?.ClientName,
            receipt: p.ReceiptNo,
          })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── APPOINTMENTS ─────────────────────────────────────────────────────────────
  server.tool(
    "get_appointments",
    'List appointments — today\'s schedule, by status, by doctor. Use for "show today\'s appointments", "pending appointments", "list surgeries this week".',
    {
      from_date: z.string().optional(),
      to_date: z.string().optional(),
      status: z
        .enum(["pending", "waiting", "attending", "completed", "cancel"])
        .optional(),
      clinic_id: z.string().optional(),
      staff_id: z.string().optional(),
      patient_id: z.string().optional(),
      client_id: z.string().optional(),
    },
    async ({
      from_date,
      to_date,
      status,
      clinic_id,
      staff_id,
      patient_id,
      client_id,
    }) => {
      try {
        const appts = await vb.getAppointments({
          startdate: from_date || today(),
          enddate: to_date || today(),
          ...(status ? { status } : {}),
          ...(clinic_id ? { clinicid: clinic_id } : {}),
          ...(staff_id ? { staffid: staff_id } : {}),
          ...(patient_id ? { patientid: patient_id } : {}),
          ...(client_id ? { clientid: client_id } : {}),
        });
        const byStatus = {},
          byType = {},
          byDoctor = {};
        for (const a of appts) {
          const s = a.AppointmentStatus || "unknown",
            t = a.AppointmentType?.AppointmentTypeName || "Unknown",
            d =
              a.AppointmentResources?.Providers?.Staff?.StaffName ||
              "Unassigned";
          byStatus[s] = (byStatus[s] || 0) + 1;
          byType[t] = (byType[t] || 0) + 1;
          byDoctor[d] = (byDoctor[d] || 0) + 1;
        }
        return ok({
          total: appts.length,
          by_status: byStatus,
          by_type: byType,
          by_doctor: byDoctor,
          appointments: appts.map((a) => ({
            id: a.AppointmentID,
            status: a.AppointmentStatus,
            start: a.AppointmentStartTime,
            end: a.AppointmentEndTime,
            patient: a.Patient?.PatientName,
            patient_id: a.Patient?.PatientID,
            client: a.Client?.ClientName,
            client_id: a.Client?.ClientID,
            type: a.AppointmentType?.AppointmentTypeName,
            doctor:
              a.AppointmentResources?.Providers?.Staff?.StaffName ||
              "Unassigned",
            clinic: a.Clinic?.ClinicName,
          })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── PATIENTS ─────────────────────────────────────────────────────────────────
  server.tool(
    "get_patients",
    "Search patients (pets). Supports safety capping and local name matching to avoid timeouts.",
    {
      name_query: z.string().optional().describe("Search keyword for pet name"),
      patient_id: z.string().optional(),
      client_id: z.string().optional(),
      status: z.enum(["Active", "InActive", "Deceased"]).optional(),
      clinic_id: z.string().optional(),
    },
    async ({ name_query, patient_id, client_id, status, clinic_id }) => {
      try {
        const patients = await vb.getPatients({
          max_pages: 10,
          ...(patient_id ? { patientid: patient_id } : {}),
          ...(client_id ? { clientid: client_id } : {}),
          ...(status ? { status } : {}),
          ...(clinic_id ? { clinicid: clinic_id } : {}),
        });

        let filtered = patients;
        if (name_query) {
          const q = name_query.toLowerCase();
          filtered = patients.filter((p) =>
            (p.PatientName || "").toLowerCase().includes(q),
          );
        }

        const bySpecies = {};
        for (const p of filtered) {
          const sp = p.Species?.SpeciesName || "Unknown";
          bySpecies[sp] = (bySpecies[sp] || 0) + 1;
        }

        return ok({
          total_matching: filtered.length,
          species_breakdown: bySpecies,
          patients_sample: filtered.slice(0, 15).map((p) => ({
            id: p.PatientID,
            name: p.PatientName,
            species: p.Species?.SpeciesName,
            breed: p.Breed?.BreedName,
            dob: p.BirthDate,
            status: p.Status,
            client_id: p.ClientID,
            owner:
              `${p.ClientFirstName || ""} ${p.ClientLastName || ""}`.trim(),
            mobile: p.MobilePhone,
            last_visit: p.LastActivity,
          })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── CLIENTS ──────────────────────────────────────────────────────────────────
  server.tool(
    "get_clients",
    "Search clients (pet owners). Supports safety capping and local name/phone search.",
    {
      name_query: z
        .string()
        .optional()
        .describe("Search keyword for owner name or phone"),
      client_id: z.string().optional(),
      status: z.enum(["Active", "InActive"]).optional(),
      clinic_id: z.string().optional(),
      from_date: z.string().optional(),
      to_date: z.string().optional(),
      search_on: z.enum(["firstactive", "lastactive"]).optional(),
    },
    async ({
      name_query,
      client_id,
      status,
      clinic_id,
      from_date,
      to_date,
      search_on,
    }) => {
      try {
        const clients = await vb.getClients({
          max_pages: 10,
          ...(client_id ? { clientid: client_id } : {}),
          ...(status ? { status } : {}),
          ...(clinic_id ? { clinicid: clinic_id } : {}),
          ...(from_date ? { startdate: from_date } : {}),
          ...(to_date ? { enddate: to_date } : {}),
          ...(search_on ? { searchon: search_on } : {}),
        });

        let filtered = clients;
        if (name_query) {
          const q = name_query.toLowerCase();
          filtered = clients.filter((c) => {
            const name =
              `${c.FirstName || ""} ${c.LastName || ""}`.toLowerCase();
            const ph = `${c.MobilePhone || c.HomePhone || ""}`;
            return name.includes(q) || ph.includes(q);
          });
        }

        return ok({
          total_matching: filtered.length,
          clients_sample: filtered.slice(0, 15).map((c) => ({
            id: c.ClientID,
            name: `${c.FirstName || ""} ${c.LastName || ""}`.trim(),
            mobile: c.MobilePhone || c.HomePhone,
            status: c.Status,
            first_visit: c.FirstActivity,
            last_visit: c.LastActivity,
          })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── STOCK ────────────────────────────────────────────────────────────────────
  server.tool(
    "get_stock",
    "Search inventory items. Includes safety capping and keyword search.",
    {
      name_query: z
        .string()
        .optional()
        .describe("Search keyword for item name"),
      clinic_id: z.string().optional(),
      category: z.string().optional(),
    },
    async ({ name_query, clinic_id, category }) => {
      try {
        const stock = await vb.getStock({
          max_pages: 20,
          ...(clinic_id ? { clinicid: clinic_id } : {}),
          ...(category ? { category } : {}),
        });

        let filtered = stock;
        if (name_query) {
          const q = name_query.toLowerCase();
          filtered = stock.filter((s) =>
            (s.Stock?.StockName || "").toLowerCase().includes(q),
          );
        }

        const outOfStock = [],
          lowStock = [],
          adequate = [];
        for (const s of filtered) {
          const oh = safeNum(s.OnhandQty),
            th = safeNum(s.ThresholdQty);
          const item = {
            name: s.Stock?.StockName,
            onhand: oh,
            threshold: th,
            reorder: safeNum(s.ReorderQty),
            category:
              s.Stock?.PlanItemDetails?.PlanItem?.PlanCategory
                ?.PlanCategoryName,
          };
          if (oh <= 0) outOfStock.push(item);
          else if (oh <= th) lowStock.push(item);
          else adequate.push(item);
        }
        return ok({
          total_matching: filtered.length,
          out_of_stock_count: outOfStock.length,
          low_stock_count: lowStock.length,
          adequate_stock_count: adequate.length,
          out_of_stock_sample: outOfStock.slice(0, 15),
          low_stock_sample: lowStock.slice(0, 15),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── STAFF ────────────────────────────────────────────────────────────────────
  server.tool(
    "get_staff",
    'List staff members. Use for "who are our doctors", "list all staff", "find staff ID for Dr Raje".',
    {
      clinic_id: z.string().optional(),
      staff_id: z.string().optional(),
      status: z.enum(["active", "inactive"]).optional(),
      staff_category: z.string().optional(),
    },
    async ({ clinic_id, staff_id, status, staff_category }) => {
      try {
        const staff = await vb.getStaff({
          ...(clinic_id ? { clinicid: clinic_id } : {}),
          ...(staff_id ? { staffid: staff_id } : {}),
          ...(status ? { status } : {}),
          ...(staff_category ? { staffcategory: staff_category } : {}),
        });
        return ok({
          total: staff.length,
          staff: staff.map((s) => ({
            id: s.StaffID,
            name: `${s.FirstName || ""} ${s.LastName || ""}`.trim(),
            category: s.StaffCategoryName,
            email: s.Email,
            clinic: s.ClinicName,
            status: s.Status,
          })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── REMINDERS ────────────────────────────────────────────────────────────────
  server.tool(
    "get_reminders",
    'Patient reminders — due, overdue, expiring. Use for "overdue reminders", "patients needing follow-up", "vaccination reminders this week".',
    {
      status: z.enum(["due", "overdue", "expires"]).optional(),
      patient_id: z.string().optional(),
      client_id: z.string().optional(),
      from_date: z.string().optional(),
      to_date: z.string().optional(),
    },
    async ({ status, patient_id, client_id, from_date, to_date }) => {
      try {
        const reminders = await vb.getReminders({
          ...(status ? { status } : {}),
          ...(patient_id ? { patientid: patient_id } : {}),
          ...(client_id ? { clientid: client_id } : {}),
          ...(from_date ? { startdate: from_date } : {}),
          ...(to_date ? { enddate: to_date } : {}),
        });
        return ok({
          total: reminders.length,
          reminders: reminders.map((r) => ({
            id: r.ReminderID,
            name: r.ReminderName,
            patient: r.Patient?.PatientName,
            patient_id: r.Patient?.PatientID,
            client: r.Client?.ClientName,
            mobile: r.Client?.ClientUniqueID,
            due: r.DateToRemind,
            expiry: r.DateOfExpiry,
            doctor: r.Staff?.StaffName,
            type: r.ReminderType,
          })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── CLIENT ACCOUNT ───────────────────────────────────────────────────────────
  server.tool(
    "get_client_account",
    'Client account summary — balance, credits, outstanding. Use for "what does client 24 owe", "account balance for Hemant".',
    { client_id: z.string().describe("VetBuddy Client ID") },
    async ({ client_id }) => {
      try {
        return ok(await vb.getClientAccountSummary(client_id));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── MEDICAL RECORDS ──────────────────────────────────────────────────────────
  server.tool(
    "get_medical_records",
    'List visit history for a patient or client. Use for "show visits for Doggy", "visit history client 24".',
    { patient_id: z.string().optional(), client_id: z.string().optional() },
    async ({ patient_id, client_id }) => {
      try {
        const records = await vb.getMedicalRecords({
          ...(patient_id ? { patientid: patient_id } : {}),
          ...(client_id ? { clientid: client_id } : {}),
        });
        return ok({
          total: records.length,
          records: records.map((r) => ({
            visit_id: r.Visit?.VisitID,
            visit_name: r.Visit?.VisitName,
            patient: r.Patient?.PatientName,
            created: r.CreatedOn,
            modified: r.LastModified,
            status: r.CaseStatus,
          })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── STAFF AVAILABILITY ───────────────────────────────────────────────────────
  server.tool(
    "get_staff_availability",
    'Who is available on a given date. Use for "who is working tomorrow", "is Dr Raje available Friday".',
    { date: z.string().describe("MM/DD/YYYY"), clinic_id: z.string() },
    async ({ date, clinic_id }) => {
      try {
        const avail = await vb.getStaffAvailability(date, clinic_id);
        if (!avail) return ok({ message: "No availability data found." });
        const staffList = Array.isArray(avail.Staffs?.Staff)
          ? avail.Staffs.Staff
          : avail.Staffs?.Staff
            ? [avail.Staffs.Staff]
            : [];
        return ok({
          date,
          clinic: avail.Clinic?.ClinicName,
          staff: staffList.map((s) => {
            const slots = (s.Slots || "").split(","),
              okSlots = slots.filter((sl) => sl.endsWith("OK")).length;
            return {
              id: s.StaffID,
              name: s.StaffName,
              category: s.StaffCategory?.StaffCategoryName,
              rota: s.RotaAssigned?.RotaName,
              hours: s.RotaAssigned?.Time,
              available_slots: okSlots,
              status: okSlots > 0 ? "Available" : "Not Available",
            };
          }),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── CLINIC INFO ──────────────────────────────────────────────────────────────
  server.tool(
    "get_clinic_info",
    "Get clinic details — name, address, contact.",
    {},
    async () => {
      try {
        return ok({ clinics: await vb.getClinics() });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── BUSINESS INSIGHTS (delegates to full dashboard) ──────────────────────────
  server.tool(
    "business_insights",
    "Full business dashboard — revenue, day/night split, species, categories, customers, inventory.",
    {
      from_date: z.string().optional().describe("MM/DD/YYYY"),
      to_date: z.string().optional().describe("MM/DD/YYYY"),
    },
    async ({ from_date, to_date }) => {
      try {
        const fromIso = from_date ? vbToIso(from_date) : isoAgo(30);
        const toIso = to_date ? vbToIso(to_date) : isoAgo(0);
        return okText(await getDashboard(fromIso, toIso));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── CREATE CLIENT ────────────────────────────────────────────────────────────
  server.tool(
    "create_client",
    "Register a new client (pet owner) in VetBuddy.",
    {
      clinic_name: z.string(),
      first_name: z.string(),
      last_name: z.string(),
      mobile: z.string(),
      email: z.string().optional(),
      address1: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await vb.createClient({
          ClinicName: args.clinic_name,
          FirstName: args.first_name,
          LastName: args.last_name,
          MobilePhone: args.mobile,
          Email: args.email || "",
          Address1: args.address1 || "",
          City: args.city || "",
          State: args.state || "",
          Zip: args.zip || "",
          Status: "Active",
        });
        return result.success
          ? ok({ message: "Client created.", vetbuddy_client_id: result.id })
          : err({ message: result.raw });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── UPDATE CLIENT ────────────────────────────────────────────────────────────
  server.tool(
    "update_client",
    "Update an existing client's details.",
    {
      client_id: z.string(),
      clinic_name: z.string(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      mobile: z.string().optional(),
      email: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      status: z.enum(["Active", "InActive"]).optional(),
    },
    async (args) => {
      try {
        const result = await vb.updateClient({
          ClientID: args.client_id,
          ClinicName: args.clinic_name,
          FirstName: args.first_name || "",
          LastName: args.last_name || "",
          MobilePhone: args.mobile || "",
          Email: args.email || "",
          City: args.city || "",
          State: args.state || "",
          Zip: args.zip || "",
          Status: args.status || "Active",
        });
        return result.success
          ? ok({ message: "Client updated.", id: result.id })
          : err({ message: result.raw });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── CREATE PATIENT ───────────────────────────────────────────────────────────
  server.tool(
    "create_patient",
    "Register a new patient (pet) under an existing client.",
    {
      clinic_name: z.string(),
      client_id: z.string(),
      patient_name: z.string(),
      species: z.string(),
      breed: z.string().optional(),
      gender: z.string().optional(),
      neutered: z.enum(["TRUE", "FALSE"]).optional(),
      dob: z.string().optional().describe("MM/DD/YYYY"),
      comment: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await vb.createPatient({
          ClinicName: args.clinic_name,
          ClientID: args.client_id,
          PatientName: args.patient_name,
          SpeciesName: args.species,
          BreedName: args.breed || "",
          GenderName: args.gender || "",
          Neutered: args.neutered || "FALSE",
          BirthDate: args.dob || "",
          Comment: args.comment || "",
        });
        return result.success
          ? ok({
              message: "Patient registered.",
              vetbuddy_patient_id: result.id,
            })
          : err({ message: result.raw });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── UPDATE PATIENT ───────────────────────────────────────────────────────────
  server.tool(
    "update_patient",
    "Update an existing patient's details.",
    {
      patient_id: z.string(),
      clinic_name: z.string(),
      client_id: z.string(),
      patient_name: z.string().optional(),
      species: z.string().optional(),
      breed: z.string().optional(),
      gender: z.string().optional(),
      neutered: z.enum(["TRUE", "FALSE"]).optional(),
      dob: z.string().optional(),
      status: z.enum(["Active", "InActive", "Deceased"]).optional(),
    },
    async (args) => {
      try {
        const result = await vb.updatePatient({
          PatientID: args.patient_id,
          ClientID: args.client_id,
          ClinicName: args.clinic_name,
          PatientName: args.patient_name || "",
          SpeciesName: args.species || "",
          BreedName: args.breed || "",
          GenderName: args.gender || "",
          Neutered: args.neutered || "FALSE",
          BirthDate: args.dob || "",
          Status: args.status || "Active",
        });
        return result.success
          ? ok({ message: "Patient updated.", id: result.id })
          : err({ message: result.raw });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── BOOK APPOINTMENT ─────────────────────────────────────────────────────────
  server.tool(
    "book_appointment",
    'Book a new appointment. Use for "schedule appointment", "book a consultation for Bella".',
    {
      client_id: z.string(),
      patient_id: z.string(),
      clinic_name: z.string(),
      type: z
        .string()
        .describe('e.g. "OPD Consultation", "Surgery", "Grooming"'),
      reason: z.string().optional(),
      start_time: z.string().describe("MM/DD/YYYY HH:MM:SS"),
      end_time: z.string().describe("MM/DD/YYYY HH:MM:SS"),
      staff_id: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await vb.createAppointment({
          ClientID: args.client_id,
          PatientID: args.patient_id,
          ClinicName: args.clinic_name,
          AppointmentTypeName: args.type,
          ReasonForVisitName: args.reason || "",
          AppointmentStartTime: args.start_time,
          AppointmentEndTime: args.end_time,
          AppointmentStatus: "Pending",
          StaffID: args.staff_id || "",
        });
        return result.success
          ? ok({
              message: "Appointment booked.",
              vetbuddy_appointment_id: result.id,
            })
          : err({ message: result.raw });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── CANCEL APPOINTMENT ───────────────────────────────────────────────────────
  server.tool(
    "cancel_appointment",
    "Cancel an existing appointment.",
    {
      appointment_id: z.string(),
      client_id: z.string(),
      patient_id: z.string(),
      clinic_name: z.string(),
      start_time: z.string(),
      end_time: z.string(),
      staff_id: z.string().optional(),
      cancelled_by: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await vb.cancelAppointment({
          AppointmentID: args.appointment_id,
          ClientID: args.client_id,
          PatientID: args.patient_id,
          ClinicName: args.clinic_name,
          AppointmentStartTime: args.start_time,
          AppointmentEndTime: args.end_time,
          StaffID: args.staff_id || "",
          CancelledBy: args.cancelled_by || "reception",
        });
        return result.success
          ? ok({ message: "Appointment cancelled." })
          : err({ message: result.raw });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── FULL ANALYTICS DASHBOARD ─────────────────────────────────────────────────
  server.tool(
    "get_dashboard",
    "PRIMARY analytics tool. ALWAYS call this for any question about revenue, invoices, species, day/night split, categories, sub-categories, opportunity areas, customer cohorts, inventory, stock mismatch, or business performance. Returns a fully formatted dashboard with bar charts.",
    {
      from_date: z
        .string()
        .optional()
        .describe("MM/DD/YYYY — defaults to 30 days ago"),
      to_date: z.string().optional().describe("MM/DD/YYYY — defaults to today"),
    },
    async ({ from_date, to_date }) => {
      try {
        const fromIso = from_date ? vbToIso(from_date) : isoAgo(30);
        const toIso = to_date ? vbToIso(to_date) : isoAgo(0);
        return okText(await getDashboard(fromIso, toIso));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── SYNC MANAGEMENT ──────────────────────────────────────────────────────────
  server.tool(
    "force_sync",
    "Trigger an immediate nightly sync (last 3 days + stock refresh). Use after data issues or to get the freshest numbers.",
    {},
    async () => {
      sync.runNightlySync().catch(console.error);
      return ok({
        message: "Sync started in background. Results ready in ~60s.",
      });
    },
  );

  // ── DAILY REVENUE TREND ──────────────────────────────────────────────────────
  server.tool(
    "get_daily_trend",
    'Day-by-day revenue breakdown for a date range. Use for "show me last week day by day", "daily revenue trend", "which day was best this month".',
    {
      from_date: z
        .string()
        .optional()
        .describe("MM/DD/YYYY — defaults to 14 days ago"),
      to_date: z.string().optional().describe("MM/DD/YYYY — defaults to today"),
    },
    async ({ from_date, to_date }) => {
      try {
        const fromIso = from_date ? vbToIso(from_date) : isoAgo(13);
        const toIso = to_date ? vbToIso(to_date) : isoAgo(0);
        const rows = await db.queryDailyTrend(fromIso, toIso);
        if (!rows.length)
          return okText("No data for this period. Try force_sync first.");

        const W = 22;
        const SEP = "━".repeat(58);
        const maxRev = Math.max(...rows.map((r) => +r.revenue), 1);
        const totalRev = rows.reduce((s, r) => s + +r.revenue, 0);

        const lines = [];
        lines.push("# 📈 Daily Revenue Trend");
        lines.push(
          `📅 **${from_date || isoToVB(fromIso)} → ${to_date || isoToVB(toIso)}**`,
        );
        lines.push("");
        lines.push(SEP);
        for (const r of rows) {
          const rev = +r.revenue;
          const bar =
            "█".repeat(Math.round((rev / maxRev) * W)) +
            "░".repeat(W - Math.round((rev / maxRev) * W));
          const dayLabel = new Date(r.day).toLocaleDateString("en-IN", {
            weekday: "short",
            day: "2-digit",
            month: "short",
          });
          lines.push(
            `  ${dayLabel.padEnd(12)} ${bar}  ₹${Math.round(rev).toLocaleString("en-IN")}  (${r.invoices} inv, ${r.new_clients} new)`,
          );
        }
        lines.push(SEP);
        lines.push(
          `  **Total: ₹${Math.round(totalRev).toLocaleString("en-IN")}  across ${rows.length} days**`,
        );
        return okText(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── TOP CLIENTS BY SPEND ─────────────────────────────────────────────────────
  server.tool(
    "get_top_clients",
    'Top clients ranked by total spend. Use for "who are our best clients", "top 10 spenders this month", "VIP clients".',
    {
      from_date: z
        .string()
        .optional()
        .describe("MM/DD/YYYY — defaults to 30 days ago"),
      to_date: z.string().optional().describe("MM/DD/YYYY — defaults to today"),
      limit: z
        .number()
        .min(5)
        .max(50)
        .default(15)
        .describe("How many clients to return"),
    },
    async ({ from_date, to_date, limit }) => {
      try {
        const fromIso = from_date ? vbToIso(from_date) : isoAgo(29);
        const toIso = to_date ? vbToIso(to_date) : isoAgo(0);
        const rows = await db.queryTopClients(fromIso, toIso, limit || 15);
        if (!rows.length) return okText("No data for this period.");

        const W = 20;
        const maxSpend = +rows[0].total_spend || 1;
        const lines = [];
        lines.push("# 🏆 Top Clients by Spend");
        lines.push(
          `📅 **${from_date || isoToVB(fromIso)} → ${to_date || isoToVB(toIso)}**`,
        );
        lines.push("");
        rows.forEach((r, i) => {
          const spend = +r.total_spend;
          const bar =
            "█".repeat(Math.round((spend / maxSpend) * W)) +
            "░".repeat(W - Math.round((spend / maxSpend) * W));
          const tag = +r.is_new ? " 🆕" : "";
          lines.push(
            `  ${String(i + 1).padStart(2)}. Client ${r.client_id}${tag}  ${bar}  ₹${Math.round(spend).toLocaleString("en-IN")}  (${r.invoices} visits)`,
          );
        });
        return okText(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── HOURLY DISTRIBUTION ──────────────────────────────────────────────────────
  server.tool(
    "get_hourly_distribution",
    'Revenue and invoice count by hour of day. Use for "when are we busiest", "peak hours", "slow hours", "staffing analysis".',
    {
      from_date: z
        .string()
        .optional()
        .describe("MM/DD/YYYY — defaults to 30 days ago"),
      to_date: z.string().optional().describe("MM/DD/YYYY — defaults to today"),
    },
    async ({ from_date, to_date }) => {
      try {
        const fromIso = from_date ? vbToIso(from_date) : isoAgo(29);
        const toIso = to_date ? vbToIso(to_date) : isoAgo(0);
        const rows = await db.queryHourlyDistribution(fromIso, toIso);
        if (!rows.length) return okText("No data for this period.");

        const W = 20;
        const maxInv = Math.max(...rows.map((r) => +r.invoices), 1);
        const totalInv = rows.reduce((s, r) => s + +r.invoices, 0);
        const lines = [];
        lines.push("# 🕐 Hourly Distribution");
        lines.push(
          `📅 **${from_date || isoToVB(fromIso)} → ${to_date || isoToVB(toIso)}**  *(Day shift: 9 AM – 9 PM)*`,
        );
        lines.push("");
        for (const r of rows) {
          const h = +r.hour;
          const inv = +r.invoices;
          const label = `${String(h).padStart(2, "0")}:00${h >= 9 && h < 21 ? " ☀" : " 🌙"}`;
          const bar =
            "█".repeat(Math.round((inv / maxInv) * W)) +
            "░".repeat(W - Math.round((inv / maxInv) * W));
          lines.push(
            `  ${label}  ${bar}  ${inv} inv  ₹${Math.round(+r.revenue).toLocaleString("en-IN")}  ${((inv / totalInv) * 100).toFixed(1)}%`,
          );
        }
        return okText(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── CLIENT DAY/NIGHT SHIFT PATTERN ──────────────────────────────────────────
  server.tool(
    "get_client_shift_pattern",
    'Who visits day-only, night-only, or both shifts. Use for "which clients come at night", "day vs night client mix", "pet parents visiting both shifts", "shift loyalty analysis".',
    {
      from_date: z
        .string()
        .optional()
        .describe("MM/DD/YYYY — defaults to 30 days ago"),
      to_date: z.string().optional().describe("MM/DD/YYYY — defaults to today"),
    },
    async ({ from_date, to_date }) => {
      try {
        const fromIso = from_date ? vbToIso(from_date) : isoAgo(29);
        const toIso = to_date ? vbToIso(to_date) : isoAgo(0);
        const rows = await db.queryClientShiftPattern(fromIso, toIso);
        if (!rows.length) return okText("No data for this period.");

        const dayOnly = rows.filter((r) => +r.night_visits === 0);
        const nightOnly = rows.filter((r) => +r.day_visits === 0);
        const both = rows.filter(
          (r) => +r.day_visits > 0 && +r.night_visits > 0,
        );
        const total = rows.length;

        const W = 20;
        const maxSeg = Math.max(
          dayOnly.length,
          nightOnly.length,
          both.length,
          1,
        );
        function bar(n) {
          return (
            "█".repeat(Math.round((n / maxSeg) * W)) +
            "░".repeat(W - Math.round((n / maxSeg) * W))
          );
        }
        function pct(n) {
          return ((n / total) * 100).toFixed(1) + "%";
        }
        function c(v) {
          return "₹" + Math.round(+v).toLocaleString("en-IN");
        }

        const SEP = "━".repeat(58);
        const lines = [];
        lines.push("# 🌅 Client Day/Night Shift Pattern");
        lines.push(
          `📅 **${from_date || isoToVB(fromIso)} → ${to_date || isoToVB(toIso)}**  |  ${total} unique clients`,
        );
        lines.push("");
        lines.push(SEP);
        lines.push(
          `  ☀️  Day only   ${bar(dayOnly.length)}  **${dayOnly.length}** clients  ${pct(dayOnly.length)}`,
        );
        lines.push(
          `  🌙 Night only  ${bar(nightOnly.length)}  **${nightOnly.length}** clients  ${pct(nightOnly.length)}`,
        );
        lines.push(
          `  🔄 Both shifts ${bar(both.length)}  **${both.length}** clients  ${pct(both.length)}`,
        );
        lines.push(SEP);
        lines.push("");

        if (both.length > 0) {
          lines.push(
            `### 🔄 ${both.length} Pet Parents Visiting Both Day & Night`,
          );
          lines.push(
            "  Client ID         | Visits | Day Spend    | Night Spend  | Night %",
          );
          lines.push("  " + "-".repeat(70));
          const sorted = both
            .sort((a, b) => +b.total_visits - +a.total_visits)
            .slice(0, 25);
          for (const r of sorted) {
            const nightPct = (
              (+r.night_visits / +r.total_visits) *
              100
            ).toFixed(0);
            lines.push(
              `  ${String(r.client_id).padEnd(18)}| ${String(r.total_visits).padEnd(7)}| ${c(r.day_spend).padEnd(14)}| ${c(r.night_spend).padEnd(14)}| ${nightPct}%`,
            );
          }
          lines.push("");
        }

        if (nightOnly.length > 0) {
          lines.push(`### 🌙 ${nightOnly.length} Night-Only Clients`);
          const topNight = nightOnly
            .sort((a, b) => +b.night_spend - +a.night_spend)
            .slice(0, 10);
          for (const r of topNight)
            lines.push(
              `  Client ${r.client_id}  ${r.night_visits} visits  ${c(r.night_spend)}`,
            );
        }

        return okText(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── HISTORICAL SYNC ───────────────────────────────────────────────────────────
  server.tool(
    "historical_sync",
    "Back-fill the RDS warehouse from a given start date to today. Use once on go-live to load all historical data.",
    {
      from_date: z
        .string()
        .describe("YYYY-MM-DD — start date for historical back-fill"),
    },
    async ({ from_date }) => {
      sync.runHistoricalSync(from_date).catch(console.error);
      return ok({
        message: `Historical sync started in background from ${from_date}. Check DB in a few minutes.`,
      });
    },
  );

  // ── DYNAMIC SQL EXECUTOR ───────────────────────────────────────────────────────
  server.tool(
    "execute_sql",
    "Execute direct SQL read queries against the AWS RDS analytics database. Use this to answer complex questions dynamically via custom aggregations without triggering token exhaustion.",
    {
      sql_query: z
        .string()
        .describe("The SQL SELECT/SHOW/DESCRIBE statement to execute on RDS."),
    },
    async ({ sql_query }) => {
      try {
        const cleanSql = sql_query.trim();
        const upper = cleanSql.toUpperCase();
        
        // Basic read-only safety check
        const allowed = ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"];
        const isAllowed = allowed.some(word => upper.startsWith(word));
        
        if (!isAllowed) {
          throw new Error("Read-Only Guard: Only SELECT, SHOW, DESCRIBE, and EXPLAIN operations are permitted.");
        }
        
        const startTime = Date.now();
        const rows = await db.query(cleanSql);
        const executionTimeMs = Date.now() - startTime;
        
        return ok({
          metadata: {
            rows_returned: rows.length,
            execution_time_ms: executionTimeMs,
            note: "Limited to 500 rows maximum for token safety."
          },
          rows: rows.slice(0, 500) // Safety cap on JSON output size
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  return server;
}

// ── HTTP + SSE TRANSPORT ──────────────────────────────────────────────────────
app.get("/mcp", async (req, res) => {
  console.log("[SSE] Incoming client connection at /mcp...");
  const transport = new SSEServerTransport("/messages", res);
  activeTransports.set(transport.sessionId, transport);
  console.log(`[SSE] Session established: ${transport.sessionId}`);

  res.on("close", () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    activeTransports.delete(transport.sessionId);
  });

  const mcpServer = buildMcpServer();
  try {
    await mcpServer.connect(transport);
  } catch (e) {
    console.error("[SSE] Failed to connect mcp server:", e);
  }
});

app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;
  const transport = activeTransports.get(sessionId);

  if (!transport) {
    console.error(`[SSE] Message post failed. Session not found: ${sessionId}`);
    return res.status(404).json({ error: "Active session not found." });
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (e) {
    console.error("[SSE] Request error on post-message:", e);
    if (!res.headersSent)
      res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AllPets VetBuddy MCP",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/dashboard-data", async (req, res) => {
  const { from_date, to_date, do_sync } = req.query;
  const fmtToday = new Date().toISOString().slice(0, 10);

  const fromIso = from_date ? from_date : fmtToday; // Expecting YYYY-MM-DD
  const toIso = to_date ? to_date : fmtToday;

  try {
    // 1. Optional background live sync before querying to match "Today"
    if (do_sync === "true") {
      await sync.syncDateRange(fromIso, toIso);
    }

    // 2. Fetch Dynamic Appointments from VetBuddy API
    const toVB = (iso) => {
      const [y, m, d] = iso.split("-");
      return `${m}/${d}/${y}`;
    };

    const [dashData, appts] = await Promise.all([
      db.queryDashboard(fromIso, toIso),
      vb
        .getAppointments({
          startdate: toVB(fromIso),
          enddate: toVB(toIso),
          max_pages: 5,
        })
        .catch((err) => {
          console.warn(
            "Warning: Failed to fetch live appointments for dashboard:",
            err.message,
          );
          return []; // non-fatal fallback
        }),
    ]);

    // Aggregate stats for appointments
    const apptCount = appts.length;
    const checkedOutCount = appts.filter(
      (a) => (a.AppointmentStatus || "").toLowerCase() === "completed",
    ).length;

    const apptsByType = {};
    for (const a of appts) {
      const typeName = a.AppointmentType?.AppointmentTypeName || "Unspecified";
      apptsByType[typeName] = (apptsByType[typeName] || 0) + 1;
    }

    res.json({
      success: true,
      dashboard: dashData,
      appointments: {
        total: apptCount,
        checkedOut: checkedOutCount,
        byType: apptsByType,
      },
    });
  } catch (error) {
    console.error("Dashboard API Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`[AllPets MCP] Server running on port ${PORT}`);
  console.log(`[AllPets MCP] MCP endpoint: http://localhost:${PORT}/mcp`);

  // Schedule nightly 2 AM IST sync, then kick off startup sync in background
  sync.scheduleNightlySync();
  sync
    .runNightlySync()
    .catch((e) =>
      console.error("[AllPets MCP] Startup sync failed:", e.message),
    );
});
