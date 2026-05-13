require("dotenv").config();
const mysql = require("mysql2/promise");
const sync = require("./sync.js");

async function runFix() {
  console.log("=============================================================");
  console.log("🛠️  AllPets Multi-Clinic Schema & Stock Fix Utility");
  console.log("=============================================================\n");

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  const conn = await pool.getConnection();
  try {
    console.log("Step 1: Preparing RDS Database Migration...");
    
    // 1. Truncate table to ensure clean ALTER TABLE execution
    console.log(" -> Emptying allpets_stock to prevent duplicate errors during key migration...");
    await conn.execute("TRUNCATE TABLE allpets_stock");
    
    // 2. Modify column constraints
    console.log(" -> Updating 'clinic_id' and 'stock_id' definitions...");
    await conn.execute("ALTER TABLE allpets_stock MODIFY stock_id VARCHAR(64) NOT NULL");
    await conn.execute("ALTER TABLE allpets_stock MODIFY clinic_id VARCHAR(64) NOT NULL");
    
    // 3. Update Primary Key
    console.log(" -> Changing PRIMARY KEY to (stock_id, clinic_id) to prevent multi-clinic collisions...");
    try {
      await conn.execute("ALTER TABLE allpets_stock DROP PRIMARY KEY");
    } catch (e) {
      // Might not have primary key, ignore
    }
    await conn.execute("ALTER TABLE allpets_stock ADD PRIMARY KEY (stock_id, clinic_id)");
    
    console.log("🎉 Database Migration Complete!\n");
    
    console.log("Step 2: Starting Optimized Multi-Clinic Batch Synchronization...");
    const startTime = Date.now();
    
    const finalCount = await sync.refreshStock();
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 SUCCESS! Fully synchronized ${finalCount} SKUs across all clinics in ${elapsed} seconds!`);
    
    // Double check RDS count directly
    const [res] = await conn.execute("SELECT COUNT(*) as count FROM allpets_stock");
    console.log(` -> Verified count in RDS: ${res[0].count} items.`);
    
  } catch (err) {
    console.error("\n❌ FAILED to execute fix:");
    console.error(err.message);
  } finally {
    conn.release();
    await pool.end();
    setTimeout(() => process.exit(0), 1000);
  }
}

runFix();
