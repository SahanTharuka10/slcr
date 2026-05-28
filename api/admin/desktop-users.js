const { applyCors, parseBody, requireAdmin, newEntityId } = require('../lib/http');
const { withDb } = require('../lib/db');
const store = require('../lib/desktop-users-store');

function dbErrorResponse(res, e) {
  console.error('desktop-users API', e);
  const code = e.code === 'NO_DATABASE' ? 503 : 500;
  return res.status(code).json({
    error: e.message || 'Database error',
    hint:
      code === 503
        ? 'Vercel → Settings → Environment Variables → add DATABASE_URL (copy from Render)'
        : undefined,
  });
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    try {
      const users = await withDb((db) => store.listUsers(db));
      return res.status(200).json({ users });
    } catch (e) {
      return dbErrorResponse(res, e);
    }
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const username = String(body.username || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '').trim();
    const displayName = String(body.displayName || body.username || '').trim();

    if (!username || username.length < 2) {
      return res.status(400).json({ error: 'Username required (min 2 characters)' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password required (min 4 characters)' });
    }

    try {
      const users = await withDb((db) => store.listUsers(db));
      if (users.some((u) => u.username === username)) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      const user = await withDb((db) =>
        store.createUser(db, { username, password, displayName, newEntityId })
      );
      return res.status(200).json({ ok: true, user });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      return dbErrorResponse(res, e);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
