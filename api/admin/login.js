const { applyCors, parseBody, ADMIN_PIN, signAdminToken } = require('../lib/http');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseBody(req);
  const submitted = String(body.pin || body.password || '').trim();
  if (submitted !== ADMIN_PIN) {
    return res.status(401).json({ success: false, message: 'Wrong PIN. Check your credentials.' });
  }

  const { token, expiresInMs } = signAdminToken();
  return res.status(200).json({ success: true, token, expiresInMs });
};
