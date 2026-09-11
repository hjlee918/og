'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const T=require('../checks/theme-artifact');
test('official Dracula artifact is the exact pinned public commit payload',()=>{
  const v=T.verify();assert.equal(v.ok,true);assert.equal(v.commit,T.COMMIT);assert.equal(v.manifestId,'dracula_logseq');
});
test('offline placement verifies exact bytes, reuses them, and refuses tampering',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f28-dracula-')),plugins=path.join(root,'plugins');
  const first=T.installOrVerify(plugins),second=T.installOrVerify(plugins);
  assert.equal(first.reused,false);assert.equal(second.reused,true);
  fs.appendFileSync(path.join(first.dest,'custom.css'),'\n');
  assert.throws(()=>T.installOrVerify(plugins),/changed/);
});
