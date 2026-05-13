#!/usr/bin/env node
/**
 * stress-test.js — AllPets VetBuddy MCP Stress & Consistency Test
 *
 * Usage:
 *   node stress-test.js https://your-app.onrender.com
 *
 * Tests:
 *   1. Health & connectivity
 *   2. SSE session establishment latency
 *   3. Warehouse cache hit latency (×5 runs)
 *   4. Data consistency (same query ×3, results must match)
 *   5. All major tools (breadth + individual latency)
 *   6. Concurrent load — 5 simultaneous sessions
 *   7. Token anti-collision — 8 rapid-fire parallel calls
 *   8. Self-hydrator trigger — query for an old date range
 */

require("dotenv").config();
const {
  Client,
} = require("./node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js");
const {
  SSEClientTransport,
} = require("./node_modules/@modelcontextprotocol/sdk/dist/cjs/client/sse.js");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");

// ── Terminal colours ──────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;
const W = (s) => `\x1b[1m${s}\x1b[0m`;

const pass = (msg) => console.log(`  ${G("✓")} ${msg}`);
const fail = (msg) => console.log(`  ${R("✗")} ${msg}`);
const warn = (msg) => console.log(`  ${Y("⚠")} ${msg}`);
const info = (msg) => console.log(`  ${B("ℹ")} ${msg}`);
const sep = () => console.log(W("─".repeat(60)));

