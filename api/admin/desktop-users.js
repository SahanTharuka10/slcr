const bcrypt = require('bcrypt');
const { applyCors, parseBody, requireAdmin, newEntityId } = require('../lib/http');
const { getDb } = require('../lib/db');
const { mapUserRow } = require('../lib/schema');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAdmin(req, res)) return;

  let db;
  try {
    db = await getDb();
  } catch (e) {
    const code = e.code === 'NO_DATABASE_URL' ? 503 : 500;
    return res.status(code).json({ error: e.message || 'Database unavailable' });
  }

  if (req.method === 'GET') {
    try {
      const { rows } = await db.query('SELECT * FROM desktop_users');
      const users = rows.map(mapUserRow).filter(Boolean);
      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json({ users });
    } catch (e) {
      console.error('desktop-users GET', e);
      return res.status(500).json({ error: e.message || 'Failed to list users' });
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
      const existing = await db.query('SELECT id FROM desktop_users WHERE username = $1', [username]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const now = Date.now();
      const id = newEntityId('DU');
      await db.query(
        `INSERT INTO desktop_users (id, username, "passwordHash", "displayName", active, "createdAt", "lastLoginAt")
         VALUES ($1, $2, $3, $4, true, $5, NULL)`,
        [id, username, passwordHash, displayName || username, now]
      );

      return res.status(200).json({
        ok: true,
        user: { id, username, displayName: displayName || username, active: true, createdAt: now },
      });
    } catch (e) {
      console.error('desktop-users POST', e);
      return res.status(500).json({ error: e.message || 'Failed to create user' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
