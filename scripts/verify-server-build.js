const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'server', 'index.js');
if (!fs.existsSync(indexPath)) {
  console.error(
    'BUILD FAIL: server/index.js not found. Use "npm run build:server" on Render (full repo). ' +
      'Vercel static deploys must use "npm run build" only — server/ is in .vercelignore.'
  );
  process.exit(1);
}

const src = fs.readFileSync(indexPath, 'utf8');
if (!src.includes('/api/admin/desktop-users')) {
  console.error('BUILD FAIL: server/index.js missing desktop-users API');
  process.exit(1);
}
console.log('OK: desktop-users API present in server/index.js');
