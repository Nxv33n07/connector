/**
 * server.js — AllPets VetBuddy Remote MCP Server
 * ─────────────────────────────────────────────────
 * Runs as a standard HTTP server (Streamable HTTP transport).
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

require('dotenv').config();

const express                               = require('express');
const { McpServer }                         = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport }     = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z }                                 = require('zod');
const fs                                    = require('fs');
const path                                  = require('path');
const vb                                    = require('./vetbuddy.js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── IN-MEMORY DATA WAREHOUSE & CACHE ───────────────────────────────────────────
let warehouse = {
  lastSync: null,
  daily: {}, // Key: 'MM/DD/YYYY', Value: DaySummary object
  stockSnapshot: null,
  isSyncing: false,
  syncProgress: 'Not started'
};

const CACHE_FILE = path.join(__dirname, 'warehouse_cache.json');

function saveWarehouseToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(warehouse, null, 2));
  } catch (e) { console.error('[Warehouse Cache] Save failed:', e.message); }
}

function loadWarehouseFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      warehouse = { ...warehouse, ...data };
      console.log(`[Warehouse Cache] Loaded from disk. ${Object.keys(warehouse.daily||{}).length} days cached.`);
    }
  } catch (e) { console.error('[Warehouse Cache] Load failed:', e.message); }
}

// ── ANALYTICS MAPPERS ──────────────────────────────────────────────────────────
const CATEGORY_MAP = {
  Prescription:    ['prescript', 'pharmacy', 'medicine', 'drug', 'inj', 'tab', 'syrup', 'capsule', 'vial'],
  Laboratory:      ['lab', 'blood', 'test', 'diagnost', 'x-ray', 'scan', 'ultra', 'radiograph', 'imag', 'patho'],
  Hospitalization: ['hospit', 'ipd', 'board', 'stay', 'cag', 'ward', 'kennel'],
  Consultation:    ['consult', 'opd', 'visit', 'examin', 'check', 'review', 'follow'],
  Food:            ['food', 'diet', 'feed', 'treat', 'nutr', 'kibble', 'can'],
  Grooming:        ['groom', 'bath', 'clip', 'spa', 'trim', 'wash', 'hair', 'nail']
};

function getStandardCategory(catName) {
  const c = (catName || '').toLowerCase();
  for (const [stdCat, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some(kw => c.includes(kw))) return stdCat;
  }
  return 'Others';
}

function getDayNightShift(invoiceDateStr) {
  if (!invoiceDateStr || !invoiceDateStr.includes(' ')) return 'Day';
  const timePart = invoiceDateStr.split(' ')[1];
  const hour = parseInt(timePart.split(':')[0], 10);
  if (isNaN(hour)) return 'Day';
  // Corporate Rule matching DB: Day Shift is 9 AM to 9 PM
  return (hour >= 9 && hour < 21) ? 'Day' : 'Night';
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const today   = () => new Date().toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' });
const daysAgo = n  => { const d = new Date(); d.setDate(d.getDate()-n); return d.toLocaleDateString('en-US',{month:'2-digit',day:'2-digit',year:'numeric'}); };
const safeNum = v  => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const formatDate = d => d.toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' });
const ok      = d  => ({ content: [{ type:'text', text: JSON.stringify(d, null, 2) }] });
const err     = e  => ({ content: [{ type:'text', text:`Error: ${e.message||e}` }], isError: true });

// ── WAREHOUSE SYNC ENGINE ──────────────────────────────────────────────────────
async function syncDay(dateStr) {
  try {
    console.log(`[Warehouse Sync] Processing metrics for ${dateStr}...`);
    const [invoices, payments, newClients] = await Promise.all([
      vb.getInvoices({ startdate: dateStr, enddate: dateStr, max_pages: 5 }),
      vb.getPayments({ startpaymentdate: dateStr, endpaymentdate: dateStr, max_pages: 5 }),
      vb.getClients({ startdate: dateStr, enddate: dateStr, searchon: 'firstactive', max_pages: 5 })
    ]);

    let totalRevenue = 0;
    let dayInvoices = 0, nightInvoices = 0;
    let dayRevenue = 0, nightRevenue = 0;
    
    const speciesStats = {
      Canine: { day: 0, night: 0, revenue: 0 },
      Feline: { day: 0, night: 0, revenue: 0 },
      Others: { day: 0, night: 0, revenue: 0 }
    };

    const catRevenue = {
      Prescription: 0, Laboratory: 0, Hospitalization: 0, Consultation: 0, Food: 0, Grooming: 0, Others: 0
    };

    const uniqueClients = new Set();
    
    for (const inv of invoices) {
      const amt = safeNum(inv.InvoiceDetails?.InvoiceAmount);
      const timeStr = inv.InvoiceDetails?.InvoiceDate;
      
      totalRevenue += amt;
      if (inv.Client?.ClientID) uniqueClients.add(inv.Client.ClientID);
      
      const shift = getDayNightShift(timeStr);
      if (shift === 'Day') { dayInvoices++; dayRevenue += amt; }
      else { nightInvoices++; nightRevenue += amt; }
      
      const pats = inv.Patients?.Patient;
      const patArr = Array.isArray(pats) ? pats : pats ? [pats] : [];
      
      for (const pat of patArr) {
        let sp = pat.PatientSpecies || 'Others';
        if (sp !== 'Canine' && sp !== 'Feline') sp = 'Others';
        
        if (shift === 'Day') speciesStats[sp].day++;
        else speciesStats[sp].night++;
        
        const items = pat.Items?.Item;
        const itemArr = Array.isArray(items) ? items : items ? [items] : [];
        for (const item of itemArr) {
          const itemTotal = safeNum(item.Total);
          speciesStats[sp].revenue += itemTotal;
          const rawCat = item.PlanItem?.PlanCategory?.PlanCategoryName;
          const stdCat = getStandardCategory(rawCat);
          catRevenue[stdCat] += itemTotal;
        }
      }
    }

    const collectedAmount = payments.reduce((sum, p) => sum + safeNum(p.PaymentAmount), 0);

    return {
      date: dateStr,
      revenue: totalRevenue,
      collected: collectedAmount,
      invoicesCount: invoices.length,
      daySplit: { dayInvoices, nightInvoices, dayRevenue, nightRevenue },
      speciesSplit: speciesStats,
      categorySplit: catRevenue,
      customers: { uniqueClientsCount: uniqueClients.size, new: newClients.length, returning: Math.max(0, uniqueClients.size - newClients.length) }
    };
  } catch (e) {
    console.error(`[Warehouse Sync] Day failure for ${dateStr}:`, e.message);
    return null;
  }
}

async function syncStockSnapshot() {
  try {
    console.log('[Warehouse Sync] Capturing current stock/inventory reconciliation snapshot...');
    const stock = await vb.getStock({ max_pages: 20 }); 
    const stats = {
      totalItems: stock.length,
      negativeStockCount: 0,
      outOfStockCount: 0,
      lowStockCount: 0,
      totalValuation: 0,
      negativeStockSample: [],
      outOfStockSample: [],
      lowStockSample: [],
      categoryValuation: {}
    };
    
    for (const s of stock) {
      const oh = safeNum(s.OnhandQty);
      const th = safeNum(s.ThresholdQty);
      const cost = safeNum(s.PurchaseCost || s.Stock?.PlanItemDetails?.PlanItem?.CostPrice);
      const val = oh * cost;
      const name = s.Stock?.StockName || 'Unknown';
      const cat = s.Stock?.PlanItemDetails?.PlanItem?.PlanCategory?.PlanCategoryName || 'Uncategorised';
      
      if (oh < 0) {
        stats.negativeStockCount++;
        if (stats.negativeStockSample.length < 8) stats.negativeStockSample.push({ name, onhand: oh, category: cat });
      } else if (oh === 0) {
        stats.outOfStockCount++;
        if (stats.outOfStockSample.length < 8) stats.outOfStockSample.push({ name, category: cat });
      } else if (oh <= th) {
        stats.lowStockCount++;
        if (stats.lowStockSample.length < 8) stats.lowStockSample.push({ name, onhand: oh, threshold: th, category: cat });
      }
      
      if (val > 0) stats.totalValuation += val;
      stats.categoryValuation[cat] = (stats.categoryValuation[cat] || 0) + (val > 0 ? val : 0);
    }
    
    warehouse.stockSnapshot = stats;
    saveWarehouseToDisk();
  } catch (e) { console.error('[Warehouse Sync] Inventory capture failed:', e.message); }
}

async function syncWarehouseHistory(days = 30) {
  if (warehouse.isSyncing) return;
  warehouse.isSyncing = true;
  warehouse.syncProgress = `Syncing 0 of ${days}`;
  console.log(`[Warehouse Sync] COMMENCING background synchronization (${days} days historical context)...`);
  
  try {
    await syncStockSnapshot();
    
    for (let i = 0; i < days; i++) {
      const dStr = daysAgo(i);
      warehouse.syncProgress = `Syncing ${i+1} of ${days} (${dStr})`;
      const daySum = await syncDay(dStr);
      if (daySum) {
        warehouse.daily[dStr] = daySum;
        saveWarehouseToDisk();
      }
      // Politeness delay
      await new Promise(r => setTimeout(r, 200));
    }
    warehouse.lastSync = new Date().toISOString();
    warehouse.syncProgress = 'Fully synced';
    console.log(`[Warehouse Sync] SUCCESS: Pre-computation complete. Ready for AI dashboards.`);
  } catch (e) {
    warehouse.syncProgress = `Sync failed: ${e.message}`;
  } finally {
    warehouse.isSyncing = false;
    saveWarehouseToDisk();
  }
}

// Dynamically fetches and hydrates any missing dates between startDt and endDt.
// If missing <= 12 days, fetches synchronously. If more, triggers background sync.
async function ensureDatesHydrated(startDt, endDt) {
  const missing = [];
  // Loop through every day between start and end (inclusive)
  const d = new Date(startDt);
  // Reset time parts for safe calendar day comparison
  d.setHours(0,0,0,0);
  const terminal = new Date(endDt);
  terminal.setHours(23,59,59,999);

  while (d <= terminal) {
    const dStr = formatDate(d);
    if (!warehouse.daily[dStr]) missing.push(dStr);
    d.setDate(d.getDate() + 1);
  }

  if (missing.length === 0) return true;

  console.log(`[Warehouse Sync] On-Demand Self-Hydration triggered for ${missing.length} missing dates.`);

  if (missing.length <= 12) {
    // Safe to block and download in real-time (under Claude 30s timeout)
    for (const dStr of missing) {
      const daySum = await syncDay(dStr);
      if (daySum) {
        warehouse.daily[dStr] = daySum;
        saveWarehouseToDisk(); // Update disk as we download
      }
      await new Promise(r => setTimeout(r, 150)); // Slight breath
    }
    return true;
  } else {
    // Too heavy to block synchronously! Hand off to background thread
    const totalDaysDiff = Math.ceil((terminal - new Date(startDt)) / (1000 * 60 * 60 * 24)) + 1;
    console.log(`[Warehouse Sync] Triggering large historical hydration for past ${totalDaysDiff} days in background...`);
    syncWarehouseHistory(totalDaysDiff).catch(e => console.error('[Background Hydrate Fail]', e.message));
    throw new Error(`I am currently downloading ${missing.length} missing historical days from VetBuddy ERP to build your full report. I have started this in the background — please try this query again in 10 seconds!`);
  }
}

// ── Build MCP server ──────────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: 'allpets-vetbuddy', version: '1.0.0' });

  // ── DAILY BRIEFING ──────────────────────────────────────────────────────────
  server.tool('daily_briefing',
    'Full morning briefing: today\'s appointments, overdue reminders, stock alerts, yesterday\'s revenue. Use for "good morning", "what\'s today\'s status", "give me a briefing".',
    { clinic_id: z.string().optional() },
    async ({ clinic_id }) => {
      try {
        const cid = clinic_id;
        // Fetch today's small operational lists in real-time (very fast)
        const [appts, reminders, invoices, payments] = await Promise.all([
          vb.getAppointments({ startdate:today(), enddate:today(), max_pages: 2, ...(cid?{clinicid:cid}:{}) }),
          vb.getReminders({ status:'overdue', max_pages: 2 }),
          vb.getInvoices({ startdate:daysAgo(1), enddate:daysAgo(1), max_pages: 2, ...(cid?{clinicid:cid}:{}) }),
          vb.getPayments({ startpaymentdate:daysAgo(1), endpaymentdate:daysAgo(1), max_pages: 2, ...(cid?{clinicid:cid}:{}) }),
        ]);
        
        const byStatus = {};
        for (const a of appts) { const s=a.AppointmentStatus||'unknown'; byStatus[s]=(byStatus[s]||0)+1; }
        
        const revenue    = invoices.reduce((s,i)=>s+safeNum(i.InvoiceDetails?.InvoiceAmount),0);
        const collected  = payments.reduce((s,p)=>s+safeNum(p.PaymentAmount),0);
        const stock      = warehouse.stockSnapshot || { negativeStockCount: 0, outOfStockCount: 0, lowStockCount: 0, negativeStockSample:[], outOfStockSample:[], lowStockSample:[] };

        return ok({
          date: today(),
          sync_warehouse: { last_sync: warehouse.lastSync, syncing: warehouse.isSyncing, progress: warehouse.syncProgress },
          today_appointments: {
            total: appts.length, by_status: byStatus,
            next_pending: appts.filter(a=>a.AppointmentStatus==='pending').slice(0,5).map(a=>({
              time:a.AppointmentStartTime, patient:a.Patient?.PatientName,
              type:a.AppointmentType?.AppointmentTypeName, doctor:a.AppointmentResources?.Providers?.Staff?.StaffName,
            })),
          },
          overdue_reminders: {
            total: reminders.length,
            sample: reminders.slice(0,5).map(r=>({ patient:r.Patient?.PatientName, reminder:r.ReminderName, due:r.DateToRemind, mobile:r.Client?.ClientUniqueID })),
          },
          inventory_alerts_from_warehouse: {
            negative_stock_mismatch: stock.negativeStockCount,
            out_of_stock: stock.outOfStockCount,
            low_stock: stock.lowStockCount,
            critical_action_needed: [...(stock.negativeStockSample||[]), ...(stock.outOfStockSample||[])].slice(0, 8)
          },
          yesterday: { invoices: invoices.length, revenue:revenue.toFixed(2), collected:collected.toFixed(2), outstanding:(revenue-collected).toFixed(2) },
        });
      } catch(e) { return err(e); }
    }
  );

  // ── REVENUE & INVOICE DASHBOARD ──────────────────────────────────────────────
  server.tool('get_revenue',
    'Revenue dashboard — instantly aggregates precomputed summaries, Day/Night split, category distribution, collection rates.',
    { from_date:z.string().optional().describe('MM/DD/YYYY'), to_date:z.string().optional().describe('MM/DD/YYYY') },
    async ({ from_date, to_date }) => {
      try {
        const from = from_date || daysAgo(30);
        const to = to_date || today();
        
        const start = new Date(from), end = new Date(to);
        
        // On-demand Self Hydrator (Masterpiece architecture feature)
        await ensureDatesHydrated(start, end);

        let matchingDates = Object.keys(warehouse.daily).filter(d => {
          const cur = new Date(d);
          return cur >= start && cur <= end;
        });

        let totalRev = 0, totalCol = 0, totalInv = 0;
        let dayRev = 0, nightRev = 0, dayInv = 0, nightInv = 0;
        const catTotals = { Prescription: 0, Laboratory: 0, Hospitalization: 0, Consultation: 0, Food: 0, Grooming: 0, Others: 0 };
        
        for (const d of matchingDates) {
          const day = warehouse.daily[d];
          totalRev += day.revenue;
          totalCol += day.collected;
          totalInv += day.invoicesCount;
          
          dayRev += day.daySplit.dayRevenue;
          nightRev += day.daySplit.nightRevenue;
          dayInv += day.daySplit.dayInvoices;
          nightInv += day.daySplit.nightInvoices;
          
          for (const [c, v] of Object.entries(day.categorySplit)) {
            if (catTotals[c] !== undefined) catTotals[c] += v;
          }
        }

        return ok({
          metrics_type: "Analytics Warehouse (Pre-Computed)",
          period: { from, to, days_included: matchingDates.length },
          revenue_summary: {
            total_revenue: totalRev.toFixed(2),
            total_collected: totalCol.toFixed(2),
            collection_rate: totalRev > 0 ? ((totalCol / totalRev) * 100).toFixed(1) + '%' : '0%',
            outstanding_receivables: (totalRev - totalCol).toFixed(2),
            invoices_count: totalInv,
            avg_invoice_value: totalInv > 0 ? (totalRev / totalInv).toFixed(2) : '0.00'
          },
          day_night_billing_split: {
            day_shift_9am_9pm:   { count: dayInv, revenue: dayRev.toFixed(2), proportion: totalInv>0?((dayInv/totalInv)*100).toFixed(1)+'%':'0%' },
            night_shift_9pm_9am: { count: nightInv, revenue: nightRev.toFixed(2), proportion: totalInv>0?((nightInv/totalInv)*100).toFixed(1)+'%':'0%' }
          },
          standard_category_split: Object.fromEntries(Object.entries(catTotals).map(([k,v]) => [k, v.toFixed(2)])),
          sync_metadata: { last_sync: warehouse.lastSync, syncing: warehouse.isSyncing }
        });
      } catch(e) { return err(e); }
    }
  );

  // ── PAYMENTS ─────────────────────────────────────────────────────────────────
  server.tool('get_payments',
    'Payment collections — total collected, by payment method (GPay, cash, etc). Use for "how much collected today", "payment method breakdown".',
    { from_date:z.string().optional(), to_date:z.string().optional(), clinic_id:z.string().optional(), client_id:z.string().optional() },
    async ({ from_date, to_date, clinic_id, client_id }) => {
      try {
        const payments = await vb.getPayments({
          startpaymentdate:from_date||today(), endpaymentdate:to_date||today(),
          ...(clinic_id?{clinicid:clinic_id}:{}), ...(client_id?{clientid:client_id}:{}),
        });
        let total=0; const byMethod={};
        for (const p of payments) {
          const amt=safeNum(p.PaymentAmount), method=p.PaymentType?.PaymentTypeName||'Unknown';
          total+=amt; byMethod[method]=(byMethod[method]||0)+amt;
        }
        return ok({
          period:{from:from_date||today(),to:to_date||today()}, total_collected:total.toFixed(2),
          by_method:Object.fromEntries(Object.entries(byMethod).map(([k,v])=>[k,v.toFixed(2)])),
          count:payments.length,
          payments:payments.map(p=>({ id:p.PaymentID, amount:p.PaymentAmount, method:p.PaymentType?.PaymentTypeName, date:p.PaymentDate, client:p.Client?.ClientName, receipt:p.ReceiptNo })),
        });
      } catch(e) { return err(e); }
    }
  );

  // ── APPOINTMENTS ─────────────────────────────────────────────────────────────
  server.tool('get_appointments',
    'List appointments — today\'s schedule, by status, by doctor. Use for "show today\'s appointments", "pending appointments", "list surgeries this week".',
    { from_date:z.string().optional(), to_date:z.string().optional(), status:z.enum(['pending','waiting','attending','completed','cancel']).optional(), clinic_id:z.string().optional(), staff_id:z.string().optional(), patient_id:z.string().optional(), client_id:z.string().optional() },
    async ({ from_date, to_date, status, clinic_id, staff_id, patient_id, client_id }) => {
      try {
        const appts = await vb.getAppointments({
          startdate:from_date||today(), enddate:to_date||today(),
          ...(status?{status}:{}), ...(clinic_id?{clinicid:clinic_id}:{}),
          ...(staff_id?{staffid:staff_id}:{}), ...(patient_id?{patientid:patient_id}:{}),
          ...(client_id?{clientid:client_id}:{}),
        });
        const byStatus={}, byType={}, byDoctor={};
        for (const a of appts) {
          const s=a.AppointmentStatus||'unknown', t=a.AppointmentType?.AppointmentTypeName||'Unknown', d=a.AppointmentResources?.Providers?.Staff?.StaffName||'Unassigned';
          byStatus[s]=(byStatus[s]||0)+1; byType[t]=(byType[t]||0)+1; byDoctor[d]=(byDoctor[d]||0)+1;
        }
        return ok({
          total:appts.length, by_status:byStatus, by_type:byType, by_doctor:byDoctor,
          appointments:appts.map(a=>({ id:a.AppointmentID, patient:a.Patient?.PatientName, client_id:a.Client?.ClientID, type:a.AppointmentType?.AppointmentTypeName, reason:a.ReasonForVisit?.ReasonForVisitName, doctor:a.AppointmentResources?.Providers?.Staff?.StaffName, start:a.AppointmentStartTime, end:a.AppointmentEndTime, status:a.AppointmentStatus, clinic:a.Clinic?.ClinicName })),
        });
      } catch(e) { return err(e); }
    }
  );

  // ── PATIENTS ─────────────────────────────────────────────────────────────────
  server.tool('get_patients',
    'Search patients (pets). Supports safety capping and local name matching to avoid timeouts.',
    { name_query:z.string().optional().describe('Search keyword for pet name'), patient_id:z.string().optional(), client_id:z.string().optional(), status:z.enum(['Active','InActive','Deceased']).optional(), clinic_id:z.string().optional() },
    async ({ name_query, patient_id, client_id, status, clinic_id }) => {
      try {
        // Force cap at 10 pages max to guarantee speed
        const patients = await vb.getPatients({ max_pages: 10, ...(patient_id?{patientid:patient_id}:{}), ...(client_id?{clientid:client_id}:{}), ...(status?{status}:{}), ...(clinic_id?{clinicid:clinic_id}:{}) });
        
        let filtered = patients;
        if (name_query) {
          const q = name_query.toLowerCase();
          filtered = patients.filter(p => (p.PatientName||'').toLowerCase().includes(q));
        }
        
        const bySpecies={};
        for (const p of filtered) { const sp=p.Species?.SpeciesName||'Unknown'; bySpecies[sp]=(bySpecies[sp]||0)+1; }
        
        return ok({
          total_matching: filtered.length,
          species_breakdown: bySpecies,
          patients_sample: filtered.slice(0, 15).map(p=>({ id:p.PatientID, name:p.PatientName, species:p.Species?.SpeciesName, breed:p.Breed?.BreedName, dob:p.BirthDate, status:p.Status, client_id:p.ClientID, owner:`${p.ClientFirstName||''} ${p.ClientLastName||''}`.trim(), mobile:p.MobilePhone, last_visit:p.LastActivity }))
        });
      } catch(e) { return err(e); }
    }
  );

  // ── CLIENTS ──────────────────────────────────────────────────────────────────
  server.tool('get_clients',
    'Search clients (pet owners). Supports safety capping and local name/phone search.',
    { name_query:z.string().optional().describe('Search keyword for owner name or phone'), client_id:z.string().optional(), status:z.enum(['Active','InActive']).optional(), clinic_id:z.string().optional(), from_date:z.string().optional(), to_date:z.string().optional(), search_on:z.enum(['firstactive','lastactive']).optional() },
    async ({ name_query, client_id, status, clinic_id, from_date, to_date, search_on }) => {
      try {
        // Force cap at 10 pages
        const clients = await vb.getClients({ max_pages: 10, ...(client_id?{clientid:client_id}:{}), ...(status?{status}:{}), ...(clinic_id?{clinicid:clinic_id}:{}), ...(from_date?{startdate:from_date}:{}), ...(to_date?{enddate:to_date}:{}), ...(search_on?{searchon:search_on}:{}) });
        
        let filtered = clients;
        if (name_query) {
          const q = name_query.toLowerCase();
          filtered = clients.filter(c => {
            const name = `${c.FirstName||''} ${c.LastName||''}`.toLowerCase();
            const ph = `${c.MobilePhone||c.HomePhone||''}`;
            return name.includes(q) || ph.includes(q);
          });
        }
        
        return ok({
          total_matching: filtered.length,
          clients_sample: filtered.slice(0, 15).map(c=>({ id:c.ClientID, name:`${c.FirstName||''} ${c.LastName||''}`.trim(), mobile:c.MobilePhone||c.HomePhone, status:c.Status, first_visit:c.FirstActivity, last_visit:c.LastActivity }))
        });
      } catch(e) { return err(e); }
    }
  );

  // ── STOCK ────────────────────────────────────────────────────────────────────
  server.tool('get_stock',
    'Search inventory items. Includes safety capping and keyword search.',
    { name_query:z.string().optional().describe('Search keyword for item name'), clinic_id:z.string().optional(), category:z.string().optional() },
    async ({ name_query, clinic_id, category }) => {
      try {
        // Force cap at 15 pages
        const stock = await vb.getStock({ max_pages: 15, ...(clinic_id?{clinicid:clinic_id}:{}), ...(category?{category}:{}) });
        
        let filtered = stock;
        if (name_query) {
          const q = name_query.toLowerCase();
          filtered = stock.filter(s => (s.Stock?.StockName||'').toLowerCase().includes(q));
        }
        
        const outOfStock=[], lowStock=[], adequate=[];
        for (const s of filtered) {
          const oh=safeNum(s.OnhandQty), th=safeNum(s.ThresholdQty);
          const item={ name:s.Stock?.StockName, onhand:oh, threshold:th, reorder:safeNum(s.ReorderQty), category:s.Stock?.PlanItemDetails?.PlanItem?.PlanCategory?.PlanCategoryName };
          if (oh<=0) outOfStock.push(item); else if (oh<=th) lowStock.push(item); else adequate.push(item);
        }
        return ok({
          total_matching: filtered.length,
          out_of_stock_count: outOfStock.length,
          low_stock_count: lowStock.length,
          adequate_stock_count: adequate.length,
          out_of_stock_sample: outOfStock.slice(0, 15),
          low_stock_sample: lowStock.slice(0, 15)
        });
      } catch(e) { return err(e); }
    }
  );

  // ── STAFF ────────────────────────────────────────────────────────────────────
  server.tool('get_staff',
    'List staff members. Use for "who are our doctors", "list all staff", "find staff ID for Dr Raje".',
    { clinic_id:z.string().optional(), staff_id:z.string().optional(), status:z.enum(['active','inactive']).optional(), staff_category:z.string().optional() },
    async ({ clinic_id, staff_id, status, staff_category }) => {
      try {
        const staff = await vb.getStaff({ ...(clinic_id?{clinicid:clinic_id}:{}), ...(staff_id?{staffid:staff_id}:{}), ...(status?{status}:{}), ...(staff_category?{staffcategory:staff_category}:{}) });
        return ok({ total:staff.length, staff:staff.map(s=>({ id:s.StaffID, name:`${s.FirstName||''} ${s.LastName||''}`.trim(), category:s.StaffCategoryName, email:s.Email, clinic:s.ClinicName, status:s.Status })) });
      } catch(e) { return err(e); }
    }
  );

  // ── REMINDERS ────────────────────────────────────────────────────────────────
  server.tool('get_reminders',
    'Patient reminders — due, overdue, expiring. Use for "overdue reminders", "patients needing follow-up", "vaccination reminders this week".',
    { status:z.enum(['due','overdue','expires']).optional(), patient_id:z.string().optional(), client_id:z.string().optional(), from_date:z.string().optional(), to_date:z.string().optional() },
    async ({ status, patient_id, client_id, from_date, to_date }) => {
      try {
        const reminders = await vb.getReminders({ ...(status?{status}:{}), ...(patient_id?{patientid:patient_id}:{}), ...(client_id?{clientid:client_id}:{}), ...(from_date?{startdate:from_date}:{}), ...(to_date?{enddate:to_date}:{}) });
        return ok({ total:reminders.length, reminders:reminders.map(r=>({ id:r.ReminderID, name:r.ReminderName, patient:r.Patient?.PatientName, patient_id:r.Patient?.PatientID, client:r.Client?.ClientName, mobile:r.Client?.ClientUniqueID, due:r.DateToRemind, expiry:r.DateOfExpiry, doctor:r.Staff?.StaffName, type:r.ReminderType })) });
      } catch(e) { return err(e); }
    }
  );

  // ── CLIENT ACCOUNT ───────────────────────────────────────────────────────────
  server.tool('get_client_account',
    'Client account summary — balance, credits, outstanding. Use for "what does client 24 owe", "account balance for Hemant".',
    { client_id:z.string().describe('VetBuddy Client ID') },
    async ({ client_id }) => {
      try { return ok(await vb.getClientAccountSummary(client_id)); }
      catch(e) { return err(e); }
    }
  );

  // ── MEDICAL RECORDS ──────────────────────────────────────────────────────────
  server.tool('get_medical_records',
    'List visit history for a patient or client. Use for "show visits for Doggy", "visit history client 24".',
    { patient_id:z.string().optional(), client_id:z.string().optional() },
    async ({ patient_id, client_id }) => {
      try {
        const records = await vb.getMedicalRecords({ ...(patient_id?{patientid:patient_id}:{}), ...(client_id?{clientid:client_id}:{}) });
        return ok({ total:records.length, records:records.map(r=>({ visit_id:r.Visit?.VisitID, visit_name:r.Visit?.VisitName, patient:r.Patient?.PatientName, created:r.CreatedOn, modified:r.LastModified, status:r.CaseStatus })) });
      } catch(e) { return err(e); }
    }
  );

  // ── STAFF AVAILABILITY ───────────────────────────────────────────────────────
  server.tool('get_staff_availability',
    'Who is available on a given date. Use for "who is working tomorrow", "is Dr Raje available Friday".',
    { date:z.string().describe('MM/DD/YYYY'), clinic_id:z.string() },
    async ({ date, clinic_id }) => {
      try {
        const avail = await vb.getStaffAvailability(date, clinic_id);
        if (!avail) return ok({ message:'No availability data found.' });
        const staffList = Array.isArray(avail.Staffs?.Staff) ? avail.Staffs.Staff : avail.Staffs?.Staff ? [avail.Staffs.Staff] : [];
        return ok({ date, clinic:avail.Clinic?.ClinicName, staff:staffList.map(s=>{ const slots=(s.Slots||'').split(','), okSlots=slots.filter(sl=>sl.endsWith('OK')).length; return { id:s.StaffID, name:s.StaffName, category:s.StaffCategory?.StaffCategoryName, rota:s.RotaAssigned?.RotaName, hours:s.RotaAssigned?.Time, available_slots:okSlots, status:okSlots>0?'Available':'Not Available' }; }) });
      } catch(e) { return err(e); }
    }
  );

  // ── CLINIC INFO ──────────────────────────────────────────────────────────────
  server.tool('get_clinic_info', 'Get clinic details — name, address, contact.', {},
    async () => { try { return ok({ clinics: await vb.getClinics() }); } catch(e) { return err(e); } }
  );

  // ── BUSINESS INSIGHTS ────────────────────────────────────────────────────────
  server.tool('business_insights',
    'Primary Business Dashboard — aggregates multi-dimensional KPIs: Revenue, Day/Night split, Species matrix, New vs Old customers, Stock Reconciliation.',
    { from_date:z.string().optional().describe('MM/DD/YYYY'), to_date:z.string().optional().describe('MM/DD/YYYY') },
    async ({ from_date, to_date }) => {
      try {
        const from = from_date || daysAgo(30);
        const to = to_date || today();
        
        const start = new Date(from), end = new Date(to);

        // On-demand Self Hydrator (Masterpiece architecture feature)
        await ensureDatesHydrated(start, end);

        let matchingDates = Object.keys(warehouse.daily).filter(d => {
          const cur = new Date(d);
          return cur >= start && cur <= end;
        });

        let totalRevenue = 0, totalCollected = 0, totalInvoices = 0;
        let dayRev = 0, nightRev = 0, dayInv = 0, nightInv = 0;
        let newCustAcq = 0, returningCustVisits = 0;
        
        const catTotals = { Prescription:0, Laboratory:0, Hospitalization:0, Consultation:0, Food:0, Grooming:0, Others:0 };
        const speciesCohorts = {
          Canine: { day_visits: 0, night_visits: 0, revenue: 0 },
          Feline: { day_visits: 0, night_visits: 0, revenue: 0 },
          Others: { day_visits: 0, night_visits: 0, revenue: 0 }
        };

        for (const d of matchingDates) {
          const day = warehouse.daily[d];
          totalRevenue += day.revenue;
          totalCollected += day.collected;
          totalInvoices += day.invoicesCount;
          
          dayRev += day.daySplit.dayRevenue;
          nightRev += day.daySplit.nightRevenue;
          dayInv += day.daySplit.dayInvoices;
          nightInv += day.daySplit.nightInvoices;
          
          newCustAcq += day.customers.new;
          returningCustVisits += day.customers.returning;
          
          for (const [cat, amt] of Object.entries(day.categorySplit)) {
            if (catTotals[cat] !== undefined) catTotals[cat] += amt;
          }
          
          for (const [sp, vals] of Object.entries(day.speciesSplit)) {
            if (speciesCohorts[sp]) {
              speciesCohorts[sp].day_visits += vals.day;
              speciesCohorts[sp].night_visits += vals.night;
              speciesCohorts[sp].revenue += vals.revenue;
            }
          }
        }

        const stock = warehouse.stockSnapshot || { totalItems:0, negativeStockCount:0, outOfStockCount:0, totalValuation:0 };

        return ok({
          dashboard_period: { from, to, data_days_analyzed: matchingDates.length },
          warehouse_sync: { last_sync: warehouse.lastSync, status: warehouse.syncProgress },
          revenue_health: {
            total_billed: totalRevenue.toFixed(2),
            total_collected: totalCollected.toFixed(2),
            collection_rate: totalRevenue > 0 ? ((totalCollected / totalRevenue) * 100).toFixed(1) + '%' : '0%',
            avg_ticket_value: totalInvoices > 0 ? (totalRevenue / totalInvoices).toFixed(2) : '0.00'
          },
          day_night_matrix: {
            day_shift_9am_9pm:   { invoices: dayInv, revenue: dayRev.toFixed(2) },
            night_shift_9pm_9am: { invoices: nightInv, revenue: nightRev.toFixed(2) }
          },
          species_day_night_cohorts: speciesCohorts,
          business_category_split: Object.fromEntries(Object.entries(catTotals).map(([k,v]) => [k, v.toFixed(2)])),
          customer_cohorts: {
            newly_registered_clients_count: newCustAcq,
            returning_client_visits_count: returningCustVisits,
            ratio: (newCustAcq + returningCustVisits) > 0 ? ((newCustAcq / (newCustAcq + returningCustVisits)) * 100).toFixed(1) + '% New' : '0%'
          },
          inventory_reconciliation: {
            total_tracked_skus: stock.totalItems,
            stock_mismatch_negatives: stock.negativeStockCount,
            out_of_stock_skus: stock.outOfStockCount,
            system_estimated_valuation: stock.totalValuation ? stock.totalValuation.toFixed(2) : '0.00',
            critical_discrepancies: stock.negativeStockSample || []
          }
        });
      } catch(e) { return err(e); }
    }
  );

  // ── CREATE CLIENT ────────────────────────────────────────────────────────────
  server.tool('create_client',
    'Register a new client (pet owner) in VetBuddy.',
    { clinic_name:z.string(), first_name:z.string(), last_name:z.string(), mobile:z.string(), email:z.string().optional(), address1:z.string().optional(), city:z.string().optional(), state:z.string().optional(), zip:z.string().optional() },
    async (args) => {
      try {
        const result = await vb.createClient({ ClinicName:args.clinic_name, FirstName:args.first_name, LastName:args.last_name, MobilePhone:args.mobile, Email:args.email||'', Address1:args.address1||'', City:args.city||'', State:args.state||'', Zip:args.zip||'', Status:'Active' });
        return result.success ? ok({ message:'Client created.', vetbuddy_client_id:result.id }) : err({ message:result.raw });
      } catch(e) { return err(e); }
    }
  );

  // ── UPDATE CLIENT ────────────────────────────────────────────────────────────
  server.tool('update_client',
    'Update an existing client\'s details.',
    { client_id:z.string(), clinic_name:z.string(), first_name:z.string().optional(), last_name:z.string().optional(), mobile:z.string().optional(), email:z.string().optional(), city:z.string().optional(), state:z.string().optional(), zip:z.string().optional(), status:z.enum(['Active','InActive']).optional() },
    async (args) => {
      try {
        const result = await vb.updateClient({ ClientID:args.client_id, ClinicName:args.clinic_name, FirstName:args.first_name||'', LastName:args.last_name||'', MobilePhone:args.mobile||'', Email:args.email||'', City:args.city||'', State:args.state||'', Zip:args.zip||'', Status:args.status||'Active' });
        return result.success ? ok({ message:'Client updated.', id:result.id }) : err({ message:result.raw });
      } catch(e) { return err(e); }
    }
  );

  // ── CREATE PATIENT ───────────────────────────────────────────────────────────
  server.tool('create_patient',
    'Register a new patient (pet) under an existing client.',
    { clinic_name:z.string(), client_id:z.string(), patient_name:z.string(), species:z.string(), breed:z.string().optional(), gender:z.string().optional(), neutered:z.enum(['TRUE','FALSE']).optional(), dob:z.string().optional().describe('MM/DD/YYYY'), comment:z.string().optional() },
    async (args) => {
      try {
        const result = await vb.createPatient({ ClinicName:args.clinic_name, ClientID:args.client_id, PatientName:args.patient_name, SpeciesName:args.species, BreedName:args.breed||'', GenderName:args.gender||'', Neutered:args.neutered||'FALSE', BirthDate:args.dob||'', Comment:args.comment||'' });
        return result.success ? ok({ message:'Patient registered.', vetbuddy_patient_id:result.id }) : err({ message:result.raw });
      } catch(e) { return err(e); }
    }
  );

  // ── UPDATE PATIENT ───────────────────────────────────────────────────────────
  server.tool('update_patient',
    'Update an existing patient\'s details.',
    { patient_id:z.string(), clinic_name:z.string(), client_id:z.string(), patient_name:z.string().optional(), species:z.string().optional(), breed:z.string().optional(), gender:z.string().optional(), neutered:z.enum(['TRUE','FALSE']).optional(), dob:z.string().optional(), status:z.enum(['Active','InActive','Deceased']).optional() },
    async (args) => {
      try {
        const result = await vb.updatePatient({ PatientID:args.patient_id, ClientID:args.client_id, ClinicName:args.clinic_name, PatientName:args.patient_name||'', SpeciesName:args.species||'', BreedName:args.breed||'', GenderName:args.gender||'', Neutered:args.neutered||'FALSE', BirthDate:args.dob||'', Status:args.status||'Active' });
        return result.success ? ok({ message:'Patient updated.', id:result.id }) : err({ message:result.raw });
      } catch(e) { return err(e); }
    }
  );

  // ── BOOK APPOINTMENT ─────────────────────────────────────────────────────────
  server.tool('book_appointment',
    'Book a new appointment. Use for "schedule appointment", "book a consultation for Bella".',
    { client_id:z.string(), patient_id:z.string(), clinic_name:z.string(), type:z.string().describe('e.g. "OPD Consultation", "Surgery", "Grooming"'), reason:z.string().optional(), start_time:z.string().describe('MM/DD/YYYY HH:MM:SS'), end_time:z.string().describe('MM/DD/YYYY HH:MM:SS'), staff_id:z.string().optional() },
    async (args) => {
      try {
        const result = await vb.createAppointment({ ClientID:args.client_id, PatientID:args.patient_id, ClinicName:args.clinic_name, AppointmentTypeName:args.type, ReasonForVisitName:args.reason||'', AppointmentStartTime:args.start_time, AppointmentEndTime:args.end_time, AppointmentStatus:'Pending', StaffID:args.staff_id||'' });
        return result.success ? ok({ message:'Appointment booked.', vetbuddy_appointment_id:result.id }) : err({ message:result.raw });
      } catch(e) { return err(e); }
    }
  );

  // ── CANCEL APPOINTMENT ───────────────────────────────────────────────────────
  server.tool('cancel_appointment',
    'Cancel an existing appointment.',
    { appointment_id:z.string(), client_id:z.string(), patient_id:z.string(), clinic_name:z.string(), start_time:z.string(), end_time:z.string(), staff_id:z.string().optional(), cancelled_by:z.string().optional() },
    async (args) => {
      try {
        const result = await vb.cancelAppointment({ AppointmentID:args.appointment_id, ClientID:args.client_id, PatientID:args.patient_id, ClinicName:args.clinic_name, AppointmentStartTime:args.start_time, AppointmentEndTime:args.end_time, StaffID:args.staff_id||'', CancelledBy:args.cancelled_by||'reception' });
        return result.success ? ok({ message:'Appointment cancelled.' }) : err({ message:result.raw });
      } catch(e) { return err(e); }
    }
  );

  // ── WAREHOUSE MANAGEMENT ─────────────────────────────────────────────────────
  server.tool('force_warehouse_sync',
    'Trigger a manual refresh/hydration of the Analytics Warehouse. Use to sync the latest X days of metrics.',
    { days:z.number().min(1).max(90).default(30).describe('How many past days to re-compute') },
    async ({ days }) => {
      if (warehouse.isSyncing) return ok({ message: 'Sync already in progress.', progress: warehouse.syncProgress });
      // Fire and forget in the background to prevent HTTP timeout
      syncWarehouseHistory(days).catch(console.error);
      return ok({ message: `Background sync initiated for past ${days} days. Check status again in business_insights.` });
    }
  );

  return server;
}

// ── HTTP endpoint — one session per request (stateless) ───────────────────────
app.post('/mcp', async (req, res) => {
  const mcpServer = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session persistence needed
  });
  res.on('close', () => transport.close().catch(() => {}));
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Request error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /mcp — required for Claude Desktop compatibility check
app.get('/mcp', (req, res) => {
  res.status(405).json({ error: 'Method not allowed. Use POST.' });
});

// Health check — Render uses this to confirm the service is up
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'AllPets VetBuddy MCP', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ service: 'AllPets VetBuddy MCP Server', mcp_endpoint: '/mcp', health: '/health' });
});

app.listen(PORT, () => {
  console.log(`[AllPets MCP] Server running on port ${PORT}`);
  console.log(`[AllPets MCP] MCP endpoint: http://localhost:${PORT}/mcp`);
  
  // Load cached analytics and fire up syncer
  try {
    loadWarehouseFromDisk();
    // Sync past 30 days in background on startup (async, no blocking)
    syncWarehouseHistory(30).catch(console.error);
    
    // Auto refresh every 6 hours to capture new data
    setInterval(() => {
      syncWarehouseHistory(3).catch(console.error); // Fetch just last 3 days repeatedly
    }, 1000 * 60 * 60 * 6);
  } catch (e) { console.error('[AllPets MCP] Failed initializing warehouse sync:', e.message); }
});
