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

  // ===========================================================================
  // 🛡️ ENFORCED DYNAMIC SQL STRATEGY: Rigid analytical tools pruned.
  // Claude Desktop is now fully directed to generate optimized dynamic SQL queries
  // natively via execute_sql for 100% accuracy, speed, and zero token bloat.
  // ===========================================================================

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
