/**
 * vetbuddy.js — VetBuddy API client
 * Handles all read (Open API) and write (Push API) calls.
 * Token is cached in memory; auto-refreshes 24h before expiry.
 */

const axios = require("axios");

const BASE = process.env.VETBUDDY_APP_URL;
const PUSH_BASE = process.env.VETBUDDY_PUSH_URL;
const UID = process.env.VETBUDDY_UID;
const PASSWD = process.env.VETBUDDY_PASSWD;
const INSTANCE = process.env.VETBUDDY_INSTANCE;
const PUSH_KEY = process.env.VETBUDDY_PUSH_KEY;

// ── Token cache ───────────────────────────────────────────────────────────────
let _token = null,
  _expiresAt = 0,
  _tokenFetchPromise = null;

async function getToken() {
  if (_token && Date.now() < _expiresAt - 86400000) return _token;
  // Gate: if a fetch is already in-flight, wait for it instead of launching a second one
  if (_tokenFetchPromise) return _tokenFetchPromise;
  _tokenFetchPromise = (async () => {
    const res = await axios.get(`${BASE}/openapi.php`, {
      params: { action: "get_token", uid: UID, passwd: PASSWD },
      headers: { Accept: "application/json" },
      timeout: 10000,
    });
    if (!res.data?.Token)
      throw new Error(
        "VetBuddy token fetch failed: " + JSON.stringify(res.data),
      );
    _token = res.data.Token;
    _expiresAt = new Date(res.data.ExpiresOn.replace(" ", "T")).getTime();
    console.log("[VetBuddy] Token refreshed. Expires:", res.data.ExpiresOn);
    return _token;
  })().finally(() => {
    _tokenFetchPromise = null;
  });
  return _tokenFetchPromise;
}

async function headers() {
  return {
    Authorization: `Bearer ${await getToken()}`,
    Accept: "application/json",
  };
}

// ── API core caller with robust exponential backoff retries ──────────────────
async function apiGet(params, timeout = 30000, attempt = 1) {
  const res = await axios.get(`${BASE}/openapi.php`, {
    headers: await headers(),
    params,
    timeout,
  });

  // Handle potential 'Invalid Token' which happens under high-load rate limits
  const dataStr =
    typeof res.data === "string" ? res.data : JSON.stringify(res.data || {});
  if (dataStr.includes("Invalid Token")) {
    const maxAttempts = 3;
    if (attempt <= maxAttempts) {
      const delay = 3000 * attempt; // Exponential pause: 3s, 6s, 9s
      console.warn(
        `[VetBuddy] Warning: Received 'Invalid Token' (Attempt ${attempt}/${maxAttempts}). Waiting ${delay / 1000}s for cool-down...`,
      );
      _token = null; // Invalidate memory cache
      _expiresAt = 0;
      // Give the API a moment to breathe before refreshing and retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
      return apiGet(params, timeout, attempt + 1);
    }
    throw new Error(
      `VetBuddy API request failed with persistent Invalid Token error after ${maxAttempts} attempts.`,
    );
  }

  return res;
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function clean(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
    return null;
  return v;
}
function deepClean(obj) {
  if (Array.isArray(obj)) return obj.map(deepClean);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = clean(deepClean(v));
    return out;
  }
  return obj;
}
function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function fetchAll(params) {
  const { max_pages = Infinity, ...restParams } = params;
  let page = 1,
    results = [];
  while (true) {
    const res = await apiGet({ ...restParams, page, pagesize: 100 }, 30000);

    let items = [],
      totalPages = 1;
    if (res.data && typeof res.data === "object") {
      for (const key of Object.keys(res.data)) {
        const sec = res.data[key];
        if (sec?.["@attributes"]?.total_pages !== undefined) {
          totalPages = parseInt(sec["@attributes"].total_pages, 10);
          const dk = Object.keys(sec).find((k) => k !== "@attributes");
          items = toArray(sec[dk]);
          break;
        }
      }
    }

    results = results.concat(items.map(deepClean));
    if (page >= totalPages || page >= max_pages) break;
    page++;
  }
  return results;
}

// ── Read API ──────────────────────────────────────────────────────────────────
const getClinics = (p = {}) => fetchAll({ action: "clinic", ...p });
const getClients = (p = {}) => fetchAll({ action: "clients", ...p });
const getPatients = (p = {}) => fetchAll({ action: "patients", ...p });
const getAppointments = (p = {}) => fetchAll({ action: "appointment", ...p });
const getInvoices = (p = {}) => fetchAll({ action: "invoice", ...p });
const getPayments = (p = {}) => fetchAll({ action: "payment", ...p });
const getStock = (p = {}) => fetchAll({ action: "stock", ...p });
const getStaff = (p = {}) => fetchAll({ action: "staff", ...p });
const getReminders = (p = {}) => fetchAll({ action: "reminder", ...p });
const getStaffRota = (p = {}) => fetchAll({ action: "staffrota", ...p });
const getMedicalRecords = (p = {}) =>
  fetchAll({ action: "patientmrlist", ...p });
