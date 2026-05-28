# Render deploy — Desktop Users API 404 fix

## Problem (මොකද්ද වැරදි?)

GitHub `main` branch එකේ **නව API** තියෙනවා, නමුත් `https://slcrickpro.onrender.com` තවම **පැරණි server** run කරනවා.

Verify:

| URL | දැන් (පැරණි) | නව deploy එකෙන් |
|-----|----------------|------------------|
| `/api/ping` | 200 | 200 + `"build":"1.0.5"` |
| `/api/status` | plain text `SLCRICKPRO_SERVER_UP` | JSON + `build` |
| `/api/version` | **404** | 200 + `desktopUsers:true` |
| `/api/admin/desktop-users` | **404** | 401 (login without token) |

Auto deploy “success” වුණත් **අලුත් build fail** වුණාම Render **පැරණි live version** තියාගන්නවා.

## Render dashboard — check list

1. **Service** → `slcrickpro` (හෝ API service) → **Settings**
2. **Repository:** `SahanTharuka10/slcr` — **Branch:** `main`
3. **Root Directory:** *(empty)* — repo root
4. **Build Command:** `npm install && npm run build`
5. **Start Command:** `npm start` *(not* `node server/index.js` alone)
6. **Environment:** `DATABASE_URL` = Supabase Postgres connection string
7. **Events** → latest deploy → **Succeeded**? Commit `1.0.5` / `render-start`?
8. **Manual Deploy** → tick **Clear build cache** → Deploy

## After deploy

Browser:

- https://slcrickpro.onrender.com/api/version  
- https://slcrickpro.onrender.com/api/ping  

Admin → Desktop Users tab → refresh (Ctrl+F5).

Logs should show: `[SLCRICKPRO] server/index.js OK (desktop API included)`
