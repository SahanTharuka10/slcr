# Vercel — Desktop Users API (live admin)

The **slcrickpro.live** admin panel uses **Vercel serverless** (`/api/*`) for desktop users when Render is on an old build.

## Required (one time)

Vercel project → **Settings → Environment Variables**:

| Name | Value |
|------|--------|
| `DATABASE_URL` | Same Supabase Postgres URL as Render (postgresql://...) |

Apply to **Production** (and Preview if you test there).

Redeploy after saving.

## Verify

- https://slcrickpro.live/api/version → `"desktopUsers":true`
- Admin → Desktop Users → login with `slcrickpro@2026`

Desktop **PC app** still uses `https://slcrickpro.onrender.com` until Render deploys the new server (see `RENDER-FIX-SI.md`).
