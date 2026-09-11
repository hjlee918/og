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
  networkControl:'f28-origin-network/1',installed:false,release:false},null,2)+'\n';
const files=new Map([
  [path.join(CONTENTS,'Info.plist'),plist],
  [path.join(MACOS,EXECUTABLE),wrapper],
  [path.join(RESOURCES,'launcher-manifest.json'),manifest],
]);
if(fs.existsSync(APP)){
  for(const [p,want] of files){if(!fs.existsSync(p)||fs.readFileSync(p,'utf8')!==want)throw Error('Refusing to overwrite changed launcher: '+p);}
  console.log(APP);process.exit(0);
}
fs.mkdirSync(MACOS,{recursive:true});fs.mkdirSync(RESOURCES,{recursive:true});
for(const [p,body]of files)fs.writeFileSync(p,body);
fs.chmodSync(path.join(MACOS,EXECUTABLE),0o755);
const icon=path.join(PRODUCT,'Contents/Resources/electron.icns');
if(fs.existsSync(icon))fs.copyFileSync(icon,path.join(RESOURCES,'electron.icns'));
console.log(APP);
