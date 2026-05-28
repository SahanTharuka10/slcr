const { applyCors } = require('./lib/http');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  return res.status(200).json({
    app: 'SLCRICKPRO',
    version: '1.0.6',
    host: 'vercel',
    features: { desktopUsers: true, desktopLogin: true },
  });
};
