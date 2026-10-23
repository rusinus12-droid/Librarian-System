'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const helper=path.resolve(__dirname,'../tools/ensure_build_support.cjs');
const names=['jsdom','acorn','terser','fake-indexeddb','fixture-child'];
// The child process require()s the helper by path, and Node resolves symlinks in module
// paths, so macOS reports /private/var for a tmpdir handed over as /var. Compare the
// physical directories on both sides instead of one raw and one resolved string.
const real=value=>{try{return fs.realpathSync(value);}catch(_){return value;}};

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'build-support-cache-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const program=path.join(root,'PROGRAM'),temp=path.join(root,'tmp'),cache=path.join(root,'npm-cache');
 fs.mkdirSync(path.join(program,'tools'),{recursive:true});fs.mkdirSync(path.join(program,'build-support'));
 fs.mkdirSync(temp);fs.copyFileSync(helper,path.join(program,'tools/ensure_build_support.cjs'));
 fs.writeFileSync(path.join(program,'build-support/package.json'),JSON.stringify({private:true}));
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
 const unpackLegacy=(selected,base=legacy)=>{for(const name of selected){const dir=path.join(base,name);fs.mkdirSync(dir,{recursive:true});const r=spawnSync('tar',['-xzf',tarballs.get(name).tarball,'-C',dir,'--strip-components=1'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}};
 const run=(options={})=>{
  const code=`let support;try{support=require(${JSON.stringify(path.join(program,'tools/ensure_build_support.cjs'))}).ensureBuildSupportDependencies(${JSON.stringify(options)});}catch(e){console.log(JSON.stringify({error:e.message,nodePath:process.env.NODE_PATH,toolchain:process.env.GRADIA_TOOLCHAIN_ROOT}));process.exit(0);}const loads={};if(support)for(const name of ${JSON.stringify(names.slice(0,4))}){try{loads[name]=require(require.resolve(name,{paths:[support.modulesDir]})).ready===true;}catch(e){loads[name]=e.code;}}console.log(JSON.stringify({support,loads,nodePath:process.env.NODE_PATH,toolchain:process.env.GRADIA_TOOLCHAIN_ROOT}));`;
  const r=spawnSync(process.execPath,['-e',code],{encoding:'utf8',timeout:30000,env:{...process.env,TMPDIR:temp,TMP:temp,TEMP:temp,NODE_PATH:'',GRADIA_TOOLCHAIN_ROOT:'',npm_config_cache:cache,NPM_CONFIG_CACHE:cache}});
  assert.equal(r.status,0,r.stderr||String(r.error));return JSON.parse(r.stdout);
 };
 const makeNpmCli=(mode='complete')=>{
  const cli=path.join(root,'npm path with spaces','npm-cli.js');fs.mkdirSync(path.dirname(cli),{recursive:true});
  const calls=path.join(root,'npm-calls.jsonl');
  fs.writeFileSync(cli,`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(${JSON.stringify(mode)}==='fail'){console.error('PRIVATE_PROVIDER_SECRET');process.exit(17);}const dest=args[args.indexOf('--prefix')+1];for(const name of ${JSON.stringify(mode==='incomplete'?names.slice(0,4):names)})fs.cpSync(path.join(${JSON.stringify(root)},'tar-'+name,'package'),path.join(dest,'node_modules',name),{recursive:true});`);
  return {cli,calls};
 };
 return {root,program,cache,temp,legacy,run,cachePackages,unpackLegacy,tarballs,makeNpmCli};
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


test('standard build-support npm ci installation is discovered without NODE_PATH',t=>{
 const x=fixture(t);const modules=path.join(x.program,'build-support/node_modules');x.unpackLegacy(names,modules);
 const result=x.run();assertReady(result);assert.equal(real(result.support.modulesDir),real(modules));assert.equal(result.support.source,'build_support_node_modules');
});

test('opt-in npm bootstrap uses pinned ci with dev packages, no shell, and reuses the verified generation',t=>{
 const x=fixture(t),npm=x.makeNpmCli();const first=x.run({installIfMissing:true,npmCliPath:npm.cli});assertReady(first);
 assert.equal(first.support.source,'npm_ci');
 const calls=fs.readFileSync(npm.calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);
 assert.deepEqual(calls[0].slice(0,6),['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund','--prefix']);
 assert.ok(!real(first.support.modulesDir).startsWith(real(x.program)));
 fs.unlinkSync(npm.cli);const second=x.run({installIfMissing:true,npmCliPath:npm.cli});assertReady(second);
 assert.equal(second.support.modulesDir,first.support.modulesDir);assert.equal(fs.readFileSync(npm.calls,'utf8').trim().split('\n').length,1);
});

for(const mode of ['fail','incomplete'])test('npm '+mode+' does not publish or activate a partial toolchain',t=>{
 const x=fixture(t),npm=x.makeNpmCli(mode);const result=x.run({installIfMissing:true,npmCliPath:npm.cli});
 assert.match(result.error,mode==='fail'?/build_support_npm_ci_failed:17/:/build_support_installed_tree_incomplete/);
 assert.ok(!result.error.includes('PRIVATE_PROVIDER_SECRET'));assert.equal(result.nodePath,'');assert.equal(result.toolchain,'');
 assert.equal(fs.readdirSync(path.dirname(x.legacy)).some(name=>name.startsWith('ready-')||name.startsWith('.install-')),false);
 assert.equal(x.run().support,null);const retry=x.makeNpmCli();assertReady(x.run({installIfMissing:true,npmCliPath:retry.cli}));
});

test('npm CLI discovery handles the standard Windows Node installation layout with spaces',t=>{
 const x=fixture(t),node=path.join(x.root,'Node install with spaces','node.exe'),cli=path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js');
 fs.mkdirSync(path.dirname(cli),{recursive:true});fs.writeFileSync(cli,'');
 assert.equal(require(helper).findNpmCli(node,''),cli);
});
