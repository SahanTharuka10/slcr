/**
 * Render start: refresh server/index.js from GitHub main, then boot API.
 * Fixes stale deploys when Render runs an old copy without desktop-user routes.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'server', 'index.js');
const INDEX_URL =
  process.env.SERVER_INDEX_URL ||
  'https://raw.githubusercontent.com/SahanTharuka10/slcr/main/server/index.js';

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
    throw new Error('Missing desktop-users routes');
  }
}

(async () => {
  if (process.env.SKIP_SERVER_REFRESH !== '1') {
    try {
      console.log('[SLCRICKPRO] Refreshing server/index.js from GitHub...');
      const body = await download(INDEX_URL);
      verifyServerSource(body);
      fs.writeFileSync(INDEX_PATH, body, 'utf8');
      console.log('[SLCRICKPRO] server/index.js OK (desktop API included)');
    } catch (e) {
      console.warn('[SLCRICKPRO] server refresh skipped:', e.message);
      if (fs.existsSync(INDEX_PATH)) {
        verifyServerSource(fs.readFileSync(INDEX_PATH, 'utf8'));
        console.log('[SLCRICKPRO] Using bundled server/index.js');
      } else {
        throw e;
      }
    }
  }

  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code === null ? 1 : code);
  });
})().catch((err) => {
  console.error('[SLCRICKPRO] render-start failed:', err);
  process.exit(1);
});
