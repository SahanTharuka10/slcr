const { applyCors, requireAdmin } = require('../../../lib/http');
const { getDb } = require('../../../lib/db');
const { mapUserRow } = require('../../../lib/schema');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
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

  try {
    const userRes = await db.query('SELECT * FROM desktop_users WHERE id = $1', [id]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

    const u = mapUserRow(userRes.rows[0]);
    const actRes = await db.query(
      `SELECT id, "tournamentId", name, venue, "playedAt", format, "matchCount", status, "createdAt"
       FROM desktop_user_activity WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
      [id]
    );

    return res.status(200).json({
      user: u,
      activity: actRes.rows.map((a) => ({
        id: a.id,
        tournamentId: a.tournamentId,
        name: a.name,
        venue: a.venue,
        playedAt: a.playedAt,
        format: a.format,
        matchCount: a.matchCount,
        status: a.status,
        createdAt: a.createdAt,
      })),
    });
  } catch (e) {
    console.error('desktop-users activity', e);
    return res.status(500).json({ error: e.message || 'Failed to load activity' });
  }
};
