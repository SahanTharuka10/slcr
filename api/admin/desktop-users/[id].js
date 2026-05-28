const { requireAdmin } = require('../../lib/admin-auth');
const db = require('../../lib/desktop-db');
const { proxyToRender } = require('../../lib/render-proxy');

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

async function handleLocal(req, res, id) {
  if (!requireAdmin(req, res)) return;
  try {
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      await db.updateUser(id, body);
      res.json({ ok: true });
      return;
    }
    if (req.method === 'DELETE') {
      await db.deleteUser(id);
      res.json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed' });
  }
}

module.exports = async (req, res) => {
  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'Missing user id' });
    return;
  }

  if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')) {
    return handleLocal(req, res, id);
  }

  try {
    await proxyToRender(req, res, `/api/admin/desktop-users/${encodeURIComponent(id)}`);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
