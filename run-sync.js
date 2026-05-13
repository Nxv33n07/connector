require("dotenv").config();
const sync = require("./sync.js");

const args = process.argv.slice(2);
const command = args[0] || "nightly";

async function run() {
  console.log("==========================================");
  console.log("⚡️ AllPets Manual Sync Trigger");
  console.log("==========================================");
  
  try {
    if (command === "nightly") {
      console.log("▶️ Running standard Nightly Sync (last 3 days + stock refresh)...");
      await sync.runNightlySync();
    } else if (command === "history") {
      const startDate = args[1];
      if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        console.error("❌ Error: Please provide a start date in YYYY-MM-DD format.");
        console.log("Example: node run-sync.js history 2026-04-01");
        process.exit(1);
      }
      console.log(`▶️ Running Historical Sync starting from: ${startDate} ...`);
      await sync.runHistoricalSync(startDate);
    } else if (command === "stock") {
      console.log("▶️ Running direct Stock Refresh only...");
      await sync.refreshStock();
      console.log("✅ Stock refresh completed.");
    } else if (command === "range") {
      const from = args[1];
      const to = args[2];
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        console.error("❌ Error: Please provide 'from' and 'to' dates in YYYY-MM-DD format.");
        console.log("Example: node run-sync.js range 2026-05-01 2026-05-07");
        process.exit(1);
      }
      console.log(`▶️ Syncing direct date range: ${from} to ${to} ...`);
      await sync.syncDateRange(from, to);
      console.log("✅ Range sync completed.");
    } else {
      console.log("Available commands:");
      console.log("  node run-sync.js nightly              - Sync last 3 days + refresh stock");
      console.log("  node run-sync.js history YYYY-MM-DD   - Backfill all history from date up to today");
      console.log("  node run-sync.js stock                - Refresh stock snapshot only");
      console.log("  node run-sync.js range YYYY-MM-DD YYYY-MM-DD - Sync a specific date window");
    }
  } catch (e) {
    console.error("\n❌ Sync execution failed:");
    console.error(e.message);
  } finally {
    // Give DB handles time to close if necessary, then exit
    setTimeout(() => process.exit(0), 1000);
  }
}

run();
