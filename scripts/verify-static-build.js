/**
 * Vercel / static site build — server/ is excluded via .vercelignore.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const required = [
  'index.html',
  'pages/admin.html',
  'js/admin-desktop-users.js',
  'js/cloud-config.js',
  'api/version.js',
  'api/admin/desktop-users.js',
];

for (const rel of required) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    console.error('BUILD FAIL: missing static file:', rel);
    process.exit(1);
  }
}

console.log('OK: static site files present (server/ not required on Vercel)');
