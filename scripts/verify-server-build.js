const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
if (!src.includes('/api/admin/desktop-users')) {
  console.error('BUILD FAIL: server/index.js missing desktop-users API');
  process.exit(1);
}
console.log('OK: desktop-users API present in server/index.js');
