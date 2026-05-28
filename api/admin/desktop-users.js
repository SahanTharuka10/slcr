const { requireAdmin } = require('../lib/admin-auth');
const db = require('../lib/desktop-db');
const { proxyToRender } = require('../lib/render-proxy');

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

async function handleLocal(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const users = await db.listUsers();
      res.json({ users, source: 'vercel-db' });
      return;
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '').trim();
      const displayName = String(body.displayName || body.username || '').trim();
      if (!username || username.length < 2) {
        res.status(400).json({ error: 'Username required (min 2 characters)' });
        return;
      }
      if (!password || password.length < 4) {
        res.status(400).json({ error: 'Password required (min 4 characters)' });
        return;
      }
      const user = await db.createUser({ username, password, displayName });
      res.json({ ok: true, user });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const code = e.status || 500;
    res.status(code).json({ error: e.message || 'Request failed' });
  }
}

module.exports = async (req, res) => {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')) {
    return handleLocal(req, res);
  }

  if (!requireAdmin(req, res)) return;

  try {
    const status = await proxyToRender(req, res, '/api/admin/desktop-users');
    if (status === 404 && !res.headersSent) {
      res.status(503).json({
        error:
          'Render API not deployed. Add DATABASE_URL on Vercel (same Supabase URL as Render) and redeploy.',
      });
    }
  } catch (e) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Render unreachable', message: e.message });
    }
  }
};
