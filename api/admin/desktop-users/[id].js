const { requireAdmin } = require('../../lib/admin-auth');
const db = require('../../lib/desktop-db');

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
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      await db.updateUser(id, body);
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'DELETE') {
      await db.deleteUser(id);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed' });
  }
};
