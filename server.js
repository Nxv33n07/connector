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

// ── Dashboard HTML formatter — Chart.js powered ──────────────────────────────
function buildDashboardText(data, opp) {
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
    paymentsBreakdown,
    returnedPayments,
    revenueSplit,
    invoiceSplit,
  } = data;
  const { thisWeek, lastWeek, thisMonth, lastMonth } = opp;

  const INR = (v) => "₹" + Math.round(v || 0).toLocaleString("en-IN");
  const PCT = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "0") + "%";
  const CHG = (a, b) => {
    if (!b) return { txt: "—", up: null };
    const d = (((a - b) / b) * 100).toFixed(1);
    return { txt: (d > 0 ? "+" : "") + d + "%", up: Number(d) > 0 };
  };
  const J = JSON.stringify;
  // Days in period + daily avg
  const periodDays = Math.max(
    1,
    Math.round((new Date(toDate) - new Date(fromDate)) / 86400000) + 1,
  );
  const avgDaily = totalRevenue / periodDays;

  const outstanding = totalRevenue - totalCollected;
  const collRate = totalRevenue
    ? ((totalCollected / totalRevenue) * 100).toFixed(1)
    : "0";
  const avgInv = invoiceCount ? totalRevenue / invoiceCount : 0;
  const wChg = CHG(thisWeek.rev, lastWeek.rev);
  const mChg = CHG(thisMonth.rev, lastMonth.rev);

  const CAT_COLORS = {
    Prescription: "#ef4444",
    Laboratory: "#3b82f6",
    Hospitalization: "#8b5cf6",
    Consultation: "#10b981",
    Food: "#f59e0b",
    Grooming: "#ec4899",
    Others: "#64748b",
  };
  const catLabels = Object.keys(catTotals).filter((k) => catTotals[k] > 0);
  const catVals = catLabels.map((k) => Math.round(catTotals[k]));
  const catColors = catLabels.map((k) => CAT_COLORS[k] || "#64748b");
  const subTop = subCategories.slice(0, 12);
  const pmts = paymentsBreakdown || [];
  const pmtColors = [
    "#3b82f6",
    "#10b981",
    "#f59e0b",
    "#8b5cf6",
    "#ec4899",
    "#64748b",
    "#f97316",
    "#14b8a6",
  ];
  const CAT_KEYS = [
    "Prescription",
    "Laboratory",
    "Hospitalization",
    "Consultation",
    "Food",
    "Grooming",
    "Others",
  ];

  // ── derived insight for executive summary ──────────────────────────────────
  const topCatEntry = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
  const topSpeciesEntry = Object.entries(species).sort(
    (a, b) => b[1].revenue - a[1].revenue,
  )[0];
  const collRateNum = parseFloat(collRate);
  const collStatus =
    collRateNum >= 85
      ? { icon: "✅", msg: "Excellent collection", col: "#10b981" }
      : collRateNum >= 60
        ? { icon: "⚠️", msg: "Collections need attention", col: "#f59e0b" }
        : { icon: "🚨", msg: "Critical: low collections", col: "#ef4444" };

  const kpiCard = (label, value, sub, accent, badgeTxt, badgeUp) =>
    `<div class="kpi" style="--a:${accent}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-val">${value}</div>
      <div class="kpi-sub">${sub}</div>
      ${badgeTxt ? `<span class="badge ${badgeUp === true ? "up" : badgeUp === false ? "dn" : "neu"}">${badgeTxt}</span>` : ""}
    </div>`;

  const oppRow = (label, prev, curr, chgObj) =>
    `<tr>
      <td class="td-label">${label}</td>
      <td class="td-prev">${prev}</td>
      <td><span class="arr ${chgObj.up === true ? "up" : chgObj.up === false ? "dn" : "neu"}">${chgObj.up === true ? "▲" : chgObj.up === false ? "▼" : "→"}</span></td>
      <td class="td-curr">${curr}</td>
      <td><span class="badge ${chgObj.up === true ? "up" : chgObj.up === false ? "dn" : "neu"}">${chgObj.txt}</span></td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AllPets Analytics Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#060b14;color:#e2e8f0;padding:24px;min-height:100vh}
/* ── Header ── */
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding:20px 24px;background:linear-gradient(135deg,#0f1e3a 0%,#0a1628 100%);border:1px solid #1e3a5f;border-radius:16px}
.hdr-title{font-size:24px;font-weight:900;background:linear-gradient(135deg,#60a5fa,#a78bfa,#f472b6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.5px}
.hdr-sub{font-size:12px;color:#475569;margin-top:3px}
.hdr-right{text-align:right}
.hdr-date{font-size:14px;font-weight:700;color:#93c5fd}
.hdr-ts{font-size:11px;color:#334155;margin-top:3px}
/* ── Executive Summary ── */
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.sum-card{padding:14px 16px;border-radius:12px;border:1px solid;position:relative;overflow:hidden}
.sum-icon{font-size:20px;margin-bottom:6px}
.sum-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;opacity:.7}
.sum-val{font-size:16px;font-weight:800;margin-top:2px}
.sum-hint{font-size:10px;opacity:.6;margin-top:2px}
/* ── Section header ── */
.sec{font-size:10px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:1.2px;margin:20px 0 10px;display:flex;align-items:center;gap:10px}
.sec::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#1e293b,transparent)}
/* ── KPI cards ── */
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px}
.kpi{background:linear-gradient(145deg,#111d35,#0d1626);border:1px solid #1e3352;border-radius:14px;padding:16px 14px;position:relative;overflow:hidden;transition:border-color .2s}
.kpi:hover{border-color:#3b82f6}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--a);border-radius:14px 14px 0 0}
.kpi-label{font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.kpi-val{font-size:19px;font-weight:900;color:#f1f5f9;letter-spacing:-.5px;line-height:1;margin-bottom:4px}
.kpi-sub{font-size:10px;color:#334155;margin-bottom:6px}
.kpi-avg{font-size:10px;color:#64748b;margin-bottom:4px}
/* ── Badges ── */
.badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:700}
.badge.up{background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.2)}
.badge.dn{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.2)}
.badge.neu{background:rgba(100,116,139,.12);color:#64748b;border:1px solid rgba(100,116,139,.2)}
/* ── Grid layouts ── */
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.grid31{display:grid;grid-template-columns:3fr 1fr;gap:14px;margin-bottom:14px}
.grid211{display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px;margin-bottom:14px}
/* ── Cards ── */
.card{background:linear-gradient(145deg,#111d35,#0d1626);border:1px solid #1e3352;border-radius:14px;padding:18px}
.ctitle{font-size:10px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.9px;margin-bottom:14px;display:flex;align-items:center;gap:6px}
/* ── Chart heights ── */
.ch-xs{position:relative;height:160px}
.ch-sm{position:relative;height:200px}
.ch-md{position:relative;height:260px}
.ch-lg{position:relative;height:300px}
.ch-xl{position:relative;height:340px}
/* ── Legend ── */
.leg{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.leg-i{display:flex;align-items:center;gap:5px;font-size:11px;color:#94a3b8}
.leg-val{font-weight:700;color:#e2e8f0}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
/* ── Stat rows ── */
.srow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #0f1e35}
.srow:last-child{border-bottom:none}
.slabel{font-size:11px;color:#475569}
.sval{font-size:13px;font-weight:700;color:#e2e8f0}
/* ── Opportunity table ── */
.opp-table{width:100%;border-collapse:collapse;margin-top:12px}
.opp-table td{padding:6px 4px;border-bottom:1px solid #0f1e35;font-size:11px}
.opp-table tr:last-child td{border-bottom:none}
.td-label{color:#475569;width:90px}
.td-prev{color:#334155;text-align:right}
.td-curr{font-weight:700;color:#e2e8f0;text-align:right;padding-right:6px}
.arr{font-size:9px}
.arr.up{color:#10b981}
.arr.dn{color:#ef4444}
.arr.neu{color:#64748b}
/* ── Alert rows (mismatch) ── */
.alert-row{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-radius:8px;margin-bottom:4px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.12)}
.alert-name{font-size:11px;color:#fca5a5;flex:1;font-weight:500}
.alert-qty{font-size:12px;color:#ef4444;font-weight:800}
/* ── Food / stock table ── */
.stk-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #0f1e35}
.stk-row:last-child{border-bottom:none}
.stk-name{font-size:11px;color:#94a3b8;flex:1}
.stk-val{font-size:11px;font-weight:700;color:#f59e0b}
.stk-qty{font-size:10px;color:#475569}
/* ── Footer ── */
.footer{text-align:center;padding:20px 0 4px;color:#1e293b;font-size:10px}
</style></head><body>

<!-- ═══════ HEADER ═══════ -->
<div class="hdr">
  <div>
    <div class="hdr-title">🏥 AllPets Veterinary Clinic</div>
    <div class="hdr-sub">Business Intelligence Dashboard · RDS-backed · Auto-synced nightly</div>
  </div>
  <div class="hdr-right">
    <div class="hdr-date">${isoToVB(fromDate)} → ${isoToVB(toDate)} &nbsp;(${periodDays}d)</div>
    <div class="hdr-ts">Generated ${new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
  </div>
</div>

<!-- ═══════ EXECUTIVE SUMMARY ═══════ -->
<div class="sec">📋 Executive Summary</div>
<div class="summary">
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(59,130,246,.08),rgba(59,130,246,.03));border-color:rgba(59,130,246,.25)">
    <div class="sum-icon">💰</div>
    <div class="sum-label">Revenue</div>
    <div class="sum-val" style="color:#60a5fa">${INR(totalRevenue)}</div>
    <div class="sum-hint">${INR(avgDaily)}/day avg · ${invoiceCount} invoices</div>
  </div>
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(${collRateNum >= 85 ? "16,185,129" : collRateNum >= 60 ? "245,158,11" : "239,68,68"},.08),transparent);border-color:rgba(${collRateNum >= 85 ? "16,185,129" : collRateNum >= 60 ? "245,158,11" : "239,68,68"},.25)">
    <div class="sum-icon">${collStatus.icon}</div>
    <div class="sum-label">Collections</div>
    <div class="sum-val" style="color:${collStatus.col}">${collRate}% rate</div>
    <div class="sum-hint">${INR(outstanding)} outstanding</div>
  </div>
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(139,92,246,.08),transparent);border-color:rgba(139,92,246,.25)">
    <div class="sum-icon">🏆</div>
    <div class="sum-label">Top Category</div>
    <div class="sum-val" style="color:#a78bfa">${topCatEntry?.[0] || "—"}</div>
    <div class="sum-hint">${INR(topCatEntry?.[1] || 0)} · ${PCT(topCatEntry?.[1] || 0, totalRevenue)} of revenue</div>
  </div>
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(16,185,129,.08),transparent);border-color:rgba(16,185,129,.25)">
    <div class="sum-icon">🐾</div>
    <div class="sum-label">Top Species</div>
    <div class="sum-val" style="color:#34d399">${topSpeciesEntry?.[0] || "—"}</div>
    <div class="sum-hint">${topSpeciesEntry?.[1]?.visits || 0} visits · ${INR(topSpeciesEntry?.[1]?.revenue || 0)}</div>
  </div>
</div>

<!-- ═══════ KPI CARDS ═══════ -->
<div class="sec">💰 Revenue KPIs</div>
<div class="kpis">
  ${kpiCard("Total Revenue", INR(totalRevenue), `${invoiceCount} invoices · ${periodDays}d`, "#3b82f6", wChg.txt + " WoW", wChg.up)}
  ${kpiCard("Collected", INR(totalCollected), "Payments received", "#10b981", collRate + "% collection rate", collRateNum >= 85 ? true : collRateNum >= 60 ? null : false)}
  ${kpiCard("Outstanding", INR(outstanding), PCT(outstanding, totalRevenue) + " of billed", "#ef4444", "", null)}
  ${kpiCard("Avg / Invoice", INR(avgInv), `vs ${INR(avgDaily)}/day avg`, "#f59e0b", "", null)}
  ${kpiCard("New Clients", String(newClients), PCT(newClients, newClients + returningClients) + " of visits", "#8b5cf6", "", null)}
  ${kpiCard("Returning", String(returningClients), PCT(returningClients, newClients + returningClients) + " of visits", "#ec4899", "", null)}
</div>

<!-- ═══════ 3 DONUTS: DAY/NIGHT · SPECIES · CUSTOMERS ═══════ -->
<div class="sec">📊 Core Breakdowns</div>
<div class="grid3">
  <div class="card">
    <div class="ctitle">🌅 Day vs Night — Invoices</div>
    <div class="ch-sm"><canvas id="cDayNight"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#f59e0b"></div>Day &nbsp;<span class="leg-val">${dayInvoices} inv</span>&nbsp;${INR(dayRevenue)}</div>
      <div class="leg-i"><div class="dot" style="background:#6366f1"></div>Night &nbsp;<span class="leg-val">${nightInvoices} inv</span>&nbsp;${INR(nightRevenue)}</div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">🐕🐈 Species — Revenue & Visits</div>
    <div class="ch-sm"><canvas id="cSpecies"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#3b82f6"></div>🐕 Dog &nbsp;<span class="leg-val">${species.Canine.visits}v</span>&nbsp;${INR(species.Canine.revenue)}</div>
      <div class="leg-i"><div class="dot" style="background:#a78bfa"></div>🐈 Cat &nbsp;<span class="leg-val">${species.Feline.visits}v</span>&nbsp;${INR(species.Feline.revenue)}</div>
      <div class="leg-i"><div class="dot" style="background:#475569"></div>Others &nbsp;<span class="leg-val">${species.Others.visits}v</span>&nbsp;${INR(species.Others.revenue)}</div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">👥 New vs Returning Clients</div>
    <div class="ch-sm"><canvas id="cCustomer"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#10b981"></div>New &nbsp;<span class="leg-val">${newClients}</span>&nbsp;(${PCT(newClients, newClients + returningClients)})</div>
      <div class="leg-i"><div class="dot" style="background:#3b82f6"></div>Returning &nbsp;<span class="leg-val">${returningClients}</span>&nbsp;(${PCT(returningClients, newClients + returningClients)})</div>
    </div>
  </div>
</div>

<!-- ═══════ CATEGORY DONUT + SUB-CATEGORY BAR ═══════ -->
<div class="sec">📈 Category & Sub-Category Revenue</div>
<div class="grid2">
  <div class="card">
    <div class="ctitle">💊 Revenue by Category</div>
    <div class="ch-lg"><canvas id="cCategory"></canvas></div>
  </div>
  <div class="card">
    <div class="ctitle">📊 Sub-Category Sales — Top 12</div>
    <div class="ch-lg"><canvas id="cSubCat"></canvas></div>
  </div>
</div>

<!-- ═══════ OPPORTUNITY: WoW + MoM ═══════ -->
<div class="sec">🎯 Opportunity Areas — Week & Month Comparison</div>
<div class="grid2">
  <div class="card">
    <div class="ctitle">📅 Week over Week — Category Revenue</div>
    <div class="ch-md"><canvas id="cWeek"></canvas></div>
    <table class="opp-table">
      ${oppRow("Revenue", INR(lastWeek.rev), INR(thisWeek.rev), CHG(thisWeek.rev, lastWeek.rev))}
      ${oppRow("Invoices", String(lastWeek.inv), String(thisWeek.inv), CHG(thisWeek.inv, lastWeek.inv))}
      ${oppRow("New Clients", String(lastWeek.newC), String(thisWeek.newC), CHG(thisWeek.newC, lastWeek.newC))}
      ${oppRow("Collection %", PCT(lastWeek.col, lastWeek.rev), PCT(thisWeek.col, thisWeek.rev), CHG(lastWeek.rev ? thisWeek.col / thisWeek.rev : 0, lastWeek.rev ? lastWeek.col / lastWeek.rev : 0))}
    </table>
  </div>
  <div class="card">
    <div class="ctitle">📆 Month over Month — Species Revenue</div>
    <div class="ch-md"><canvas id="cMonth"></canvas></div>
    <table class="opp-table">
      ${oppRow("Revenue", INR(lastMonth.rev), INR(thisMonth.rev), mChg)}
      ${oppRow("Invoices", String(lastMonth.inv), String(thisMonth.inv), CHG(thisMonth.inv, lastMonth.inv))}
      ${oppRow("New Clients", String(lastMonth.newC), String(thisMonth.newC), CHG(thisMonth.newC, lastMonth.newC))}
    </table>
  </div>
</div>

<!-- ═══════ SUB-CATEGORY BREAKDOWN + PAYMENTS ═══════ -->
<div class="sec">🏷️ Sub-Category Revenue Breakdown & Payments</div>
<div class="grid2">
  <div class="card">
    <div class="ctitle">🏷️ Sub-Category Sales Detail</div>
    <div class="ch-xl"><canvas id="cSubCatDetail"></canvas></div>
    ${returnedPayments?.txns > 0 ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.15);border-radius:8px;font-size:11px;color:#fca5a5">⚠️ Returned payments: ${returnedPayments.txns} txns · ${INR(returnedPayments.value)}</div>` : ""}
  </div>
  <div class="card">
    <div class="ctitle">💳 Payment Methods Breakdown</div>
    <div class="ch-sm"><canvas id="cPayments"></canvas></div>
    <div style="margin-top:14px">
      ${subTop
        .slice(0, 8)
        .map(
          (s, i) => `
        <div class="srow">
          <span class="slabel" style="font-size:10px">${s.name}</span>
          <span class="sval" style="font-size:11px">${INR(s.revenue)}</span>
        </div>`,
        )
        .join("")}
    </div>
  </div>
