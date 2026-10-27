// Copies third-party browser libs from node_modules into the renderer vendor
// folder so they can be loaded with a plain <script> tag under contextIsolation.
// Runs on postinstall and before dev/build/dist.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'src', 'renderer', 'vendor');

const copies = [
  {
    from: path.join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js'),
    to: path.join(vendorDir, 'hls.min.js'),
  },
];

fs.mkdirSync(vendorDir, { recursive: true });

let copied = 0;
for (const { from, to } of copies) {
  if (!fs.existsSync(from)) {
    console.warn(`[copy-vendor] missing source (run npm install first): ${from}`);
    continue;
  }
  fs.copyFileSync(from, to);
  copied += 1;
  console.log(`[copy-vendor] ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}
console.log(`[copy-vendor] done (${copied} file(s))`);
