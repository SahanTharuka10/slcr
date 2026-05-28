const { applyCors, requireAdmin } = require('../../../lib/http');
const { getPool } = require('../../../lib/db');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'User id required' });

  try {
    const db = getPool();
    const userRes = await db.query(
      'SELECT id, username, "displayName" FROM desktop_users WHERE id = $1',
      [id]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

    const u = userRes.rows[0];
    const actRes = await db.query(
      `SELECT id, "tournamentId", name, venue, "playedAt", format, "matchCount", status, "createdAt"
       FROM desktop_user_activity WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
      [id]
    );

    return res.status(200).json({
      user: { id: u.id, username: u.username, displayName: u.displayName },
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
