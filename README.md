# bldg110 — אישור נציגות זמנית (בניין 110)

טופס חתימות לדיירים + מסך אדמין. עובד על GitHub Pages מול Google Apps Script.

## מה תוקן בגרסה הזו (יולי 2026)
- **הסיסמה לא נמצאת יותר בקוד** — היא נשמרת ב-Script Properties של Apps Script ונבדקת בצד השרת בלבד.
- **ה-API לא חושף נתונים אישיים**: הדף הציבורי מקבל רק רשימת מספרי דירות שחתמו (`action=stats`). שמות, טלפונים וחתימות מוחזרים רק עם סיסמת אדמין (`action=getAll` ב-POST).
- **שדה תעודת הזהות הוסר** מהטופס, מהאדמין ומה-API.
- בדיקת "דירה כבר חתמה" עברה לשרת (כולל נעילה נגד מרוץ), עם ולידציה של כל השדות.

## הפעלה מחדש — צעד אחר צעד

### 1. Apps Script
1. היכנס ל-https://script.google.com (בחשבון שבו נמצא הגיליון) → New project
2. הדבק את התוכן של [`apps-script/Code.gs`](apps-script/Code.gs)
3. ⚙️ Project Settings → Script Properties → הוסף:
   - `SPREADSHEET_ID` — ה-ID של הגיליון (מתוך ה-URL שלו)
   - `ADMIN_PASSWORD` — סיסמה **חדשה** (הסיסמה הישנה `bldg110admin` נחשפה — לא להשתמש בה!)
4. Deploy → New deployment → Web app → Execute as: **Me** | Who has access: **Anyone** → Deploy
5. העתק את כתובת ה-Web app (נגמרת ב-`/exec`)

### 2. עדכון הקבצים
החלף את `PASTE_APPS_SCRIPT_DEPLOYMENT_URL_HERE` בכתובת מהשלב הקודם, בקבצים:
- `index.html`
- `admin.html`
- וגם בריפו `bldg110-vote`: `vote.html`, `vote-admin.html` (אותו backend משרת את שניהם)

### 3. GitHub Pages
Settings → Pages → Deploy from branch → main

## הערה
הכתובת של ה-Web app היא ציבורית מעצם היותה ב-HTML — זה בסדר: בלי הסיסמה היא מחזירה סטטיסטיקה בלבד.
