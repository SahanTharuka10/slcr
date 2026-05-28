const { applyCors, requireAdmin } = require('../../../lib/http');
const { withDb } = require('../../../lib/db');
const store = require('../../../lib/desktop-users-store');

function mapActivity(a) {
  return {
    id: a.id,
    tournamentId: a.tournamentId || a.tournament_id,
    name: a.name,
    venue: a.venue,
    playedAt: a.playedAt || a.played_at,
    format: a.format,
    matchCount: a.matchCount ?? a.match_count,
    status: a.status,
    createdAt: a.createdAt || a.created_at,
  };
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'User id required' });

  try {
    const user = await withDb((db) => store.findUserById(db, id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const rows = await withDb((db) => store.listActivity(db, id));
    return res.status(200).json({
      user,
      activity: rows.map(mapActivity),
    });
  } catch (e) {
    console.error('desktop-users activity', e);
    const code = e.code === 'NO_DATABASE' ? 503 : 500;
    return res.status(code).json({ error: e.message || 'Failed to load activity' });
  }
};
