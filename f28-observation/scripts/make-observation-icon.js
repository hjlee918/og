#!/usr/bin/env node
'use strict';

// This macOS host refuses locally generated iconsets. Reuse the repository's
// already-built canary icon only after pinning its exact bytes. It remains
// visually distinct from the ordinary stable icon and requires no download.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..');
const source = path.join(REPO, 'resources', 'icons', 'canary', 'logseq_big_sur.icns');
const target = path.join(REPO, 'static', 'icons', 'pilot.icns');
const expected = '804efcebfeab2444b2468811a4bd390c1e8005b1553552b55addbc64f0362dae';
const bytes = fs.readFileSync(source);
const measured = crypto.createHash('sha256').update(bytes).digest('hex');
if (measured !== expected) throw new Error(`refusing changed canary icon ${measured}`);
fs.mkdirSync(path.dirname(target), {recursive: true});
fs.copyFileSync(source, target);
console.log(`[make-observation-icon] copied hash-pinned canary icon (${bytes.length} bytes)`);
