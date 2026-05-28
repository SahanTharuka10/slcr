const { ADMIN_PIN, ADMIN_TOKEN_TTL_MS, createAdminToken } = require('../lib/admin-auth');

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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = await parseBody(req);
  const submitted = String(body.pin || body.password || '').trim();

  if (submitted === ADMIN_PIN) {
    res.json({ success: true, token: createAdminToken(), expiresInMs: ADMIN_TOKEN_TTL_MS, source: 'vercel' });
    return;
  }

  res.status(401).json({ success: false, message: 'Wrong PIN. Check your credentials.' });
};
