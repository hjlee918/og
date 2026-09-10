'use strict';
// Actual preserved TEST package round trip. Never installed Logseq or a user profile.
const fs = require('fs');
const path = require('path');
const APP = require('../../f28-refpath/checks/packaged-app');
const FP = require('../../f28-refpath/checks/fresh-profile');
const B = require('../../f27-pilot/checks/allowed-root');
const GH = require('../../f27-pilot/checks/graph-hash');
const OP = require('../../f27-pilot/checks/owned-process');
const CG = require('../../f28-refpath/checks/make-combined-graph');
const RD = require('../../f28-refpath/checks/reforder-read');
const NET = require('./network-refusal');
const STORAGE = require('./storage-origin');
const {_electron} = require('../../node_modules/playwright');
const REC = require('../../f28-refpath/checks/recorder');
const KEY = 'f28-origin-synthetic-rollback-preference';
async function main() {
  const old = APP.resolve('Logseq-OG-F28-RefPath');
  const candidate = NET.assertReady();
  if (!old.preflight.ok) throw Error('old TEST package preflight failed');
  const graph = B.assertInsideAllowedRoot('new rollback fixture',CG.build({kind:'origin-test-build-rollback'}).graph);
  const baseline = GH.snapshot(graph);
  const out = {graph, kind:'actual-old-test-package-roundtrip', userProfileMigration:false,
    acceptedSharedProfileOpened:false, oldBuild:old.preflight.manifest.pilotBuildId,
    candidateBuild:candidate.preflight.manifest.pilotBuildId, stages:[], checks:[]};
  const handles=[]; let session=null;
  const evidence=path.resolve(__dirname,'../../../evidence', 'f28-origin-test-build-rollback-'+Date.now()+'.json');
  const note=(id,title,ok,detail)=>{out.checks.push({id,title,ok,detail});if(!ok)throw Error(title);};
  try {
    handles.push(FP.swapAside(old.identity));
    session=await APP.open({built:old,graph,errors:REC.createRecorder(),bad:path.join(path.dirname(B.allowedRootReal()),'f28-inert-rollback'),record:note});
    await session.page.evaluate(k=>localStorage.setItem(k,'OLD-TEST-PREFERENCE'),KEY);
    await session.goTo(CG.ANCHOR);
    const first=await RD.read(session.page);
    if (!first.present) throw Error('old test baseline references missing');
    out.stages.push({name:'old-test-baseline',origin:await session.page.evaluate(()=>location.origin),storage:await STORAGE.inventoryFromPage(session.page),references:first.groups.length});
    out.stages[0].cleanup=await APP.close(session);session=null;

    handles.push(FP.swapAside(candidate.identity));
    session=await APP.open({built:candidate,graph,errors:REC.createRecorder(),bad:path.join(path.dirname(B.allowedRootReal()),'f28-inert-rollback'),record:note,deps:{launch:NET.launchWith(opts=>_electron.launch(opts))}});
    const absent=await session.page.evaluate(k=>localStorage.getItem(k)===null,KEY);
    if(!absent)throw Error('fresh candidate unexpectedly sees old test preference');
    await session.page.evaluate(k=>localStorage.setItem(k,'CANDIDATE-TEST-PREFERENCE'),KEY);
    out.stages.push({name:'candidate-separate-test-profile',oldPreferenceAbsent:absent,network:await NET.read(session.app),storage:await STORAGE.inventoryFromPage(session.page)});
    out.stages[1].cleanup=await APP.close(session);session=null;

    // Reopen the SAME old TEST profile. Read live identity before any UI action.
    const app=await _electron.launch({executablePath:old.exe,timeout:120000});
    const pid=app.process().pid;
    session={app,appPid:pid,ownedTree:OP.descendants(pid)};
    const page=await app.firstWindow(); session.page=page;
    await page.waitForLoadState('domcontentloaded'); await OP.sleep(22000);
    const reported=await page.evaluate(()=>({api:window.logseq?.api?.get_current_graph?.(),liveRepo:window.frontend?.state?.get_current_repo?.(),storage:localStorage.getItem('git/current-repo')}));
    const verdict=APP.currentGraphVerdict({...reported,approved:graph,allowedRoot:B.allowedRootReal()});
    if(!verdict.ok)throw Error('rollback live graph assertion failed: '+verdict.reason);
    const preference=await page.evaluate(k=>localStorage.getItem(k),KEY);
    if(preference!=='OLD-TEST-PREFERENCE')throw Error('old synthetic preference not preserved');
    await page.evaluate(n=>{location.hash='#/page/'+encodeURIComponent(n);},CG.ANCHOR);
    await OP.sleep(3500);
    const refs=await RD.read(page);
    if(!refs.present || refs.groups.length!==first.groups.length)throw Error('old TEST reference behavior changed');
    out.stages.push({name:'actual-old-test-build-rollback',liveGraph:verdict,preferencePreserved:true,references:refs.groups.length,storage:await STORAGE.inventoryFromPage(page)});
    out.stages[2].cleanup=await APP.close(session);session=null;
    out.graphIntegrity=GH.compare(baseline,GH.snapshot(graph));
    if(out.graphIntegrity.content.length)throw Error('rollback graph content changed');
    out.actualOldTestBuildRollback=true;
  } catch(e) {out.error=e.message;process.exitCode=1;}
  finally {
    if(session)out.finalCleanup=await APP.close(session);
    out.restorations=handles.reverse().map(h=>FP.restore(h,{label:'origin-rollback'}));
    out.ok=out.actualOldTestBuildRollback===true && out.restorations.every(r=>r.ok);
    fs.writeFileSync(evidence,JSON.stringify(out,null,2));console.log(evidence);console.log(JSON.stringify({ok:out.ok,error:out.error}));
    if(!out.ok)process.exitCode=1;
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
