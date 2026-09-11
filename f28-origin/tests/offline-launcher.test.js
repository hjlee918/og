'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chooseGraph,confirmLimitations}=require('../checks/offline-launcher');
test('native picker cancellation performs no selection',()=>{
  const got=chooseGraph(()=>Buffer.from('__CANCELLED__\n'));assert.equal(got,null);
});
test('native picker returns its exact folder without only the trailing slash',()=>{
  const p='/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test/test-owned/';
  assert.equal(chooseGraph(()=>Buffer.from(p+'\n')),p.slice(0,-1));
});
test('limitations dialog can cancel or continue',()=>{
  assert.equal(confirmLimitations(()=>Buffer.from('CANCEL\n')),false);
  assert.equal(confirmLimitations(()=>Buffer.from('OPEN\n')),true);
});
