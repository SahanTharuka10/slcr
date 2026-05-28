#!/usr/bin/env node
const { syncServerIndex } = require('./lib/sync-server-index');

const force =
  process.argv.includes('--force') ||
  process.env.FORCE_SYNC_SERVER === '1' ||
  !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);

syncServerIndex({ force })
  .then((updated) => {
    if (updated) process.exit(0);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[sync-server] failed:', err.message);
    process.exit(1);
  });