const getPatientDx = (p = {}) => fetchAll({ action: "patientdx", ...p });
const getAppointmentTypes = (p = {}) =>
  fetchAll({ action: "appointment_type", ...p });

async function getStaffAvailability(availabilitydate, clinicid) {
  const res = await apiGet(
    { action: "staffavailability", availabilitydate, clinicid },
    15000,
  );
  return deepClean(res.data?.StaffRotas?.StaffAvailability || null);
}

async function getClientAccountSummary(clientid) {
  const res = await apiGet({ action: "clientaccsummary", clientid }, 15000);
  return deepClean(res.data?.ClientAccountSummary || null);
}

// ── Push API ──────────────────────────────────────────────────────────────────
function parseResponse(text) {
  const p = (text || "").trim().split("|");
  return {
    success: p[0] === "OK",
    id: p[1] || null,
    action: p[2] || null,
    raw: text,
  };
}
async function pushXML(slug, xml) {
  const url = `${PUSH_BASE}/wsapi.html?instance=${INSTANCE}&key=${PUSH_KEY}&slug=${slug}`;
  const res = await axios.post(url, xml, {
    headers: { "Content-Type": "application/xml" },
    timeout: 15000,
    responseType: "text",
  });
  return parseResponse(res.data);
}
const cd = (v) => `<![CDATA[${v || ""}]]>`;

async function createClient(c) {
  return pushXML(
    "client",
    `<?xml version="1.0" encoding="UTF-8"?>
<DataXML Action='insert' Type='Client' App='CRM'><Client>
  <ClinicName>${cd(c.ClinicName)}</ClinicName><CRMClientID>${cd(c.CRMClientID || "")}</CRMClientID>
  <FirstName>${cd(c.FirstName)}</FirstName><LastName>${cd(c.LastName)}</LastName>
  <HomePhone>${cd(c.HomePhone || "")}</HomePhone><Address1>${cd(c.Address1 || "")}</Address1>
  <Address2>${cd(c.Address2 || "")}</Address2><City>${cd(c.City || "")}</City>
  <Zip>${cd(c.Zip || "")}</Zip><State>${cd(c.State || "")}</State>
  <Email>${cd(c.Email || "")}</Email><MobilePhone>${cd(c.MobilePhone || "")}</MobilePhone>
  <Status>${c.Status || "Active"}</Status>
</Client></DataXML>`,
  );
}

async function updateClient(c) {
  return pushXML(
    "client",
    `<?xml version="1.0" encoding="UTF-8"?>
<DataXML Action='modify' Type='Client' App='CRM'><Client>
  <ClinicName>${cd(c.ClinicName)}</ClinicName><CRMClientID>${cd(c.CRMClientID || "")}</CRMClientID>
  <ClientID>${c.ClientID}</ClientID><FirstName>${cd(c.FirstName || "")}</FirstName>
  <LastName>${cd(c.LastName || "")}</LastName><MobilePhone>${cd(c.MobilePhone || "")}</MobilePhone>
  <Email>${cd(c.Email || "")}</Email><Address1>${cd(c.Address1 || "")}</Address1>
  <City>${cd(c.City || "")}</City><State>${cd(c.State || "")}</State><Zip>${cd(c.Zip || "")}</Zip>
  <Status>${c.Status || "Active"}</Status>
</Client></DataXML>`,
  );
}

async function createPatient(p) {
  return pushXML(
    "patient",
    `<?xml version="1.0" encoding="UTF-8"?>
<DataXML Action='insert' Type='Patient' App='CRM'><Patient>
  <ClinicName>${cd(p.ClinicName)}</ClinicName><ClientID>${cd(p.ClientID)}</ClientID>
  <CRMClientID>${cd(p.CRMClientID || "")}</CRMClientID><CRMPatientID>${cd(p.CRMPatientID || "")}</CRMPatientID>
  <PatientName>${cd(p.PatientName)}</PatientName><BirthDate>${cd(p.BirthDate || "")}</BirthDate>
  <Species><SpeciesName>${cd(p.SpeciesName || "Canine")}</SpeciesName></Species>
  <Breed><BreedName>${cd(p.BreedName || "")}</BreedName></Breed>
  <Gender><GenderName>${cd(p.GenderName || "")}</GenderName><Neutered>${p.Neutered || "FALSE"}</Neutered></Gender>
  <Comment>${cd(p.Comment || "")}</Comment><Status>${p.Status || "Active"}</Status>
</Patient></DataXML>`,
  );
}

