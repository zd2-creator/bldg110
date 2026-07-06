/**
 * Backend משותף ל-bldg110 (רשימת חותמים), ל-bldg110-vote (הצבעת בדק)
 * ול-shabbat-elevator (סקר מעלית שבת) — הכל באותו גיליון.
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
 *   GET  ?action=progress              → סקר מעלית: ספירה לפי קומה, בלי שמות
 *   POST {action:'submitSign', ...}    → הוספת חתימה (עם בדיקת כפילות בשרת)
 *   POST {action:'submitVote', ...}    → הוספת הצבעה (עם בדיקת כפילות בשרת)
 *   POST {action:'submit', ...}        → רישום לסקר המעלית (עם בדיקת כפילות)
 *   POST {action:'getAll', sheet, password} → כל הנתונים, רק עם סיסמת אדמין
 */

const SIGN_SHEET = 'חותמים';
const VOTE_SHEET = 'הצבעות';
const ELEV_SHEET = 'מעלית';
const TOTAL_APTS = 52;
const MAX_FLOOR  = 20;

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
  if (action === 'progress') {
    return json_(getElevProgress_()); // סקר מעלית שבת — בלי שמות
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
    case 'submit':     return handleSubmitElev_(data); // רישום מעלית שבת
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
// הגנה מפני ניחוש סיסמה: 3 ניסיונות שגויים ⇒ נעילה ל-15 דקות (גלובלית,
// כי Apps Script לא חושף IP של המבקש)

const LOCK_MAX_FAILS   = 3;
const LOCK_SECONDS     = 900; // 15 דקות

function handleGetAll_(data) {
  const cache = CacheService.getScriptCache();
  if (cache.get('pw_lock')) {
    return json_({ status: 'locked' });
  }
  if (!checkPassword_(data.password)) {
    const fails = parseInt(cache.get('pw_fails') || '0') + 1;
    if (fails >= LOCK_MAX_FAILS) {
      cache.put('pw_lock', '1', LOCK_SECONDS);
      cache.remove('pw_fails');
      return json_({ status: 'locked' });
    }
    cache.put('pw_fails', String(fails), LOCK_SECONDS);
    return json_({ status: 'unauthorized' });
  }
  cache.remove('pw_fails'); // כניסה מוצלחת מאפסת את המונה
  const sheetName = (data.sheet === VOTE_SHEET) ? VOTE_SHEET
                  : (data.sheet === ELEV_SHEET) ? ELEV_SHEET
                  : SIGN_SHEET;
  const sh = (sheetName === ELEV_SHEET) ? elevSheet_() : ss_().getSheetByName(sheetName);
  if (!sh) return json_({ status: 'error', message: 'sheet not found' });
  const values = sh.getDataRange().getValues().slice(1);

  let entries;
  if (sheetName === VOTE_SHEET) {
    entries = values.filter(function(r){ return r[1]; }).map(function(r) {
      return { ts: String(r[0]), name: String(r[1]), phone: String(r[2]), apt: String(r[3]), company: String(r[4]), sig: String(r[5] || '') };
    });
  } else if (sheetName === ELEV_SHEET) {
    entries = values.filter(function(r){ return r[3]; }).map(function(r) {
      return { ts: String(r[0]), floor: String(r[1]), apt: String(r[2]), name: String(r[3]), want: String(r[4] || 'yes') };
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
  // הסרת < > מונעת הזרקת HTML/סקריפט דרך שדות הטופס (הגנת עומק מול XSS באדמין)
  return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, maxLen);
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

// ── סקר מעלית שבת (shabbat-elevator) ──────────────────────────
// עמודות: תאריך | קומה | דירה | שם | רוצה (yes/no)
// הלשונית נוצרת אוטומטית אם היא לא קיימת

function elevSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(ELEV_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ELEV_SHEET);
    sh.appendRow(['תאריך/שעה', 'קומה', 'מספר דירה', 'שם', 'רוצה מעלית']);
  }
  return sh;
}

// ציבורי: ספירה לכל קומה + דירות שנרשמו — בלי שמות
function getElevProgress_() {
  const values = elevSheet_().getDataRange().getValues().slice(1);
  const floorWant = {}, floorNo = {};
  const registeredApts = [];
  let wantCount = 0, noCount = 0;
  values.forEach(function(r) {
    if (!r[3]) return;
    const wantsIt = String(r[4]) !== 'no';
    const f = parseInt(r[1]);
    if (!isNaN(f)) {
      if (wantsIt) floorWant[f] = (floorWant[f] || 0) + 1;
      else         floorNo[f]   = (floorNo[f]   || 0) + 1;
    }
    if (wantsIt) wantCount++; else noCount++;
    const a = parseInt(r[2]);
    if (!isNaN(a) && registeredApts.indexOf(a) === -1) registeredApts.push(a);
  });
  return { status: 'ok', floorWant: floorWant, floorNo: floorNo, registeredApts: registeredApts,
           count: registeredApts.length, wantCount: wantCount, noCount: noCount };
}

function handleSubmitElev_(data) {
  const name  = cleanStr_(data.name, 80);
  const apt   = validApt_(data.apt);
  const floor = parseInt(data.floor);
  const want  = (String(data.want) === 'no') ? 'no' : 'yes';

  if (!name || !apt) return json_({ status: 'error', message: 'missing or invalid fields' });
  if (isNaN(floor) || floor < 0 || floor > MAX_FLOOR) return json_({ status: 'error', message: 'קומה לא תקינה' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = elevSheet_();
    if (aptAlreadyIn_(sh, 2, apt)) return json_({ status: 'duplicate', message: 'דירה ' + apt + ' כבר נרשמה' });
    sh.appendRow([now_(), floor, apt, name, want]);
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
