#!/usr/bin/env node
/**
 * Render often uses Start Command: node server/index.js
 * Forward to the canonical API entry at repo root (server/app.js via server.js).
 */
require('../server.js');
