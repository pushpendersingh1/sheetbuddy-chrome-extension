#!/usr/bin/env node
// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');

const watch = process.argv.includes('--watch');
const distDir = path.join(__dirname, 'dist');

// --- Placeholder icon generation (SheetBuddy green #10B981) ---
function createPNG(size, r, g, b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function crc32(buf) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    let crc = 0xffffffff;
    for (const byte of buf) crc = t[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const tb = Buffer.from(type, 'ascii');
    const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
    const cd = Buffer.concat([tb, data]);
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(cd), 0);
    return Buffer.concat([lb, cd, cb]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, RGB color type

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function generateIcons() {
  const iconsDir = path.join(distDir, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const size of [16, 48, 128]) {
    fs.writeFileSync(
      path.join(iconsDir, `icon${size}.png`),
      createPNG(size, 16, 185, 129),
    );
  }
}

// --- Static file copy ---
function copyStatics() {
  // Inject "alarms" only in watch/dev builds — the dev-reload polling loop needs
  // it, but production installs should not declare an unused permission.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  if (watch && !manifest.permissions.includes('alarms')) {
    manifest.permissions.splice(1, 0, 'alarms'); // keep alphabetical order
  }
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (const [src, dest] of [
    ['src/offscreen/offscreen.html', 'offscreen.html'],
    ['src/devpanel/devpanel.html', 'devpanel.html'],
  ]) {
    fs.copyFileSync(path.join(__dirname, src), path.join(distDir, dest));
  }
}

// --- Dev-reload server (watch mode only) ---
// The background service worker polls this endpoint every ~2 s.
// When the build version changes it calls chrome.runtime.reload() — same
// effect as the Reload button on chrome://extensions.
const DEV_RELOAD_PORT = 35729;

function startDevReloadServer() {
  let buildVersion = Date.now();
  let debounce = null;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ v: buildVersion }));
  });

  server.listen(DEV_RELOAD_PORT, '127.0.0.1', () => {
    console.log(`[SheetBuddy] Dev-reload server → http://127.0.0.1:${DEV_RELOAD_PORT}`);
  });

  // Returns a bump function. Debounced 50 ms so all 5 esbuild onEnd calls
  // (one per entry) collapse into a single version increment.
  return function bump() {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      buildVersion = Date.now();
      console.log(`[SheetBuddy] Rebuilt (v=${buildVersion}) — extension will reload`);
    }, 50);
  };
}

// --- esbuild entries ---
const entries = [
  { in: 'src/background/index.ts', out: 'background' },
  { in: 'src/content/index.ts',    out: 'content'    },
  { in: 'src/offscreen/index.ts',  out: 'offscreen'  },
  { in: 'src/injected/index.ts',   out: 'injected'   },
  { in: 'src/devpanel/index.ts',   out: 'devpanel'   },
];

const sharedOptions = {
  bundle: true,
  outdir: distDir,
  target: 'es2020',
  format: /** @type {'iife'} */ ('iife'),
  sourcemap: true,
  logLevel: /** @type {'info'} */ ('info'),
  // __DEV__ is tree-shaken away in production builds, eliminating the dev-reload
  // polling loop and its chrome.alarms usage entirely. Dead-code elimination of
  // the resulting `if (false)` branch requires minifySyntax — without it esbuild
  // substitutes the identifier but leaves the unreachable branch's code in place.
  define: { __DEV__: watch ? 'true' : 'false' },
  minifySyntax: !watch,
};

async function build() {
  fs.mkdirSync(distDir, { recursive: true });
  generateIcons();
  copyStatics();

  if (watch) {
    const bump = startDevReloadServer();
    const reloadPlugin = {
      name: 'dev-reload-notify',
      setup(build) { build.onEnd(() => bump()); },
    };

    const contexts = await Promise.all(
      entries.map(e =>
        esbuild.context({
          ...sharedOptions,
          plugins: [reloadPlugin],
          entryPoints: [{ in: e.in, out: e.out }],
        }),
      ),
    );
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('[SheetBuddy] Watching for changes — Ctrl+C to stop');
  } else {
    await Promise.all(
      entries.map(e =>
        esbuild.build({ ...sharedOptions, entryPoints: [{ in: e.in, out: e.out }] }),
      ),
    );
    console.log('[SheetBuddy] Build complete → dist/');
  }
}

build().catch(err => { console.error(err); process.exit(1); });
