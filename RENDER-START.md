# Render — fix /api/version 404

## Start command (required)

In Render → **Settings → Start Command**, set:

```bash
node server.js
```

Or:

```bash
npm start
```

Do **not** use `node server/index.js` alone (old deploys used a stale file).

## Deploy

1. **Manual Deploy** → branch `main` → **Clear build cache**
2. Logs must show: `Starting API from server/app.js (build 1.0.6)`
3. Test: https://slcrickpro.onrender.com/api/version

Expected JSON includes `"desktopUsers":true` and `"build":"1.0.6"` on `/api/ping`.
