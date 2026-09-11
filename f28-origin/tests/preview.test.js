'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreAfterExit,packageIdentity,canonicalExistingGraph,redactExistingGraphErrors}=require('../checks/preview');
test('never restores a profile while any retained application process is alive',async()=>{
 let calls=0;await assert.rejects(restoreAfterExit({},[71,72],pid=>pid===72,()=>calls++),/still alive/);assert.equal(calls,0);
});
test('restores only after exit and forwards the preservation handle',async()=>{
 const handle={preserved:'synthetic-marker'};let got;
 const result=await restoreAfterExit(handle,[71,72],()=>false,(h,o)=>{got={h,o};return {ok:true};});
 assert.equal(got.h,handle);assert.equal(got.o.label,'offline-preview');assert.equal(result.ok,true);
});
test('preview requires the exact retained clean package and startup hashes',()=>{
  const b=packageIdentity();assert.equal(b.preflight.ok,true);assert.equal(b.preflight.checks.length,15);
});
test('existing graph mode requires an absolute canonical contained directory',()=>{
  assert.throws(()=>canonicalExistingGraph('LogseqOGINTELTEST'),/exact absolute path/);
  const p='/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test/LogseqOGINTELTEST';
  assert.equal(canonicalExistingGraph(p),p);
});
test('existing graph evidence retains classification without graph text',()=>{
  const secret='disposable note title that must stay local';
  const rows=redactExistingGraphErrors([{kind:'console',phase:'plugin-host',operation:'observe',seq:3,text:secret}]);
  assert.equal(rows.length,1);assert.equal(rows[0].category,'other-runtime-error');
  assert.equal(rows[0].textRedacted,true);assert.equal(JSON.stringify(rows).includes(secret),false);
});