async function updatePatient(p) {
  return pushXML(
    "patient",
    `<?xml version="1.0" encoding="UTF-8"?>
<DataXML Action='modify' Type='Patient' App='CRM'><Patient>
  <ClinicName>${cd(p.ClinicName)}</ClinicName><ClientID>${cd(p.ClientID)}</ClientID>
  <PatientID>${cd(p.PatientID)}</PatientID><PatientName>${cd(p.PatientName || "")}</PatientName>
  <BirthDate>${cd(p.BirthDate || "")}</BirthDate>
  <Species><SpeciesName>${cd(p.SpeciesName || "Canine")}</SpeciesName></Species>
  <Breed><BreedName>${cd(p.BreedName || "")}</BreedName></Breed>
  <Gender><GenderName>${cd(p.GenderName || "")}</GenderName><Neutered>${p.Neutered || "FALSE"}</Neutered></Gender>
  <Comment>${cd(p.Comment || "")}</Comment><Status>${p.Status || "Active"}</Status>
</Patient></DataXML>`,
  );
}

async function createAppointment(a) {
  return pushXML(
    "appointment",
    `<?xml version="1.0" encoding="UTF-8"?>
<DataXML Action='insert' Type='Appointment' App='CRM'><Appointment>
  <CRMAppointmentID>${cd(a.CRMAppointmentID || `mcp-${Date.now()}`)}</CRMAppointmentID>
  <Client><ClientID>${a.ClientID}</ClientID></Client>
  <Patient><PatientID>${a.PatientID}</PatientID></Patient>
  <AppointmentType><AppointmentTypeName>${cd(a.AppointmentTypeName)}</AppointmentTypeName></AppointmentType>
  <ReasonForVisit><ReasonForVisitName>${cd(a.ReasonForVisitName || "")}</ReasonForVisitName></ReasonForVisit>
  <Clinic><ClinicName>${cd(a.ClinicName)}</ClinicName></Clinic>
  <AppointmentStartTime>${cd(a.AppointmentStartTime)}</AppointmentStartTime>
  <AppointmentEndTime>${cd(a.AppointmentEndTime)}</AppointmentEndTime>
  <AppointmentStatus>${cd(a.AppointmentStatus || "Pending")}</AppointmentStatus>
  <AppointmentResources><Providers><Staff><StaffID>${a.StaffID || ""}</StaffID></Staff></Providers></AppointmentResources>
</Appointment></DataXML>`,
  );
}

async function cancelAppointment(a) {
  return pushXML(
    "appointment",
    `<?xml version="1.0" encoding="UTF-8"?>
<DataXML Action='modify' Type='Appointment' App='CRM'><Appointment>
  <AppointmentID>${a.AppointmentID}</AppointmentID>
  <Client><ClientID>${a.ClientID}</ClientID></Client>
  <Patient><PatientID>${a.PatientID}</PatientID></Patient>
  <AppointmentType><AppointmentTypeName>${cd(a.AppointmentTypeName || "")}</AppointmentTypeName></AppointmentType>
  <Clinic><ClinicName>${cd(a.ClinicName)}</ClinicName></Clinic>
  <AppointmentStartTime>${cd(a.AppointmentStartTime)}</AppointmentStartTime>
  <AppointmentEndTime>${cd(a.AppointmentEndTime)}</AppointmentEndTime>
  <AppointmentStatus>Cancel</AppointmentStatus>
  <AppointmentResources><Providers><Staff><StaffID>${a.StaffID || ""}</StaffID></Staff></Providers></AppointmentResources>
  <AppointmentCancel>
    <CancelledBy>${cd(a.CancelledBy || "reception")}</CancelledBy>
    <CancelledOn>${cd(a.CancelledOn || new Date().toLocaleDateString("en-US") + " 00:00:00")}</CancelledOn>
  </AppointmentCancel>
</Appointment></DataXML>`,
  );
}

module.exports = {
  getToken,
  getClinics,
  getClients,
  getPatients,
  getAppointments,
  getInvoices,
  getPayments,
  getStock,
  getStaff,
  getReminders,
  getStaffRota,
  getMedicalRecords,
  getPatientDx,
  getAppointmentTypes,
  getStaffAvailability,
  getClientAccountSummary,
  createClient,
  updateClient,
  createPatient,
  updatePatient,
  createAppointment,
  cancelAppointment,
};
