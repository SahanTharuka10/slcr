# SLCRICKPRO website — slcrickpro.live

Live cricket scores, a free web scorer and past match stats. The SLCRICKPRO
desktop app publishes matches here when the scorer picks **Online**.

| Page | What it does |
|------|--------------|
| `index.html` | Home — Ongoing · Score new match · Past stats · Get desktop app |
| `live.html` | Live matches + results from the last 24 hours |
| `past.html` | Finished matches (older than 24h), grouped by tournament |
| `match.html?id=` | Scorecard (auto-refresh while live) + summary PDF |
| `tournament.html?id=` | Points table, fixtures; organizer tools with `#key=` |
| `register.html?token=` | Team registration link — players, numbers, photos |
| `score.html` | Web scorer — single match or small round robin, PDF summary |

Light / dark mode: button in the header (remembers the choice).

## Hosting

- **Vercel** serves the static site and `/api/*` (`api/handler.js`, via the rewrite in `vercel.json`).
  - With `DATABASE_URL` set in Vercel (Supabase *transaction pooler* string,
    port 6543) the API runs on Vercel itself — no Render needed.
  - Without it, `/api/*` is proxied to Render (`RENDER_API_URL`, default
    https://slcrickpro.onrender.com).
- **Render** (optional) runs `render-api.js` with the same `DATABASE_URL`.
- Tables `slc_matches`, `slc_tournaments`, `slc_rosters` are created on first
  use; older tables are not touched.
- Desktop download link: `js/config.js` → `desktopDownloadUrl`.

Local: `npm install` then `npm run dev` → http://localhost:3000 (in-memory data
without `DATABASE_URL`).
