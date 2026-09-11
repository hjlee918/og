'use strict';
// Finder-launchable owner for the local Intel-only offline TEST application.
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const PREVIEW=require('./preview');
const B=require('../../f27-pilot/checks/allowed-root');
const EVIDENCE=path.resolve(__dirname,'../../../evidence');
const LOCK=path.join(EVIDENCE,'origin-offline-launcher-active.json');
const PREVIEW_LEASE=path.join(EVIDENCE,'origin-preview-active.json');
function assert(v,m){if(!v)throw Error(m);}
function dialog(title,message){
  if(process.env.F28_OFFLINE_TEST_NO_DIALOG==='1'){console.error(title+'\n'+message);return;}
  const script='on run argv\n display dialog (item 2 of argv) with title (item 1 of argv) buttons {"OK"} default button "OK" with icon stop\nend run';
  try{execFileSync('/usr/bin/osascript',['-e',script,'--',title,message],{stdio:'ignore'});}catch(e){/* user dismissed */}
}
function chooseGraph(exec=execFileSync){
  if(process.env.F28_OFFLINE_TEST_CANCEL==='1')return null;
  if(process.env.F28_OFFLINE_TEST_SELECTION)return process.env.F28_OFFLINE_TEST_SELECTION;
  const root=B.allowedRootReal();
  const script='on run argv\n set rootFolder to POSIX file (item 1 of argv) as alias\n try\n  set picked to choose folder with prompt "Choose an Intel-only disposable TEST graph / 인텔 전용 폐기 가능 시험 그래프를 선택하세요" default location rootFolder\n  return POSIX path of picked\n on error number -128\n  return "__CANCELLED__"\n end try\nend run';
  const selected=String(exec('/usr/bin/osascript',['-e',script,'--',root],{encoding:'utf8'})).trim();
  return selected==='__CANCELLED__'?null:selected.replace(/\/$/,'');
}
function confirmLimitations(exec=execFileSync){
  if(process.env.F28_OFFLINE_TEST_NO_DIALOG==='1')return true;
  const message='Experimental offline TEST build. Readwise sync/login and AI are disabled. Roam/JSON/OPML import is unavailable because the native file picker is not path-contained. Online CSS @import is blocked; use local CSS only.\n\n실험용 오프라인 TEST 빌드입니다. Readwise 동기화·로그인과 AI는 비활성화됩니다. 파일 선택 경로를 안전하게 제한할 수 없어 Roam/JSON/OPML 가져오기는 사용할 수 없습니다. 온라인 CSS @import는 차단되며 로컬 CSS만 사용할 수 있습니다.';
  const script='on run argv\n try\n  display dialog (item 1 of argv) with title "Logseq OG Test — Offline" buttons {"Cancel", "Open Offline Test"} default button "Open Offline Test" cancel button "Cancel" with icon caution\n  return "OPEN"\n on error number -128\n  return "CANCEL"\n end try\nend run';
  return String(exec('/usr/bin/osascript',['-e',script,'--',message],{encoding:'utf8'})).trim()==='OPEN';
}
function claim(){
  fs.mkdirSync(EVIDENCE,{recursive:true});
  if(fs.existsSync(PREVIEW_LEASE))throw Error('Another guarded preview is active. Quit it first. / 다른 보호된 미리보기가 실행 중입니다. 먼저 종료하세요.');
  const lease={schema:'origin-offline-launcher/1',launcherPid:process.pid,createdAt:new Date().toISOString()};
  try{fs.writeFileSync(LOCK,JSON.stringify(lease,null,2)+'\n',{flag:'wx'});}
  catch(e){
    if(e.code==='EEXIST')throw Error('Another launch is active, or a prior supervisor crashed. Do not delete the lock while an app may be running. Request an owned-process review. / 다른 실행이 진행 중이거나 이전 감독 프로세스가 중단되었습니다. 앱이 실행 중일 수 있으므로 잠금 파일을 삭제하지 말고 소유 프로세스 검토를 요청하세요.\n'+LOCK);
    throw e;
  }
  return lease;
}
function release(lease){
  const current=JSON.parse(fs.readFileSync(LOCK));
  assert(current.schema===lease.schema&&current.launcherPid===lease.launcherPid,'Launcher lock ownership changed; preserving it');
  fs.unlinkSync(LOCK);
}
async function main(){
  let lease=null;
  try{
    lease=claim();
    const selected=chooseGraph();
    if(!selected)return {cancelled:true};
    const graph=PREVIEW.canonicalExistingGraph(selected);
    if(!confirmLimitations())return {cancelled:true};
    const result=await PREVIEW.start({existingGraph:graph,persistentProfile:true,
      smokeClose:process.env.F28_OFFLINE_TEST_AUTOCLOSE==='1'});
    if(result.error||result.cleanupError)throw Error(result.cleanupError||result.error);
    return result;
  }catch(e){
    dialog('Logseq OG Test — Offline: cannot start safely / 안전하게 시작할 수 없음',String(e.message||e));
    process.exitCode=1;
    return {error:String(e.message||e)};
  }finally{
    if(lease&&fs.existsSync(LOCK)){
      try{release(lease);}catch(e){dialog('Logseq OG Test — Offline: recovery required / 복구 검토 필요',String(e.message||e));process.exitCode=1;}
    }
  }
}
if(require.main===module)main();
module.exports={LOCK,PREVIEW_LEASE,chooseGraph,confirmLimitations,claim,release,main};