</div>

${
  stock
    ? `
<!-- ═══════ INVENTORY ═══════ -->
<div class="sec">📦 Inventory — Closing Stock, Alerts & Mismatches</div>

<!-- Row 1: Status donut + valuation table + mismatch list -->
<div class="grid211">
  <div class="card">
    <div class="ctitle">📊 Inventory Status Distribution</div>
    <div style="display:flex;gap:22px;align-items:center">
      <div style="width:170px;flex-shrink:0;position:relative;height:170px"><canvas id="cInv"></canvas></div>
      <div style="flex:1">
        <div class="srow"><span class="slabel">Total SKUs</span><span class="sval">${stock.totalItems.toLocaleString()}</span></div>
        <div class="srow"><span class="slabel">Closing Valuation</span><span class="sval" style="color:#60a5fa">${INR(stock.valuation)}</span></div>
        <div class="srow"><span class="slabel" style="color:#10b981">✅ Adequate</span><span class="sval" style="color:#10b981">${stock.adequateCount.toLocaleString()} <small style="color:#334155">${PCT(stock.adequateCount, stock.totalItems)}</small></span></div>
        <div class="srow"><span class="slabel" style="color:#f59e0b">🟡 Low Stock</span><span class="sval" style="color:#f59e0b">${stock.lowCount.toLocaleString()} <small style="color:#334155">${PCT(stock.lowCount, stock.totalItems)}</small></span></div>
        <div class="srow"><span class="slabel" style="color:#ef4444">🔴 Out of Stock</span><span class="sval" style="color:#ef4444">${stock.outCount.toLocaleString()} <small style="color:#334155">${PCT(stock.outCount, stock.totalItems)}</small></span></div>
        <div class="srow"><span class="slabel" style="color:#fbbf24">⚠️ Negative (Mismatch)</span><span class="sval" style="color:#fbbf24">${stock.negativeCount.toLocaleString()} <small style="color:#334155">${PCT(stock.negativeCount, stock.totalItems)}</small></span></div>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">⚠️ System vs Physical Mismatch</div>
    <div style="font-size:10px;color:#334155;margin-bottom:8px">Items billed but not received — negative onhand qty</div>
    ${
      stock.negativeItems?.length > 0
        ? stock.negativeItems
            .slice(0, 8)
            .map(
              (i) =>
                `<div class="alert-row"><span class="alert-name">${i.name}</span><span class="alert-qty">${i.onhand_qty}</span></div>`,
            )
            .join("")
        : `<div style="font-size:12px;color:#10b981;padding:10px 0">✅ No mismatches detected</div>`
    }
  </div>
  <div class="card">
    <div class="ctitle">🔴 Out / 🟡 Low Stock</div>
    ${
      stock.outItems?.length > 0
        ? `<div style="font-size:10px;font-weight:700;color:#ef4444;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Out of Stock</div>
    ${stock.outItems
      .slice(0, 5)
      .map(
        (i) =>
          `<div class="stk-row"><span class="stk-name">• ${i.name}</span><span class="stk-qty">${i.cat || ""}</span></div>`,
      )
      .join("")}`
        : ""
    }
    ${
      stock.lowItems?.length > 0
        ? `<div style="font-size:10px;font-weight:700;color:#f59e0b;margin:10px 0 6px;text-transform:uppercase;letter-spacing:.5px">Low Stock</div>
    ${stock.lowItems
      .slice(0, 5)
      .map(
        (i) =>
          `<div class="stk-row"><span class="stk-name">• ${i.name}</span><span class="stk-val">${i.onhand_qty}/${i.threshold_qty}</span></div>`,
      )
      .join("")}`
        : ""
    }
  </div>
</div>

<!-- Row 2: Sub-category valuation bar + Food items -->
<div class="grid2">
  <div class="card">
    <div class="ctitle">📦 Sub-Category Stock Valuation</div>
    ${stock.subCatStock?.length > 0 ? `<div class="ch-xl"><canvas id="cStockSub"></canvas></div>` : `<div style="color:#334155;font-size:12px;padding:20px 0">No sub-category stock data</div>`}
  </div>
  <div class="card">
    <div class="ctitle">🍖 Food Inventory</div>
    ${
      stock.foodItems?.length > 0
        ? stock.foodItems
            .slice(0, 10)
            .map(
              (i) =>
                `<div class="stk-row"><span class="stk-name">${i.name}</span><div style="text-align:right"><span class="stk-val">${INR(i.value || 0)}</span><br><span class="stk-qty">qty: ${i.onhand_qty}</span></div></div>`,
            )
            .join("")
        : `<div style="color:#334155;font-size:12px;padding:20px 0">No food items in stock</div>`
    }
  </div>
</div>
`
    : ""
}

