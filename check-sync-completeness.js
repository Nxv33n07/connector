require("dotenv").config();
const mysql = require("mysql2/promise");
const vb = require("./vetbuddy.js");
const axios = require("axios");

// Reuse the token helpers and internal axios client from vetbuddy to avoid recreating logic
const BASE = process.env.VETBUDDY_APP_URL;

async function getApiTotal(action, params = {}) {
  const token = await vb.getToken();
  const res = await axios.get(`${BASE}/openapi.php`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    params: { ...params, action, page: 1, pagesize: 1 },
    timeout: 15000,
  });

  let totalRecords = 0;
  if (res.data && typeof res.data === "object") {
    for (const key of Object.keys(res.data)) {
      const sec = res.data[key];
      if (sec?.["@attributes"]?.total_records !== undefined) {
        totalRecords = parseInt(sec["@attributes"].total_records, 10);
        return { totalRecords, raw: res.data };
      }
    }
  }
  return { totalRecords: 0, raw: res.data };
}

// Convert date for API: "YYYY-MM-DD..." to "MM/DD/YYYY"
function formatToVBDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  return `${month}/${day}/${year}`;
}

async function runDiagnostics() {
  console.log("=============================================================");
  console.log("🔍  RDS vs API SYNC COMPLETENESS CHECKER");
  console.log("=============================================================\n");

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: "utf8mb4",
    timezone: "+00:00",
  });

  try {
    console.log("📊 Connecting to RDS Database...");
    
    // 0. SCHEMA VERIFICATION
    console.log("\n📋 Verifying RDS Table Structure...");
    const tables = ["allpets_invoices", "allpets_invoice_items", "allpets_payments", "allpets_stock", "allpets_sync_log"];
    
    for (const tbl of tables) {
      try {
        const [cols] = await pool.query(`SHOW COLUMNS FROM ${tbl}`);
        const colNames = cols.map(c => c.Field);
        console.log(` -> ${tbl}: [${colNames.join(", ")}]`);
        
        // Check specific potential mismatches
        if (tbl === "allpets_payments") {
          if (!colNames.includes("payment_type_name")) {
            console.log("    ⚠️  CRITICAL WARNING: 'payment_type_name' column missing! codebase expects it, but RDS has " + (colNames.includes("payment_method") ? "'payment_method'" : "neither") + ".");
          }
        }
        if (tbl === "allpets_sync_log") {
          if (!colNames.includes("completed_at") || !colNames.includes("records_upserted")) {
            console.log("    ⚠️  WARNING: 'allpets_sync_log' structure differs from what is written in sync.js.");
          }
        }
      } catch (err) {
        console.log(` -> ${tbl}: ❌ FAILED TO READ STRUCTURE (${err.message})`);
      }
    }
    
    // 1. STOCKS CHECK
    console.log("\n📦 Checking STOCK...");
    const [stockRes] = await pool.query("SELECT COUNT(*) as count FROM allpets_stock");
    const rdsStockCount = stockRes[0].count;
    console.log(` -> RDS: ${rdsStockCount} stock items`);
    
    console.log(" -> Querying API for current Stock count...");
    const apiStockInfo = await getApiTotal("stock");
    const apiStockCount = apiStockInfo.totalRecords;
    console.log(` -> API: ${apiStockCount} stock items`);

    const stockDiff = apiStockCount - rdsStockCount;
    const stockStatus = stockDiff === 0 ? "✅ PERFECT MATCH" : `⚠️  MISMATCH (${Math.abs(stockDiff)} items difference)`;
    console.log(` -> Result: ${stockStatus}`);

    // 2. INVOICES CHECK
    console.log("\n🧾 Checking INVOICES...");
    const [invStats] = await pool.query(
      "SELECT COUNT(*) as count, MIN(invoice_date) as min_date, MAX(invoice_date) as max_date FROM allpets_invoices"
    );
    const rdsInvCount = invStats[0].count;
    const minInvDate = invStats[0].min_date;
    const maxInvDate = invStats[0].max_date;

    let apiInvCount = 0;
    if (rdsInvCount === 0) {
      console.log(" -> RDS: No invoices found.");
    } else {
      const vbMinDate = formatToVBDate(minInvDate);
      const vbMaxDate = formatToVBDate(maxInvDate);
      console.log(` -> RDS Range: ${minInvDate.toISOString().slice(0, 10)} to ${maxInvDate.toISOString().slice(0, 10)}`);
      console.log(` -> RDS: ${rdsInvCount} invoices`);
      
      console.log(` -> Querying API for Invoices between ${vbMinDate} and ${vbMaxDate}...`);
      const apiInvInfo = await getApiTotal("invoice", { startdate: vbMinDate, enddate: vbMaxDate });
      apiInvCount = apiInvInfo.totalRecords;
      console.log(` -> API: ${apiInvCount} invoices`);

      const invDiff = apiInvCount - rdsInvCount;
      const invStatus = invDiff === 0 ? "✅ PERFECT MATCH" : `⚠️  MISMATCH (${Math.abs(invDiff)} invoices difference)`;
      console.log(` -> Result: ${invStatus}`);
    }

    // 3. PAYMENTS CHECK
    console.log("\n💳 Checking PAYMENTS...");
    const [pmtStats] = await pool.query(
      "SELECT COUNT(*) as count, MIN(payment_date) as min_date, MAX(payment_date) as max_date FROM allpets_payments"
    );
    const rdsPmtCount = pmtStats[0].count;
    const minPmtDate = pmtStats[0].min_date;
    const maxPmtDate = pmtStats[0].max_date;

    let apiPmtCount = 0;
    if (rdsPmtCount === 0) {
      console.log(" -> RDS: No payments found.");
    } else {
      const vbMinDate = formatToVBDate(minPmtDate);
      const vbMaxDate = formatToVBDate(maxPmtDate);
      console.log(` -> RDS Range: ${minPmtDate.toISOString().slice(0, 10)} to ${maxPmtDate.toISOString().slice(0, 10)}`);
      console.log(` -> RDS: ${rdsPmtCount} payments`);
      
      console.log(` -> Querying API for Payments between ${vbMinDate} and ${vbMaxDate}...`);
      const apiPmtInfo = await getApiTotal("payment", { startpaymentdate: vbMinDate, endpaymentdate: vbMaxDate });
      apiPmtCount = apiPmtInfo.totalRecords;
      console.log(` -> API: ${apiPmtCount} payments`);

      const pmtDiff = apiPmtCount - rdsPmtCount;
      const pmtStatus = pmtDiff === 0 ? "✅ PERFECT MATCH" : `⚠️  MISMATCH (${Math.abs(pmtDiff)} payments difference)`;
      console.log(` -> Result: ${pmtStatus}`);
    }

    // 4. FINAL SUMMARY
    console.log("\n=============================================================");
    console.log("📋  FINAL REPORT SUMMARY");
    console.log("=============================================================");
    
    const getLabel = (api, rds) => {
      if (api === rds) return "MATCHING  ✅";
      if (rds < api) return "INCOMPLETE ⚠️";
      return "OVERFLOWN ❓";
    };

    console.log(
      ` Entity     | API Count  | RDS Count  | Sync Status\n` +
      `------------|------------|------------|----------------\n` +
      ` Stock      | ${String(apiStockCount).padEnd(10)} | ${String(rdsStockCount).padEnd(10)} | ${getLabel(apiStockCount, rdsStockCount)}\n` +
      ` Invoices   | ${String(rdsInvCount ? apiInvCount : "N/A").padEnd(10)} | ${String(rdsInvCount).padEnd(10)} | ${rdsInvCount ? getLabel(apiInvCount, rdsInvCount) : "EMPTY    ❌"}\n` +
      ` Payments   | ${String(rdsPmtCount ? apiPmtCount : "N/A").padEnd(10)} | ${String(rdsPmtCount).padEnd(10)} | ${rdsPmtCount ? getLabel(apiPmtCount, rdsPmtCount) : "EMPTY    ❌"}`
    );
    console.log("=============================================================\n");

    if (rdsStockCount < apiStockCount || rdsInvCount < apiInvCount || rdsPmtCount < apiPmtCount) {
      console.log("💡 Pro Tip: Some data appears to be missing in RDS.");
      console.log("   You might need to run a historical sync to catch up!");
    } else {
      console.log("🎉 Success! RDS and API appear perfectly aligned.");
    }

  } catch (err) {
    console.error("\n❌ An error occurred during diagnostic checks:");
    console.error(err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    await pool.end();
  }
}

runDiagnostics();
