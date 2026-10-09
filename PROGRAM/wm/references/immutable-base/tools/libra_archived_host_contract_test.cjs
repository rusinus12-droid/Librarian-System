'use strict';
// Portable synthetic execution of exact archived deployment code, not a live host.
const fs=require('fs'),path=require('path'),Module=require('module'),crypto=require('crypto');
const root=path.resolve(__dirname,'..');
const allowed=new Set(['libra_projection_authority_test.cjs','libra_typed_recall_host_boundary_static_test.cjs']);
const name=process.argv[2];if(!allowed.has(name))throw Error('Specify one supported host contract test');
const fixture=path.join(__dirname,'fixtures/installed-host-source-contract.json');
const f=JSON.parse(fs.readFileSync(fixture,'utf8'));
if(f.originalSourceMapSha256!=='cebc7c347c303fed7aee269342fd5d5646c7559e7483b395a88001d329518348')throw Error('Archived host contract origin mismatch');
for(const dir of ['task5-authority-correction','task5-host-boundary'])fs.mkdirSync(path.join(root,'test-output/typed-recall',dir),{recursive:true});
const target=path.join(__dirname,name),source=fs.readFileSync(target,'utf8');
const installed="G:/PocketRisu-v1.8.1-win-x64/dist/assets/database.svelte-CVkWRAON.js.map";
if(!source.includes(installed))throw Error('Original fixture-path contract changed');
console.log(JSON.stringify({fixture:'archived deployment code / synthetic execution',liveHost:'unavailable',originalSourceMapSha256:f.originalSourceMapSha256,fixtureSha256:crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex')}));
const test=new Module(target,module);test.filename=target;test.paths=Module._nodeModulePaths(__dirname);
test._compile(source.replace(installed,fixture.replace(/\\/g,'/')),target);
