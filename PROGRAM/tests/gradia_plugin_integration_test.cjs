'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const program=path.resolve(__dirname,'..');
const expected=['flashback','gradia','hayaku','lia','libra','retrace','wm'];

test('build and release registries contain exactly seven packaged plugins',()=>{
 const build=require('../tools/build_plugins.cjs').PLUGINS;
 const metadata=require('../tools/release_metadata.cjs').PLUGINS;
 assert.deepEqual(Object.keys(build).sort(),expected);
 assert.deepEqual(Object.keys(metadata).sort(),expected);
 assert.equal(build.gradia.file,'plugins/GRADIA.js');
 assert.equal(metadata.gradia[2],'serial_gradation_agents_for_rp');
});

test('release metadata and update components report the actual GRADIA version',()=>{
 const metadata=require('../tools/release_metadata.cjs').readReleaseMetadata(program);
 assert.deepEqual(Object.keys(metadata.plugins).sort(),expected);
 assert.equal(metadata.plugins.gradia.version,'0.25.83');
 const update=require('../tools/release_asset_contract.cjs').buildUpdateManifest(program);
 assert.equal(update.components.gradia,metadata.plugins.gradia.version);
});

test('actual build CLI accepts GRADIA and preserves its installed plugin identity',t=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'lib-gradia-build-'));
 t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 const r=spawnSync(process.execPath,[path.join(program,'tools/build_plugins.cjs'),'--plugin','gradia','--profile','source','--no-minify','--out',out],{encoding:'utf8',maxBuffer:4*1024*1024});
 assert.equal(r.status,0,r.stderr||r.stdout);
 const source=fs.readFileSync(path.join(out,'GRADIA.js'),'utf8');
 assert.match(source,/^\/\/@name serial_gradation_agents_for_rp\r?$/m);
 assert.match(source,/^\/\/@version 0\.25\.83\r?$/m);
 const directives=text=>(text.match(/^[ \t]*\/\/(?:@|!)[^\r\n]*$/gm)||[]).map(line=>line.trim());
 assert.deepEqual(directives(source),directives(fs.readFileSync(path.join(program,'plugins/GRADIA.js'),'utf8')),'readable artifacts retain each source directive exactly once');
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'ultralight-build-report.json'))).rows.length,1);
});

test('seven packaged plugins retain three active storage owners and five legacy namespace slots',()=>{
 const server=fs.readFileSync(path.join(program,'server/server.cjs'),'utf8');
 const registry=require('../server/server.cjs');
 assert.deepEqual(registry.ACTIVE_STORAGE_NAMESPACES,['flashback','hayaku','libra']);
 assert.deepEqual(registry.LEGACY_STORAGE_NAMESPACES,['lia','retrace']);
 const manifest=JSON.parse(fs.readFileSync(path.join(program,'program-manifest.json')));
 assert.ok(server.includes("const NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra', 'lia', 'retrace']);"));
 assert.ok(server.includes("roles: ['readonly']"));
 assert.deepEqual(manifest.dataContract.namespaces,['flashback','hayaku','libra','lia','retrace']);
 assert.deepEqual(manifest.dataContract.retraceHayakuNativeOwnerDeference.coreStorageOwners,['flashback','hayaku','libra']);
 assert.equal(manifest.dataContract.retraceHayakuNativeOwnerDeference.managerOnlyConnection,true);
 assert.equal(fs.existsSync(path.join(program,'../DATA/stores/gradia')),false);
});

test('current cross-project tests resolve their host within PROGRAM',()=>{
 for(const name of ['gradia_readonly_cross_project_test.cjs','composed_reanalysis_gradia_runtime_test.cjs','review_readonly_worst_escape_test.cjs']){
  const source=fs.readFileSync(path.join(__dirname,name),'utf8');
  assert.doesNotMatch(source,/require\(['"]\.\.\/\.\.\/\.\.\/GRA\//,name);
  assert.ok(source.includes("require('./gradia/host.cjs')"),name);
 }
 assert.ok(fs.existsSync(path.join(__dirname,'gradia/fixtures/baselines/frozen-G2-GRADIA.js')));
});
