require("dotenv").config();
const { pool } = require("./db.js");

async function removeClientsData() {
  console.log("Connecting to RDS...");
  
  try {
    console.log("Dropping client_id and is_new_client from allpets_invoices...");
    await pool.query("ALTER TABLE allpets_invoices DROP COLUMN client_id, DROP COLUMN is_new_client");
    console.log("✅ Dropped from allpets_invoices");
  } catch (e) {
    console.log("⚠️ Could not drop from allpets_invoices (might already be removed):", e.message);
  }

  try {
    console.log("Dropping client_id from allpets_payments...");
    await pool.query("ALTER TABLE allpets_payments DROP COLUMN client_id");
    console.log("✅ Dropped from allpets_payments");
  } catch (e) {
    console.log("⚠️ Could not drop from allpets_payments (might already be removed):", e.message);
  }

  try {
    console.log("Dropping allpets_clients table just in case it exists...");
    await pool.query("DROP TABLE IF EXISTS allpets_clients");
    console.log("✅ Dropped allpets_clients table");
  } catch (e) {
    console.log("⚠️ Could not drop allpets_clients:", e.message);
  }

  console.log("🎉 Client data cleanup complete.");
  process.exit(0);
}

removeClientsData();
