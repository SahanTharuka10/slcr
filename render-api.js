#!/usr/bin/env node
// SLCRICKPRO site API — the code lives in server/api.js.
// Works as "node render-api.js" (repo root) and is what Vercel's /api function loads.
const api = require('./server/api');

module.exports = api;
if (require.main === module) api.startServer();
