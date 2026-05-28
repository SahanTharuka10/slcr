# Render — Desktop Users API (fix 404)

## Render dashboard (required)

| Setting | Value |
|--------|--------|
| Repository | `SahanTharuka10/slcr` |
| Branch | `main` |
| Root Directory | *(empty)* |
| **Start Command** | `node server.js` |
| Build Command | `npm install && npm run build:server` |
| Health Check | `/api/ping` |
| `DATABASE_URL` | Supabase Postgres connection string |

Do **not** use an old start command like `node index.js` or a stale `server/index.js` without forwarding to `server.js`.

## Deploy

1. Render → **Manual Deploy** → branch `main` → **Clear build cache**
2. Wait until status is **Live** (not Error)
3. Logs should include: `[SLCRICKPRO] Boot build 1.0.8 — entry server.js`

## Verify (new deploy)

Open: https://slcrickpro.onrender.com/api/ping

Expected:

```json
{
  "status": "alive",
  "build": "1.0.8",
  "entry": "server.js",
  "features": { "desktopUsers": true }
}
```

Then: https://slcrickpro.onrender.com/api/version → `"desktopUsers": true`

Without admin token: https://slcrickpro.onrender.com/api/admin/desktop-users → **401** (not 404)

## Admin site

1. https://slcrickpro.live/pages/admin.html → logout → login PIN `slcrickpro@2026`
2. **Desktop Users** tab → create user
3. Desktop app: login with that username/password

## If still 404

- Ping has **no** `"build"` / `"entry"` → Render is still on an **old** deploy; fix Start Command and redeploy with cache clear.
- Deploy **Error** in Render → open **Logs** tab and fix the crash (often missing `DATABASE_URL` or wrong Node version; use Node **20**).
