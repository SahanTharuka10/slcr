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

- **Vercel** serves the static site; `api/[[...path]].js` proxies `/api/*` to Render.
- **Render** runs `render-api.js` (Express + Postgres). Set `DATABASE_URL`
  (Supabase connection string). Tables `slc_matches`, `slc_tournaments`,
  `slc_rosters` are created on start; older tables are not touched.
- Desktop download link: `js/config.js` → `desktopDownloadUrl`.

Local: `npm install` then `npm run dev` → http://localhost:3000 (in-memory data
without `DATABASE_URL`).
