const { applyCors } = require('./lib/http');
const { getDatabaseUrl, getSupabaseConfig } = require('./lib/db');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const hasDb = !!getDatabaseUrl();
  const hasSupabase = !!getSupabaseConfig();

  return res.status(200).json({
    host: 'vercel',
    database: hasDb || hasSupabase,
    hasDatabaseUrl: hasDb,
    hasSupabaseKeys: hasSupabase,
    hint: hasDb || hasSupabase ? null : 'Add DATABASE_URL on Vercel (copy from Render env)',
  });
};
