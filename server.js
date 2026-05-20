const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  SSEServerTransport,
} = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");
const db = require("./db.js");
const sync = require("./sync.js");

const app = express();
const PORT = process.env.PORT || 3000;
const activeTransports = new Map();

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-session-id",
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── MCP helpers ───────────────────────────────────────────────────────────────
const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const err = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message}` }],
  isError: true,
});

// ── Build MCP server ──────────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: "allpets-vetbuddy", version: "3.0.0" });

  // ── Analyst instructions (dynamic — queries DB on every fetch) ───────────────
  server.prompt(
    "analyst_instructions",
    "AllPets analyst role — read this before every conversation",
    async () => {
      // Fetch live context from RDS so Claude knows exactly what data exists
      const [dateRange, stdCats, subCats, payTypes, clinics, lastSync, counts] =
        await Promise.all([
          db.query(
            `SELECT DATE_FORMAT(MIN(DATE(invoice_date)),'%Y-%m-%d') AS earliest,
                    DATE_FORMAT(MAX(DATE(invoice_date)),'%Y-%m-%d') AS latest
             FROM allpets_invoices`,
          ),
          db.query(
            `SELECT std_category, COUNT(DISTINCT plan_sub_category_name) AS sub_count
             FROM allpets_invoice_items
             WHERE std_category IS NOT NULL AND std_category != ''
             GROUP BY std_category ORDER BY std_category`,
          ),
          db.query(
            `SELECT plan_sub_category_name AS name, std_category AS cat,
                    ROUND(SUM(item_total)) AS total_revenue
             FROM allpets_invoice_items
             WHERE plan_sub_category_name IS NOT NULL AND plan_sub_category_name != ''
             GROUP BY plan_sub_category_name, std_category
             ORDER BY total_revenue DESC LIMIT 40`,
          ),
          db.query(
            `SELECT DISTINCT payment_type_name
             FROM allpets_payments
             WHERE payment_type_name IS NOT NULL ORDER BY payment_type_name`,
          ),
          db.query(
            `SELECT DISTINCT clinic_name FROM allpets_invoices
             WHERE clinic_name IS NOT NULL ORDER BY clinic_name`,
          ),
          db.query(
            `SELECT sync_type, DATE_FORMAT(completed_at,'%Y-%m-%d %H:%i') AS completed_at,
                    records_upserted, status
             FROM allpets_sync_log ORDER BY completed_at DESC LIMIT 1`,
          ),
          db.query(
            `SELECT
               (SELECT COUNT(*) FROM allpets_invoices WHERE cancelled=0)         AS active_invoices,
               (SELECT COUNT(*) FROM allpets_invoice_items)                       AS line_items,
               (SELECT COUNT(*) FROM allpets_payments WHERE returned=0)           AS valid_payments,
               (SELECT COUNT(*) FROM allpets_stock WHERE onhand_qty > 0)          AS stock_skus`,
          ),
        ]).catch(() => [[], [], [], [], [], [], []]);

      const dr = dateRange[0] || {};
      const cnt = counts[0] || {};
      const ls = lastSync[0] || {};

      const stdCatList = stdCats
        .map((r) => `  • ${r.std_category} (${r.sub_count} sub-categories)`)
        .join("\n");

      const subCatList = subCats
        .map(
          (r) =>
            `  • [${r.cat}] ${r.name}  →  ₹${Number(r.total_revenue).toLocaleString("en-IN")}`,
        )
        .join("\n");

      const payTypeList = payTypes
        .map((r) => `  • ${r.payment_type_name}`)
        .join("\n");
      const clinicList = clinics.map((r) => `  • ${r.clinic_name}`).join("\n");

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are the dedicated business analyst for AllPets Veterinary Clinic.
All data lives in AWS RDS MySQL. Use execute_sql to answer every business question — never guess.

════════════════════════════════════════════════════════════════════
LIVE DATA CONTEXT  (fetched right now from RDS)
════════════════════════════════════════════════════════════════════
Data range available : ${dr.earliest || "?"} → ${dr.latest || "?"}
Active invoices      : ${Number(cnt.active_invoices || 0).toLocaleString()}
Line items           : ${Number(cnt.line_items || 0).toLocaleString()}
Valid payments       : ${Number(cnt.valid_payments || 0).toLocaleString()}
Stock SKUs (in stock): ${Number(cnt.stock_skus || 0).toLocaleString()}
Last sync            : ${ls.completed_at || "unknown"} — ${ls.records_upserted || 0} records (${ls.status || "?"})

Clinics in DB:
${clinicList || "  (none found)"}

std_category values in DB:
${stdCatList || "  (none found)"}

Top sub-categories by all-time revenue:
${subCatList || "  (none found)"}

Payment types in DB:
${payTypeList || "  (none found)"}

════════════════════════════════════════════════════════════════════
DATABASE SCHEMA
════════════════════════════════════════════════════════════════════
TABLE: allpets_invoices
  invoice_id VARCHAR PK, invoice_no, clinic_id, clinic_name,
  client_name, mobile_phone,
  invoice_date DATETIME,
  invoice_amount DECIMAL(12,2),
  shift ENUM('Day','Night'),
  cancelled TINYINT  -- 0 = active, 1 = cancelled

TABLE: allpets_invoice_items
  id BIGINT PK, invoice_id, sales_id, patient_id, patient_name,
  patient_species, species_group ENUM('Canine','Feline','Others'),
  invoice_date DATETIME,
  plan_category_name VARCHAR,
  std_category VARCHAR,
  plan_sub_category_name VARCHAR,
  item_total DECIMAL(12,2)

TABLE: allpets_payments
  payment_id VARCHAR PK, payment_date DATETIME,
  payment_amount DECIMAL(12,2), payment_type_name VARCHAR,
  returned TINYINT,  -- 0 = valid, 1 = returned
  invoice_id VARCHAR

TABLE: allpets_stock
  stock_id VARCHAR, clinic_id VARCHAR,
  clinic_name, stock_name VARCHAR,
  plan_category_name, plan_sub_category_name, std_category VARCHAR,
  onhand_qty DECIMAL(10,2), threshold_qty DECIMAL(10,2),
  purchase_cost DECIMAL(12,2),
  stock_status ENUM('adequate','low','out','negative')

════════════════════════════════════════════════════════════════════
SQL RULES
════════════════════════════════════════════════════════════════════
1. Always add cancelled=0 when querying allpets_invoices for revenue/counts.
2. Always add returned=0 when querying allpets_payments.
3. Date filter: DATE(invoice_date) BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'
4. New vs returning patients: use MIN(invoice_date) per patient_id from allpets_invoice_items.
   There is NO is_new_client or client_id column on invoices — never use them.
5. Stock value = SUM(onhand_qty * purchase_cost) WHERE onhand_qty > 0.
6. Use the exact std_category and plan_sub_category_name values shown in LIVE DATA CONTEXT above.
7. NEVER show "Pharmacy vs Service" split — always use sub-category breakdown.

════════════════════════════════════════════════════════════════════
⚡ TOKEN EXHAUSTION PREVENTION — CRITICAL RULE
════════════════════════════════════════════════════════════════════
For ANY dashboard, report, or multi-section analysis:
  • Send ALL execute_sql calls in ONE single parallel batch (multiple tool calls in one response).
  • NEVER run queries one at a time sequentially — that exhausts tokens.
  • Wait for ALL results, then generate the complete artifact in ONE response.
  • The full dashboard must be a single self-contained HTML artifact.

════════════════════════════════════════════════════════════════════
DASHBOARD SPEC — run these 10 queries in ONE parallel batch
════════════════════════════════════════════════════════════════════
Replace <FROM> and <TO> with the requested period dates (e.g. 2026-04-01 / 2026-04-30).
Replace <PREV_FROM> and <PREV_TO> with the prior period (same duration, one month/year back).

Q1 — Summary KPIs (current + prior period for delta):
  SELECT
    SUM(CASE WHEN DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>' AND cancelled=0 THEN invoice_amount END) AS revenue,
    COUNT(CASE WHEN DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>' AND cancelled=0 THEN 1 END) AS invoices,
    COUNT(CASE WHEN DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>' AND cancelled=1 THEN 1 END) AS cancelled,
    COUNT(DISTINCT CASE WHEN DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>' AND cancelled=0 THEN DATE(invoice_date) END) AS active_days,
    SUM(CASE WHEN DATE(invoice_date) BETWEEN '<PREV_FROM>' AND '<PREV_TO>' AND cancelled=0 THEN invoice_amount END) AS prev_revenue,
    COUNT(CASE WHEN DATE(invoice_date) BETWEEN '<PREV_FROM>' AND '<PREV_TO>' AND cancelled=0 THEN 1 END) AS prev_invoices
  FROM allpets_invoices

Q2 — Day vs Night invoice split:
  SELECT shift, COUNT(*) AS invoices, SUM(invoice_amount) AS revenue
  FROM allpets_invoices
  WHERE DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>' AND cancelled=0
  GROUP BY shift

Q3 — Species breakdown (Canine / Feline / Others) vs avg:
  SELECT species_group,
    COUNT(DISTINCT invoice_id) AS visits,
    COUNT(DISTINCT patient_id) AS unique_patients,
    SUM(item_total) AS revenue,
    ROUND(SUM(item_total)/COUNT(DISTINCT invoice_id),2) AS avg_per_visit
  FROM allpets_invoice_items
  WHERE DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>'
  GROUP BY species_group

Q4 — Category split (std_category — Prescription/Laboratory/Hospitalization/Consultation/Food/Grooming/Others):
  SELECT std_category,
    SUM(item_total) AS revenue,
    COUNT(DISTINCT invoice_id) AS invoices,
    ROUND(SUM(item_total)*100/(SELECT SUM(item_total) FROM allpets_invoice_items WHERE DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>'),1) AS pct
  FROM allpets_invoice_items
  WHERE DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>'
  GROUP BY std_category ORDER BY revenue DESC

Q5 — Sub-category sales (top 20, ranked by revenue):
  SELECT plan_sub_category_name AS sub_category, std_category,
    SUM(item_total) AS revenue,
    COUNT(DISTINCT invoice_id) AS invoices
  FROM allpets_invoice_items
  WHERE DATE(invoice_date) BETWEEN '<FROM>' AND '<TO>'
    AND plan_sub_category_name IS NOT NULL AND plan_sub_category_name != ''
  GROUP BY plan_sub_category_name, std_category
  ORDER BY revenue DESC LIMIT 20

Q6 — New vs returning pet parents:
  SELECT
    COUNT(DISTINCT CASE WHEN mn.first_visit BETWEEN '<FROM>' AND '<TO>' THEN ii.patient_id END) AS new_patients,
    COUNT(DISTINCT CASE WHEN mn.first_visit < '<FROM>' THEN ii.patient_id END) AS returning_patients,
    SUM(CASE WHEN mn.first_visit BETWEEN '<FROM>' AND '<TO>' THEN ii.item_total ELSE 0 END) AS new_revenue,
    SUM(CASE WHEN mn.first_visit < '<FROM>' THEN ii.item_total ELSE 0 END) AS returning_revenue
  FROM allpets_invoice_items ii
  JOIN (SELECT patient_id, MIN(DATE(invoice_date)) AS first_visit
        FROM allpets_invoice_items WHERE patient_id != '' GROUP BY patient_id) mn
    ON mn.patient_id = ii.patient_id
  WHERE DATE(ii.invoice_date) BETWEEN '<FROM>' AND '<TO>' AND ii.patient_id != ''

Q7 — Weekly trend (opportunity — last 8 weeks):
  SELECT DATE_FORMAT(DATE_SUB(invoice_date, INTERVAL WEEKDAY(invoice_date) DAY),'%Y-%m-%d') AS week_start,
    SUM(invoice_amount) AS revenue, COUNT(*) AS invoices
  FROM allpets_invoices
  WHERE DATE(invoice_date) >= DATE_SUB('<TO>', INTERVAL 8 WEEK) AND cancelled=0
  GROUP BY week_start ORDER BY week_start

Q8 — Monthly trend (last 13 months):
  SELECT DATE_FORMAT(invoice_date,'%Y-%m') AS month,
    SUM(invoice_amount) AS revenue, COUNT(*) AS invoices
  FROM allpets_invoices
  WHERE DATE(invoice_date) >= DATE_SUB('<TO>', INTERVAL 13 MONTH) AND cancelled=0
  GROUP BY month ORDER BY month

Q9 — Inventory snapshot (closing stock + low/out alerts):
  SELECT
    COUNT(*) AS total_skus,
    SUM(CASE WHEN stock_status='adequate' THEN 1 ELSE 0 END) AS adequate,
    SUM(CASE WHEN stock_status='low' THEN 1 ELSE 0 END) AS low_stock,
    SUM(CASE WHEN stock_status='out' THEN 1 ELSE 0 END) AS out_of_stock,
    SUM(CASE WHEN stock_status='negative' THEN 1 ELSE 0 END) AS negative_stock,
    ROUND(SUM(CASE WHEN onhand_qty>0 THEN onhand_qty*purchase_cost ELSE 0 END)) AS closing_value,
    COUNT(DISTINCT CASE WHEN std_category='Food' THEN stock_id END) AS food_skus,
    ROUND(SUM(CASE WHEN std_category='Food' AND onhand_qty>0 THEN onhand_qty*purchase_cost ELSE 0 END)) AS food_value
  FROM allpets_stock

Q10 — Stock mismatch (negative = system says below zero — physical vs system discrepancy):
  SELECT stock_name, clinic_name, std_category, plan_sub_category_name,
    onhand_qty, threshold_qty, purchase_cost,
    ROUND(onhand_qty*purchase_cost) AS stock_value,
    stock_status
  FROM allpets_stock
  WHERE stock_status IN ('negative','out')
  ORDER BY stock_status, onhand_qty ASC LIMIT 30

════════════════════════════════════════════════════════════════════
DASHBOARD LAYOUT (build as single HTML artifact after all 10 queries return)
════════════════════════════════════════════════════════════════════
Dark theme (#0f172a background). Use Chart.js from CDN. Sections:

1. SUMMARY ROW — KPI cards: Total Revenue | Total Invoices | Avg/Invoice | Active Days | Cancellations
   Each card shows current value + delta % vs prior period (green up / red down arrow).

2. DAY vs NIGHT — donut or stacked bar showing invoice count and revenue by shift.

3. SPECIES — 3 cards (Canine / Feline / Others): revenue, unique patients, avg/visit vs overall avg.
   Add a bar chart comparing avg/visit across species.

4. CATEGORY SPLIT — horizontal bar chart: Prescription | Laboratory | Hospitalization |
   Consultation | Food | Grooming | Others — sorted by revenue, showing % of total.

5. SUB-CATEGORY SALES — horizontal bar chart top 20, colored by std_category.

6. NEW vs RETURNING PET PARENTS — stacked bar: new patients vs returning patients + revenue split.

7. OPPORTUNITY — two charts side by side:
   • Weekly trend (last 8 weeks) — bar chart with revenue + invoice count line overlay
   • Monthly trend (last 13 months) — line chart

8. INVENTORY — summary cards: Closing Value | Food Value | Low Stock | Out of Stock | Mismatches.
   Table of negative/out stock items (stock name, qty, value, clinic) — these are system vs physical mismatches.

Currency = ₹ Indian format. All numbers with Indian comma formatting.`,
            },
          },
        ],
      };
    },
  );

  // ── execute_sql ────────────────────────────────────────────────────────────
  server.tool(
    "execute_sql",
    "Run any read-only SQL query against the AllPets RDS MySQL database and return the results as JSON. Use this for every data question.",
    {
      sql: z.string().describe("The SQL SELECT statement to execute"),
      params: z
        .array(z.union([z.string(), z.number(), z.null()]))
        .optional()
        .describe("Optional parameterised values for ? placeholders"),
    },
    async ({ sql, params = [] }) => {
      try {
        const trimmed = sql.trim().toUpperCase();
        if (
          !trimmed.startsWith("SELECT") &&
          !trimmed.startsWith("SHOW") &&
          !trimmed.startsWith("DESCRIBE") &&
          !trimmed.startsWith("EXPLAIN")
        ) {
          return err(
            new Error(
              "Only SELECT / SHOW / DESCRIBE / EXPLAIN queries are allowed.",
            ),
          );
        }
        const rows = await db.query(sql, params);
        return ok({ row_count: rows.length, rows });
      } catch (e) {
        return err(e);
      }
    },
  );

  return server;
}

// ── SSE transport ─────────────────────────────────────────────────────────────
app.get("/mcp", async (req, res) => {
  console.log("[SSE] New connection...");
  const transport = new SSEServerTransport("/messages", res);
  activeTransports.set(transport.sessionId, transport);
  res.on("close", () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    activeTransports.delete(transport.sessionId);
  });
  try {
    await buildMcpServer().connect(transport);
  } catch (e) {
    console.error("[SSE] Connect error:", e);
  }
});

app.post("/messages", async (req, res) => {
  const transport = activeTransports.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (e) {
    console.error("[SSE] Message error:", e);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  }
});

app.get("/health", (_, res) =>
  res.json({
    status: "ok",
    service: "AllPets MCP",
    ts: new Date().toISOString(),
  }),
);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[AllPets MCP] Listening on port ${PORT}`);
  sync.scheduleDailySync();
  sync
    .runNightlySync()
    .catch((e) => console.error("[Startup sync]", e.message));
});
