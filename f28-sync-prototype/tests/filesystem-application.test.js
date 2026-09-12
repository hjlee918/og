'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { createState } = require('../src/core');
const { snapshotFingerprint } = require('../src/planner');
const { applyBatch, encodeProtocol, initialize, invoke } = require('../src/filesystem-coordinator');
const { APPROVED_TEST_ROOT } = require('../src/persistence');

const helper = process.env.F28_HELPER;
const runName = process.env.F28_RUN_NAME;
const ownerToken = process.env.F28_OWNER_TOKEN;
if (!helper || !runName || !ownerToken) throw new Error('F28_HELPER, F28_RUN_NAME and F28_OWNER_TOKEN are required');
const suffix = process.env.F28_CASE_SUFFIX || '';
const cname = (name) => name + suffix;
const runRoot = path.join(APPROVED_TEST_ROOT, runName);
const base = createState('fs-experiment');
function event(eventId, kind, fileId, revisionId, values = {}) { return { eventId, kind, fileId, revisionId, ...values }; }
function init(kase, state = base) { return initialize({ helper, runName, caseName: kase, ownerToken, state }); }
function request(command, kase, state = base) { return { command, root: APPROVED_TEST_ROOT, runName, caseName: kase, ownerToken, state: require('../src/core').stableStringify(state), projectedFingerprint: snapshotFingerprint(state) }; }
function current(kase) { return fs.readFileSync(path.join(runRoot, kase, '.f28-sync', 'CURRENT'), 'utf8').trim(); }
function generation(kase, name = current(kase)) { return path.join(runRoot, kase, '.f28-sync', 'generations', name); }
function treeHash(root) { const hash=crypto.createHash('sha256'); function walk(dir, rel=''){ for(const name of fs.readdirSync(dir).sort()){ const p=path.join(dir,name), r=path.join(rel,name), st=fs.lstatSync(p); hash.update(r); hash.update(String(st.mode)); if(st.isFile()) hash.update(fs.readFileSync(p)); else if(st.isDirectory()) walk(p,r); else hash.update('other'); } } walk(root); return hash.digest('hex'); }

test('bounded protocol rejects duplicate fields and embedded NUL before root access', () => {
  const valid=encodeProtocol(request('inspect',cname('never-created')));
  const duplicate=valid.replace('COMMAND\tinspect','COMMAND\tinspect\nCOMMAND\tinspect');
  assert.equal(spawnSync(helper,[],{input:duplicate}).status,23);
  assert.equal(spawnSync(helper,[],{input:Buffer.concat([Buffer.from(valid),Buffer.from([0])])}).status,23);
});

test('normal create/update/rename/delete, Korean bytes and exact retry', () => {
  const kase=cname('normal'); init(kase); const genesis=current(kase); const genesisHash=treeHash(generation(kase,genesis));
  const first=applyBatch({helper,runName,caseName:kase,ownerToken,sourceSnapshot:base,events:[
    event('c','create','f1','r1',{path:'pages/회의 Notes.md',content:'안녕하세요\nEnglish'}),
    event('u','update','f1','r2',{parentRevisionId:'r1',content:'수정됨\nEnglish kept'}),
    event('r','rename','f1','r3',{parentRevisionId:'r2',path:'pages/동기화 Sync.org'})]});
  assert.equal(first.response.status,'acknowledged'); assert.equal(fs.readFileSync(path.join(generation(kase),'pages/동기화 Sync.org'),'utf8'),'수정됨\nEnglish kept');
  const second=applyBatch({helper,runName,caseName:kase,ownerToken,sourceSnapshot:first.state,events:[event('d','delete','f1','r4',{parentRevisionId:'r3'})]});
  assert.equal(second.response.status,'acknowledged');
  const retry=invoke(helper,second.request); assert.equal(retry.status,'already-applied');
  assert.equal(treeHash(generation(kase,genesis)),genesisHash);
});

test('NFC/NFD collision is rejected before helper publication', () => {
  const kase=cname('unicode'); init(kase);
  assert.throws(()=>applyBatch({helper,runName,caseName:kase,ownerToken,sourceSnapshot:base,events:[
    event('a','create','a','a1',{path:'pages/한글.md',content:'A'}),
    event('b','create','b','b1',{path:'pages/한글.md'.normalize('NFD'),content:'B'})]}),/batch refused/);
  assert.equal(current(kase),'0'.repeat(64));
});

