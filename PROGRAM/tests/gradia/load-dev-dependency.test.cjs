'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const helper=path.join(__dirname,'../../tools/gradia/load-dev-dependency.cjs');
function probe(t,{standard=false,external=false,externalFailure=false,missing=false}={}){
 assert.ok(fs.existsSync(helper),'portable dependency loader must exist');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gradia-dependency-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'tools'));fs.copyFileSync(helper,path.join(root,'tools/load-dev-dependency.cjs'));
 const write=(base,body)=>{fs.mkdirSync(path.join(base,'acorn'),{recursive:true});fs.writeFileSync(path.join(base,'acorn/index.js'),body);};
 if(standard)write(path.join(root,'node_modules'),"module.exports={tag:'standard'};");
 if(external)write(path.join(root,'external'),externalFailure?"throw new Error('PACKAGE_EXECUTION_FAILED');":"module.exports={tag:'explicit'};");
 const env={...process.env};delete env.NODE_PATH;delete env.GRADIA_TOOLCHAIN_ROOT;if(external)env.GRADIA_TOOLCHAIN_ROOT=path.join(root,'external');
 return spawnSync(process.execPath,['-e',"console.log(require('./tools/load-dev-dependency.cjs')('acorn').tag)"],{cwd:root,env,encoding:'utf8'});
}
test('loader uses standard installed devDependencies before an optional explicit root',t=>{const r=probe(t,{standard:true,external:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'standard');});
test('loader uses GRADIA_TOOLCHAIN_ROOT when standard dependency is absent',t=>{const r=probe(t,{external:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'explicit');});
test('loader explains a missing dependency without a historical fallback',t=>{const r=probe(t,{missing:true});assert.notEqual(r.status,0);assert.match(r.stderr,/Install pinned devDependencies with npm ci|GRADIA_TOOLCHAIN_ROOT/);assert.doesNotMatch(r.stderr,/min-verification-20261004/);});
test('loader preserves dependency execution errors rather than hiding them',t=>{const r=probe(t,{external:true,externalFailure:true});assert.notEqual(r.status,0);assert.match(r.stderr,/PACKAGE_EXECUTION_FAILED/);});
