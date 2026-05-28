# Vercel — Desktop Users API

Admin panel on **slcrickpro.live** uses `/api/*` on Vercel. You need **one** of these:

## Option A (recommended): DATABASE_URL

Vercel → Project → **Settings → Environment Variables**

| Name | Value |
|------|--------|
| `DATABASE_URL` | Copy from **Render** → Environment → `DATABASE_URL` (starts with `postgresql://`) |

Same Supabase database as Render.

## Option B: Supabase keys

| Name | Value |
|------|--------|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (Secret, not anon) |

## After saving

1. **Redeploy** Production
2. Admin → **Logout** → login `slcrickpro@2026`
3. Desktop Users tab → Ctrl+F5

## Test

- https://www.slcrickpro.live/api/version → `desktopUsers: true`
- Login → load users (empty list is OK)

If you see “Database not configured”, Option A or B is missing on Vercel.
