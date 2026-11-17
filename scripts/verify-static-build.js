// Vercel build check: the pages the site needs are present.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const required = ['index.html', 'live.html', 'past.html', 'match.html', 'tournament.html', 'register.html', 'score.html',
  'css/site.css', 'js/config.js', 'js/site.js', 'api/handler.js'];
const missing = required.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error('BUILD FAIL: missing', missing.join(', '));
  process.exit(1);
}
console.log('OK: SLCRICKPRO site files present');
