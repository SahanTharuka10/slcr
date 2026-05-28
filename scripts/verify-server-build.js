const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'server', 'app.js');
const bootPath = path.join(__dirname, '..', 'server', 'index.js');
if (!fs.existsSync(appPath)) {
  console.error('BUILD FAIL: server/app.js not found.');
  process.exit(1);
}
const src = fs.readFileSync(appPath, 'utf8');
if (!src.includes('/api/admin/desktop-users')) {
  console.error('BUILD FAIL: server/app.js missing desktop-users API');
  process.exit(1);
}
const bootSrc = fs.existsSync(bootPath) ? fs.readFileSync(bootPath, 'utf8') : '';
if (!bootSrc.includes("require('../server.js')") && !bootSrc.includes('require("../server.js")')) {
  console.error('BUILD FAIL: server/index.js must forward to ../server.js');
  process.exit(1);
}
if (!src.includes('module.exports.startServer')) {
  console.error('BUILD FAIL: server/app.js must export startServer');
  process.exit(1);
}
console.log('OK: desktop-users API present in server/app.js');
