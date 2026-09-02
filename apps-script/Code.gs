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
  if (action === 'formStats') {
    return handleFormStats_(e.parameter); // טפסים גנריים — בלי עמודות אישיות
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
    case 'formSubmit': return handleFormSubmit_(data); // טפסים גנריים
    case 'formGetAll': return handleFormGetAll_(data); // טפסים גנריים — אדמין
    case 'formDeadline': return handleFormDeadline_(data); // ניהול מועד סגירה
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

/**
 * ═══════════════════════════════════════════════════════════════════
 *  שכבה גנרית לטפסים — תוספת ל-Backend של בניין 110
 * ═══════════════════════════════════════════════════════════════════
 *
 *  מדביקים את הבלוק הזה בסוף Code.gs הקיים (מתחת לכל שאר הקוד),
 *  ומפרסים גרסה חדשה — פעם אחת בלבד. אחרי זה כל טופס חדש שהסקיל
 *  מייצר עובד מיד, בלי לגעת יותר בשרת.
 *
 *  הטפסים הקיימים (חתימות/הצבעות/מעלית) לא מושפעים — זו תוספת בלבד.
 *
 *  ── הסכם ה-API הגנרי ──
 *   GET  ?action=formStats&form=<שם-לשונית>
 *        → שורות עם עמודות ציבוריות בלבד (בלי שם/טלפון/מייל/ת"ז/חתימה).
 *          הלקוח מחשב מזה כל אגרגציה שירצה. אין דליפת מידע אישי.
 *
 *   POST {action:'formSubmit', form, fields:[...], values:{...}}
 *        → הוספת רשומה. יוצר את הלשונית אוטומטית לפי fields אם חסרה.
 *          בדיקת כפילות לפי apt (אם קיים), סינון <>, נעילה על מרוץ.
 *
 *   POST {action:'formGetAll', form, password}
 *        → כל העמודות כולל האישיות — רק עם סיסמת האדמין הנכונה.
 *          כפוף לאותה נעילת 15 דקות אחרי 3 טעויות.
 * ═══════════════════════════════════════════════════════════════════
 */

// עמודות שנחשבות אישיות ולעולם לא מוחזרות ב-formStats (ללא סיסמה).
// ההשוואה case-insensitive; אפשר להוסיף שמות לפי הצורך.
var PRIVATE_COLS_ = [
  'name', 'phone', 'email', 'id', 'sig', 'signature', 'address',
  'שם', 'שם מלא', 'טלפון', 'נייד', 'מייל', 'אימייל', 'דוא"ל',
  'תעודת זהות', 'ת"ז', 'תז', 'חתימה', 'כתובת'
];

function isPrivateCol_(header) {
  var h = String(header || '').trim().toLowerCase();
  for (var i = 0; i < PRIVATE_COLS_.length; i++) {
    if (PRIVATE_COLS_[i].toLowerCase() === h) return true;
  }
  return false;
}

// שם לשונית בטוח: אותיות (עברית/אנגלית), ספרות, רווח, מקף — עד 40 תווים.
// מונע גישה ללשוניות מערכת או הזרקה דרך שם הטופס.
function safeFormKey_(k) {
  var s = String(k || '').trim().slice(0, 40);
  return /^[֐-׿A-Za-z0-9 _-]+$/.test(s) ? s : null;
}

function formSheet_(formKey, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(formKey);
  if (!sh && headers && headers.length) {
    sh = ss.insertSheet(formKey);
    sh.appendRow(['ts'].concat(headers));
  }
  return sh;
}

function handleFormStats_(p) {
  var formKey = safeFormKey_(p.form);
  if (!formKey) return json_({ status: 'error', message: 'bad form' });
  var sh = ss_().getSheetByName(formKey);
  if (!sh) return json_({ status: 'ok', total: TOTAL_APTS, rows: [], deadline: formDeadline_(formKey) });

  var values = sh.getDataRange().getValues();
  if (values.length < 2) return json_({ status: 'ok', total: TOTAL_APTS, rows: [] });

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var publicIdx = [];
  headers.forEach(function (h, i) { if (h && !isPrivateCol_(h)) publicIdx.push(i); });

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var hasData = values[r].some(function (c) { return c !== '' && c != null; });
    if (!hasData) continue;
    var obj = {};
    publicIdx.forEach(function (i) { obj[headers[i]] = values[r][i]; });
    rows.push(obj);
  }
  return json_({ status: 'ok', total: TOTAL_APTS, rows: rows, deadline: formDeadline_(formKey) });
}

