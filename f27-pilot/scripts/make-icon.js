#!/usr/bin/env node
'use strict';
//
// Temporary pilot icon, built offline from an asset already in the tree using
// tools already on the machine (/usr/bin/sips, /usr/bin/iconutil). The
// monochrome mark is visibly different from the installed application's colour
// icon in the Dock and in Cmd-Tab, which is the entire requirement. It is
// explicitly temporary and carries no design claim.
//
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(REPO, 'resources', 'icon_monochrome.png');
const TARGET = path.join(REPO, 'static', 'icons', 'pilot.icns');

const SIPS = '/usr/bin/sips';
const ICONUTIL = '/usr/bin/iconutil';

for (const tool of [SIPS, ICONUTIL]) {
  if (!fs.existsSync(tool)) {
    console.error(`[make-icon] REFUSED: ${tool} not present`);
    process.exit(1);
  }
}
if (!fs.existsSync(SOURCE)) {
  console.error(`[make-icon] REFUSED: source icon missing: ${SOURCE}`);
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'f27-pilot-icon-'));
const iconset = path.join(work, 'pilot.iconset');
fs.mkdirSync(iconset);

// The sizes iconutil expects for a complete .icns.
const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const s of sizes) {
  const single = path.join(iconset, `icon_${s}x${s}.png`);
  execFileSync(SIPS, ['-z', String(s), String(s), SOURCE, '--out', single], { stdio: 'ignore' });
  if (s > 16) {
    // the @2x of the half-size slot
    fs.copyFileSync(single, path.join(iconset, `icon_${s / 2}x${s / 2}@2x.png`));
  }
}
fs.rmSync(path.join(iconset, 'icon_1024x1024.png'), { force: true });

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
execFileSync(ICONUTIL, ['-c', 'icns', iconset, '-o', TARGET], { stdio: 'inherit' });
fs.rmSync(work, { recursive: true, force: true });

console.log(`[make-icon] wrote ${TARGET} (${fs.statSync(TARGET).size} bytes) from ${path.basename(SOURCE)}`);
