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
  const J = (v) => JSON.stringify(v);

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

  const kpiCard = (label, value, sub, accent, badgeTxt, badgeUp) =>
    `<div class="kpi" style="--a:${accent}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-val">${value}</div>
      <div class="kpi-sub">${sub}</div>
      ${badgeTxt ? `<span class="badge ${badgeUp === true ? "up" : badgeUp === false ? "dn" : "neu"}">${badgeTxt}</span>` : ""}
    </div>`;

  const oppRow = (label, prev, curr, chgObj) =>
    `<div class="orow">
      <span class="olabel">${label}</span>
      <span class="oprev">${prev}</span>
      <span class="oarr">${chgObj.up === true ? "▲" : chgObj.up === false ? "▼" : "→"}</span>
      <span class="ocurr">${curr}</span>
      <span class="badge ${chgObj.up === true ? "up" : chgObj.up === false ? "dn" : "neu"}" style="font-size:10px">${chgObj.txt}</span>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AllPets Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#080e1a;color:#e2e8f0;padding:20px;min-height:100vh}
h1{font-size:22px;font-weight:800;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid #1e293b}
.hdr-meta{text-align:right;font-size:12px;color:#475569}
.hdr-meta strong{color:#94a3b8}
.sec{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin:18px 0 10px;display:flex;align-items:center;gap:8px}
.sec::after{content:'';flex:1;height:1px;background:#1e293b}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:4px}
.kpi{background:linear-gradient(145deg,#1a2540,#111827);border:1px solid #2d3f55;border-radius:14px;padding:16px 14px;position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--a);border-radius:14px 14px 0 0}
.kpi-label{font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px}
.kpi-val{font-size:20px;font-weight:800;color:#f1f5f9;letter-spacing:-.5px;line-height:1;margin-bottom:4px}
.kpi-sub{font-size:11px;color:#475569;margin-bottom:6px}
.badge{display:inline-block;padding:2px 7px;border-radius:20px;font-size:11px;font-weight:600}
.badge.up{background:rgba(16,185,129,.15);color:#10b981}
.badge.dn{background:rgba(239,68,68,.15);color:#ef4444}
.badge.neu{background:rgba(100,116,139,.15);color:#94a3b8}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.grid21{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:14px}
.card{background:linear-gradient(145deg,#1a2540,#111827);border:1px solid #2d3f55;border-radius:14px;padding:18px}
.ctitle{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px}
.ch-sm{position:relative;height:190px}
.ch-md{position:relative;height:250px}
.ch-lg{position:relative;height:300px}
.leg{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.leg-i{display:flex;align-items:center;gap:5px;font-size:11px;color:#94a3b8}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.srow{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #1a2540}
.srow:last-child{border-bottom:none}
.slabel{font-size:12px;color:#64748b}
.sval{font-size:13px;font-weight:700;color:#e2e8f0}
.orow{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #1a2540}
.orow:last-child{border-bottom:none}
.olabel{font-size:11px;color:#64748b;width:110px;flex-shrink:0}
.oprev{font-size:11px;color:#475569}
.oarr{font-size:10px;color:#475569}
.ocurr{font-size:12px;font-weight:700;color:#e2e8f0;flex:1}
.alert{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;margin-bottom:5px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.15)}
.aname{font-size:11px;color:#fca5a5;flex:1;font-weight:500}
.aqty{font-size:11px;color:#ef4444;font-weight:700}
.footer{text-align:center;padding:16px 0 2px;color:#1e293b;font-size:10px}
</style></head><body>

<div class="hdr">
  <div>
    <h1>🏥 AllPets Clinic — Analytics</h1>
    <div style="font-size:12px;color:#475569;margin-top:4px">Business Intelligence · RDS-backed · Real-time sync</div>
  </div>
  <div class="hdr-meta">
    <strong>${isoToVB(fromDate)} → ${isoToVB(toDate)}</strong><br>
    ${invoiceCount} invoices &nbsp;·&nbsp; ${new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
  </div>
</div>

<div class="sec">💰 Revenue KPIs</div>
<div class="kpis">
  ${kpiCard("Total Revenue", INR(totalRevenue), `${invoiceCount} invoices`, "#3b82f6", wChg.txt + " WoW", wChg.up)}
  ${kpiCard("Collected", INR(totalCollected), "Amount received", "#10b981", collRate + "% rate", parseFloat(collRate) >= 85 ? true : parseFloat(collRate) >= 60 ? null : false)}
  ${kpiCard("Outstanding", INR(outstanding), PCT(outstanding, totalRevenue) + " of billed", "#ef4444", "", null)}
  ${kpiCard("Avg Invoice", INR(avgInv), "Per visit", "#f59e0b", "", null)}
  ${kpiCard("New Clients", String(newClients), PCT(newClients, newClients + returningClients) + " of total", "#8b5cf6", "", null)}
  ${kpiCard("Returning", String(returningClients), PCT(returningClients, newClients + returningClients) + " of total", "#ec4899", "", null)}
</div>

<div class="sec">📊 Core Breakdowns</div>
<div class="grid3">
  <div class="card">
    <div class="ctitle">🌅 Day vs Night Split</div>
    <div class="ch-sm"><canvas id="cDayNight"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#f59e0b"></div>Day — ${dayInvoices} inv · ${INR(dayRevenue)}</div>
      <div class="leg-i"><div class="dot" style="background:#6366f1"></div>Night — ${nightInvoices} inv · ${INR(nightRevenue)}</div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">🐾 Species Breakdown</div>
    <div class="ch-sm"><canvas id="cSpecies"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#3b82f6"></div>Canine ${species.Canine.visits} visits · ${INR(species.Canine.revenue)}</div>
      <div class="leg-i"><div class="dot" style="background:#8b5cf6"></div>Feline ${species.Feline.visits} visits · ${INR(species.Feline.revenue)}</div>
      <div class="leg-i"><div class="dot" style="background:#64748b"></div>Others ${species.Others.visits} visits · ${INR(species.Others.revenue)}</div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">👥 Customer Cohorts</div>
    <div class="ch-sm"><canvas id="cCustomer"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#10b981"></div>New — ${newClients} (${PCT(newClients, newClients + returningClients)})</div>
      <div class="leg-i"><div class="dot" style="background:#3b82f6"></div>Returning — ${returningClients} (${PCT(returningClients, newClients + returningClients)})</div>
    </div>
  </div>
</div>

<div class="sec">📈 Category & Sub-Category Revenue</div>
<div class="grid2">
  <div class="card">
    <div class="ctitle">Standard Category Split</div>
    <div class="ch-md"><canvas id="cCategory"></canvas></div>
  </div>
  <div class="card">
    <div class="ctitle">Sub-Category Sales — Top 12</div>
    <div class="ch-md"><canvas id="cSubCat"></canvas></div>
  </div>
</div>

<div class="sec">🎯 Opportunity Areas</div>
<div class="grid2">
  <div class="card">
    <div class="ctitle">Week over Week — Category Comparison</div>
    <div class="ch-lg"><canvas id="cWeek"></canvas></div>
    <div style="margin-top:12px">
      ${oppRow("Revenue", INR(lastWeek.rev), INR(thisWeek.rev), CHG(thisWeek.rev, lastWeek.rev))}
      ${oppRow("Invoices", String(lastWeek.inv), String(thisWeek.inv), CHG(thisWeek.inv, lastWeek.inv))}
      ${oppRow("New Clients", String(lastWeek.newC), String(thisWeek.newC), CHG(thisWeek.newC, lastWeek.newC))}
      ${oppRow("Collection", PCT(lastWeek.col, lastWeek.rev), PCT(thisWeek.col, thisWeek.rev), CHG(thisWeek.col / (lastWeek.rev || 1), lastWeek.col / (lastWeek.rev || 1)))}
    </div>
  </div>
  <div class="card">
    <div class="ctitle">Month over Month — Species Trend</div>
    <div class="ch-lg"><canvas id="cMonth"></canvas></div>
    <div style="margin-top:12px">
      ${oppRow("Revenue", INR(lastMonth.rev), INR(thisMonth.rev), mChg)}
      ${oppRow("Invoices", String(lastMonth.inv), String(thisMonth.inv), CHG(thisMonth.inv, lastMonth.inv))}
      ${oppRow("New Clients", String(lastMonth.newC), String(thisMonth.newC), CHG(thisMonth.newC, lastMonth.newC))}
    </div>
  </div>
</div>

<div class="sec">💊 Revenue Type & 💳 Payments</div>
<div class="grid2">
  <div class="card">
    <div class="ctitle">Pharmacy vs Service Split</div>
    <div class="ch-sm"><canvas id="cPharm"></canvas></div>
    <div class="leg" style="margin-top:10px">
      <div class="leg-i"><div class="dot" style="background:#ef4444"></div>Pharmacy — ${INR(revenueSplit?.Pharmacy || 0)} · ${invoiceSplit?.pharmacy || 0} invoices</div>
      <div class="leg-i"><div class="dot" style="background:#3b82f6"></div>Service — ${INR(revenueSplit?.Service || 0)} · ${invoiceSplit?.service || 0} invoices</div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">Payment Methods</div>
    <div class="ch-sm"><canvas id="cPayments"></canvas></div>
    ${returnedPayments?.txns > 0 ? `<div style="margin-top:10px;padding:7px 12px;background:rgba(239,68,68,.08);border-radius:8px;font-size:11px;color:#fca5a5">⚠️ Returned: ${returnedPayments.txns} txns · ${INR(returnedPayments.value)}</div>` : ""}
  </div>
</div>

${
  stock
    ? `
