/**
 * Download server/index.js from GitHub main (Render deploys sometimes run stale copies).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_PATH = path.join(ROOT, 'server', 'app.js');
const INDEX_URL =
  process.env.SERVER_INDEX_URL ||
  process.env.SERVER_APP_URL ||
  'https://raw.githubusercontent.com/SahanTharuka10/slcr/main/server/app.js';

function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const next = res.headers.location;
          if (!next) return reject(new Error('Redirect without location'));
          return download(next).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

function verifyServerSource(src) {
  if (!src.includes("app.get('/api/version'")) {
    throw new Error('Missing /api/version route');
  }
  if (!src.includes('/api/admin/desktop-users')) {
    throw new Error('Missing /api/admin/desktop-users routes');
  }
}

function bundledLooksCurrent() {
  if (!fs.existsSync(INDEX_PATH)) return false;
  try {
    verifyServerSource(fs.readFileSync(INDEX_PATH, 'utf8'));
    return true;
  } catch (_) {
    return false;
  }
}

async function syncServerIndex({ force = false } = {}) {
  const onRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  const onVercel = !!process.env.VERCEL;

  if (onVercel && !force) {
    console.log('[sync-server] skip on Vercel (static site)');
    return false;
  }

  if (!force && !onRender) {
    if (bundledLooksCurrent()) {
      console.log('[sync-server] skip (bundled server/index.js is current)');
      return false;
    }
  }

  if (!force && onRender && bundledLooksCurrent()) {
    console.log('[sync-server] bundled server/app.js OK on Render');
    return false;
  }

  console.log('[sync-server] downloading', INDEX_URL);
  const body = await download(INDEX_URL);
  verifyServerSource(body);
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, body, 'utf8');
  console.log('[sync-server] wrote server/app.js (desktop API included)');
  return true;
}

module.exports = { syncServerIndex, verifyServerSource, INDEX_PATH };