<div class="footer">AllPets VetBuddy · Powered by RDS Analytics · ${new Date().toISOString()}</div>

<script>
Chart.register(ChartDataLabels);
Chart.defaults.color='#64748b';
Chart.defaults.borderColor='#0f1e35';
Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
Chart.defaults.font.size=11;

const inr=v=>'₹'+Math.round(v||0).toLocaleString('en-IN');
const pct=(a,b)=>b?((a/b)*100).toFixed(1)+'%':'0%';
const fmtK=v=>v>=1e5?'₹'+(v/1e5).toFixed(1)+'L':v>=1e3?'₹'+(v/1e3).toFixed(0)+'K':'₹'+v;

const DL_PCT={id:'datalabels',formatter:(v,ctx)=>{const t=ctx.dataset.data.reduce((a,b)=>a+b,0);return t&&v/t>.04?((v/t)*100).toFixed(0)+'%':'';},color:'#fff',font:{weight:'700',size:11},textStrokeColor:'rgba(0,0,0,.4)',textStrokeWidth:2};
const DL_INR={id:'datalabels',formatter:(v)=>v>0?inr(v):'',color:'#fff',font:{weight:'700',size:10},textStrokeColor:'rgba(0,0,0,.4)',textStrokeWidth:2};
const NO_DL={id:'datalabels',display:false};

// Day / Night
new Chart(document.getElementById('cDayNight'),{type:'doughnut',data:{labels:['Day','Night'],datasets:[{data:[${dayInvoices},${nightInvoices}],backgroundColor:['#f59e0b','#6366f1'],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.label+': '+ctx.raw+' invoices ('+pct(ctx.raw,${dayInvoices + nightInvoices})+')'}},datalabels:DL_PCT}}});

// Species
new Chart(document.getElementById('cSpecies'),{type:'doughnut',data:{labels:['🐕 Dog','🐈 Cat','Others'],datasets:[{data:[${Math.round(species.Canine.revenue)},${Math.round(species.Feline.revenue)},${Math.round(species.Others.revenue)}],backgroundColor:['#3b82f6','#a78bfa','#475569'],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.label+': '+inr(ctx.raw)}},datalabels:DL_PCT}}});

// Customers
new Chart(document.getElementById('cCustomer'),{type:'doughnut',data:{labels:['New','Returning'],datasets:[{data:[${newClients},${returningClients}],backgroundColor:['#10b981','#3b82f6'],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.label+': '+ctx.raw+' ('+pct(ctx.raw,${newClients + returningClients})+')'}},datalabels:DL_PCT}}});

// Category donut (large, with ₹ labels)
new Chart(document.getElementById('cCategory'),{type:'doughnut',data:{labels:${J(catLabels)},datasets:[{data:${J(catVals)},backgroundColor:${J(catColors)},borderWidth:0,hoverOffset:8}]},options:{responsive:true,maintainAspectRatio:false,cutout:'50%',plugins:{legend:{display:true,position:'right',labels:{padding:14,boxWidth:11,color:'#94a3b8',usePointStyle:true}},tooltip:{callbacks:{label:ctx=>ctx.label+': '+inr(ctx.raw)+' ('+pct(ctx.raw,${Math.round(totalRevenue) || 1})+')'}},datalabels:{...DL_PCT,font:{weight:'700',size:10}}}}});

// Sub-category horizontal bar
new Chart(document.getElementById('cSubCat'),{type:'bar',data:{labels:${J(subCategories.slice(0, 12).map((s) => (s.name.length > 22 ? s.name.slice(0, 20) + "…" : s.name)))},datasets:[{data:${J(subCategories.slice(0, 12).map((s) => Math.round(s.revenue)))},backgroundColor:subColors=${J(subCategories.slice(0, 12).map((_, i) => ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#a855f7"][i]))},borderWidth:0,borderRadius:5}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)}},datalabels:{anchor:'end',align:'start',formatter:v=>fmtK(v),color:'#94a3b8',font:{size:10}}},scales:{x:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},y:{grid:{display:false},ticks:{font:{size:10}}}}}});

// WoW grouped bar
new Chart(document.getElementById('cWeek'),{type:'bar',data:{labels:${J(CAT_KEYS)},datasets:[{label:'Last Week',data:${J(CAT_KEYS.map((k) => Math.round(lastWeek.cats[k] || 0)))},backgroundColor:'rgba(71,85,105,.5)',borderColor:'#475569',borderWidth:1,borderRadius:4},{label:'This Week',data:${J(CAT_KEYS.map((k) => Math.round(thisWeek.cats[k] || 0)))},backgroundColor:${J(CAT_KEYS.map((k) => catColors[catLabels.indexOf(k)] || "rgba(59,130,246,.6)"))},borderColor:${J(CAT_KEYS.map((k) => CAT_COLORS[k] || "#3b82f6"))},borderWidth:1,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:10,usePointStyle:true}},tooltip:{callbacks:{label:ctx=>' '+ctx.dataset.label+': '+inr(ctx.raw)}},datalabels:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:9}}},y:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}}}}});

// MoM species bar
new Chart(document.getElementById('cMonth'),{type:'bar',data:{labels:['🐕 Dog','🐈 Cat','Others'],datasets:[{label:'Last Month',data:[${Math.round(lastMonth.spRevs.Canine || 0)},${Math.round(lastMonth.spRevs.Feline || 0)},${Math.round(lastMonth.spRevs.Others || 0)}],backgroundColor:'rgba(71,85,105,.5)',borderColor:'#475569',borderWidth:1,borderRadius:4},{label:'This Month',data:[${Math.round(thisMonth.spRevs.Canine || 0)},${Math.round(thisMonth.spRevs.Feline || 0)},${Math.round(thisMonth.spRevs.Others || 0)}],backgroundColor:['rgba(59,130,246,.65)','rgba(167,139,250,.65)','rgba(71,85,105,.65)'],borderColor:['#3b82f6','#a78bfa','#475569'],borderWidth:1,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:10,usePointStyle:true}},tooltip:{callbacks:{label:ctx=>' '+ctx.dataset.label+': '+inr(ctx.raw)}},datalabels:{display:false}},scales:{x:{grid:{display:false}},y:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}}}}});

