#!/usr/bin/env node
/**
 * Render / production API entry — always use server/app.js (never stale server/index.js).
 */
const path = require('path');
const fs = require('fs');

const appPath = path.join(__dirname, 'server', 'app.js');

if (!fs.existsSync(appPath)) {
  console.error('[SLCRICKPRO] Missing server/app.js');
  process.exit(1);
}

console.log('[SLCRICKPRO] Starting API from server/app.js (build 1.0.6)');
const api = require(appPath);
if (typeof api.startServer !== 'function') {
  console.error('[SLCRICKPRO] server/app.js must export startServer');
  process.exit(1);
}
api.startServer();
