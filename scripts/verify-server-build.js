// Render build check: API entry loads.
const path = require('path');
const api = require(path.join(__dirname, '..', 'render-api.js'));
if (!api || typeof api.startServer !== 'function') {
  console.error('BUILD FAIL: render-api.js must export startServer');
  process.exit(1);
}
console.log('OK: SLCRICKPRO API loads');
