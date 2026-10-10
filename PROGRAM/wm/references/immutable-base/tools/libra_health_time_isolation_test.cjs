'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const file=path.join(__dirname,'libra_shared_health_dispatch_test.cjs');let code=fs.readFileSync(file,'utf8');
const test=` await test('cache repair isolates legacy TimeEngine tracking side effects',async f=>{
 const root=f.canonicalPayload();const row=root.entries.find(x=>x.comment==='lmai_entity');assert(row);
 const entity=JSON.parse(row.content);entity.timeTracking={currentDate:'2044-07-19',currentTime:'18:45',notes:'legacy fixture'};
 f.api.IntegrityMetaManager.applyIntegrityMeta(entity,{domain:'entity',recordSchema:'libra.entity.record.v1',recordId:entity.name,scopeKey:f.api.MemoryState._activeScopeKey,turn:1,source:'fixture'});
 row.content=JSON.stringify(entity);f.store.set(f.key,JSON.stringify(root));
 f.api.TimeEngine.resetState({currentDate:'2026-01-01',currentTime:'08:00',notes:'time sentinel'});
 const before=JSON.stringify(f.api.TimeEngine.getState()),canonical=f.store.get(f.key),calls=f.provider.calls;
 await f.click('#btn-health-repair-preview');assert.equal(JSON.stringify(f.api.TimeEngine.getState()),before,'preview leaves exact time state unchanged');
 await f.click('#btn-health-repair-apply');
 const result=f.trace.calls.findLast(x=>x.method==='apply'&&x.kind==='refresh_derived_cache').result;assert.equal(result.status,'verified');
 assert.equal(JSON.stringify(f.api.TimeEngine.getState()),before,'derived-only repair must preserve exact TimeEngine state');
 assert.equal(f.store.get(f.key),canonical);assert.equal(f.canonicalWrites().length,0);assert.equal(f.calls.hostWrites.length,0);assert.equal(f.provider.calls,calls);
 });\n`;
assert(code.includes(' const report={testSourceSha256'));code=code.replace(' const report={testSourceSha256',test+' const report={variant:"legacy_time_isolation",variantTestSourceSha256:module.__variantSha,testSourceSha256');
process.env.LIBRA_SHARED_DISPATCH_FILTER='^cache repair isolates';code=code.replace('if(require.main===module)main()', 'if(true)main()');
const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(__dirname);mod.__variantSha=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');mod._compile(code,file);