test('traversal, symlink and ownership substitutions fail closed', () => {
  const kase=cname('boundary'); init(kase);
  const bad={...request('apply',kase),basisFingerprint:snapshotFingerprint(base),planId:'bad',transactionId:'1'.repeat(64),operationIds:['bad'],files:[{path:'../escape.md',content:'x'}]};
  assert.throws(()=>invoke(helper,bad),/path traversal|unsafe path/);
  assert.throws(()=>invoke(helper,{...request('inspect',kase),ownerToken:'2'.repeat(64)}),/ownership refused/);
  const sentinel=path.join(runRoot,'sentinel'); fs.writeFileSync(sentinel,'unchanged');
  const linkCase=cname('linked'); fs.symlinkSync(sentinel,path.join(runRoot,linkCase));
  assert.throws(()=>init(linkCase),/directory open refused/); assert.equal(fs.readFileSync(sentinel,'utf8'),'unchanged');
});

test('cooperative lock refuses overlap and releases after process death', async () => {
  const kase=cname('locking'); init(kase); const lockPath=path.join(runRoot,kase,'.f28-sync','LOCK'); const lockInode=fs.statSync(lockPath).ino;
  assert.equal(invoke(helper,request('inspect',kase)).status,'inspected');
  assert.equal(fs.statSync(lockPath).ino,lockInode);
  const child=spawn(helper,[],{stdio:['pipe','ignore','ignore']}); child.stdin.end(encodeProtocol({...request('hold',kase)}));
  await new Promise((resolve)=>setTimeout(resolve,250)); assert.throws(()=>invoke(helper,request('inspect',kase)),/another helper/);
  child.kill('SIGKILL'); await new Promise((resolve)=>child.once('exit',resolve));
  assert.equal(invoke(helper,request('inspect',kase)).status,'inspected');
  assert.equal(fs.statSync(lockPath).ino,lockInode);
});

for (const point of ['after-prepared','after-generation-rename','before-current-rename','during-synchronization']) {
  test(`restart rolls forward exact prepared work after ${point}`, () => {
    const kase=cname(`recover-${point.replaceAll('-','')}`); init(kase); const args={helper,runName,caseName:kase,ownerToken,sourceSnapshot:base,events:[event('c','create','f','r',{path:'pages/recover.md',content:point})]};
    assert.throws(()=>applyBatch({...args,failurePoint:point}),/INJECTED/); const done=applyBatch(args); assert.equal(done.response.status,'acknowledged');
  });
}

for (const point of ['after-current-rename','before-ack']) {
  test(`published unacknowledged ${point} is an exact retry`, () => {
    const kase=cname(`retry-${point.replaceAll('-','')}`); init(kase); const args={helper,runName,caseName:kase,ownerToken,sourceSnapshot:base,events:[event('c','create','f','r',{path:'pages/retry.md',content:point})]};
    assert.throws(()=>applyBatch({...args,failurePoint:point}),/INJECTED/); const done=applyBatch(args); assert.equal(done.response.status,'already-applied');
  });
}

test('unprepared interrupted staging is preserved and refused', () => {
  const kase=cname('incomplete'); init(kase); const args={helper,runName,caseName:kase,ownerToken,sourceSnapshot:base,events:[event('c','create','f','r',{path:'pages/a.md',content:'a'})]};
  assert.throws(()=>applyBatch({...args,failurePoint:'during-staging'}),/INJECTED/); assert.throws(()=>applyBatch(args),/file open refused/); assert.equal(current(kase),'0'.repeat(64));
});

test('stale basis and source corruption before publication are refused', () => {
  const kase=cname('stale'); init(kase); const args={helper,runName,caseName:kase,ownerToken,sourceSnapshot:base,events:[event('c','create','f','r',{path:'pages/a.md',content:'a'})]};
  const first=applyBatch(args); assert.throws(()=>applyBatch({...args,events:[event('x','create','x','x',{path:'pages/x.md',content:'x'})]}),/stale basis/);
  const kase2=cname('sourcechange'); init(kase2); const args2={...args,caseName:kase2}; assert.throws(()=>applyBatch({...args2,failurePoint:'after-prepared'}),/INJECTED/);
  fs.writeFileSync(path.join(generation(kase2),'state.json'),'changed'); assert.throws(()=>applyBatch(args2),/state hash mismatch/); assert.ok(first.state);
});

for (const target of ['CURRENT','manifest.txt','state.json','file']) {
  test(`corrupt or missing ${target} is refused`, () => {
    const kase=cname(`corrupt-${target.toLowerCase().replace('.','')}`); init(kase); const done=applyBatch({helper,runName,caseName:kase,ownerToken,sourceSnapshot:base,events:[event('c','create','f','r',{path:'pages/a.md',content:'a'})]});
    const gen=generation(kase); if(target==='CURRENT')fs.writeFileSync(path.join(runRoot,kase,'.f28-sync','CURRENT'),'../unsafe\n'); else if(target==='file')fs.writeFileSync(path.join(gen,'pages/a.md'),'changed'); else fs.renameSync(path.join(gen,target),path.join(gen,`${target}.missing`));
    assert.throws(()=>invoke(helper,{...request('inspect',kase,done.state)}),/unsafe CURRENT|file open refused|materialized file mismatch/);
  });
}
