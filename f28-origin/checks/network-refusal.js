'use strict';
// Only packaged first-party startup control is accepted; never install after launch.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VERSION = require('../src/network-bootstrap').VERSION;
function assertReady(executablePath) {
  const built = require('../../f28-refpath/checks/packaged-app').resolve('Logseq-OG-F28-OriginExp');
  if (executablePath && path.resolve(executablePath) !== built.exe) throw Error('activation blocked: wrong executable');
  const m = built.preflight.manifest;
  if (!built.preflight.ok || m.builtFrom.dirty || !m.artifacts['network-bootstrap.js'])
    throw Error('activation blocked: verified clean startup control required');
  const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  for (const [source, shipped] of [['network-bootstrap.js','network-bootstrap.js'], ['experiment-main.js','pilot-main.js']]) {
    if (hash(path.join(__dirname,'../src',source)) !== hash(path.join(built.resApp,shipped)))
      throw Error('activation blocked: startup source mismatch');
  }
  return built;
}
function launchWith(launch) {
  return async opts => {
    if (!opts || !opts.executablePath) throw Error('activation blocked: explicit executable required');
    assertReady(opts.executablePath);
    const app = await launch(opts);
    try {
      const evidence = await read(app);
      if (!evidence || !evidence.active || evidence.version !== VERSION) throw Error('startup control evidence missing');
      return app;
    } catch (e) { await app.close(); throw e; }
  };
}
async function install() { throw Error('activation blocked: post-launch installation forbidden'); }
async function read(app) { return app.evaluate(() => global.__expNet || null).catch(() => null); }
module.exports = {assertReady,launchWith,install,read};
