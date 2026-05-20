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

  // ── Analyst instructions ───────────────────────────────────────────────────
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
All data lives in AWS RDS MySQL. Use execute_sql to answer every business question — never guess.

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
  std_category VARCHAR,   -- Prescription | Laboratory | Hospitalization | Consultation | Food | Grooming | Others
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
4. New vs returning patients: use MIN(invoice_date) per patient_id from allpets_invoice_items — there is NO is_new_client or client_id column on invoices.
5. Stock value = SUM(onhand_qty * purchase_cost) WHERE onhand_qty > 0.

════════════════════════════════════════════════════════════════════
HOW TO RESPOND
════════════════════════════════════════════════════════════════════
• Run SQL with execute_sql to get data. For complex requests fire multiple queries in parallel.
• Use your own skills to build charts, dashboards, tables, or slide decks from the data returned.
• For board meeting / PPT / presentation requests: run all needed queries in one parallel batch, then generate a complete self-contained HTML slide deck as an artifact (dark theme, Chart.js from CDN, keyboard navigation).
• Always show key numbers as formatted KPI cards alongside any chart.
• Currency = Indian Rupees (₹). Format large numbers with commas (e.g. ₹17,38,167).`,
          },
        },
      ],
    }),
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
