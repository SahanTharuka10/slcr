const { requireAdmin } = require('../lib/admin-auth');
const db = require('../lib/desktop-db');

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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).startsWith('postgres')) {
    if (!requireAdmin(req, res)) return;
    res.status(503).json({
      error: 'DATABASE_URL is not set on Vercel.',
      steps: [
        'Vercel → Project → Settings → Environment Variables',
        'Add DATABASE_URL = same postgresql:// URL as on Render',
        'Redeploy Production',
      ],
    });
    return;
  }

  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const users = await db.listUsers();
      res.status(200).json({ users, source: 'vercel-db' });
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
      res.status(200).json({ ok: true, user });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[desktop-users]', e);
    res.status(e.status || 500).json({ error: e.message || 'Request failed' });
  }
};
