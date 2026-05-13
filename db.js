/**
 * db.js — RDS connection pool + all analytical query functions
 * Every dashboard query runs as a single parameterised SQL call — no API pagination.
 */

const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "+00:00",
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ── Category mapper (same keyword rules as before) ────────────────────────────
const CAT_MAP = {
  Prescription: [
    "prescript",
    "pharmacy",
    "medicine",
    "drug",
    "parenteral",
    "antibiotic",
    "antiparasit",
    "parasiticide",
    "preventive",
    "vaccine",
    "tab",
    "syrup",
    "vial",
  ],
  Laboratory: [
    "lab",
    "blood",
    "test",
    "diagnost",
    "x-ray",
    "scan",
    "ultra",
    "radiograph",
    "imag",
    "patho",
    "serology",
    "hematology",
    "radiology",
  ],
  Hospitalization: [
    "hospit",
    "ipd",
    "board",
    "stay",
    "cag",
    "ward",
    "kennel",
    "surgery",
    "procedure",
    "soft tissue",
    "anaesth",
    "fluids",
  ],
  Consultation: [
    "consult",
    "opd",
    "visit",
    "examin",
    "check",
    "review",
    "follow",
  ],
  Food: ["food", "diet", "feed", "treat", "nutr", "kibble", "can", "pet shop"],
  Grooming: ["groom", "bath", "clip", "spa", "trim", "wash", "hair", "nail"],
};
function getStdCat(raw) {
  const c = (raw || "").toLowerCase();
  for (const [k, kws] of Object.entries(CAT_MAP))
    if (kws.some((kw) => c.includes(kw))) return k;
  return "Others";
}

