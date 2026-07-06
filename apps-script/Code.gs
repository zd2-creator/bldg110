/**
 * Backend משותף ל-bldg110 (רשימת חותמים) ול-bldg110-vote (הצבעת בדק).
 *
 * ── הגדרה חד-פעמית (Project Settings → Script Properties) ──
 *   SPREADSHEET_ID  – ה-ID של הגיליון בדרייב
 *   ADMIN_PASSWORD  – סיסמת אדמין חדשה (לא לשמור בקוד ולא ב-HTML!)
 *
 * ── פריסה ──
 *   Deploy → New deployment → Web app
 *   Execute as: Me | Who has access: Anyone
 *
 * ── API ──
 *   GET  ?action=stats[&sheet=הצבעות]  → סטטיסטיקה בלבד, בלי פרטים אישיים
 *   POST {action:'submitSign', ...}    → הוספת חתימה (עם בדיקת כפילות בשרת)
 *   POST {action:'submitVote', ...}    → הוספת הצבעה (עם בדיקת כפילות בשרת)
 *   POST {action:'getAll', sheet, password} → כל הנתונים, רק עם סיסמת אדמין
 */

const SIGN_SHEET = 'חותמים';
const VOTE_SHEET = 'הצבעות';
const TOTAL_APTS = 52;

function props_() { return PropertiesService.getScriptProperties(); }
function ss_()    { return SpreadsheetApp.openById(props_().getProperty('SPREADSHEET_ID')); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'd.M.yyyy, HH:mm:ss');
}

// השוואת סיסמה ללא תלות בזמן (מונע timing attack)
function checkPassword_(pw) {
  const real = props_().getProperty('ADMIN_PASSWORD');
  if (!real || !pw) return false;
  const a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pw), Utilities.Charset.UTF_8);
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(real), Utilities.Charset.UTF_8);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'stats') {
    const sheet = (e.parameter.sheet === VOTE_SHEET) ? VOTE_SHEET : SIGN_SHEET;
    return json_(getStats_(sheet));
  }
  // GET לעולם לא מחזיר נתונים אישיים
  return json_({ status: 'ok', service: 'bldg110' });
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ status: 'error', message: 'bad request' }); }

  switch (data.action) {
    case 'getAll':     return handleGetAll_(data);
    case 'submitSign': return handleSubmitSign_(data);
    case 'submitVote': return handleSubmitVote_(data);
    default:           return json_({ status: 'error', message: 'unknown action' });
  }
}

// ── סטטיסטיקה ציבורית (בלי שמות/טלפונים/חתימות) ──────────────

function getStats_(sheetName) {
  const sh = ss_().getSheetByName(sheetName);
  if (!sh) return { status: 'error', message: 'sheet not found' };
  const values = sh.getDataRange().getValues().slice(1); // בלי כותרת

  if (sheetName === VOTE_SHEET) {
    // עמודות: תאריך | שם | טלפון | דירה | בחירה | חתימה
    const aptMap = {};
    values.forEach(function(r) {
      const apt = parseInt(r[3]);
      const company = String(r[4] || '');
      if (!isNaN(apt) && (company === 'laad' || company === 'cohen')) aptMap[apt] = company;
    });
    return { status: 'ok', total: TOTAL_APTS, aptMap: aptMap };
  }

  // חותמים — עמודות: תאריך | שם | נייד | דירה | מייל | חתימה | בניין (בלי ת"ז)
  const apts = [];
  values.forEach(function(r) {
    const apt = parseInt(r[3]);
    if (!isNaN(apt) && apts.indexOf(apt) === -1) apts.push(apt);
  });
  return { status: 'ok', total: TOTAL_APTS, apts: apts };
}

// ── נתונים מלאים — אדמין בלבד ─────────────────────────────────

function handleGetAll_(data) {
  if (!checkPassword_(data.password)) {
    return json_({ status: 'unauthorized' });
  }
  const sheetName = (data.sheet === VOTE_SHEET) ? VOTE_SHEET : SIGN_SHEET;
  const sh = ss_().getSheetByName(sheetName);
  if (!sh) return json_({ status: 'error', message: 'sheet not found' });
  const values = sh.getDataRange().getValues().slice(1);

  let entries;
  if (sheetName === VOTE_SHEET) {
    entries = values.filter(function(r){ return r[1]; }).map(function(r) {
      return { ts: String(r[0]), name: String(r[1]), phone: String(r[2]), apt: String(r[3]), company: String(r[4]), sig: String(r[5] || '') };
    });
  } else {
    // תעודת זהות לא נאספת ולא קיימת בגיליון
    entries = values.filter(function(r){ return r[1]; }).map(function(r) {
      return { ts: String(r[0]), name: String(r[1]), phone: String(r[2]), apt: String(r[3]), email: String(r[4] || ''), sig: String(r[5] || '') };
    });
  }
  return json_({ status: 'ok', entries: entries });
}

// ── ולידציה משותפת ────────────────────────────────────────────

function cleanStr_(v, maxLen) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function validApt_(apt) {
  const n = parseInt(apt);
  return (!isNaN(n) && n >= 1 && n <= TOTAL_APTS) ? n : null;
}

function validSig_(sig) {
  sig = String(sig || '');
  return (sig.indexOf('data:image/png;base64,') === 0 && sig.length < 60000) ? sig : null;
}

function aptAlreadyIn_(sh, aptCol, apt) {
  const values = sh.getDataRange().getValues().slice(1);
  return values.some(function(r) { return parseInt(r[aptCol]) === apt; });
}

// ── הוספת חתימה (bldg110) ─────────────────────────────────────

function handleSubmitSign_(data) {
  const name  = cleanStr_(data.name, 100);
  const phone = cleanStr_(data.phone, 20);
  const email = cleanStr_(data.email, 100);
  const bldg  = cleanStr_(data.building, 10) || '110';
  const apt   = validApt_(data.apt);
  const sig   = validSig_(data.sig);

  if (!name || !phone || !apt || !sig) {
    return json_({ status: 'error', message: 'missing or invalid fields' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ss_().getSheetByName(SIGN_SHEET);
    if (aptAlreadyIn_(sh, 3, apt)) return json_({ status: 'duplicate' });
    sh.appendRow([now_(), name, phone, apt, email, sig, bldg]);
  } finally {
    lock.releaseLock();
  }
  return json_({ status: 'ok' });
}

// ── הוספת הצבעה (bldg110-vote) ────────────────────────────────

function handleSubmitVote_(data) {
  const name    = cleanStr_(data.name, 100);
  const phone   = cleanStr_(data.phone, 20);
  const apt     = validApt_(data.apt);
  const sig     = validSig_(data.sig);
  const company = (data.company === 'laad' || data.company === 'cohen') ? data.company : null;

  if (!name || !phone || !apt || !sig || !company) {
    return json_({ status: 'error', message: 'missing or invalid fields' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ss_().getSheetByName(VOTE_SHEET);
    if (aptAlreadyIn_(sh, 3, apt)) return json_({ status: 'duplicate' });
    sh.appendRow([now_(), name, phone, apt, company, sig]);
  } finally {
    lock.releaseLock();
  }
  return json_({ status: 'ok' });
}
