#!/usr/bin/env node
/**
 * Render start entry — sync server/index.js then boot API.
 * Works even when dashboard Start Command is "node server/index.js" if build ran sync.
 */
const path = require('path');
const { spawn } = require('child_process');
const { syncServerIndex } = require('./lib/sync-server-index');
const INDEX_PATH = require('path').join(__dirname, '..', 'server', 'index.js');

(async () => {
  const onRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  try {
    await syncServerIndex({ force: onRender || process.env.FORCE_SYNC_SERVER === '1' });
  } catch (err) {
    console.error('[start-server] sync failed:', err.message);
    if (!require('fs').existsSync(INDEX_PATH)) {
      process.exit(1);
    }
    console.warn('[start-server] continuing with existing server/index.js');
  }

  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code === null ? 1 : code);
  });
})();