// ── Main dashboard query — 13 parallel SQL calls, all indexed ─────────────────
async function queryDashboard(fromDate, toDate) {
  const [
    revRows,
    dnRows,
    colRows,
    speciesRows,
    catRows,
    subCatRows,
    custRows,
    stkSumRows,
    stkNegRows,
    stkOutRows,
    stkLowRows,
    stkFoodRows,
    stkSubRows,
    pmtMethodRows,
    returnedPmtRows,
    itemSplitRows,
    invoiceSplitRows,
  ] = await Promise.all([
    // 1. Revenue & invoice count — one row per invoice, no duplication
    query(
      `SELECT COALESCE(SUM(invoice_amount),0) AS rev, COUNT(*) AS inv
           FROM allpets_invoices
           WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0`,
      [fromDate, toDate],
    ),

    // 2. Day / Night split
    query(
      `SELECT
             COALESCE(SUM(CASE WHEN shift='Day'   THEN invoice_amount END),0) AS day_rev,
             COALESCE(SUM(CASE WHEN shift='Night' THEN invoice_amount END),0) AS night_rev,
             COALESCE(SUM(CASE WHEN shift='Day'   THEN 1 END),0) AS day_inv,
             COALESCE(SUM(CASE WHEN shift='Night' THEN 1 END),0) AS night_inv
           FROM allpets_invoices
           WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0`,
      [fromDate, toDate],
    ),

    // 3. Collected amount
    query(
      `SELECT COALESCE(SUM(payment_amount),0) AS collected, COUNT(*) AS txns
           FROM allpets_payments
           WHERE DATE(payment_date) BETWEEN ? AND ? AND returned=0
             AND payment_date IS NOT NULL`,
      [fromDate, toDate],
    ),

    // 4. Species — visits + revenue + day/night from pre-tagged items
    query(
      `SELECT species_group,
             COUNT(DISTINCT invoice_id) AS visits,
             COALESCE(SUM(CASE WHEN HOUR(invoice_date)>=9 AND HOUR(invoice_date)<21 THEN 1 END),0) AS day_items,
             COALESCE(SUM(CASE WHEN HOUR(invoice_date)<9  OR  HOUR(invoice_date)>=21 THEN 1 END),0) AS night_items,
             COALESCE(SUM(item_total),0) AS revenue,
             COUNT(DISTINCT patient_id) AS patients
           FROM allpets_invoice_items
           WHERE DATE(invoice_date) BETWEEN ? AND ?
           GROUP BY species_group`,
      [fromDate, toDate],
    ),

    // 5. Category revenue (std_category pre-mapped at sync time)
    query(
      `SELECT std_category AS cat, COALESCE(SUM(item_total),0) AS revenue
           FROM allpets_invoice_items
           WHERE DATE(invoice_date) BETWEEN ? AND ?
           GROUP BY std_category`,
      [fromDate, toDate],
    ),

    // 6. Sub-category revenue top 20
    query(
      `SELECT plan_sub_category_name AS sub_cat, COALESCE(SUM(item_total),0) AS revenue
           FROM allpets_invoice_items
           WHERE DATE(invoice_date) BETWEEN ? AND ?
             AND plan_sub_category_name IS NOT NULL AND plan_sub_category_name != ''
           GROUP BY plan_sub_category_name
           ORDER BY revenue DESC LIMIT 20`,
      [fromDate, toDate],
    ),

    // 7. New vs returning customers (pre-tagged at sync time)
    query(
      `SELECT
             COALESCE(SUM(is_new_client),0)     AS new_clients,
             COALESCE(SUM(1-is_new_client),0)   AS returning_clients,
             COUNT(DISTINCT client_id)          AS total_clients
           FROM allpets_invoices
           WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0`,
      [fromDate, toDate],
    ),

    // 8-13. Stock summary + detail samples
    query(
      `SELECT COUNT(*) AS total,
             SUM(stock_status='negative') AS neg,
             SUM(stock_status='out')      AS out_c,
             SUM(stock_status='low')      AS low_c,
             SUM(stock_status='adequate') AS adeq,
             COALESCE(SUM(CASE WHEN onhand_qty>0 AND purchase_cost>0 THEN onhand_qty*purchase_cost END),0) AS valuation
           FROM allpets_stock`,
      [],
    ),

    query(
      `SELECT stock_name AS name, plan_category_name AS cat, onhand_qty
           FROM allpets_stock WHERE stock_status='negative'
           ORDER BY onhand_qty ASC LIMIT 15`,
      [],
    ),

    query(
      `SELECT stock_name AS name, plan_category_name AS cat
           FROM allpets_stock WHERE stock_status='out' LIMIT 15`,
      [],
    ),

    query(
      `SELECT stock_name AS name, plan_category_name AS cat, onhand_qty, threshold_qty
           FROM allpets_stock WHERE stock_status='low'
           ORDER BY onhand_qty/NULLIF(threshold_qty,0) ASC LIMIT 15`,
      [],
    ),

    query(
      `SELECT stock_name AS name, plan_category_name AS cat, onhand_qty, threshold_qty,
                   ROUND(onhand_qty*purchase_cost,2) AS value
           FROM allpets_stock
           WHERE std_category='Food'
           ORDER BY onhand_qty*purchase_cost DESC LIMIT 20`,
      [],
    ),

    query(
      `SELECT plan_sub_category_name AS sub_cat, COUNT(*) AS skus,
                   SUM(onhand_qty) AS total_onhand,
                   COALESCE(SUM(CASE WHEN onhand_qty>0 AND purchase_cost>0
                             THEN onhand_qty*purchase_cost END),0) AS value
           FROM allpets_stock WHERE plan_sub_category_name IS NOT NULL
           GROUP BY plan_sub_category_name ORDER BY value DESC LIMIT 12`,
      [],
    ),

    // 14. Payments breakdown by method
    query(
      `SELECT payment_type_name AS payment_method, COUNT(*) AS txns, COALESCE(SUM(payment_amount),0) AS value
       FROM allpets_payments
       WHERE DATE(payment_date) BETWEEN ? AND ? AND returned=0
       GROUP BY payment_type_name ORDER BY value DESC`,
      [fromDate, toDate],
    ),

    // 15. Returned payments
    query(
      `SELECT COUNT(*) AS txns, COALESCE(SUM(payment_amount),0) AS value
       FROM allpets_payments
       WHERE DATE(payment_date) BETWEEN ? AND ? AND returned=1`,
      [fromDate, toDate],
    ),

    // 16. Item-level Pharmacy vs Service split
    query(
      `SELECT 
         CASE WHEN std_category = 'Prescription' THEN 'Pharmacy' ELSE 'Service' END AS type,
         COALESCE(SUM(item_total),0) AS revenue
       FROM allpets_invoice_items
       WHERE DATE(invoice_date) BETWEEN ? AND ?
       GROUP BY type`,
      [fromDate, toDate],
    ),

    // 17. Invoice count split (classified as pharmacy if contains ANY prescription)
    query(
      `SELECT 
         COALESCE(SUM(has_pharmacy),0) AS pharmacy_invoices,
         COALESCE(SUM(1-has_pharmacy),0) AS service_invoices
       FROM (
         SELECT invoice_id, MAX(CASE WHEN std_category = 'Prescription' THEN 1 ELSE 0 END) AS has_pharmacy
         FROM allpets_invoice_items
         WHERE DATE(invoice_date) BETWEEN ? AND ?
         GROUP BY invoice_id
       ) t`,
      [fromDate, toDate],
    ),
  ]);

  // Assemble species map
  const spMap = {
    Canine: { visits: 0, dayItems: 0, nightItems: 0, revenue: 0, patients: 0 },
    Feline: { visits: 0, dayItems: 0, nightItems: 0, revenue: 0, patients: 0 },
    Others: { visits: 0, dayItems: 0, nightItems: 0, revenue: 0, patients: 0 },
  };
  for (const r of speciesRows) {
    const k = r.species_group;
    if (spMap[k]) {
      spMap[k].visits += +r.visits;
      spMap[k].dayItems += +r.day_items;
      spMap[k].nightItems += +r.night_items;
      spMap[k].revenue += +r.revenue;
      spMap[k].patients += +r.patients || 0;
    }
  }

  // Assemble standard category totals
  const catTotals = {
    Prescription: 0,
    Laboratory: 0,
    Hospitalization: 0,
    Consultation: 0,
    Food: 0,
    Grooming: 0,
    Others: 0,
  };
  for (const r of catRows)
    if (catTotals[r.cat] !== undefined) catTotals[r.cat] += +r.revenue;

  // Format invoice classification
  const itemSplit = { Pharmacy: 0, Service: 0 };
  for (const r of itemSplitRows) {
    if (itemSplit[r.type] !== undefined) itemSplit[r.type] += +r.revenue;
  }

  const s = stkSumRows[0];
  return {
    fromDate,
    toDate,
    totalRevenue: +revRows[0].rev,
    invoiceCount: +revRows[0].inv,
    totalCollected: +colRows[0].collected,
    paymentTransactions: +colRows[0].txns || 0,
    dayRevenue: +dnRows[0].day_rev,
    nightRevenue: +dnRows[0].night_rev,
    dayInvoices: +dnRows[0].day_inv,
    nightInvoices: +dnRows[0].night_inv,
    species: spMap,
    catTotals,
    subCategories: subCatRows.map((r) => ({
      name: r.sub_cat,
      revenue: +r.revenue,
    })),
    newClients: +custRows[0].new_clients,
    returningClients: +custRows[0].returning_clients,
    totalUniqueClients: +custRows[0].total_clients || 0,
    stock: {
      totalItems: +s.total,
      negativeCount: +s.neg,
      outCount: +s.out_c,
      lowCount: +s.low_c,
      adequateCount: +s.adeq,
      valuation: +s.valuation,
      negativeItems: stkNegRows,
      outItems: stkOutRows,
      lowItems: stkLowRows,
      foodItems: stkFoodRows,
      subCatStock: stkSubRows,
    },
    paymentsBreakdown: pmtMethodRows.map((r) => ({
      method: r.payment_method || "Unknown",
      value: +r.value,
      txns: +r.txns,
    })),
    returnedPayments: {
      txns: +returnedPmtRows[0]?.txns || 0,
      value: +returnedPmtRows[0]?.value || 0,
    },
    revenueSplit: itemSplit,
    invoiceSplit: {
      pharmacy: +invoiceSplitRows[0]?.pharmacy_invoices || 0,
      service: +invoiceSplitRows[0]?.service_invoices || 0,
    },
  };
}

