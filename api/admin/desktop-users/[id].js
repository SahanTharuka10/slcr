const bcrypt = require('bcrypt');
const { applyCors, parseBody, requireAdmin } = require('../../lib/http');
const { getDb } = require('../../lib/db');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAdmin(req, res)) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'User id required' });

  let db;
  try {
    db = await getDb();
  } catch (e) {
    const code = e.code === 'NO_DATABASE_URL' ? 503 : 500;
    return res.status(code).json({ error: e.message || 'Database unavailable' });
  }

  if (req.method === 'PATCH') {
    const body = parseBody(req);
    try {
      const found = await db.query('SELECT id FROM desktop_users WHERE id = $1', [id]);
      if (!found.rows.length) return res.status(404).json({ error: 'User not found' });

      const sets = [];
      const vals = [];
      let i = 1;

      if (typeof body.active === 'boolean') {
        sets.push(`active = $${i++}`);
        vals.push(body.active);
      }
      if (body.displayName != null) {
        sets.push(`"displayName" = $${i++}`);
        vals.push(String(body.displayName).trim());
      }
      if (body.password) {
        const pw = String(body.password).trim();
        if (pw.length < 4) return res.status(400).json({ error: 'Password min 4 characters' });
        sets.push(`"passwordHash" = $${i++}`);
        vals.push(await bcrypt.hash(pw, 10));
      }

      if (!sets.length) return res.status(200).json({ ok: true });
      vals.push(id);
      await db.query(`UPDATE desktop_users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('desktop-users PATCH', e);
      return res.status(500).json({ error: e.message || 'Failed to update user' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const found = await db.query('SELECT id FROM desktop_users WHERE id = $1', [id]);
      if (!found.rows.length) return res.status(404).json({ error: 'User not found' });
      await db.query('DELETE FROM desktop_user_activity WHERE "userId" = $1', [id]);
      await db.query('DELETE FROM desktop_users WHERE id = $1', [id]);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('desktop-users DELETE', e);
      return res.status(500).json({ error: e.message || 'Failed to delete user' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
