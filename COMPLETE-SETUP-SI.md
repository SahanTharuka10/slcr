# SLCRICKPRO — Desktop Users සම්පූර්ණ Setup

## Architecture

| Part | Host | Database |
|------|------|----------|
| Website (admin UI) | Vercel `slcrickpro.live` | — |
| API | Render `slcrickpro.onrender.com` | Supabase (`DATABASE_URL` on **Render only**) |

Vercel `/api/*` → proxy → Render (no `DATABASE_URL` on Vercel needed).

---

## 1. Render (API) — අනිවාර්ය

1. [dashboard.render.com](https://dashboard.render.com) → service **slcrickpro**
2. **Settings → Start Command:**

   ```bash
   node server.js
   ```

3. **Environment:** `DATABASE_URL` = Supabase `postgresql://...` (already there usually)
4. **Manual Deploy** → branch `main` → **Clear build cache**
5. Logs: `Boot build 1.0.7` and `Rocket backend listening`
6. Test: https://slcrickpro.onrender.com/api/version → `desktopUsers: true`

---

## 2. Vercel (website)

1. Auto deploy from GitHub `slcr` repo
2. **Do not** add `DATABASE_URL` on Vercel (optional — not required anymore)
3. After deploy: https://www.slcrickpro.live/api/version should proxy to Render

---

## 3. Admin panel

1. https://www.slcrickpro.live/admin
2. **Logout** → login PIN: `slcrickpro@2026`
3. Tab **Desktop Users** → Ctrl+F5
4. Create user (e.g. `deepu` + password)

---

## 4. Desktop app

Uses `https://slcrickpro.onrender.com` — same users as admin creates.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 503 Database not configured on Vercel | Redeploy Vercel after latest git (proxy, no DB on Vercel) |
| 404 /api/version on Render | Render Start Command = `node server.js`, redeploy |
| 401 on desktop-users | Logout → login `slcrickpro@2026` again |
