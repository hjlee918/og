'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const REPO=path.resolve(__dirname,'../..');
const OUTPUT=path.resolve(REPO,'../out-launcher');
const NAME='Logseq OG Test — Offline.app';
const APP=path.join(OUTPUT,NAME);
const CONTENTS=path.join(APP,'Contents'),MACOS=path.join(CONTENTS,'MacOS'),RESOURCES=path.join(CONTENTS,'Resources');
const EXECUTABLE='Logseq OG Test — Offline';
const NODE=process.execPath;
const ENTRY=path.join(REPO,'f28-origin/checks/offline-launcher.js');
const PRODUCT=path.resolve(REPO,'../out-originexp/Logseq-OG-F28-OriginExp-darwin-x64/Logseq-OG-F28-OriginExp.app');
function sha(p){return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Logseq OG Test — Offline</string>
<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
<key>CFBundleIdentifier</key><string>com.logseq.logseq-og.test.offline-launcher</string>
<key>CFBundleName</key><string>Logseq OG Test — Offline</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0-preview.1</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
const wrapper=`#!/bin/zsh
exec ${JSON.stringify(NODE)} ${JSON.stringify(ENTRY)}
`;
const manifest=JSON.stringify({schema:'f28-origin-offline-launcher/1',name:NAME,
  bundleId:'com.logseq.logseq-og.test.offline-launcher',architecture:'x86_64',
  launcherEntry:ENTRY,launcherSha256:sha(ENTRY),node:NODE,
  targetPackage:PRODUCT,targetBuild:'2026-09-10T22-15-35-426Z-4cf82a57',
  targetSource:'cb04131613e1640ca0e64c47e07b3afca81c47f6',
  networkControl:'f28-origin-network/1',
  offlineTheme:{name:'logseq-dracula-theme',version:'0.1.0',
    sourceCommit:'0064af84b7236676f6b4b6d1b37c355501c91111',
    manifestSha256:'2e3b6095c3a5f71e47cf1556f9236aabb3e4a5e1bfd508753440dd268206981d',
    cssSha256:'3ba529d41f2c5d5fc93f31630690f3e5ada1332cccb8eb74126e172d69b6260c'},
  installed:false,release:false},null,2)+'\n';
const files=new Map([
  [path.join(CONTENTS,'Info.plist'),plist],
  [path.join(MACOS,EXECUTABLE),wrapper],
  [path.join(RESOURCES,'launcher-manifest.json'),manifest],
]);
if(fs.existsSync(APP)){
  const same=[...files].every(([p,want])=>fs.existsSync(p)&&fs.readFileSync(p,'utf8')===want);
  if(same){console.log(APP);process.exit(0);}
  const oldManifest=path.join(APP,'Contents/Resources/launcher-manifest.json');
  let old=null;try{old=JSON.parse(fs.readFileSync(oldManifest,'utf8'));}catch(e){}
  if(old?.schema!=='f28-origin-offline-launcher/1'||old?.bundleId!=='com.logseq.logseq-og.test.offline-launcher')
    throw Error('Refusing to replace a launcher without the owned manifest');
  const preserved=APP+'.preserved-'+new Date().toISOString().replace(/[:.]/g,'-');
  fs.renameSync(APP,preserved);console.log('Preserved '+preserved);
}
fs.mkdirSync(MACOS,{recursive:true});fs.mkdirSync(RESOURCES,{recursive:true});
for(const [p,body]of files)fs.writeFileSync(p,body);
fs.chmodSync(path.join(MACOS,EXECUTABLE),0o755);
const icon=path.join(PRODUCT,'Contents/Resources/electron.icns');
if(fs.existsSync(icon))fs.copyFileSync(icon,path.join(RESOURCES,'electron.icns'));
console.log(APP);
