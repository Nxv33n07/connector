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

// Maps raw VetBuddy plan category names to standard categories used in the DB.
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
    "pathol",
    "culture",
    "cytol",
    "biopsy",
    "ecg",
    "echo",
    "endoscop",
  ],
  Hospitalization: [
    "hospital",
    "icu",
    "ward",
    "boarding",
    "kennel",
    "admission",
    "inpatient",
    "drip",
    "iv fluid",
    "oxygen",
    "nursing",
  ],
  Consultation: [
    "consult",
    "exam",
    "visit",
    "opd",
    "checkup",
    "check-up",
    "revisit",
    "follow",
    "second opinion",
    "triage",
  ],
  Food: [
    "food",
    "diet",
    "nutrition",
    "feed",
    "treat",
    "snack",
    "supplement",
    "vitamin",
    "probiotic",
    "dental chew",
  ],
  Grooming: [
    "groom",
    "bath",
    "spa",
    "nail",
    "clip",
    "trim",
    "haircut",
    "deshed",
    "ear clean",
    "anal gland",
  ],
};

function getStdCat(raw) {
  const s = (raw || "").toLowerCase();
  for (const [cat, kws] of Object.entries(CAT_MAP)) {
    if (kws.some((k) => s.includes(k))) return cat;
  }
  return "Others";
}

module.exports = { pool, query, getStdCat };
