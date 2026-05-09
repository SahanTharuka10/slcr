# SLCRICKPRO Cloud Deployment

Target setup:

- Frontend: Vercel static hosting
- Realtime: Firebase Realtime Database
- Database: Supabase Postgres

## 1. Firebase

1. Create a Firebase project.
2. Enable Realtime Database.
3. Start in test mode for first deployment.
4. Copy the Firebase web app config into `js/cloud-config.js`.
5. Import `firebase-database.rules.json` in Realtime Database Rules.

Firebase is used for fast live data:

- `liveMatches`
- `matches`
- `broadcastCommands`

## 2. Supabase

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `supabase-schema.sql`.
4. Copy the project URL and anon public key into `js/cloud-config.js`.

Supabase stores persistent data:

- `players`
- `teams`
- `matches`
- `tournaments`
- `match_reports`

## 3. Vercel

1. Import this project in Vercel.
2. Framework preset: Other.
3. Build command: `npm run build`.
4. Output directory: `.`.
5. Deploy.

The server folder is ignored by `.vercelignore`; Vercel only serves the frontend.

## 4. Optional Express Backend

If you still want the old Express backend as a fallback, deploy `server/index.js` separately and set:

```js
backendUrl: "https://your-backend-url.com"
```

inside `js/cloud-config.js`.

Leave `backendUrl` empty for Firebase + Supabase only.

## Security Note

The included Firebase rules and Supabase policies are public so the existing no-login app works immediately. Before a public production launch, add authentication and restrict writes to admins/scorers.
