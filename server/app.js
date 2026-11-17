#!/usr/bin/env node
// Older Render setups use Root Directory = server and start "node app.js" (npm start).
// Same API as render-api.js — see server/api.js.
require('./api').startServer();