// מועדי סגירה לטפסים — אכיפה בשרת (עוקף-דף לא יכול להצביע אחרי המועד).
// ברירת מחדל בקוד; ניתן לשנות/לסגור מתוך מסך האדמין (נשמר ב-Script Properties).
var FORM_DEADLINES_ = {
  'שדרוגים': '2026-09-06T23:59:59+03:00'  // יום ראשון 6.9.26 23:59 שעון ישראל
};

// המועד האפקטיבי: מה שנקבע באדמין גובר על ברירת המחדל.
// הערך 'closed' סוגר מיידית; 'open' מבטל מועד לגמרי.
function formDeadline_(formKey) {
  var override = props_().getProperty('DEADLINE_' + formKey);
  return override || FORM_DEADLINES_[formKey] || null;
}

// אדמין: קריאה/שינוי של מועד הסגירה
function handleFormDeadline_(p) {
  var cache = CacheService.getScriptCache();
  if (cache.get('pw_lock')) return json_({ status: 'locked' });
  if (!checkPassword_(p.password)) {
    var fails = parseInt(cache.get('pw_fails') || '0') + 1;
    if (fails >= LOCK_MAX_FAILS) {
      cache.put('pw_lock', '1', LOCK_SECONDS);
      cache.remove('pw_fails');
      return json_({ status: 'locked' });
    }
    cache.put('pw_fails', String(fails), LOCK_SECONDS);
    return json_({ status: 'unauthorized' });
  }
  cache.remove('pw_fails');

  var formKey = safeFormKey_(p.form);
  if (!formKey) return json_({ status: 'error', message: 'bad form' });

  if (p.set !== undefined && p.set !== null) {
    var v = String(p.set).trim().slice(0, 40);
    // מותר: 'closed', 'open', או תאריך תקין
    if (v !== 'closed' && v !== 'open' && isNaN(new Date(v).getTime())) {
      return json_({ status: 'error', message: 'תאריך לא תקין' });
    }
    props_().setProperty('DEADLINE_' + formKey, v);
  }
  return json_({ status: 'ok', deadline: formDeadline_(formKey) });
}

// ── התראת רוב + PDF (גנרי, לפי טופס) ─────────────────────────
// כשמספר הדירות שבחרו ב-yes מגיע ל-target — נשלח מייל חד-פעמי עם PDF תוצאות.
// להוסיף טופס חדש: שורה במפה + פריסת גרסה חדשה.
var FORM_MAJORITY_ = {
  'שדרוגים': { target: 35, yes: 'בעד', to: 'zachi.daniel@gmail.com, ibenshaul2911@gmail.com',
               title: 'הצבעת דיירים — חבילת השדרוגים · בניין 110',
               adminUrl: 'https://zd2-creator.github.io/bldg110-upgrades/admin.html' }
};

