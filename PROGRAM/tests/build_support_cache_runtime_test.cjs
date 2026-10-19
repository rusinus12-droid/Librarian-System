'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const helper=path.resolve(__dirname,'../tools/ensure_build_support.cjs');
const names=['jsdom','acorn','terser','fake-indexeddb','fixture-child'];

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'build-support-cache-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const program=path.join(root,'PROGRAM'),temp=path.join(root,'tmp'),cache=path.join(root,'npm-cache');
 fs.mkdirSync(path.join(program,'tools'),{recursive:true});fs.mkdirSync(path.join(program,'build-support'));
 fs.mkdirSync(temp);fs.copyFileSync(helper,path.join(program,'tools/ensure_build_support.cjs'));
 const packages={},tarballs=new Map();
 for(const name of names){
  const dir=path.join(root,'tar-'+name,'package');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',main:'index.js'}));
  fs.writeFileSync(path.join(dir,'index.js'),name==='jsdom'?"module.exports=require('fixture-child');":"module.exports={ready:true};");
  const tarball=path.join(root,name+'.tgz');
  const tar=spawnSync('tar',['-czf',tarball,'-C',path.dirname(dir),'package'],{encoding:'utf8'});
  assert.equal(tar.status,0,tar.stderr);
  const hash=crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest();
  const hex=hash.toString('hex');
  packages['node_modules/'+name]={version:'1.0.0',integrity:'sha512-'+hash.toString('base64')};
  tarballs.set(name,{tarball,cacheFile:path.join(cache,'_cacache/content-v2/sha512',hex.slice(0,2),hex.slice(2,4),hex.slice(4))});
 }
 const lock=Buffer.from(JSON.stringify({lockfileVersion:3,packages}));
 fs.writeFileSync(path.join(program,'build-support/package-lock.json'),lock);
 const hash=crypto.createHash('sha256').update(lock).digest('hex').slice(0,16);
 const legacy=path.join(temp,'librarian-build-support-'+hash,'node_modules');
 const cachePackages=selected=>{for(const name of selected){const row=tarballs.get(name);fs.mkdirSync(path.dirname(row.cacheFile),{recursive:true});fs.copyFileSync(row.tarball,row.cacheFile);}};
 const unpackLegacy=selected=>{for(const name of selected){const dir=path.join(legacy,name);fs.mkdirSync(dir,{recursive:true});const r=spawnSync('tar',['-xzf',tarballs.get(name).tarball,'-C',dir,'--strip-components=1'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}};
 const run=()=>{
  const code=`const support=require(${JSON.stringify(path.join(program,'tools/ensure_build_support.cjs'))}).ensureBuildSupportDependencies();const loads={};if(support)for(const name of ${JSON.stringify(names.slice(0,4))}){try{loads[name]=require(require.resolve(name,{paths:[support.modulesDir]})).ready===true;}catch(e){loads[name]=e.code;}}console.log(JSON.stringify({support,loads,nodePath:process.env.NODE_PATH,toolchain:process.env.GRADIA_TOOLCHAIN_ROOT}));`;
  const r=spawnSync(process.execPath,['-e',code],{encoding:'utf8',timeout:30000,env:{...process.env,TMPDIR:temp,TMP:temp,TEMP:temp,NODE_PATH:'',GRADIA_TOOLCHAIN_ROOT:'',npm_config_cache:cache,NPM_CONFIG_CACHE:cache}});
  assert.equal(r.status,0,r.stderr||String(r.error));return JSON.parse(r.stdout);
 };
 return {root,cache,temp,legacy,run,cachePackages,unpackLegacy,tarballs};
}

const assertReady=result=>{assert.ok(result.support);assert.deepEqual(result.loads,Object.fromEntries(names.slice(0,4).map(n=>[n,true])));};

test('an incomplete npm cache cannot be activated as a complete toolchain',t=>{
 const x=fixture(t);x.cachePackages(names.slice(0,4));
 const result=x.run();assert.equal(result.support,null);assert.equal(result.nodePath,'');assert.equal(result.toolchain,'');
 x.cachePackages(['fixture-child']);assertReady(x.run());
});

test('legacy partial extraction is repaired when the missing transitive tarball becomes available',t=>{
 const x=fixture(t);x.unpackLegacy(names.slice(0,4));x.cachePackages(names);
 assertReady(x.run());
});

test('verified cache remains reusable without npm tarballs',t=>{
 const x=fixture(t);x.cachePackages(names);const first=x.run();assertReady(first);
 fs.rmSync(x.cache,{recursive:true,force:true});const second=x.run();assertReady(second);
 assert.equal(second.support.modulesDir,first.support.modulesDir);
});

test('a missing file behind existing package metadata is repaired from the complete cache',t=>{
 const x=fixture(t);x.cachePackages(names);const first=x.run();assertReady(first);
 fs.unlinkSync(path.join(first.support.modulesDir,'fixture-child/index.js'));
 assertReady(x.run());
});

test('a damaged tarball is refused and a subsequent intact cache can recover',t=>{
 const x=fixture(t);x.cachePackages(names);
 fs.appendFileSync(x.tarballs.get('jsdom').cacheFile,'damaged-cache');
 const refused=x.run();assert.equal(refused.support,null);assert.equal(refused.nodePath,'');
 x.cachePackages(['jsdom']);assertReady(x.run());
});
