# שרת טוקנים (שלב 3)

Cloudflare Worker שמחזיק את מפתח OpenAI ונותן לרובוט טוקן זמני לשיחה. הרובוט והדפדפן אף פעם לא רואים את המפתח עצמו.

## מה יש כאן

- `POST /token`: מקבל מזהה מכשיר וסוד, ומחזיר client secret זמני מ-OpenAI. ה-prompt, המודל והקול נקבעים כאן בשרת.
- `GET /`: דף בדיקה. הוא מתחבר לשיחה מהדפדפן, מציג תמלול ומודד זמן תגובה.
- ה-prompt נטען מ-[../prompts/character_v1.txt](../prompts/character_v1.txt). אחרי שינוי שם צריך לעשות deploy מחדש.

## התקנה ופריסה (פעם אחת)

כל הפקודות רצות מתוך התיקייה `worker` ב-PowerShell.

1. מתקינים:

   ```powershell
   npm install
   ```

2. מתחברים ל-Cloudflare. ייפתח דפדפן לאישור:

   ```powershell
   npx wrangler login
   ```

3. פורסים:

   ```powershell
   npx wrangler deploy
   ```

   בסוף מופיעה כתובת בצורה `https://kids-robot-token.<השם-שלך>.workers.dev`. שומרים אותה.

4. מייצרים שני סודות אקראיים, אחד לדפדפן ואחד לרובוט. מריצים את הפקודה פעמיים:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

5. מגדירים את מפתח OpenAI. הפקודה מבקשת להדביק את הערך:

   ```powershell
   npx wrangler secret put OPENAI_API_KEY
   ```

6. מגדירים את רשימת המכשירים. מדביקים שורה אחת בפורמט JSON, עם שני הסודות מסעיף 4:

   ```powershell
   npx wrangler secret put DEVICE_KEYS
   ```

   ```json
   {"browser-test":"<סוד ראשון>","robot-1":"<סוד שני>"}
   ```

   את שני הסודות שומרים במנהל סיסמאות. הסוד של `robot-1` ייכנס להגדרות הלוח בשלב 4.

## בדיקה מהדפדפן

1. פותחים את כתובת ה-Worker ב-Chrome, במחשב או בטלפון.
2. מזהה מכשיר: `browser-test`. סוד: הסוד הראשון.
3. לוחצים "התחל שיחה" ומאשרים גישה למיקרופון. פיקו אמור להגיד שלום.
4. מדברים. התמלול וזמן התגובה מופיעים בדף.

אם משהו לא עובד, "לוג אירועים" בתחתית הדף מראה מה הגיע מ-OpenAI. לוג של השרת רואים כך:

```powershell
npx wrangler tail
```

## שינוי הגדרות

המודל, הקול, מודל התמלול ותוקף הטוקן נמצאים תחת `[vars]` ב-[wrangler.toml](wrangler.toml). משנים שם ועושים `npx wrangler deploy`. ככה עוברים בין קולות בלי לגעת בקושחה.

## פיתוח מקומי

יוצרים קובץ `.dev.vars` בתיקייה הזאת. הוא ב-`.gitignore` ולא עולה לריפו:

```
OPENAI_API_KEY=sk-...
DEVICE_KEYS={"browser-test":"local-secret"}
```

ואז:

```powershell
npm run dev     # השרת על http://localhost:8787
npm test        # בדיקות יחידה, בלי רשת
```

## הממשק לרובוט

```
POST /token
X-Device-Id: robot-1
Authorization: Bearer <סוד המכשיר>
```

תשובה מוצלחת:

```json
{ "client_secret": "ek_...", "expires_at": 1767000000, "model": "gpt-realtime-2.1-mini" }
```

עם ה-`client_secret` הרובוט שולח SDP offer ל-`https://api.openai.com/v1/realtime/calls`, בדיוק כמו דף הבדיקה. מכשיר לא מוכר או סוד שגוי מקבלים 401. אם OpenAI לא זמין, התשובה היא 502.

## שער אישור לשלב 3

- [ ] שיחה מהדפדפן עובדת עם הדמות
- [ ] בקשה בלי סוד נכון נדחית (נסו סוד שגוי בדף הבדיקה)
- [ ] המפתח לא מופיע בשום קוד או ריפו
- [ ] אישור לעבור לשלב 4
