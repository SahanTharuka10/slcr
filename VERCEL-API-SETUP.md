# Vercel — Desktop Users API

Desktop Users tab works on **slcrickpro.live** when this env var is set:

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | Copy from **Render** → Environment → `DATABASE_URL` (postgresql://…) |

Steps:

1. Vercel → Project → **Settings** → **Environment Variables**
2. Add `DATABASE_URL` for Production (paste Supabase/Render Postgres URL)
3. **Deployments** → Redeploy latest `main`

Then test: https://www.slcrickpro.live/api/admin/desktop-users (should return **401** without login token, not 404).

Admin login PIN: `slcrickpro@2026` (works on Vercel `/api/admin/login` without Render).
