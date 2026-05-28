/**
 * Render entry: bootstrap loads server/app.js (synced from GitHub on Render).
 */
const path = require('path');
const fs = require('fs');

const appPath = path.join(__dirname, 'app.js');

async function boot() {
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
    const { syncServerIndex } = require(path.join(__dirname, '..', 'scripts', 'lib', 'sync-server-index'));
    try {
      await syncServerIndex({ force: true });
    } catch (e) {
      console.warn('[SLCRICKPRO boot] sync app.js:', e.message);
    }
  }

  if (!fs.existsSync(appPath)) {
    console.error('[SLCRICKPRO boot] Missing server/app.js');
    process.exit(1);
  }

  require(appPath);
}

boot().catch((err) => {
  console.error('[SLCRICKPRO boot] failed:', err);
  process.exit(1);
});
