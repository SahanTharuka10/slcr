const crypto = require('crypto');

const ADMIN_PIN = process.env.ADMIN_PIN || 'slcrickpro@2026';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.ADMIN_PIN || 'slcrickpro@2026';
const ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;

function applyCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  return req.body;
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function signAdminToken() {
  const exp = Date.now() + ADMIN_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_JWT_SECRET).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expiresInMs: ADMIN_TOKEN_TTL_MS };
}

function verifyAdminToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', ADMIN_JWT_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && data.exp > Date.now();
  } catch (_) {
    return false;
  }
}

function requireAdmin(req, res) {
  const token = getBearerToken(req);
  if (!verifyAdminToken(token)) {
    res.status(401).json({ success: false, message: 'Admin session expired. Log in again.' });
    return false;
  }
  return true;
}

function newEntityId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  ADMIN_PIN,
  applyCors,
  parseBody,
  getBearerToken,
  signAdminToken,
  requireAdmin,
  newEntityId,
};