<div class="sec">📦 Inventory</div>
<div class="grid21">
  <div class="card">
    <div class="ctitle">Inventory Status & Valuation</div>
    <div style="display:flex;gap:20px;align-items:flex-start">
      <div style="width:160px;flex-shrink:0;position:relative;height:160px"><canvas id="cInv"></canvas></div>
      <div style="flex:1">
        <div class="srow"><span class="slabel">Total SKUs</span><span class="sval">${stock.totalItems}</span></div>
        <div class="srow"><span class="slabel">Closing Valuation</span><span class="sval">${INR(stock.valuation)}</span></div>
        <div class="srow"><span class="slabel" style="color:#10b981">✅ Adequate</span><span class="sval" style="color:#10b981">${stock.adequateCount} &nbsp;<small style="color:#475569">${PCT(stock.adequateCount, stock.totalItems)}</small></span></div>
        <div class="srow"><span class="slabel" style="color:#f59e0b">🟡 Low</span><span class="sval" style="color:#f59e0b">${stock.lowCount} &nbsp;<small style="color:#475569">${PCT(stock.lowCount, stock.totalItems)}</small></span></div>
        <div class="srow"><span class="slabel" style="color:#ef4444">🔴 Out</span><span class="sval" style="color:#ef4444">${stock.outCount} &nbsp;<small style="color:#475569">${PCT(stock.outCount, stock.totalItems)}</small></span></div>
        <div class="srow"><span class="slabel" style="color:#fbbf24">⚠️ Negative</span><span class="sval" style="color:#fbbf24">${stock.negativeCount} &nbsp;<small style="color:#475569">${PCT(stock.negativeCount, stock.totalItems)}</small></span></div>
      </div>
    </div>
    ${
      stock.subCatStock?.length > 0
        ? `
    <div class="ctitle" style="margin-top:16px">Sub-Category Stock Valuation</div>
    <div style="position:relative;height:200px"><canvas id="cStockSub"></canvas></div>`
        : ""
    }
  </div>
  <div class="card">
    <div class="ctitle">⚠️ System vs Physical Mismatch</div>
    ${
      stock.negativeItems?.length > 0
        ? stock.negativeItems
            .slice(0, 10)
            .map(
              (i) =>
                `<div class="alert"><span class="aname">${i.name}</span><span class="aqty">${i.onhand_qty}</span></div>`,
            )
            .join("")
        : `<div style="font-size:12px;color:#10b981;padding:12px 0">✅ No mismatches detected</div>`
    }
    ${
      stock.outItems?.length > 0
        ? `
    <div class="ctitle" style="margin-top:14px">🔴 Out of Stock</div>
    ${stock.outItems
      .slice(0, 6)
      .map(
        (i) =>
          `<div style="font-size:11px;color:#94a3b8;padding:4px 0;border-bottom:1px solid #1a2540">• ${i.name}</div>`,
      )
      .join("")}`
        : ""
    }
    ${
      stock.lowItems?.length > 0
        ? `
    <div class="ctitle" style="margin-top:14px">🟡 Low Stock</div>
    ${stock.lowItems
      .slice(0, 6)
      .map(
        (i) =>
          `<div style="font-size:11px;color:#94a3b8;padding:4px 0;border-bottom:1px solid #1a2540">• ${i.name} &nbsp;<span style="color:#f59e0b">${i.onhand_qty}/${i.threshold_qty}</span></div>`,
      )
      .join("")}`
        : ""
    }
  </div>
