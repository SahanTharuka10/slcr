/**
 * Vercel /api/* handler.
 *
 *  • DATABASE_URL set in Vercel  → the API (render-api.js) runs right here, on Vercel,
 *    against the same Postgres (Supabase). No Render, no cold-start wait.
 *  • DATABASE_URL not set        → requests are proxied to the Render API (old setup).
 */
const RENDER = (process.env.RENDER_API_URL || 'https://slcrickpro.onrender.com').replace(/\/$/, '');
// Accept the names Vercel's Supabase / Postgres integrations use, too.
const DB_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'SUPABASE_DB_URL'];
if (!process.env.DATABASE_URL) {
  const alt = DB_VARS.find((k) => process.env[k]);
  if (alt) process.env.DATABASE_URL = process.env[alt];
}
const LOCAL = !!process.env.DATABASE_URL;
// Names only (never values) — helps check the Vercel env setup from outside.
const DB_ENV_SEEN = DB_VARS.filter((k) => process.env[k]).join(',') || 'none';

// ── API on Vercel ────────────────────────────────────────────────
let app = null;
let ready = null;
function localApi() {
  if (!app) {
    app = require('../render-api').app;
    const store = require('../server/store');
    ready = store.init().catch((e) => {
      ready = null; // retry on the next request
      throw e;
    });
  } else if (!ready) {
    ready = require('../server/store').init();
  }
  return ready.then(() => app);
}

// ── proxy to Render (fallback) ───────────────────────────────────
/** The real API path. vercel.json rewrites /api/<anything> → /api/handler?path=<anything>. */
function targetPath(req) {
  const url = String(req.url || '');
  const hasPathParam = req.query && req.query.path != null && req.query.path !== '';
  if (!hasPathParam && /^\/api(\/|$|\?)/.test(url) && !/^\/api\/handler(\/|$|\?)/.test(url)) return url;
  const seg = req.query && req.query.path;
  const pathPart = Array.isArray(seg) ? seg.join('/') : seg || '';
  const params = new URLSearchParams();
  Object.entries(req.query || {}).forEach(([k, v]) => {
    if (k === 'path') return;
    (Array.isArray(v) ? v : [v]).forEach((x) => params.append(k, x));
  });
  const qs = params.toString();
  return `/api/${pathPart}${qs ? `?${qs}` : ''}`;
}

async function proxy(req, res) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding'];

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  try {
    const upstream = await fetch(RENDER + targetPath(req), {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
    });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'transfer-encoding' || k === 'content-encoding' || k === 'content-length') return;
      res.setHeader(key, value);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ ok: false, error: 'API unreachable', message: e.message });
  }
}

module.exports = async (req, res) => {
  // Shows where the API ran: 'vercel' (DATABASE_URL set) or 'render-proxy'
  res.setHeader('x-slc-api', LOCAL ? 'vercel' : 'render-proxy');
  res.setHeader('x-slc-db-env', DB_ENV_SEEN);
  if (!LOCAL) return proxy(req, res);
  req.url = targetPath(req); // Express routes on the real path, e.g. /api/matches/ID
  try {
    const api = await localApi();
    res.setHeader('Cache-Control', 'no-store');
    return api(req, res);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Database not reachable', message: e.message });
  }
};
