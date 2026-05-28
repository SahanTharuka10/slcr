const crypto = require('crypto');

const ADMIN_PIN = (process.env.ADMIN_PIN || 'slcrickpro@2026').trim();
const ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;

function createAdminToken() {
  const exp = Date.now() + ADMIN_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_PIN).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function validateAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', ADMIN_PIN).update(payload).digest('hex');
  if (sig !== expected) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function getBearer(req) {
  const auth = req.headers.authorization || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return (req.headers['x-access-token'] || '').trim();
}

function requireAdmin(req, res) {
  const token = getBearer(req);
  if (!validateAdminToken(token)) {
    res.status(401).json({ success: false, message: 'Admin session expired. Log in again.' });
    return false;
  }
  return true;
}

module.exports = {
  ADMIN_PIN,
  ADMIN_TOKEN_TTL_MS,
  createAdminToken,
  validateAdminToken,
  getBearer,
  requireAdmin,
};