</div>`
    : ""
}

<div class="footer">AllPets VetBuddy · RDS Analytics · ${new Date().toISOString()}</div>

<script>
Chart.defaults.color='#64748b';
Chart.defaults.borderColor='#1e293b';
Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
Chart.defaults.font.size=11;

const inr = v => '₹'+Math.round(v||0).toLocaleString('en-IN');

new Chart(document.getElementById('cDayNight'),{type:'doughnut',data:{labels:['Day','Night'],datasets:[{data:[${dayInvoices},${nightInvoices}],backgroundColor:['#f59e0b','#6366f1'],borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+ctx.label+': '+ctx.raw+' invoices'}}}}});

new Chart(document.getElementById('cSpecies'),{type:'doughnut',data:{labels:['Canine','Feline','Others'],datasets:[{data:[${Math.round(species.Canine.revenue)},${Math.round(species.Feline.revenue)},${Math.round(species.Others.revenue)}],backgroundColor:['#3b82f6','#8b5cf6','#64748b'],borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+ctx.label+': '+inr(ctx.raw)}}}}});

new Chart(document.getElementById('cCustomer'),{type:'doughnut',data:{labels:['New','Returning'],datasets:[{data:[${newClients},${returningClients}],backgroundColor:['#10b981','#3b82f6'],borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+ctx.label+': '+ctx.raw}}}}});

new Chart(document.getElementById('cCategory'),{type:'doughnut',data:{labels:${J(catLabels)},datasets:[{data:${J(catVals)},backgroundColor:${J(catColors)},borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{display:true,position:'right',labels:{padding:12,boxWidth:10,color:'#94a3b8',borderRadius:3}},tooltip:{callbacks:{label:ctx=>' '+ctx.label+': '+inr(ctx.raw)+' ('+((ctx.raw/${Math.round(totalRevenue) || 1})*100).toFixed(1)+'%)'}}}}});

new Chart(document.getElementById('cSubCat'),{type:'bar',data:{labels:${J(subTop.map((s) => (s.name.length > 22 ? s.name.slice(0, 20) + "…" : s.name)))},datasets:[{data:${J(subTop.map((s) => Math.round(s.revenue)))},backgroundColor:'rgba(59,130,246,0.65)',borderColor:'#3b82f6',borderWidth:1,borderRadius:4,hoverBackgroundColor:'#3b82f6'}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)}}},scales:{x:{grid:{color:'#1a2540'},ticks:{callback:v=>v>=100000?'₹'+(v/100000).toFixed(1)+'L':v>=1000?'₹'+(v/1000).toFixed(0)+'K':v}},y:{grid:{display:false},ticks:{font:{size:10}}}}}});

new Chart(document.getElementById('cWeek'),{type:'bar',data:{labels:${J(CAT_KEYS)},datasets:[{label:'Last Week',data:${J(CAT_KEYS.map((k) => Math.round(lastWeek.cats[k] || 0)))},backgroundColor:'rgba(100,116,139,0.4)',borderColor:'#64748b',borderWidth:1,borderRadius:4},{label:'This Week',data:${J(CAT_KEYS.map((k) => Math.round(thisWeek.cats[k] || 0)))},backgroundColor:'rgba(59,130,246,0.65)',borderColor:'#3b82f6',borderWidth:1,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:10}},tooltip:{callbacks:{label:ctx=>' '+ctx.dataset.label+': '+inr(ctx.raw)}}},scales:{x:{grid:{display:false},ticks:{font:{size:9}}},y:{grid:{color:'#1a2540'},ticks:{callback:v=>v>=100000?'₹'+(v/100000).toFixed(1)+'L':v>=1000?'₹'+(v/1000).toFixed(0)+'K':v}}}}});

new Chart(document.getElementById('cMonth'),{type:'bar',data:{labels:['Canine','Feline','Others'],datasets:[{label:'Last Month',data:[${Math.round(lastMonth.spRevs.Canine || 0)},${Math.round(lastMonth.spRevs.Feline || 0)},${Math.round(lastMonth.spRevs.Others || 0)}],backgroundColor:'rgba(100,116,139,0.4)',borderColor:'#64748b',borderWidth:1,borderRadius:4},{label:'This Month',data:[${Math.round(thisMonth.spRevs.Canine || 0)},${Math.round(thisMonth.spRevs.Feline || 0)},${Math.round(thisMonth.spRevs.Others || 0)}],backgroundColor:['rgba(59,130,246,0.65)','rgba(139,92,246,0.65)','rgba(100,116,139,0.65)'],borderColor:['#3b82f6','#8b5cf6','#64748b'],borderWidth:1,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:10}},tooltip:{callbacks:{label:ctx=>' '+ctx.dataset.label+': '+inr(ctx.raw)}}},scales:{x:{grid:{display:false}},y:{grid:{color:'#1a2540'},ticks:{callback:v=>v>=100000?'₹'+(v/100000).toFixed(1)+'L':v>=1000?'₹'+(v/1000).toFixed(0)+'K':v}}}}});

new Chart(document.getElementById('cPharm'),{type:'doughnut',data:{labels:['Pharmacy','Service'],datasets:[{data:[${Math.round(revenueSplit?.Pharmacy || 0)},${Math.round(revenueSplit?.Service || 0)}],backgroundColor:['#ef4444','#3b82f6'],borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+ctx.label+': '+inr(ctx.raw)}}}}});

new Chart(document.getElementById('cPayments'),{type:'bar',data:{labels:${J(pmts.map((r) => r.method))},datasets:[{data:${J(pmts.map((r) => Math.round(r.value)))},backgroundColor:${J(pmts.map((_, i) => pmtColors[i % pmtColors.length]))},borderRadius:4,borderWidth:0}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)}}},scales:{x:{grid:{color:'#1a2540'},ticks:{callback:v=>v>=100000?'₹'+(v/100000).toFixed(1)+'L':v>=1000?'₹'+(v/1000).toFixed(0)+'K':v}},y:{grid:{display:false}}}}});

${stock ? `new Chart(document.getElementById('cInv'),{type:'doughnut',data:{labels:['Adequate','Low','Out','Negative'],datasets:[{data:[${stock.adequateCount},${stock.lowCount},${stock.outCount},${stock.negativeCount}],backgroundColor:['#10b981','#f59e0b','#ef4444','#fbbf24'],borderWidth:0,hoverOffset:4}]},options:{responsive:true,maintainAspectRatio:false,cutout:'62%',plugins:{legend:{display:false}}}});` : ""}

${stock?.subCatStock?.length > 0 ? `new Chart(document.getElementById('cStockSub'),{type:'bar',data:{labels:${J(stock.subCatStock.map((r) => ((r.sub_cat || "").length > 20 ? (r.sub_cat || "").slice(0, 18) + "…" : r.sub_cat || "")))},datasets:[{data:${J(stock.subCatStock.map((r) => Math.round(r.value)))},backgroundColor:'rgba(139,92,246,0.65)',borderColor:'#8b5cf6',borderWidth:1,borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+inr(ctx.raw)+' · '+ctx.dataset.data.reduce((a,b)=>a+b,0)}}},scales:{x:{grid:{color:'#1a2540'},ticks:{callback:v=>v>=100000?'₹'+(v/100000).toFixed(1)+'L':v>=1000?'₹'+(v/1000).toFixed(0)+'K':v}},y:{grid:{display:false},ticks:{font:{size:10}}}}}});` : ""}
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

  // ── DASHBOARD (HTML artifact with Chart.js) ───────────────────────────────
  server.tool(
    "get_dashboard",
    "Full business analytics dashboard — revenue, day/night split, species, categories, sub-categories, customers, opportunity WoW/MoM, inventory, payment methods. Returns a rich HTML artifact with Chart.js charts.",
    {
      from_date: z.string().describe("YYYY-MM-DD start date"),
      to_date: z.string().describe("YYYY-MM-DD end date"),
    },
    async ({ from_date, to_date }) => {
      try {
        return okText(await getDashboard(from_date, to_date));
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
