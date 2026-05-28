const { requireAdmin } = require('../../../lib/admin-auth');
const db = require('../../../lib/desktop-db');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'Missing user id' });
    return;
  }

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).startsWith('postgres')) {
    if (!requireAdmin(req, res)) return;
    res.status(503).json({ error: 'DATABASE_URL not set on Vercel' });
    return;
  }

  if (!requireAdmin(req, res)) return;

  try {
    const data = await db.getActivity(id);
    res.status(200).json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed' });
  }
};