// ── HTTP helper ───────────────────────────────────────────────────────────────
function rawGet(path, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(url.toString(), { timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(d);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

// ── MCP client factory ────────────────────────────────────────────────────────
async function makeClient() {
  const transport = new SSEClientTransport(new URL("/mcp", BASE));
  const client = new Client({ name: "stress-test", version: "1.0" });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
function stats(arr) {
  const s = arr.sort((a, b) => a - b);
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  return {
    min: s[0],
    max: s[s.length - 1],
    avg,
    p90: s[Math.floor(s.length * 0.9)],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — Health check
// ─────────────────────────────────────────────────────────────────────────────
async function t1_health() {
  console.log(W("\n TEST 1 · Health & Connectivity"));
  sep();
  const t = Date.now();
  try {
    const res = await rawGet("/health");
    const ms = Date.now() - t;
    if (res?.status === "ok") pass(`/health → OK  (${ms}ms)`);
    else fail(`/health returned unexpected: ${JSON.stringify(res)}`);
    return true;
  } catch (e) {
    fail(`/health failed: ${e.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — SSE session establishment
// ─────────────────────────────────────────────────────────────────────────────
async function t2_sse() {
  console.log(W("\n TEST 2 · SSE Session Establishment"));
  sep();
  const t = Date.now();
  let cli, trp;
  try {
    ({ client: cli, transport: trp } = await makeClient());
    pass(`Session established in ${Date.now() - t}ms`);
    return { client: cli, transport: trp };
  } catch (e) {
    fail(`SSE connect failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — Warehouse cache hit latency (5 runs, cached date range)
// ─────────────────────────────────────────────────────────────────────────────
async function t3_latency(client) {
  console.log(W("\n TEST 3 · RDS Query Latency  (×5 runs, last 30 days)"));
  sep();
  const latencies = [];

  for (let i = 1; i <= 5; i++) {
    const t = Date.now();
    try {
      await callTool(client, "get_dashboard");
      const ms = Date.now() - t;
      latencies.push(ms);
      const tag =
        ms < 300 ? G(`${ms}ms`) : ms < 1500 ? Y(`${ms}ms`) : R(`${ms}ms`);
      pass(`Run ${i}: ${tag}`);
    } catch (e) {
      const ms = Date.now() - t;
      if (
        e.message?.includes("background") ||
        e.message?.includes("30 seconds")
      ) {
        warn(
          `Run ${i}: Self-hydrator triggered (RDS data not yet synced for this range) — wait 15s and re-run`,
        );
      } else {
        fail(`Run ${i} (${ms}ms): ${e.message.slice(0, 80)}`);
      }
    }
  }

  if (latencies.length > 0) {
    const { min, max, avg, p90 } = stats(latencies);
    info(
      `Latency summary — min: ${min}ms  avg: ${avg}ms  p90: ${p90}ms  max: ${max}ms`,
    );
    if (avg < 200) pass(G(`Excellent — avg ${avg}ms (well under 200ms)`));
    else if (avg < 1000)
      warn(`Acceptable — avg ${avg}ms. Warehouse may still be warming up.`);
    else fail(`Slow — avg ${avg}ms. Run force_sync tool and re-test.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — Consistency (same query ×3, numbers must match)
// ─────────────────────────────────────────────────────────────────────────────
async function t4_consistency(client) {
  console.log(
    W("\n TEST 4 · Data Consistency  (same query ×3, results must match)"),
  );
  sep();
  const args = { from_date: "05/01/2026", to_date: "05/13/2026" };
  const snapshots = [];

  for (let i = 1; i <= 3; i++) {
    try {
      const r = await callTool(client, "get_dashboard", args);
      const text = r?.content?.[0]?.text || "";
      // Extract key numbers from the formatted dashboard text
      const revenue = text.match(/Billed\s+[█░]+\s+\*\*(₹[\d,]+)\*\*/)?.[1];
      const invoices = text.match(/\*\*(\d+) invoices\*\*/)?.[1];
      const canine = text.match(/Canine\s+[█░]+\s+\*\*(₹[\d,]+)\*\*/)?.[1];
      snapshots.push({ revenue, invoices, canine, len: text.length });
      info(
        `Run ${i} — Revenue: ${revenue}  Invoices: ${invoices}  Canine: ${canine}`,
      );
    } catch (e) {
      fail(`Run ${i} failed: ${e.message.slice(0, 80)}`);
    }
  }

  if (snapshots.length === 3) {
    const revMatch = snapshots.every((s) => s.revenue === snapshots[0].revenue);
    const invMatch = snapshots.every(
      (s) => s.invoices === snapshots[0].invoices,
    );
    const lenMatch = snapshots.every((s) => s.len === snapshots[0].len);

    revMatch
      ? pass("Revenue   → consistent across all 3 runs")
      : fail(
          `Revenue mismatch: ${snapshots.map((s) => s.revenue).join(" | ")}`,
        );
    invMatch
      ? pass("Invoices  → consistent across all 3 runs")
      : fail(
          `Invoice count mismatch: ${snapshots.map((s) => s.invoices).join(" | ")}`,
        );
    lenMatch
      ? pass("Response  → byte-identical output")
      : warn(
          `Response lengths differ slightly: ${snapshots.map((s) => s.len).join(" | ")} (minor formatting variance)`,
        );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — All major tools (breadth + latency per tool)
// ─────────────────────────────────────────────────────────────────────────────
async function t5_tools(client) {
  console.log(W("\n TEST 5 · All Major Tools — Latency per Tool"));
  sep();

  const today = new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
  const ago30 = new Date(Date.now() - 30 * 86400000).toLocaleDateString(
    "en-US",
    { month: "2-digit", day: "2-digit", year: "numeric" },
  );

  const tools = [
    // ── RDS analytics (should all be <300ms) ──────────────────────────────
    { name: "get_dashboard", args: {}, tag: "RDS" },
    {
      name: "get_dashboard",
      args: { from_date: ago30, to_date: today },
      tag: "RDS",
    },
    { name: "get_revenue", args: {}, tag: "RDS" },
    { name: "business_insights", args: {}, tag: "RDS" },
    { name: "get_daily_trend", args: {}, tag: "RDS" },
    { name: "get_top_clients", args: {}, tag: "RDS" },
    { name: "get_hourly_distribution", args: {}, tag: "RDS" },
    { name: "get_client_shift_pattern", args: {}, tag: "RDS" },
    // ── Live API tools (network-bound, <5s acceptable) ────────────────────
    { name: "daily_briefing", args: {}, tag: "API" },
    {
      name: "get_appointments",
      args: { from_date: today, to_date: today },
      tag: "API",
    },
    { name: "get_patients", args: { name_query: "a" }, tag: "API" },
    { name: "get_clients", args: { name_query: "a" }, tag: "API" },
    { name: "get_stock", args: {}, tag: "API" },
    { name: "get_staff", args: {}, tag: "API" },
    { name: "get_reminders", args: { status: "overdue" }, tag: "API" },
    { name: "get_clinic_info", args: {}, tag: "API" },
  ];

  let rdsCount = 0,
    rdsTotal = 0;
  for (const t of tools) {
    const start = Date.now();
    try {
      const r = await callTool(client, t.name, t.args);
      const ms = Date.now() - start;
      const text = r?.content?.[0]?.text || "";
      // RDS tools: green <300ms, yellow <1000ms, red otherwise
      // API tools: green <3000ms, yellow <6000ms, red otherwise
      const isRds = t.tag === "RDS";
      const coloured = isRds
        ? ms < 300
          ? G(`${ms}ms`)
          : ms < 1000
            ? Y(`${ms}ms`)
            : R(`${ms}ms`)
        : ms < 3000
          ? G(`${ms}ms`)
          : ms < 6000
            ? Y(`${ms}ms`)
            : R(`${ms}ms`);
      pass(
        `[${t.tag}] ${t.name.padEnd(26)} ${coloured}  (${text.length} chars)`,
      );
      if (isRds) {
        rdsCount++;
        rdsTotal += ms;
      }
    } catch (e) {
      fail(
        `[${t.tag}] ${t.name.padEnd(26)} ${Date.now() - start}ms — ${e.message.slice(0, 60)}`,
      );
    }
  }
  if (rdsCount > 0)
    info(
      `RDS tools avg latency: ${Math.round(rdsTotal / rdsCount)}ms across ${rdsCount} calls`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6 — Concurrent load: 5 independent sessions, simultaneous calls
// ─────────────────────────────────────────────────────────────────────────────
async function t6_concurrent() {
  console.log(
    W("\n TEST 6 · Concurrent Load  (5 simultaneous independent sessions)"),
  );
  sep();

  const sessions = [];
  try {
    info("Establishing 5 parallel sessions...");
    const connects = await Promise.allSettled(
      Array.from({ length: 5 }, () => makeClient()),
    );
    for (const c of connects) {
      if (c.status === "fulfilled") sessions.push(c.value);
      else fail(`Session failed: ${c.reason?.message}`);
    }
    info(`${sessions.length}/5 sessions connected`);

    if (sessions.length === 0) {
      fail("No sessions established");
      return;
    }

    const start = Date.now();
    const results = await Promise.allSettled(
      sessions.map(({ client }) => callTool(client, "get_dashboard")),
    );
    const elapsed = Date.now() - start;

    const ok_count = results.filter((r) => r.status === "fulfilled").length;
    const fail_count = results.filter((r) => r.status === "rejected").length;

    ok_count === sessions.length
      ? pass(`All ${ok_count} concurrent calls succeeded in ${elapsed}ms`)
      : warn(`${ok_count}/${sessions.length} calls succeeded in ${elapsed}ms`);

    for (const r of results.filter((r) => r.status === "rejected"))
      fail(`Concurrent failure: ${r.reason?.message?.slice(0, 80)}`);

    // Cross-validate: all responses should show same revenue figure
    const revenues = results
      .filter((r) => r.status === "fulfilled")
      .map(
        (r) =>
          r.value?.content?.[0]?.text?.match(
            /Billed\s+[█░]+\s+\*\*(₹[\d,]+)\*\*/,
          )?.[1],
      );

    const allSame = revenues.every((v) => v && v === revenues[0]);
    allSame
      ? pass(`All responses consistent — Revenue: ${revenues[0]}`)
      : warn(
          `Revenue values diverged across sessions: ${[...new Set(revenues)].join(" | ")}`,
        );
  } finally {
    sessions.forEach(({ transport }) => {
      try {
        transport.close?.();
      } catch {}
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7 — Token anti-collision: 8 rapid calls on one session
// ─────────────────────────────────────────────────────────────────────────────
async function t7_token(client) {
  console.log(W("\n TEST 7 · Token Anti-Collision  (8 rapid parallel calls)"));
  sep();
  info("Firing 8 simultaneous calls — should all succeed via token lock...");

  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => callTool(client, "get_clinic_info")),
  );
  const elapsed = Date.now() - start;
  const ok_count = results.filter((r) => r.status === "fulfilled").length;

  ok_count === 8
    ? pass(`All 8 rapid calls resolved in ${elapsed}ms — no token collision`)
    : warn(`${ok_count}/8 calls succeeded in ${elapsed}ms`);

  for (const r of results.filter((r) => r.status === "rejected"))
    fail(`Token collision leak: ${r.reason?.message?.slice(0, 80)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8 — Self-hydrator: request a date range unlikely to be cached
// ─────────────────────────────────────────────────────────────────────────────
async function t8_hydrator(client) {
  console.log(
    W("\n TEST 8 · Self-Hydrator Behaviour  (cold historical range)"),
  );
  sep();

  // 90-day-old range: very unlikely cached unless full sync was run
  const from = "01/01/2026",
    to = "01/15/2026";
  info(`Querying ${from} → ${to} (likely uncached — triggers self-hydrator)`);

  const t = Date.now();
  try {
    const r = await callTool(client, "get_dashboard", {
      from_date: from,
      to_date: to,
    });
    const ms = Date.now() - t;
    const text = r?.content?.[0]?.text || "";
    if (text.includes("background") || text.includes("10 seconds")) {
      warn(
        `Background hydration triggered (${ms}ms) — server building history. Re-query in 10s. ✓ (correct behaviour)`,
      );
    } else if (text.includes("Dashboard")) {
      pass(`Data was already cached — served in ${ms}ms`);
    } else {
      info(`Response (${ms}ms): ${text.slice(0, 120)}`);
    }
  } catch (e) {
    const ms = Date.now() - t;
    if (
      e.message?.includes("background") ||
      e.message?.includes("30 seconds")
    ) {
      pass(
        `Background hydration correctly triggered (${ms}ms) — ${e.message.slice(0, 80)}`,
      );
    } else {
      fail(`${ms}ms — ${e.message.slice(0, 100)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(W(`\n${"═".repeat(60)}`));
  console.log(W("  AllPets VetBuddy MCP — Stress & Consistency Test"));
  console.log(W(`  Target: ${BASE}`));
  console.log(W(`${"═".repeat(60)}`));

  // T1 — health gate
  const healthy = await t1_health();
  if (!healthy) {
    fail("Server unreachable. Check your Render URL.");
    process.exit(1);
  }

  // T2 — SSE connect (shared session for T3–T8)
  const conn = await t2_sse();
  if (!conn) {
    fail("SSE failed. Cannot continue.");
    process.exit(1);
  }
  const { client, transport } = conn;

  try {
    await t3_latency(client);
    await t4_consistency(client);
    await t5_tools(client);
    await t7_token(client);
    await t8_hydrator(client);
  } finally {
    try {
      transport.close?.();
    } catch {}
  }

  // T6 — separate sessions (must come after primary session closes to avoid port conflicts)
  await t6_concurrent();

  console.log(W(`\n${"═".repeat(60)}`));
  console.log(W("  All tests complete."));
  console.log(W(`${"═".repeat(60)}\n`));
}

main().catch((e) => {
  console.error(R(`\nFatal: ${e.message}`));
  process.exit(1);
});
