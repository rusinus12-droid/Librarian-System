'use strict';
// Checks ZIP bytes in an isolated extraction. Runtime dependencies may resolve
// only to built-ins or that extraction, never NODE_PATH or a source sibling.
// Node 22의 builtinModules에는 node:sqlite·node:test 같은 접두사 전용 모듈이 빠져 있어
// node: 접두사 요청은 Module.isBuiltin으로 다시 판정한다 (지원 런타임 22.13~22.x).
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {readZipEntries}=require('./zip_writer.cjs');
const {PAYLOAD,verifyPayload}=require('./updater-refresh.cjs');
const fail=reason=>{throw Error('distribution_runtime_dependency_'+reason);};
function inspectExtractedRuntime(rootDir){
 const root=fs.realpathSync(rootDir),inside=file=>file.startsWith(root+path.sep),builtins=new Set(Module.builtinModules.flatMap(x=>[x,'node:'+x]));
 const program=path.join(root,'PROGRAM'),payload=path.join(program,PAYLOAD);
 const pending=[],seen=new Set();let localRequires=0,builtinRequires=0;
 const gap='(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r?\\n|$))*';
 const literalRequire=new RegExp('\\brequire'+gap+'\\('+gap+'([\'\"])([^\'\"\\r\\n]+)\\1'+gap+'\\)','g');
 function walk(dir,onFile,skip){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())fail('symlink');if(file===skip)continue;if(entry.isDirectory())walk(file,onFile,skip);else if(entry.isFile())onFile(file);}}
 for(const rel of ['PROGRAM/server','PROGRAM/tools','UPDATER']){
  walk(path.join(root,...rel.split('/')),file=>{if(/\.(?:cjs|js)$/.test(file))pending.push(file);},payload);
 }
 while(pending.length){
  const file=pending.pop();if(seen.has(file))continue;seen.add(file);
  const source=fs.readFileSync(file,'utf8'),resolve=Module.createRequire(file).resolve;
  // Every literal CommonJS edge in the packaged server/tool/updater tree is
  // checked, including lazy function-local imports. Dynamic DATA paths remain
  // subject to the existing updater tests and actual apply verification.
  for(const match of source.matchAll(literalRequire)){
   const request=match[2];if(builtins.has(request)||(request.startsWith('node:')&&Module.isBuiltin(request))){builtinRequires++;continue;}
   if(!request.startsWith('./')&&!request.startsWith('../'))fail('external:'+path.relative(root,file)+':'+request);
   // Reject lexical escapes before module resolution can inspect any sibling.
   const requestedPath=path.resolve(path.dirname(file),request);
   if(requestedPath!==root&&!inside(requestedPath))fail('outside_archive:'+request);
   let resolved,real;try{resolved=resolve(request);real=fs.realpathSync(resolved);}catch{fail('missing:'+path.relative(root,file)+':'+request);}
   if(!inside(resolved)||!inside(real))fail('outside_archive:'+request);
   if(!fs.statSync(resolved).isFile())fail('not_file:'+request);
   localRequires++;if(/\.(?:cjs|js)$/.test(resolved))pending.push(resolved);
  }
 }
 const load=relative=>require(path.join(root,...relative.split('/')));
 if(typeof load('PROGRAM/server/server.cjs').createMemorySuiteServer!=='function')fail('server_entrypoint');
 if(typeof load('PROGRAM/tools/portable_export_stopped.cjs').exportStopped!=='function')fail('exporter_entrypoint');
 if(typeof load('UPDATER/core/migration-required.cjs').buildMigratedDataNext!=='function')fail('updater_entrypoint');
 if(fs.existsSync(payload)){
  // This copy is installed into UPDATER before it is used. Its literal imports
  // are checked at the installed location above, and the copy must match byte for byte.
  const updater=path.join(root,'UPDATER');
  const expected=load('UPDATER/core/updater-bootstrap.cjs').listStaticFiles(updater).sort();
  const actual=[];
  walk(payload,file=>actual.push(path.relative(payload,file).split(path.sep).join('/')));
  if(JSON.stringify(actual.sort())!==JSON.stringify(expected))fail('updater_payload_layout');
  for(const file of expected){
   if(!fs.readFileSync(path.join(payload,file)).equals(fs.readFileSync(path.join(updater,file))))fail('updater_payload_bytes:'+file);
  }
  verifyPayload({program,payload,version:fs.readFileSync(path.join(program,'VERSION.txt'),'utf8').trim()},expected);
 }
 return {verified:true,files:seen.size,localRequires,builtinRequires,entrypoints:['server/server.cjs','tools/portable_export_stopped.cjs','UPDATER/core/migration-required.cjs'],sourceFallback:false,listenersStarted:false};
}
function verifyRuntimeArchive(archivePath,extractionRoot){
 if(fs.existsSync(extractionRoot))fail('extraction_exists');
 const entries=readZipEntries(archivePath),roots=new Set(entries.map(x=>x.name.split('/')[0]));
 if(roots.size!==1)fail('archive_root');
 const top=[...roots][0],base=path.resolve(extractionRoot);fs.mkdirSync(base,{recursive:false});
 for(const entry of entries){
  const relative=entry.name.slice(top.length+1),parts=relative.split('/');
  if(!relative||parts.some(x=>!x||x==='.'||x==='..')||path.isAbsolute(relative))fail('archive_path');
  const file=path.resolve(base,...parts);if(!file.startsWith(base+path.sep))fail('archive_path');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,entry.bytes,{flag:'wx',mode:entry.mode&0o777});
 }
 return {...inspectExtractedRuntime(base),archiveFiles:entries.length};
}
if(require.main===module){try{if(process.env.NODE_PATH)fail('node_path_must_be_empty');console.log(JSON.stringify(verifyRuntimeArchive(process.argv[2],process.argv[3])));}catch(error){console.error(error.stack||error);process.exitCode=1;}}
module.exports={inspectExtractedRuntime,verifyRuntimeArchive};
