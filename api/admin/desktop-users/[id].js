const { applyCors, parseBody, requireAdmin } = require('../../lib/http');
const { withDb } = require('../../lib/db');
const store = require('../../lib/desktop-users-store');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAdmin(req, res)) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'User id required' });

  if (req.method === 'PATCH') {
    const body = parseBody(req);
    try {
      const user = await withDb((db) => store.findUserById(db, id));
      if (!user) return res.status(404).json({ error: 'User not found' });

      const updates = {};
      if (typeof body.active === 'boolean') updates.active = body.active;
      if (body.displayName != null) updates.displayName = String(body.displayName).trim();
      if (body.password) {
        const pw = String(body.password).trim();
        if (pw.length < 4) return res.status(400).json({ error: 'Password min 4 characters' });
        updates.passwordHash = await store.bcrypt.hash(pw, 10);
      }
      if (!Object.keys(updates).length) return res.status(200).json({ ok: true });

      await withDb((db) => store.updateUser(db, id, updates));
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('desktop-users PATCH', e);
      return res.status(500).json({ error: e.message || 'Failed to update user' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const user = await withDb((db) => store.findUserById(db, id));
      if (!user) return res.status(404).json({ error: 'User not found' });
      await withDb((db) => store.deleteUser(db, id));
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('desktop-users DELETE', e);
      return res.status(500).json({ error: e.message || 'Failed to delete user' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
