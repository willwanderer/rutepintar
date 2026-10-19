// Menyalin Leaflet dari node_modules ke www/lib agar aplikasi tidak bergantung pada CDN.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist');
const dest = path.join(__dirname, '..', 'www', 'lib', 'leaflet');

if (!fs.existsSync(src)) {
  console.error('leaflet tidak ditemukan. Jalankan "npm install" dulu.');
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css']) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
}
fs.cpSync(path.join(src, 'images'), path.join(dest, 'images'), { recursive: true });
console.log('Leaflet disalin ke', dest);