// ── Opportunity: week/month comparison — 4 parallel period queries ─────────────
async function queryOpportunity() {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const ago = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  };

  async function period(from, to) {
    const [rev, col, newC, cats, sps] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(invoice_amount),0) AS rev, COUNT(*) AS inv
             FROM allpets_invoices WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0`,
        [from, to],
      ),
      query(
        `SELECT COALESCE(SUM(payment_amount),0) AS col
             FROM allpets_payments WHERE DATE(payment_date) BETWEEN ? AND ? AND returned=0`,
        [from, to],
      ),
      query(
        `SELECT COALESCE(SUM(is_new_client),0) AS new_c
             FROM allpets_invoices WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0`,
        [from, to],
      ),
      query(
        `SELECT std_category AS cat, COALESCE(SUM(item_total),0) AS revenue
             FROM allpets_invoice_items WHERE DATE(invoice_date) BETWEEN ? AND ?
             GROUP BY std_category`,
        [from, to],
      ),
      query(
        `SELECT species_group AS sp, COALESCE(SUM(item_total),0) AS revenue
             FROM allpets_invoice_items WHERE DATE(invoice_date) BETWEEN ? AND ?
             GROUP BY species_group`,
        [from, to],
      ),
    ]);
    const cats_ = {};
    for (const r of cats) cats_[r.cat] = +r.revenue;
    const sps_ = { Canine: 0, Feline: 0, Others: 0 };
    for (const r of sps) sps_[r.sp] = (sps_[r.sp] || 0) + +r.revenue;
    return {
      rev: +rev[0].rev,
      col: +col[0].col,
      inv: +rev[0].inv,
      newC: +newC[0].new_c,
      cats: cats_,
      spRevs: sps_,
    };
  }

  const [thisWeek, lastWeek, thisMonth, lastMonth] = await Promise.all([
    period(fmt(ago(6)), fmt(new Date())),
    period(fmt(ago(13)), fmt(ago(7))),
    period(fmt(ago(29)), fmt(new Date())),
    period(fmt(ago(59)), fmt(ago(30))),
  ]);

  return { thisWeek, lastWeek, thisMonth, lastMonth };
}

// ── Daily trend: revenue + invoices per calendar day ─────────────────────────
async function queryDailyTrend(fromDate, toDate) {
  return query(
    `SELECT
       DATE(invoice_date)                          AS day,
       COALESCE(SUM(invoice_amount),0)             AS revenue,
       COUNT(*)                                    AS invoices,
       COALESCE(SUM(CASE WHEN shift='Day'   THEN invoice_amount END),0) AS day_rev,
       COALESCE(SUM(CASE WHEN shift='Night' THEN invoice_amount END),0) AS night_rev,
       COALESCE(SUM(is_new_client),0)              AS new_clients
     FROM allpets_invoices
     WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0
     GROUP BY DATE(invoice_date)
     ORDER BY day ASC`,
    [fromDate, toDate],
  );
}

// ── Top clients by total spend ────────────────────────────────────────────────
async function queryTopClients(fromDate, toDate, limit = 15) {
  return query(
    `SELECT
       client_id,
       COUNT(*)                       AS invoices,
       COALESCE(SUM(invoice_amount),0) AS total_spend,
       COALESCE(SUM(is_new_client),0)  AS is_new
     FROM allpets_invoices
     WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0
     GROUP BY client_id
     ORDER BY total_spend DESC
     LIMIT ?`,
    [fromDate, toDate, limit],
  );
}

// ── Hourly distribution: invoices + revenue per hour of day ──────────────────
async function queryHourlyDistribution(fromDate, toDate) {
  return query(
    `SELECT
       HOUR(invoice_date)              AS hour,
       COUNT(*)                        AS invoices,
       COALESCE(SUM(invoice_amount),0) AS revenue
     FROM allpets_invoices
     WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0
     GROUP BY HOUR(invoice_date)
     ORDER BY hour ASC`,
    [fromDate, toDate],
  );
}

// ── Client day/night shift pattern ───────────────────────────────────────────
// Returns per-client: day visits, night visits, day spend, night spend.
// Caller can split into day-only / night-only / both-shift segments.
async function queryClientShiftPattern(fromDate, toDate) {
  return query(
    `SELECT
       client_id,
       COUNT(*)                                                          AS total_visits,
       COALESCE(SUM(CASE WHEN shift='Day'   THEN 1 ELSE 0 END),0)       AS day_visits,
       COALESCE(SUM(CASE WHEN shift='Night' THEN 1 ELSE 0 END),0)       AS night_visits,
       COALESCE(SUM(CASE WHEN shift='Day'   THEN invoice_amount END),0) AS day_spend,
       COALESCE(SUM(CASE WHEN shift='Night' THEN invoice_amount END),0) AS night_spend
     FROM allpets_invoices
     WHERE DATE(invoice_date) BETWEEN ? AND ? AND cancelled=0
     GROUP BY client_id`,
    [fromDate, toDate],
  );
}

module.exports = {
  pool,
  query,
  queryDashboard,
  queryOpportunity,
  queryDailyTrend,
  queryTopClients,
  queryHourlyDistribution,
  queryClientShiftPattern,
  getStdCat,
};