function readFormRows_(sh) {
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { headers: [], rows: [] };
  var headers = values[0].map(function(x){ return String(x).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var hasData = values[r].some(function(v){ return v !== '' && v != null; });
    if (!hasData) continue;
    var o = {};
    headers.forEach(function(h, i){ if (h) o[h] = values[r][i]; });
    rows.push(o);
  }
  return { headers: headers, rows: rows };
}

function fmtPhone_(p) {
  p = String(p == null ? '' : p).replace(/\D/g, '');
  if (p.indexOf('972') === 0) p = '0' + p.slice(3);
  else if (p.length === 9 && p.charAt(0) !== '0') p = '0' + p;
  return p;
}

// PDF תוצאות (RTL) — כל העמודות חוץ מחתימה, ממוין לפי דירה
function buildFormPdf_(formKey, sh, cfg) {
  var data = readFormRows_(sh);
  var rows = data.rows.slice().sort(function(a,b){ return (parseInt(a.apt)||999) - (parseInt(b.apt)||999); });
  var cols = data.headers.filter(function(h){ return h && h !== 'ts' && h !== 'sig' && h !== 'signature'; }).concat('ts');
  var labels = { apt:'דירה', name:'שם', phone:'טלפון', email:'מייל', choice:'בחירה', floor:'קומה', ts:'מועד' };
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  var yes = cfg && cfg.yes ? rows.filter(function(r){ return String(r.choice) === cfg.yes; }).length : 0;
  var no  = cfg && cfg.yes ? rows.filter(function(r){ return r.choice && String(r.choice) !== cfg.yes; }).length : 0;
  var pct = Math.round(yes / TOTAL_APTS * 100);

  var trs = rows.map(function(r, i){
    return '<tr><td style="text-align:center">' + (i+1) + '</td>' + cols.map(function(cName){
      var v = r[cName]; var style = 'text-align:center';
      if (cName === 'name') style = 'text-align:right';
      if (cName === 'phone') v = fmtPhone_(v);
      if (cName === 'ts') style += ';font-size:11px;color:#666';
      if (cName === 'choice' && cfg && cfg.yes) style += ';font-weight:bold;color:' + (String(v) === cfg.yes ? '#0d6e52' : '#c0392b');
      return '<td style="' + style + '">' + esc(v) + '</td>';
    }).join('') + '</tr>';
  }).join('');

  var html =
    '<html dir="rtl"><head><meta charset="UTF-8"><style>' +
    'body{font-family:Arial,sans-serif;direction:rtl;padding:10px;}h1{font-size:20px;margin-bottom:4px;}' +
    '.sub{font-size:13px;color:#555;margin-bottom:14px;}.sum{border:1px solid #333;border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:14px;}' +
    'table{width:100%;border-collapse:collapse;font-size:12.5px;}th{border:1px solid #333;background:#f0f0f0;padding:6px 8px;font-weight:bold;text-align:center;}' +
    'td{border:1px solid #555;padding:5px 8px;vertical-align:middle;}</style></head><body>' +
    '<h1>' + esc(cfg && cfg.title ? cfg.title : formKey + ' · בניין 110') + '</h1>' +
    '<div class="sub">הופק אוטומטית בתאריך ' + now_() + '</div>' +
    '<div class="sum"><b>סיכום:</b> ' + rows.length + ' דירות מתוך ' + TOTAL_APTS +
    (cfg && cfg.yes ? ' · ' + cfg.yes + ': <b>' + yes + '</b> (' + pct + '% מכלל הבניין) · אחר: <b>' + no + '</b>' +
      (yes >= cfg.target ? ' · <b>✓ הושג רוב</b>' : '') : '') + '</div>' +
    '<table><tr><th>#</th>' + cols.map(function(cName){ return '<th>' + esc(labels[cName] || cName) + '</th>'; }).join('') + '</tr>' +
    trs + '</table></body></html>';

  return Utilities.newBlob(html, 'text/html', 'results.html')
    .getAs('application/pdf').setName('תוצאות ' + formKey + ' - בניין 110.pdf');
}

function checkMajorityNotify_(formKey, sh) {
  var cfg = FORM_MAJORITY_[formKey];
  if (!cfg) return;
  if (props_().getProperty('NOTIFIED_' + formKey)) return; // כבר נשלח

  var rows = readFormRows_(sh).rows;
  var yesApts = {};
  rows.forEach(function(r){ var a = parseInt(r.apt); if (!isNaN(a) && String(r.choice) === cfg.yes) yesApts[a] = true; });
  var yes = Object.keys(yesApts).length;
  if (yes < cfg.target) return;

  props_().setProperty('NOTIFIED_' + formKey, new Date().toISOString());
  var pct = Math.round(yes / TOTAL_APTS * 100);
  var pdf = null;
  try { pdf = buildFormPdf_(formKey, sh, cfg); } catch (e) { /* בלי PDF עדיף ממייל שלא נשלח */ }
  try {
    MailApp.sendEmail({
      to: cfg.to,
      subject: '🎉 הושג רוב — ' + (cfg.title || formKey),
      htmlBody:
        '<div dir="rtl" style="font-family:Arial;font-size:15px;line-height:1.8">' +
        '<h2 style="color:#0d6e52">🎉 הושג רוב של ' + pct + '%!</h2>' +
        '<p><b>' + yes + ' דירות מתוך ' + TOTAL_APTS + '</b> בחרו "' + cfg.yes + '" (הסף: ' + cfg.target + ' דירות).</p>' +
        (pdf ? '<p>📎 מצורף PDF עם התוצאות המלאות.</p>' : '') +
        (cfg.adminUrl ? '<p><a href="' + cfg.adminUrl + '">למסך הניהול</a></p>' : '') +
        '</div>',
      attachments: pdf ? [pdf] : []
    });
  } catch (e) { /* כשל בשליחת מייל לא מפיל את ההצבעה */ }
}

function handleFormSubmit_(p) {
  var formKey = safeFormKey_(p.form);
  if (!formKey) return json_({ status: 'error', message: 'bad form' });

  var dl = formDeadline_(formKey);
  if (dl === 'closed') return json_({ status: 'closed', message: 'ההצבעה נסגרה' });
  if (dl && dl !== 'open' && new Date() > new Date(dl)) {
    return json_({ status: 'closed', message: 'ההצבעה הסתיימה' });
  }

  var fields = Array.isArray(p.fields) ? p.fields.slice(0, 20) : [];
  var vals   = p.values || {};
  if (!fields.length) return json_({ status: 'error', message: 'no fields' });

  // ולידציה: אם יש שדה apt — ודא תקינות ובדוק כפילות
  var aptIdx = fields.indexOf('apt');
  var apt = null;
  if (aptIdx !== -1) {
    apt = validApt_(vals.apt);
    if (!apt) return json_({ status: 'error', message: 'מספר דירה לא תקין' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = formSheet_(formKey, fields);
    if (apt !== null && aptAlreadyIn_(sh, aptIdx + 1, apt)) { // +1 בגלל עמודת ts
      return json_({ status: 'duplicate', message: 'דירה ' + apt + ' כבר נרשמה' });
    }
    var row = [now_()];
    fields.forEach(function (f) {
      var v = vals[f];
      // חתימות base64 עוברות ולידציה ייעודית; שאר השדות מנוקים מ-<>
      if (f === 'sig' || f === 'signature') {
        row.push(validSig_(v) || '');
      } else {
        row.push(cleanStr_(v, 500));
      }
    });
    sh.appendRow(row);
    checkMajorityNotify_(formKey, sh);
  } finally {
    lock.releaseLock();
  }
  return json_({ status: 'ok' });
}

function handleFormGetAll_(p) {
  var cache = CacheService.getScriptCache();
  if (cache.get('pw_lock')) return json_({ status: 'locked' });
  if (!checkPassword_(p.password)) {
    var fails = parseInt(cache.get('pw_fails') || '0') + 1;
    if (fails >= LOCK_MAX_FAILS) {
      cache.put('pw_lock', '1', LOCK_SECONDS);
      cache.remove('pw_fails');
      return json_({ status: 'locked' });
    }
    cache.put('pw_fails', String(fails), LOCK_SECONDS);
    return json_({ status: 'unauthorized' });
  }
  cache.remove('pw_fails');

  var formKey = safeFormKey_(p.form);
  if (!formKey) return json_({ status: 'error', message: 'bad form' });
  var sh = ss_().getSheetByName(formKey);
  if (!sh) return json_({ status: 'ok', entries: [], deadline: formDeadline_(formKey) });

  var values = sh.getDataRange().getValues();
  if (values.length < 2) return json_({ status: 'ok', entries: [] });
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var entries = [];
  for (var r = 1; r < values.length; r++) {
    var hasData = values[r].some(function (c) { return c !== '' && c != null; });
    if (!hasData) continue;
    var obj = {};
    headers.forEach(function (h, i) { if (h) obj[h] = String(values[r][i]); });
    entries.push(obj);
  }
  return json_({ status: 'ok', entries: entries, deadline: formDeadline_(formKey) });
}

// עזר: איפוס נעילת האדמין. להריץ ידנית מהעורך אם נחסמת בטעות.
function resetLock() {
  var c = CacheService.getScriptCache();
  c.remove('pw_lock');
  c.remove('pw_fails');
  return 'הנעילה אופסה';
}

// עזר: בדיקת מערכת ההתראות — להריץ ידנית מהעורך (בחר testMajorityEmail ← ▶ הפעלה).
// שולח מייל בדיקה עם PDF של המצב הנוכחי לנמעני הטופס הראשון במפה FORM_MAJORITY_.
function testMajorityEmail() {
  var formKey = Object.keys(FORM_MAJORITY_)[0];
  var cfg = FORM_MAJORITY_[formKey];
  var sh = ss_().getSheetByName(formKey);
  var pdf = sh ? buildFormPdf_(formKey, sh, cfg) : null;
  MailApp.sendEmail({
    to: cfg.to,
    subject: '🧪 בדיקת מערכת ההתראות — ' + (cfg.title || formKey),
    htmlBody: '<div dir="rtl" style="font-family:Arial;font-size:15px;line-height:1.8">' +
      '<p>זהו מייל בדיקה בלבד ✓ מצורף PDF עם המצב הנוכחי.</p>' +
      '<p>המייל האמיתי יישלח כשיושג הסף (' + cfg.target + ' דירות).</p></div>',
    attachments: pdf ? [pdf] : []
  });
  return 'נשלח';
}