// Sub-category detail horizontal bar
new Chart(document.getElementById('cSubCatDetail'),{type:'bar',data:{labels:${J(subCategories.slice(0, 15).map((s) => (s.name.length > 24 ? s.name.slice(0, 22) + "…" : s.name)))},datasets:[{data:${J(subCategories.slice(0, 15).map((s) => Math.round(s.revenue)))},backgroundColor:${J(subCategories.slice(0, 15).map((_, i) => ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#a855f7", "#fb923c", "#38bdf8", "#4ade80"][i]))},borderWidth:0,borderRadius:5}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)}},datalabels:{anchor:'end',align:'start',formatter:v=>fmtK(v),color:'#94a3b8',font:{size:10}}},scales:{x:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},y:{grid:{display:false},ticks:{font:{size:9}}}}}});

// Payment methods
new Chart(document.getElementById('cPayments'),{type:'bar',data:{labels:${J(pmts.map((r) => r.method))},datasets:[{data:${J(pmts.map((r) => Math.round(r.value)))},backgroundColor:${J(pmts.map((_, i) => ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b", "#f97316", "#14b8a6"][i % 8]))},borderRadius:5,borderWidth:0}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)+' ('+${pmts.length > 0 ? "ctx.dataset.data.reduce((a,b)=>a+b,0)" : "1"}+' total)'}},datalabels:{anchor:'end',align:'start',formatter:v=>fmtK(v),color:'#94a3b8',font:{size:10}}},scales:{x:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},y:{grid:{display:false}}}}});

${
  stock
    ? `
// Inventory status donut
new Chart(document.getElementById('cInv'),{type:'doughnut',data:{labels:['Adequate','Low','Out','Negative'],datasets:[{data:[${stock.adequateCount},${stock.lowCount},${stock.outCount},${stock.negativeCount}],backgroundColor:['#10b981','#f59e0b','#ef4444','#fbbf24'],borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'60%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.label+': '+ctx.raw.toLocaleString()+' SKUs ('+pct(ctx.raw,${stock.totalItems})+')'}},datalabels:DL_PCT}}});
`
    : ""
}

${
  stock?.subCatStock?.length > 0
    ? `
// Stock sub-category bar
new Chart(document.getElementById('cStockSub'),{type:'bar',data:{labels:${J(stock.subCatStock.map((r) => ((r.sub_cat || "").length > 22 ? (r.sub_cat || "").slice(0, 20) + "…" : r.sub_cat || "")))},datasets:[{data:${J(stock.subCatStock.map((r) => Math.round(r.value)))},backgroundColor:'rgba(139,92,246,.65)',borderColor:'#8b5cf6',borderWidth:1,borderRadius:5,label:'Closing Value'}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)+' · '+ctx.dataIndex+1+' sub-cat'}},datalabels:{anchor:'end',align:'start',formatter:v=>fmtK(v),color:'#94a3b8',font:{size:9}}},scales:{x:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},y:{grid:{display:false},ticks:{font:{size:10}}}}}});
`
    : ""
}
<\/script></body></html>`;
}

// ── Dashboard query wrapper with self-hydrator ───────────────────────────────
async function getDashboard(fromIso, toIso) {
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

  // ── Standing instructions prompt ─────────────────────────────────────────────
  server.prompt(
    "analyst_instructions",
    "AllPets analyst role — read this before every conversation",
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are the dedicated business analyst for AllPets Veterinary Clinic.
Your data lives in AWS RDS MySQL. ALL answers to business questions must come from the MCP tools — never guess or use static knowledge.

════════════════════════════════════════════════════════════════════
⚡ BOARD MEETING / PPT / PERFORMANCE REVIEW — MANDATORY RULE
════════════════════════════════════════════════════════════════════
If the user mentions ANY of: board meeting, performance review, PPT, presentation,
annual review, quarterly review, "create a deck", "complete review" —
you MUST call board_meeting_report IMMEDIATELY as your FIRST and ONLY tool call.
Do NOT call execute_sql or render_chart for these requests.
board_meeting_report returns a complete 7-slide HTML presentation in ONE call.
Infer from_date and to_date from context (e.g. "April" → from_date=2026-04-01, to_date=2026-04-30;
"last 12 months" or no date → from_date=one year ago, to_date=today).

════════════════════════════════════════════════════════════════════
RDS SCHEMA (verified against deployed DB)
════════════════════════════════════════════════════════════════════
TABLE: allpets_invoices
  invoice_id, invoice_no, clinic_id, clinic_name, client_name,
  mobile_phone, invoice_date DATETIME, invoice_amount DECIMAL,
  shift ENUM('Day','Night'), cancelled TINYINT(0=active,1=cancelled),
  synced_at TIMESTAMP
  ⚠ NO is_new_client or client_id column — use patient_id from invoice_items

TABLE: allpets_invoice_items
  id BIGINT, invoice_id, sales_id, patient_id, patient_name,
  patient_species VARCHAR, species_group ENUM('Canine','Feline','Others'),
  invoice_date DATETIME, plan_category_name VARCHAR,
  std_category VARCHAR  -- Prescription|Laboratory|Hospitalization|Consultation|Food|Grooming|Others
  plan_sub_category_name VARCHAR, item_total DECIMAL, synced_at TIMESTAMP

TABLE: allpets_payments
  payment_id, payment_date DATETIME, payment_amount DECIMAL,
  payment_type_name VARCHAR, returned TINYINT(0=valid,1=returned),
  invoice_id VARCHAR
  ⚠ NO client_id column in payments

TABLE: allpets_stock
  stock_id, clinic_id, clinic_name, stock_name VARCHAR,
  plan_category_name, plan_sub_category_name, std_category VARCHAR,
  onhand_qty DECIMAL, threshold_qty DECIMAL, purchase_cost DECIMAL,
  stock_status ENUM('adequate','low','out','negative')

════════════════════════════════════════════════════════════════════
WORKFLOW FOR SPECIFIC QUERIES (non-board-meeting)
════════════════════════════════════════════════════════════════════
Step 1 — call execute_sql to get data from RDS.
Step 2 — call render_chart (returns chart image inline in chat).
Step 3 — write 2-3 sentences of actionable insight.

Never skip render_chart for specific queries. Never use is_new_client or client_id in SQL.
For new vs returning patients: use MIN(invoice_date) per patient_id from allpets_invoice_items.

════════════════════════════════════════════════════════════════════
RULES
════════════════════════════════════════════════════════════════════
1. Always filter cancelled=0 for revenue/invoice queries on allpets_invoices.
2. Always filter returned=0 for payment queries.
3. Use DATE(invoice_date) BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' for date ranges.
4. Closing stock valuation = SUM(onhand_qty * purchase_cost) WHERE onhand_qty > 0.
5. Call get_dashboard ONLY when explicitly asked for "the dashboard" or "show dashboard".
6. Choose chart types: doughnut for proportions, bar for rankings, line for trends, horizontalBar for top-N.
7. Set currency:true whenever values are ₹ amounts.
8. Always include KPI cards for key numbers.`,
          },
        },
      ],
    }),
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
    `PRIMARY TOOL — Runs read-only SQL on RDS. CRITICAL REQUIREMENT: After this, you MUST immediately call 'render_chart' to build the visual dashboard!
TABLES SCHEMA:
1. allpets_invoices: invoice_id (VARCHAR), invoice_date (DATETIME), invoice_amount (DECIMAL), shift ('Day'|'Night'), cancelled (0=active,1=cancelled), client_id, is_new_client (0|1)
2. allpets_invoice_items: invoice_id, invoice_date, item_total (DECIMAL - this is the REVENUE column), species_group ('Canine'|'Feline'|'Others'), std_category ('Prescription'|'Laboratory'|'Hospitalization'|'Consultation'|'Food'|'Grooming'|'Others'), plan_sub_category_name, patient_id
3. allpets_payments: payment_id, payment_date, payment_amount, payment_type_name, returned (0=active,1=returned), invoice_id
4. allpets_stock: stock_name, plan_category_name, std_category, onhand_qty, purchase_cost, stock_status ('adequate'|'low'|'out'|'negative')
Always filter cancelled=0 for revenue, and pair execute_sql with render_chart for every question.`,
    {
      sql_query: z
        .string()
        .describe(
          "SELECT statement to run on RDS. Read-only — SELECT/SHOW/DESCRIBE/EXPLAIN only.",
        ),
    },
    async ({ sql_query }) => {
      try {
        const cleanSql = sql_query.trim();
        const upper = cleanSql.toUpperCase();

        // Basic read-only safety check
        const allowed = ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"];
        const isAllowed = allowed.some((word) => upper.startsWith(word));

        if (!isAllowed) {
          throw new Error(
            "Read-Only Guard: Only SELECT, SHOW, DESCRIBE, and EXPLAIN operations are permitted.",
          );
        }

        const startTime = Date.now();
        const rows = await db.query(cleanSql);
        const executionTimeMs = Date.now() - startTime;

        return ok({
          metadata: {
            rows_returned: rows.length,
            execution_time_ms: executionTimeMs,
            note: "Limited to 500 rows maximum for token safety.",
          },
          rows: rows.slice(0, 500), // Safety cap on JSON output size
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── RENDER CHART — dynamic visual from Claude-supplied spec ──────────────
  server.tool(
    "render_chart",
    "ALWAYS call this after execute_sql. Returns an HTML resource that renders inline in the chat automatically. Call this for every business query without exception.",
    {
      title: z
        .string()
        .describe("Dashboard title, e.g. 'Revenue by Category — May 2026'"),
      summary: z
        .string()
        .optional()
        .describe(
          "2-3 sentence executive insight Claude writes after seeing the SQL results",
        ),
      kpis: z
        .array(
          z.object({
            label: z.string(),
            value: z
              .string()
              .describe("formatted value, e.g. '₹8,78,841' or '458'"),
            sub: z.string().optional().describe("subtitle, e.g. '39 invoices'"),
            trend: z
              .string()
              .optional()
              .describe("trend badge, e.g. '+12% WoW' or '↓5%'"),
            trend_up: z
              .boolean()
              .nullable()
              .optional()
              .describe("true=green, false=red, null=neutral"),
            accent: z
              .string()
              .optional()
              .describe("hex accent colour for the card top border"),
          }),
        )
        .optional()
        .describe("Up to 6 KPI cards shown at the top"),
      charts: z
        .array(
          z.object({
            id: z.string().describe("unique canvas id, e.g. 'c1'"),
            type: z
              .enum(["bar", "doughnut", "line", "pie", "horizontalBar"])
              .describe(
                "chart type — use doughnut for proportions, bar/line for trends, horizontalBar for ranked lists",
              ),
            title: z.string(),
            labels: z.array(z.string()),
            datasets: z
              .array(
                z.object({
                  label: z.string().optional(),
                  data: z.array(z.number()),
                  color: z
                    .string()
                    .optional()
                    .describe("single hex color for this dataset"),
                  colors: z
                    .array(z.string())
                    .optional()
                    .describe("per-slice colors for doughnut/pie"),
                }),
              )
              .describe(
                "1 dataset = simple chart, 2 datasets = comparison (e.g. this week vs last week)",
              ),
            currency: z
              .boolean()
              .optional()
              .describe(
                "true if values are ₹ amounts — formats axis and tooltip as INR",
              ),
          }),
        )
        .describe("1–4 charts to render"),
    },
    async ({ title, summary, kpis = [], charts = [] }) => {
      try {
        const PAL = [
          "#4285f4",
          "#34a853",
          "#fbbc04",
          "#ea4335",
          "#9c27b0",
          "#ff6d00",
          "#00bcd4",
          "#607d8b",
          "#e91e63",
          "#009688",
        ];
        const content = [];

        // KPI table rendered inline as text
        if (kpis.length || summary) {
          let txt = `**📊 ${title}**\n\n`;
          if (summary) txt += `> ${summary}\n\n`;
          if (kpis.length) {
            txt += `| ${kpis.map((k) => k.label).join(" | ")} |\n`;
            txt += `|${kpis.map(() => "---").join("|")}|\n`;
            txt += `| ${kpis.map((k) => `**${k.value}**${k.trend ? " " + k.trend : ""}${k.sub ? "<br>" + k.sub : ""}`).join(" | ")} |\n`;
          }
          content.push({ type: "text", text: txt });
        }

        // Fetch chart PNGs from QuickChart in parallel
        const pngs = await Promise.all(
          charts.slice(0, 4).map(async (ch) => {
            const isH = ch.type === "horizontalBar";
            const isRound = ch.type === "doughnut" || ch.type === "pie";
            const ds = ch.datasets.map((d, di) => ({
              label: d.label || "",
              data: d.data,
              backgroundColor:
                d.colors ||
                (isRound || isH
                  ? ch.labels.map((_, i) => PAL[i % PAL.length])
                  : PAL[di % PAL.length]),
              borderWidth: isRound ? 0 : 1,
              borderColor: d.color || PAL[di % PAL.length],
              borderRadius: isRound ? 0 : 4,
            }));
            const fmtK =
              "function(v){return v>=1e5?'\\u20B9'+(v/1e5).toFixed(1)+'L':v>=1e3?'\\u20B9'+(v/1e3).toFixed(0)+'K':'\\u20B9'+Math.round(v)}";
            const cfg = {
              type: isH ? "bar" : ch.type,
              data: { labels: ch.labels, datasets: ds },
              options: {
                ...(isH ? { indexAxis: "y" } : {}),
                plugins: {
                  title: {
                    display: true,
                    text: ch.title,
                    font: { size: 13, weight: "bold" },
                    color: "#202124",
                  },
                  legend: {
                    display: isRound,
                    position: "right",
                    labels: { color: "#5f6368" },
                  },
                  datalabels: { display: false },
                },
                ...(isRound
                  ? {}
                  : {
                      scales: {
                        [isH ? "x" : "y"]: {
                          grid: { color: "#eeeeee" },
                          ticks: {
                            color: "#5f6368",
                            callback: ch.currency ? fmtK : undefined,
                          },
                        },
                        [isH ? "y" : "x"]: {
                          grid: { display: false },
                          ticks: { color: "#5f6368" },
                        },
                      },
                    }),
              },
            };
            const resp = await axios.post(
              "https://quickchart.io/chart",
              {
                chart: cfg,
                width: 560,
                height: isRound ? 260 : 300,
                backgroundColor: "#ffffff",
                format: "png",
              },
              { responseType: "arraybuffer", timeout: 12000 },
            );
            return Buffer.from(resp.data).toString("base64");
          }),
        );

        pngs.forEach((b64) => {
          if (b64)
            content.push({ type: "image", data: b64, mimeType: "image/png" });
        });

        return { content };
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── DASHBOARD (HTML artifact with Chart.js) ───────────────────────────────
  server.tool(
    "get_dashboard",
    "VISUAL OVERVIEW ONLY — call this exclusively when the user explicitly asks for 'the dashboard', 'full report', 'show me the dashboard', or 'visual overview'. Do NOT call this for specific business questions. Returns an <antArtifact> block — you MUST output it verbatim as the first thing in your response.",
    {
      from_date: z.string().describe("YYYY-MM-DD start date"),
      to_date: z.string().describe("YYYY-MM-DD end date"),
    },
    async ({ from_date, to_date }) => {
      try {
        const html = await getDashboard(from_date, to_date);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `urn:allpets:dashboard:${Date.now()}`,
                mimeType: "text/html",
                text: html,
              },
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── FORCE SYNC ────────────────────────────────────────────────────────────
  server.tool(
    "force_sync",
    "Manually trigger a sync for any date range to refresh RDS with latest VetBuddy data.",
    {
      from_date: z.string().describe("YYYY-MM-DD start date"),
      to_date: z.string().describe("YYYY-MM-DD end date"),
    },
    async ({ from_date, to_date }) => {
      try {
        await sync.syncDateRange(from_date, to_date);
        return ok({ message: `Sync complete: ${from_date} → ${to_date}` });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── LIVE VETBUDDY API TOOLS ───────────────────────────────────────────────
  server.tool(
    "get_appointments",
    "Fetch today's or a specific date's appointments from VetBuddy live API.",
    {
      date: z.string().optional().describe("MM/DD/YYYY — defaults to today"),
      appointment_type: z.string().optional(),
    },
    async (args) => {
      try {
        const d = args.date || today();
        const data = await vb.getAppointments({
          date: d,
          appointmenttype: args.appointment_type,
          max_pages: 5,
        });
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_patients",
    "Search patients in VetBuddy by name, species, or date range.",
    {
      search: z.string().optional().describe("Patient name or ID"),
      species: z.string().optional(),
      from_date: z.string().optional().describe("MM/DD/YYYY"),
      to_date: z.string().optional().describe("MM/DD/YYYY"),
    },
    async (args) => {
      try {
        const data = await vb.getPatients({
          search: args.search,
          species: args.species,
          startdate: args.from_date,
          enddate: args.to_date,
          max_pages: 5,
        });
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_clients",
    "Search clients in VetBuddy by name, phone, or date of first visit.",
    {
      search: z.string().optional().describe("Client name, ID, or phone"),
      from_date: z.string().optional().describe("MM/DD/YYYY"),
      to_date: z.string().optional().describe("MM/DD/YYYY"),
    },
    async (args) => {
      try {
        const data = await vb.getClients({
          search: args.search,
          startdate: args.from_date,
          enddate: args.to_date,
          max_pages: 5,
        });
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_staff",
    "Get all staff members and their roles from VetBuddy.",
    {},
    async () => {
      try {
        return ok(await vb.getStaff({ max_pages: 3 }));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_reminders",
    "Get upcoming patient reminders (vaccinations, follow-ups, deworming) from VetBuddy.",
    {
      from_date: z.string().optional().describe("MM/DD/YYYY"),
      to_date: z.string().optional().describe("MM/DD/YYYY"),
    },
    async (args) => {
      try {
        const data = await vb.getReminders({
          startdate: args.from_date || today(),
          enddate: args.to_date || today(),
          max_pages: 5,
        });
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_stock",
    "Get live stock / inventory levels from VetBuddy.",
    { category: z.string().optional() },
    async (args) => {
      try {
        const data = await vb.getStock({ max_pages: 10 });
        const filtered = args.category
          ? data.filter((s) =>
              (
                s.Stock?.PlanItemDetails?.PlanItem?.PlanCategory
                  ?.PlanCategoryName || ""
              )
                .toLowerCase()
                .includes(args.category.toLowerCase()),
            )
          : data;
        return ok(filtered.slice(0, 200));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_clinic_info",
    "Get clinic details, settings, and configuration from VetBuddy.",
    {},
    async () => {
      try {
        return ok(await vb.getClinics());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "daily_briefing",
    "Morning briefing — today's appointments, pending reminders, and low-stock alerts combined in one call.",
    {},
    async () => {
      try {
        const t = today();
        const [appts, reminders] = await Promise.all([
          vb.getAppointments({ date: t, max_pages: 3 }),
          vb.getReminders({ startdate: t, enddate: t, max_pages: 2 }),
        ]);
        return ok({
          date: t,
          appointments: appts.length,
          reminders: reminders.length,
          appointments_detail: appts.slice(0, 20),
          reminders_detail: reminders.slice(0, 20),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── BOARD MEETING REPORT — single-call full presentation ────────────────────
  server.tool(
    "board_meeting_report",
    `Generates a complete board-meeting HTML presentation for AllPets Clinic in ONE call.
Use this whenever the user asks for a board meeting report, performance review, PPT, presentation, or annual/quarterly review.
DO NOT use execute_sql + render_chart for board meeting requests — this tool does everything in one shot.
Returns a self-contained HTML slide deck with 7 slides covering: revenue YoY, species MoM, new vs existing clients, sub-category breakdown, clinical function performance, and ailment trends.`,
    {
      from_date: z
        .string()
        .describe(
          "YYYY-MM-DD — start of the primary review period (e.g. 2026-04-01)",
        ),
      to_date: z
        .string()
        .describe(
          "YYYY-MM-DD — end of the primary review period (e.g. 2026-04-30)",
        ),
    },
    async ({ from_date, to_date }) => {
      try {
        const [
          monthlyRevenue,
          speciesMoM,
          newVsExistingMoM,
          subCatBreakdown,
          stdCatMoM,
          periodKpi,
          prevYearKpi,
        ] = await Promise.all([
          // 24 months of monthly revenue for YoY
          db.query(
            `SELECT DATE_FORMAT(invoice_date,'%Y-%m') AS month,
                    COALESCE(SUM(invoice_amount),0) AS revenue,
                    COUNT(*) AS invoices
             FROM allpets_invoices
             WHERE DATE(invoice_date) >= DATE_SUB(CURDATE(), INTERVAL 24 MONTH)
               AND cancelled=0
             GROUP BY month ORDER BY month`,
          ),
          // Species MoM last 13 months
          db.query(
            `SELECT DATE_FORMAT(invoice_date,'%Y-%m') AS month,
                    species_group,
                    COALESCE(SUM(item_total),0) AS revenue,
                    COUNT(DISTINCT invoice_id) AS visits,
                    COUNT(DISTINCT patient_id) AS patients
             FROM allpets_invoice_items
             WHERE DATE(invoice_date) >= DATE_SUB(CURDATE(), INTERVAL 13 MONTH)
             GROUP BY month, species_group ORDER BY month`,
          ),
          // New vs existing MoM using patient first-visit logic
          db.query(
            `SELECT
               DATE_FORMAT(ii.invoice_date,'%Y-%m') AS month,
               COUNT(DISTINCT CASE WHEN mn.first_month = DATE_FORMAT(ii.invoice_date,'%Y-%m') THEN ii.patient_id END) AS new_patients,
               COUNT(DISTINCT CASE WHEN mn.first_month < DATE_FORMAT(ii.invoice_date,'%Y-%m') THEN ii.patient_id END) AS returning_patients,
               COALESCE(SUM(CASE WHEN mn.first_month = DATE_FORMAT(ii.invoice_date,'%Y-%m') THEN ii.item_total ELSE 0 END),0) AS new_revenue,
               COALESCE(SUM(CASE WHEN mn.first_month < DATE_FORMAT(ii.invoice_date,'%Y-%m') THEN ii.item_total ELSE 0 END),0) AS returning_revenue
             FROM allpets_invoice_items ii
             JOIN (
               SELECT patient_id, DATE_FORMAT(MIN(invoice_date),'%Y-%m') AS first_month
               FROM allpets_invoice_items WHERE patient_id != '' GROUP BY patient_id
             ) mn ON mn.patient_id = ii.patient_id
             WHERE DATE(ii.invoice_date) >= DATE_SUB(CURDATE(), INTERVAL 13 MONTH)
               AND ii.patient_id != ''
             GROUP BY month ORDER BY month`,
          ),
          // Sub-category revenue for the period
          db.query(
            `SELECT plan_sub_category_name AS sub_cat,
                    std_category AS category,
                    COALESCE(SUM(item_total),0) AS revenue,
                    COUNT(DISTINCT invoice_id) AS invoices
             FROM allpets_invoice_items
             WHERE DATE(invoice_date) BETWEEN ? AND ?
               AND plan_sub_category_name IS NOT NULL AND plan_sub_category_name != ''
             GROUP BY plan_sub_category_name, std_category
             ORDER BY revenue DESC LIMIT 25`,
            [from_date, to_date],
          ),
          // Std category MoM last 13 months
          db.query(
            `SELECT DATE_FORMAT(invoice_date,'%Y-%m') AS month,
                    std_category AS category,
                    COALESCE(SUM(item_total),0) AS revenue
             FROM allpets_invoice_items
             WHERE DATE(invoice_date) >= DATE_SUB(CURDATE(), INTERVAL 13 MONTH)
             GROUP BY month, category ORDER BY month`,
          ),
          // Primary period KPIs
          db.query(
            `SELECT COALESCE(SUM(invoice_amount),0) AS revenue,
                    COUNT(*) AS invoices,
                    COUNT(DISTINCT DATE(invoice_date)) AS active_days
             FROM allpets_invoices
             WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0`,
            [from_date, to_date],
          ),
          // Same period prior year
          db.query(
            `SELECT COALESCE(SUM(invoice_amount),0) AS revenue, COUNT(*) AS invoices
             FROM allpets_invoices
             WHERE DATE(invoice_date) BETWEEN
               DATE_SUB(?, INTERVAL 1 YEAR) AND DATE_SUB(?, INTERVAL 1 YEAR)
               AND cancelled=0`,
            [from_date, to_date],
          ),
        ]);

        const J = JSON.stringify;
        const INR = (v) => "₹" + Math.round(v || 0).toLocaleString("en-IN");
        const pct = (a, b) =>
          b ? (((a - b) / b) * 100).toFixed(1) + "%" : "—";

        const kpi = periodKpi[0] || {};
        const prevKpi = prevYearKpi[0] || {};
        const yoyPct = pct(+kpi.revenue, +prevKpi.revenue);
        const yoyUp = +kpi.revenue >= +prevKpi.revenue;

        // Process monthly revenue array
        const sortedMonths = monthlyRevenue.map((r) => r.month);
        const last12Months = sortedMonths.slice(-12);
        const prev12Months = sortedMonths.slice(-24, -12);

        const revByMonth = {};
        for (const r of monthlyRevenue) revByMonth[r.month] = +r.revenue;
        const invByMonth = {};
        for (const r of monthlyRevenue) invByMonth[r.month] = +r.invoices;

        const curr12Rev = last12Months.map((m) =>
          Math.round(revByMonth[m] || 0),
        );
        const prev12Rev = prev12Months.map((m) =>
          Math.round(revByMonth[m] || 0),
        );
        const curr12Labels = last12Months.map((m) => {
          const [y, mo] = m.split("-");
          return (
            [
              "",
              "Jan",
              "Feb",
              "Mar",
              "Apr",
              "May",
              "Jun",
              "Jul",
              "Aug",
              "Sep",
              "Oct",
              "Nov",
              "Dec",
            ][parseInt(mo)] +
            " " +
            y.slice(2)
          );
        });

        // Species data
        const spMonths = [...new Set(speciesMoM.map((r) => r.month))]
          .sort()
          .slice(-12);
        const spLabels = spMonths.map((m) => {
          const [y, mo] = m.split("-");
          return (
            [
              "",
              "Jan",
              "Feb",
              "Mar",
              "Apr",
              "May",
              "Jun",
              "Jul",
              "Aug",
              "Sep",
              "Oct",
              "Nov",
              "Dec",
            ][parseInt(mo)] +
            " " +
            y.slice(2)
          );
        });
        const getSpRev = (sp) =>
          spMonths.map((m) => {
            const r = speciesMoM.find(
              (x) => x.month === m && x.species_group === sp,
            );
            return r ? Math.round(+r.revenue) : 0;
          });
        const getSpPat = (sp) =>
          spMonths.map((m) => {
            const r = speciesMoM.find(
              (x) => x.month === m && x.species_group === sp,
            );
            return r ? +r.patients : 0;
          });

        // New vs existing
        const nveMonths = newVsExistingMoM.map((r) => {
          const [y, mo] = r.month.split("-");
          return (
            [
              "",
              "Jan",
              "Feb",
              "Mar",
              "Apr",
              "May",
              "Jun",
              "Jul",
              "Aug",
              "Sep",
              "Oct",
              "Nov",
              "Dec",
            ][parseInt(mo)] +
            " " +
            y.slice(2)
          );
        });
        const newPats = newVsExistingMoM.map((r) => +r.new_patients);
        const retPats = newVsExistingMoM.map((r) => +r.returning_patients);
        const newRevs = newVsExistingMoM.map((r) => Math.round(+r.new_revenue));
        const retRevs = newVsExistingMoM.map((r) =>
          Math.round(+r.returning_revenue),
        );

        // Sub-category top 20
        const subCats = subCatBreakdown.slice(0, 20);
        const subLabels = subCats.map((r) =>
          (r.sub_cat || "").length > 22
            ? (r.sub_cat || "").slice(0, 20) + "…"
            : r.sub_cat || "",
        );
        const subRevs = subCats.map((r) => Math.round(+r.revenue));
        const subCols = [
          "#4285f4",
          "#34a853",
          "#fbbc04",
          "#ea4335",
          "#9c27b0",
          "#ff6d00",
          "#00bcd4",
          "#607d8b",
          "#e91e63",
          "#009688",
          "#3f51b5",
          "#ff5722",
          "#795548",
          "#9e9e9e",
          "#03a9f4",
          "#8bc34a",
          "#ffc107",
          "#673ab7",
          "#f44336",
          "#2196f3",
        ];

        // Std category MoM (Prescription, Lab, Hospitalization, Consultation, Food)
        const catKeys = [
          "Prescription",
          "Laboratory",
          "Hospitalization",
          "Consultation",
          "Food",
          "Grooming",
        ];
        const catColors2 = [
          "#ea4335",
          "#4285f4",
          "#9c27b0",
          "#34a853",
          "#fbbc04",
          "#e91e63",
        ];
        const catMonths = [...new Set(stdCatMoM.map((r) => r.month))]
          .sort()
          .slice(-12);
        const catLabels2 = catMonths.map((m) => {
          const [y, mo] = m.split("-");
          return (
            [
              "",
              "Jan",
              "Feb",
              "Mar",
              "Apr",
              "May",
              "Jun",
              "Jul",
              "Aug",
              "Sep",
              "Oct",
              "Nov",
              "Dec",
            ][parseInt(mo)] +
            " " +
            y.slice(2)
          );
        });
        const catDatasets = catKeys.map((cat, ci) => ({
          label: cat,
          data: catMonths.map((m) => {
            const r = stdCatMoM.find(
              (x) => x.month === m && x.category === cat,
            );
            return r ? Math.round(+r.revenue) : 0;
          }),
          color: catColors2[ci],
        }));

        // Disease / ailment trends — medical sub-cats from the period
        const medicalCats = subCatBreakdown
          .filter((r) =>
            ["Laboratory", "Hospitalization", "Consultation"].includes(
              r.category,
            ),
          )
          .slice(0, 12);
        const ailLabels = medicalCats.map((r) =>
          (r.sub_cat || "").length > 26
            ? (r.sub_cat || "").slice(0, 24) + "…"
            : r.sub_cat || "",
        );
        const ailRevs = medicalCats.map((r) => Math.round(+r.revenue));

        const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AllPets Board Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#060b14;color:#e2e8f0;height:100vh;overflow:hidden}
.deck{width:100%;height:100vh;position:relative}
.slide{display:none;width:100%;height:100vh;padding:28px 36px;overflow:auto;flex-direction:column}
.slide.active{display:flex}
.slide-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #1e3352}
.slide-title{font-size:22px;font-weight:900;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.5px}
.slide-sub{font-size:11px;color:#475569;margin-top:4px}
.brand{text-align:right;font-size:11px;color:#334155}
.brand strong{color:#60a5fa;display:block;font-size:13px}
.kpis{display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.kc{flex:1;min-width:120px;background:linear-gradient(145deg,#111d35,#0d1626);border:1px solid #1e3352;border-radius:12px;padding:14px 16px;position:relative}
.kc::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--a,#3b82f6);border-radius:12px 12px 0 0}
.kc-l{font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.kc-v{font-size:20px;font-weight:900;color:#f1f5f9;letter-spacing:-.5px}
.kc-s{font-size:10px;color:#334155;margin-top:3px}
.badge{display:inline-flex;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;margin-top:4px}
.up{background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.2)}
.dn{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.2)}
.charts-row{display:flex;gap:14px;flex:1;min-height:0}
.chart-box{flex:1;background:linear-gradient(145deg,#111d35,#0d1626);border:1px solid #1e3352;border-radius:14px;padding:16px;display:flex;flex-direction:column;min-height:0}
.chart-box.wide{flex:2}
.chart-box.narrow{flex:1}
.ch-title{font-size:10px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.9px;margin-bottom:10px}
.ch-wrap{position:relative;flex:1;min-height:0}
.nav{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;background:rgba(6,11,20,.9);border:1px solid #1e3352;border-radius:40px;padding:8px 20px;backdrop-filter:blur(8px);z-index:100}
.nav-btn{background:linear-gradient(135deg,#1e3a5f,#0f2541);border:1px solid #2d5a8e;color:#93c5fd;font-size:12px;font-weight:700;padding:6px 18px;border-radius:20px;cursor:pointer;transition:all .2s}
.nav-btn:hover{background:linear-gradient(135deg,#2d5a8e,#1e3a5f);color:#bfdbfe}
.nav-btn:disabled{opacity:.3;cursor:not-allowed}
.nav-counter{font-size:12px;color:#475569;font-weight:600;min-width:40px;text-align:center}
.nav-dots{display:flex;gap:6px}
.dot{width:6px;height:6px;border-radius:50%;background:#1e3352;cursor:pointer;transition:background .2s}
.dot.active{background:#3b82f6}
table.tbl{width:100%;border-collapse:collapse;font-size:11px}
table.tbl th{background:#0d1626;color:#64748b;text-transform:uppercase;letter-spacing:.6px;padding:6px 8px;text-align:left;font-size:9px;font-weight:700}
table.tbl td{padding:6px 8px;border-bottom:1px solid #0f1e35;color:#94a3b8}
table.tbl td:last-child{text-align:right;color:#f1f5f9;font-weight:700}
table.tbl tr:last-child td{border-bottom:none}
</style></head>
<body>
<div class="deck">

<!-- ══ SLIDE 1: EXECUTIVE SUMMARY ══ -->
<div class="slide active" id="s1">
  <div class="slide-hdr">
    <div>
      <div class="slide-title">🏥 AllPets Clinic — Board Meeting</div>
      <div class="slide-sub">Performance Review · ${from_date} to ${to_date}</div>
    </div>
    <div class="brand"><strong>AllPets Clinic & Beyond</strong>Hyderabad · Powered by VetBuddy MCP</div>
  </div>
  <div class="kpis">
    <div class="kc" style="--a:#3b82f6">
      <div class="kc-l">Total Revenue</div>
      <div class="kc-v">${INR(kpi.revenue)}</div>
      <div class="kc-s">${kpi.invoices || 0} invoices · ${kpi.active_days || 0} active days</div>
      <span class="badge ${yoyUp ? "up" : "dn"}">${yoyUp ? "▲" : "▼"} ${yoyPct} vs last year</span>
    </div>
    <div class="kc" style="--a:#10b981">
      <div class="kc-l">Avg / Invoice</div>
      <div class="kc-v">${INR(kpi.invoices ? +kpi.revenue / +kpi.invoices : 0)}</div>
      <div class="kc-s">Per visit revenue</div>
    </div>
    <div class="kc" style="--a:#f59e0b">
      <div class="kc-l">Prior Year Revenue</div>
      <div class="kc-v">${INR(prevKpi.revenue)}</div>
      <div class="kc-s">${prevKpi.invoices || 0} invoices same period</div>
    </div>
    <div class="kc" style="--a:#8b5cf6">
      <div class="kc-l">Top Sub-Category</div>
      <div class="kc-v" style="font-size:14px">${subCats[0]?.sub_cat || "—"}</div>
      <div class="kc-s">${INR(subCats[0]?.revenue)} · ${subCats[0]?.invoices || 0} inv</div>
    </div>
    <div class="kc" style="--a:#ec4899">
      <div class="kc-l">Daily Avg Revenue</div>
      <div class="kc-v">${INR(kpi.active_days ? +kpi.revenue / +kpi.active_days : 0)}</div>
      <div class="kc-s">Per operating day</div>
    </div>
  </div>
  <div class="charts-row">
    <div class="chart-box wide">
      <div class="ch-title">📈 Revenue Trend — Last 12 Months</div>
      <div class="ch-wrap"><canvas id="c1a"></canvas></div>
    </div>
    <div class="chart-box narrow">
      <div class="ch-title">🏷️ Top Sub-Categories (Period)</div>
      <table class="tbl">
        <tr><th>#</th><th>Sub-Category</th><th>Revenue</th></tr>
        ${subCats
          .slice(0, 10)
          .map(
            (r, i) =>
              `<tr><td style="color:#475569">${i + 1}</td><td>${r.sub_cat || "—"}</td><td>${INR(r.revenue)}</td></tr>`,
          )
          .join("")}
      </table>
    </div>
  </div>
</div>

<!-- ══ SLIDE 2: REVENUE YEAR-ON-YEAR ══ -->
<div class="slide" id="s2">
  <div class="slide-hdr">
    <div>
      <div class="slide-title">📊 Business Growth — Year on Year</div>
      <div class="slide-sub">24-month revenue trend with prior-year comparison</div>
    </div>
    <div class="brand"><strong>AllPets Clinic & Beyond</strong>2 / 7</div>
  </div>
  <div class="kpis">
    <div class="kc" style="--a:#3b82f6">
      <div class="kc-l">Current 12M Revenue</div>
      <div class="kc-v">${INR(curr12Rev.reduce((a, b) => a + b, 0))}</div>
      <span class="badge ${yoyUp ? "up" : "dn"}">${yoyUp ? "▲" : "▼"} ${Math.abs(parseFloat(yoyPct)).toFixed(1)}% YoY</span>
    </div>
    <div class="kc" style="--a:#64748b">
      <div class="kc-l">Prior 12M Revenue</div>
      <div class="kc-v">${INR(prev12Rev.reduce((a, b) => a + b, 0))}</div>
      <div class="kc-s">Same period last year</div>
    </div>
    <div class="kc" style="--a:#10b981">
      <div class="kc-l">Best Month</div>
      <div class="kc-v" style="font-size:14px">${curr12Labels[curr12Rev.indexOf(Math.max(...curr12Rev))] || "—"}</div>
      <div class="kc-s">${INR(Math.max(...curr12Rev))}</div>
    </div>
  </div>
  <div class="charts-row">
    <div class="chart-box wide">
      <div class="ch-title">📈 Monthly Revenue — Current vs Prior Year</div>
      <div class="ch-wrap"><canvas id="c2a"></canvas></div>
    </div>
    <div class="chart-box narrow">
      <div class="ch-title">📋 Monthly Breakdown</div>
      <table class="tbl">
        <tr><th>Month</th><th>Revenue</th><th>Invoices</th></tr>
        ${last12Months
          .slice(-8)
          .map(
            (m) => `<tr>
            <td>${curr12Labels[last12Months.indexOf(m)]}</td>
            <td>${INR(revByMonth[m] || 0)}</td>
            <td>${invByMonth[m] || 0}</td>
          </tr>`,
          )
          .join("")}
      </table>
    </div>
  </div>
</div>

<!-- ══ SLIDE 3: SPECIES ANALYSIS ══ -->
<div class="slide" id="s3">
  <div class="slide-hdr">
    <div>
      <div class="slide-title">🐾 Dog vs Cat vs Exotic — Growth MoM</div>
      <div class="slide-sub">Revenue and unique pet parent count per species per month</div>
    </div>
    <div class="brand"><strong>AllPets Clinic & Beyond</strong>3 / 7</div>
  </div>
  <div class="kpis">
    ${["Canine", "Feline", "Others"]
      .map((sp, si) => {
        const spData = speciesMoM.filter((r) => r.species_group === sp);
        const spRev = spData.reduce((a, r) => a + +r.revenue, 0);
        const spPat = spData.reduce((a, r) => a + +r.patients, 0);
        const icons = ["🐕", "🐈", "🦜"];
        const colors = ["#3b82f6", "#a78bfa", "#10b981"];
        return `<div class="kc" style="--a:${colors[si]}">
        <div class="kc-l">${icons[si]} ${sp === "Canine" ? "Dogs" : sp === "Feline" ? "Cats" : "Exotics"}</div>
        <div class="kc-v">${INR(spRev)}</div>
        <div class="kc-s">${spPat} unique pet parents</div>
      </div>`;
      })
      .join("")}
  </div>
  <div class="charts-row">
    <div class="chart-box wide">
      <div class="ch-title">📊 Revenue by Species — Month on Month</div>
      <div class="ch-wrap"><canvas id="c3a"></canvas></div>
    </div>
    <div class="chart-box narrow">
      <div class="ch-title">👥 Pet Parent Count MoM</div>
      <div class="ch-wrap"><canvas id="c3b"></canvas></div>
    </div>
  </div>
</div>

<!-- ══ SLIDE 4: NEW VS EXISTING ══ -->
<div class="slide" id="s4">
  <div class="slide-hdr">
    <div>
      <div class="slide-title">👥 New vs Existing Pet Parents</div>
      <div class="slide-sub">Acquisition vs retention — patient growth and revenue contribution</div>
    </div>
    <div class="brand"><strong>AllPets Clinic & Beyond</strong>4 / 7</div>
  </div>
  <div class="kpis">
    <div class="kc" style="--a:#10b981">
      <div class="kc-l">Total New (12M)</div>
      <div class="kc-v">${newPats.reduce((a, b) => a + b, 0)}</div>
      <div class="kc-s">${INR(newRevs.reduce((a, b) => a + b, 0))} revenue</div>
    </div>
    <div class="kc" style="--a:#3b82f6">
      <div class="kc-l">Total Returning (12M)</div>
      <div class="kc-v">${retPats.reduce((a, b) => a + b, 0)}</div>
      <div class="kc-s">${INR(retRevs.reduce((a, b) => a + b, 0))} revenue</div>
    </div>
    <div class="kc" style="--a:#f59e0b">
      <div class="kc-l">Avg New/Month</div>
      <div class="kc-v">${Math.round(newPats.reduce((a, b) => a + b, 0) / Math.max(newPats.length, 1))}</div>
      <div class="kc-s">New patient acquisitions</div>
    </div>
    <div class="kc" style="--a:#8b5cf6">
      <div class="kc-l">Retention Revenue %</div>
      <div class="kc-v">${(() => {
        const t =
          retRevs.reduce((a, b) => a + b, 0) +
          newRevs.reduce((a, b) => a + b, 0);
        return t
          ? ((retRevs.reduce((a, b) => a + b, 0) / t) * 100).toFixed(0) + "%"
          : "—";
      })()}</div>
      <div class="kc-s">Existing client contribution</div>
    </div>
  </div>
  <div class="charts-row">
    <div class="chart-box wide">
      <div class="ch-title">📊 New vs Returning Patients — Monthly Count</div>
      <div class="ch-wrap"><canvas id="c4a"></canvas></div>
    </div>
    <div class="chart-box narrow">
      <div class="ch-title">💰 New vs Returning — Revenue Contribution</div>
      <div class="ch-wrap"><canvas id="c4b"></canvas></div>
    </div>
  </div>
</div>

<!-- ══ SLIDE 5: SUB-CATEGORY BREAKDOWN ══ -->
<div class="slide" id="s5">
  <div class="slide-hdr">
    <div>
      <div class="slide-title">🏷️ Sub-Category Revenue Breakdown</div>
      <div class="slide-sub">Foods · Pharmacy · Prescription · Surgery · Lab · Consultation — detailed split</div>
    </div>
    <div class="brand"><strong>AllPets Clinic & Beyond</strong>5 / 7</div>
  </div>
  <div class="charts-row">
    <div class="chart-box wide">
      <div class="ch-title">📊 Top Sub-Categories by Revenue</div>
      <div class="ch-wrap"><canvas id="c5a"></canvas></div>
    </div>
    <div class="chart-box narrow">
      <div class="ch-title">📋 Full Sub-Category Detail</div>
      <table class="tbl">
        <tr><th>Sub-Category</th><th>Category</th><th>Revenue</th></tr>
        ${subCats
          .slice(0, 15)
          .map(
            (r) => `<tr>
            <td>${(r.sub_cat || "").length > 18 ? (r.sub_cat || "").slice(0, 16) + "…" : r.sub_cat || "—"}</td>
            <td style="color:#64748b;font-size:9px">${r.category || ""}</td>
            <td>${INR(r.revenue)}</td>
          </tr>`,
          )
          .join("")}
      </table>
    </div>
  </div>
</div>

<!-- ══ SLIDE 6: CLINICAL FUNCTION MOM ══ -->
<div class="slide" id="s6">
  <div class="slide-hdr">
    <div>
      <div class="slide-title">🔬 Clinical Function Performance — MoM</div>
      <div class="slide-sub">Prescription · Laboratory · Hospitalization · Consultation · Food — month on month</div>
    </div>
    <div class="brand"><strong>AllPets Clinic & Beyond</strong>6 / 7</div>
  </div>
  <div class="kpis">
    ${catKeys
      .slice(0, 5)
      .map((cat, ci) => {
        const catTotal = stdCatMoM
          .filter((r) => r.category === cat)
          .reduce((a, r) => a + +r.revenue, 0);
        return `<div class="kc" style="--a:${catColors2[ci]}">
        <div class="kc-l">${cat}</div>
        <div class="kc-v" style="font-size:14px">${INR(catTotal)}</div>
        <div class="kc-s">Last 12 months total</div>
      </div>`;
      })
      .join("")}
  </div>
  <div class="charts-row">
    <div class="chart-box" style="flex:1">
      <div class="ch-title">📈 Category Revenue — Month on Month</div>
      <div class="ch-wrap"><canvas id="c6a"></canvas></div>
    </div>
  </div>
</div>

<!-- ══ SLIDE 7: DISEASE & AILMENT TRENDS ══ -->
<div class="slide" id="s7">
  <div class="slide-hdr">
    <div>
      <div class="slide-title">🏥 Common Ailment & Disease Trends</div>
      <div class="slide-sub">Clinical treatment breakdown from invoice data — Lab · Hospitalization · Consultation categories</div>
    </div>
    <div class="brand"><strong>AllPets Clinic & Beyond</strong>7 / 7</div>
  </div>
  <div class="charts-row">
    <div class="chart-box narrow">
      <div class="ch-title">🔬 Clinical Treatment Distribution</div>
      <div class="ch-wrap"><canvas id="c7a"></canvas></div>
    </div>
    <div class="chart-box wide">
      <div class="ch-title">📋 Treatment & Ailment Hierarchy</div>
      <table class="tbl">
        <tr><th>#</th><th>Treatment / Ailment</th><th>Category</th><th>Invoices</th><th>Revenue</th></tr>
        ${subCatBreakdown
          .filter((r) =>
            ["Laboratory", "Hospitalization", "Consultation"].includes(
              r.category,
            ),
          )
          .slice(0, 15)
          .map(
            (r, i) => `<tr>
            <td style="color:#475569">${i + 1}</td>
            <td>${r.sub_cat || "—"}</td>
            <td style="color:#64748b;font-size:9px">${r.category}</td>
            <td style="text-align:center">${r.invoices || 0}</td>
            <td>${INR(r.revenue)}</td>
          </tr>`,
          )
          .join("")}
      </table>
    </div>
  </div>
</div>

</div><!-- end deck -->

<!-- Navigation -->
<div class="nav">
  <button class="nav-btn" id="prevBtn" onclick="navigate(-1)" disabled>◀ Prev</button>
  <div class="nav-dots" id="dots"></div>
  <span class="nav-counter" id="counter">1 / 7</span>
  <button class="nav-btn" id="nextBtn" onclick="navigate(1)">Next ▶</button>
</div>

<script>
Chart.defaults.color='#64748b';
Chart.defaults.borderColor='#0f1e35';
Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
Chart.defaults.font.size=10;

const slides=document.querySelectorAll('.slide');
const totalSlides=slides.length;
let current=0;
const dotsEl=document.getElementById('dots');
for(let i=0;i<totalSlides;i++){const d=document.createElement('div');d.className='dot'+(i===0?' active':'');d.onclick=()=>goTo(i);dotsEl.appendChild(d);}
function navigate(dir){goTo(current+dir)}
function goTo(n){
  slides[current].classList.remove('active');
  dotsEl.children[current].classList.remove('active');
  current=Math.max(0,Math.min(n,totalSlides-1));
  slides[current].classList.add('active');
  dotsEl.children[current].classList.add('active');
  document.getElementById('counter').textContent=(current+1)+' / '+totalSlides;
  document.getElementById('prevBtn').disabled=current===0;
  document.getElementById('nextBtn').disabled=current===totalSlides-1;
}
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowDown')navigate(1);if(e.key==='ArrowLeft'||e.key==='ArrowUp')navigate(-1);});

const fmtK=v=>v>=1e5?'₹'+(v/1e5).toFixed(1)+'L':v>=1e3?'₹'+(v/1e3).toFixed(0)+'K':'₹'+Math.round(v);
const inr=v=>'₹'+Math.round(v||0).toLocaleString('en-IN');

// Slide 1: Revenue trend line
new Chart(document.getElementById('c1a'),{type:'line',data:{labels:${J(curr12Labels)},datasets:[{label:'Revenue',data:${J(curr12Rev)},borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.1)',fill:true,tension:.3,pointRadius:3,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},datalabels:{display:false}},scales:{y:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},x:{grid:{display:false}}}}});

// Slide 2: YoY grouped bar
new Chart(document.getElementById('c2a'),{type:'bar',data:{labels:${J(curr12Labels)},datasets:[{label:'Prior Year',data:${J(prev12Rev)},backgroundColor:'rgba(71,85,105,.4)',borderColor:'#475569',borderWidth:1,borderRadius:3},{label:'Current Year',data:${J(curr12Rev)},backgroundColor:'rgba(59,130,246,.65)',borderColor:'#3b82f6',borderWidth:1,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:10}},datalabels:{display:false}},scales:{y:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},x:{grid:{display:false},ticks:{font:{size:9}}}}}});

// Slide 3a: Species revenue bar
new Chart(document.getElementById('c3a'),{type:'bar',data:{labels:${J(spLabels)},datasets:[{label:'🐕 Dog',data:${J(getSpRev("Canine"))},backgroundColor:'rgba(59,130,246,.65)',borderColor:'#3b82f6',borderWidth:1,borderRadius:3},{label:'🐈 Cat',data:${J(getSpRev("Feline"))},backgroundColor:'rgba(167,139,250,.65)',borderColor:'#a78bfa',borderWidth:1,borderRadius:3},{label:'🦜 Exotic',data:${J(getSpRev("Others"))},backgroundColor:'rgba(16,185,129,.65)',borderColor:'#10b981',borderWidth:1,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:8}},datalabels:{display:false}},scales:{y:{grid:{color:'#0f1e35'},ticks:{callback:fmtK},stacked:false},x:{grid:{display:false},ticks:{font:{size:9}}}}}});

// Slide 3b: Pet parent count line
new Chart(document.getElementById('c3b'),{type:'line',data:{labels:${J(spLabels)},datasets:[{label:'Dog',data:${J(getSpPat("Canine"))},borderColor:'#3b82f6',tension:.3,pointRadius:3,borderWidth:2},{label:'Cat',data:${J(getSpPat("Feline"))},borderColor:'#a78bfa',tension:.3,pointRadius:3,borderWidth:2},{label:'Exotic',data:${J(getSpPat("Others"))},borderColor:'#10b981',tension:.3,pointRadius:3,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6}},datalabels:{display:false}},scales:{y:{grid:{color:'#0f1e35'}},x:{grid:{display:false},ticks:{font:{size:9}}}}}});

// Slide 4a: New vs returning stacked bar
new Chart(document.getElementById('c4a'),{type:'bar',data:{labels:${J(nveMonths)},datasets:[{label:'New Patients',data:${J(newPats)},backgroundColor:'rgba(16,185,129,.7)',borderColor:'#10b981',borderWidth:1,borderRadius:3},{label:'Returning Patients',data:${J(retPats)},backgroundColor:'rgba(59,130,246,.65)',borderColor:'#3b82f6',borderWidth:1,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:8}},datalabels:{display:false}},scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:9}}},y:{stacked:true,grid:{color:'#0f1e35'}}}}});

// Slide 4b: Revenue contribution stacked bar
new Chart(document.getElementById('c4b'),{type:'bar',data:{labels:${J(nveMonths)},datasets:[{label:'New Revenue',data:${J(newRevs)},backgroundColor:'rgba(16,185,129,.7)',borderColor:'#10b981',borderWidth:1,borderRadius:3},{label:'Returning Revenue',data:${J(retRevs)},backgroundColor:'rgba(59,130,246,.65)',borderColor:'#3b82f6',borderWidth:1,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6}},datalabels:{display:false}},scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:8}}},y:{stacked:true,grid:{color:'#0f1e35'},ticks:{callback:fmtK}}}}});

// Slide 5: Sub-category horizontal bar
new Chart(document.getElementById('c5a'),{type:'bar',data:{labels:${J(subLabels)},datasets:[{data:${J(subRevs)},backgroundColor:${J(subCols.slice(0, subCats.length))},borderWidth:0,borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},datalabels:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)}}},scales:{x:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},y:{grid:{display:false},ticks:{font:{size:9}}}}}});

// Slide 6: Category MoM multi-line
new Chart(document.getElementById('c6a'),{type:'line',data:{labels:${J(catLabels2)},datasets:${J(catDatasets.map((d) => ({ label: d.label, data: d.data, borderColor: d.color, backgroundColor: "transparent", tension: 0.3, pointRadius: 3, borderWidth: 2 })))}},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:8}},datalabels:{display:false}},scales:{y:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},x:{grid:{display:false},ticks:{font:{size:9}}}}}});

// Slide 7: Ailment doughnut
new Chart(document.getElementById('c7a'),{type:'doughnut',data:{labels:${J(ailLabels)},datasets:[{data:${J(ailRevs)},backgroundColor:${J(subCols.slice(0, ailLabels.length))},borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'50%',plugins:{legend:{position:'bottom',labels:{color:'#94a3b8',boxWidth:9,padding:8,font:{size:9}}},datalabels:{display:false}}}});
<\/script></body></html>`;

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `urn:allpets:board-report:${Date.now()}`,
                mimeType: "text/html",
                text: html,
              },
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
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
