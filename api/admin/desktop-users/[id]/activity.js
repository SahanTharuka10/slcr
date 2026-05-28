const { requireAdmin } = require('../../../lib/admin-auth');
const db = require('../../../lib/desktop-db');
const { proxyToRender } = require('../../../lib/render-proxy');

module.exports = async (req, res) => {
  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'Missing user id' });
    return;
  }

  if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')) {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await db.getActivity(id);
      res.json(data);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Failed' });
    }
    return;
  }

  try {
    await proxyToRender(req, res, `/api/admin/desktop-users/${encodeURIComponent(id)}/activity`);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
