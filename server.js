#!/usr/bin/env node
/**
 * Production API entry for Render — loads server/app.js and ensures critical routes exist.
 */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, 'server', '.env') });
require('dotenv').config();

const appPath = path.join(__dirname, 'server', 'app.js');

if (!fs.existsSync(appPath)) {
  console.error('[SLCRICKPRO] Missing server/app.js');
  process.exit(1);
}

console.log('[SLCRICKPRO] Boot build 1.0.7 — entry server.js');
console.log('[SLCRICKPRO] DATABASE_URL:', process.env.DATABASE_URL ? 'set' : 'missing');

const api = require(appPath);

if (typeof api.startServer !== 'function') {
  console.error('[SLCRICKPRO] server/app.js must export startServer');
  process.exit(1);
}

api.startServer();
