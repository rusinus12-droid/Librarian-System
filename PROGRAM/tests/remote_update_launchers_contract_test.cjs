'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
// On macOS os.tmpdir() is /var/folders/... and /var is a symlink to /private/var,
// so the fixture path and the canonical path the updater resolves are different
// strings for the same directory. Canonicalise the fixture root once, otherwise
// the staging assertions compare /private/var/... against /var/... and fail for a
// reason that has nothing to do with the launcher being tested. (Verified: with a
// non-symlinked TMPDIR the same test passes unchanged, so this is a fixture path
// bug, not a product bug.)
const temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'librarian launcher spaces ')));
try{
 for(const file of ['업데이트.sh','업데이트.command','업데이트.bat'])fs.copyFileSync(path.join(root,file),path.join(temp,file));
 fs.cpSync(path.join(root,'UPDATER'),path.join(temp,'UPDATER'),{recursive:true});
 assert.ok(fs.existsSync(path.join(temp,'UPDATER/runtime.cjs')),'independent runtime checker is required');
 const rt=require('../../UPDATER/runtime.cjs');
 assert.equal(rt.detectPlatform({TERMUX_VERSION:'test'},'linux'),'android');
 assert.throws(()=>rt.validateRoot('/storage/emulated/0/Librarian',{TERMUX_VERSION:'test'},'linux'),/shared_storage/);
 assert.throws(()=>rt.validateRoot('/tmp/anything',{},'unsupported-os'),/unsupported_platform/);
 const stageRoot=path.join(temp,'stage target');const fakeExe=path.join(stageRoot,'PROGRAM','_runtime','node-fake');fs.mkdirSync(path.dirname(fakeExe),{recursive:true});fs.writeFileSync(fakeExe,'fake-node-bytes');fs.chmodSync(fakeExe,0o755);
 const staged=rt.stageRuntime(stageRoot,fakeExe);assert.ok(staged.startsWith(path.join(stageRoot,'UPDATER','_runtime')+path.sep));assert.equal(fs.readFileSync(staged,'utf8'),'fake-node-bytes');
 const bat=fs.readFileSync(path.join(root,'업데이트.bat'),'utf8');
 assert.match(bat,/_find_node\.bat/);assert.doesNotMatch(bat,/^node /m);
 const finder=fs.readFileSync(path.join(root,'UPDATER/_find_node.bat'),'utf8');
 assert.match(finder,/\.rollback/);assert.match(finder,/runtime\.cjs/);
 assert.match(finder,/--target-root/i);assert.match(finder,/PROGRAM\\_runtime\\node\.exe/i);
 assert.match(finder,/UPDATER_STAGE_ROOT=%~f2/i,'Windows target runtime staging must use the parsed target path without stale block expansion');
 assert.match(bat,/call "%~dp0UPDATER\\_find_node\.bat" %\*/i,'root batch launcher must pass target-root arguments to runtime discovery');
 if(process.platform==='win32')console.log('SKIP: POSIX launcher execution (Windows host); static contracts checked');
 else {
   // Stub only the CLI destination; use the REAL launcher/runtime selection.
   const targetRoot=path.join(temp,'legacy target');const targetRuntimeDir=path.join(targetRoot,'PROGRAM','_runtime');fs.mkdirSync(targetRuntimeDir,{recursive:true});
   const probeFile=path.join(temp,'target-runtime-used.txt');const targetNode=path.join(targetRuntimeDir,'node');
   fs.writeFileSync(targetNode,`#!/bin/sh\nprintf 'used\n' >> "${probeFile}"\nexec "${process.execPath}" "$@"\n`);fs.chmodSync(targetNode,0o755);
   fs.writeFileSync(path.join(temp,'UPDATER/updater.cjs'),`require('node:fs').writeFileSync(process.env.ARGS_FILE,JSON.stringify(process.argv.slice(2)));process.exit(37);`);
   for(const launcher of ['업데이트.sh','업데이트.command']){
     const argsFile=path.join(temp,'args.json');const args=['--target-root',targetRoot,'--release-zip','/tmp/릴리스 with spaces.zip','--expected-sha256','a'.repeat(64)];
     fs.rmSync(probeFile,{force:true});
     const r=spawnSync('/bin/sh',[path.join(temp,launcher),...args],{encoding:'utf8',env:{...process.env,ARGS_FILE:argsFile,PATH:'/usr/bin:/bin'},timeout:10000});
     assert.equal(r.status,37,r.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(argsFile)),args);assert.ok(fs.existsSync(probeFile),'target PROGRAM portable Node must be considered before fallback PATH node');
   }
 }
 console.log('remote_update_launchers_contract_test: PASS');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
