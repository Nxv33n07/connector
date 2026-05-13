require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const vb = require('./vetbuddy');

const DUMP_DIR = path.join(__dirname, 'dumps');
if (!fs.existsSync(DUMP_DIR)) {
  fs.mkdirSync(DUMP_DIR);
}

const BASE = process.env.VETBUDDY_APP_URL;
const UID = process.env.VETBUDDY_UID;
const PASSWD = process.env.VETBUDDY_PASSWD;

async function dumpRawAndCleaned(entity, action, params = {}) {
  console.log(`\n[${entity.toUpperCase()}] Testing API data extraction...`);
  try {
    const token = await vb.getToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // 1. Fetch RAW data (directly from first page of API)
    console.log(` -> Fetching raw page 1 from API for action='${action}'...`);
    const rawRes = await axios.get(`${BASE}/openapi.php`, {
      headers,
      params: { action, page: 1, pagesize: 5, ...params },
    });
    
    const rawFilename = path.join(DUMP_DIR, `${entity}_raw_page1.json`);
    fs.writeFileSync(rawFilename, JSON.stringify(rawRes.data, null, 2));
    console.log(` -> SUCCESS: Saved raw response to: ./dumps/${entity}_raw_page1.json`);

    // 2. Fetch CLEANED data (using the vetbuddy.js module methods)
    console.log(` -> Fetching and cleaning data using vetbuddy.js module...`);
    // Dynamically call the correct helper
    let cleanedData = [];
    const queryParams = { pagesize: 5, max_pages: 1, ...params };
    
    switch(entity) {
      case 'clinics': cleanedData = await vb.getClinics(queryParams); break;
      case 'clients': cleanedData = await vb.getClients(queryParams); break;
      case 'patients': cleanedData = await vb.getPatients(queryParams); break;
      case 'appointments': cleanedData = await vb.getAppointments({ startdate: '05/01/2026', enddate: '05/15/2026', ...queryParams }); break;
      case 'invoices': cleanedData = await vb.getInvoices({ startdate: '05/01/2026', enddate: '05/15/2026', ...queryParams }); break;
      case 'stock': cleanedData = await vb.getStock(queryParams); break;
      default:
        console.warn(` -> Cleaned method not implemented for '${entity}' in script, skipping.`);
        return;
    }

    const cleanedFilename = path.join(DUMP_DIR, `${entity}_cleaned.json`);
    fs.writeFileSync(cleanedFilename, JSON.stringify(cleanedData, null, 2));
    console.log(` -> SUCCESS: Saved cleaned response to: ./dumps/${entity}_cleaned.json`);
    console.log(` -> Found ${cleanedData.length} records in sample.`);

  } catch (error) {
    console.error(` !! ERROR processing ${entity}:`, error.message);
    if (error.response) {
      console.error(' !! API Status:', error.response.status);
      const errFilename = path.join(DUMP_DIR, `${entity}_error_response.json`);
      fs.writeFileSync(errFilename, JSON.stringify(error.response.data, null, 2));
      console.log(` -> Saved error body to: ./dumps/${entity}_error_response.json`);
    }
  }
}

async function main() {
  console.log('===================================================');
  console.log('VetBuddy API Data Inspector & Diagnostics Tool');
  console.log('===================================================');
  console.log(`URL: ${BASE}`);
  console.log(`UID: ${UID}`);
  console.log(`Password Loaded: Length=${(PASSWD||'').length} characters`);
  console.log(`Dumps will be saved in: ${DUMP_DIR}`);

  // Run dumps for the main endpoints. Adjust parameters if necessary.
  await dumpRawAndCleaned('clinics', 'clinic');
  await dumpRawAndCleaned('clients', 'clients');
  await dumpRawAndCleaned('patients', 'patients');
  await dumpRawAndCleaned('appointments', 'appointment');
  await dumpRawAndCleaned('invoices', 'invoice');
  await dumpRawAndCleaned('stock', 'stock');

  console.log('\n===================================================');
  console.log('COMPLETED! Inspect the files in the "./dumps" folder.');
  console.log('Compare the "*_raw_page1.json" files with "*_cleaned.json".');
  console.log('Look for missing fields, empty structures converted to null,');
  console.log('or arrays vs object mapping mismatches.');
  console.log('===================================================');
}

main();
