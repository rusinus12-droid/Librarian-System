'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const before=new Map(['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js','LIA_Persona_Linker.js','RETRACE.js'].map(n=>[n,fs.readFileSync(path.join(root,'plugins',n))]));
const result=cp.spawnSync(process.execPath,[path.join(root,'tools/sync_source_edit_consent.cjs'),'--check'],{encoding:'utf8'});
assert.equal(result.status,0,result.stderr||result.stdout);
for(const [name,content]of before)assert.ok(content.equals(fs.readFileSync(path.join(root,'plugins',name))),'check must not mutate '+name);
console.log('source_edit_shared_core_sync_test: PASS (3 identical shared input-policy embeddings; old tracker aliases inert, check-only)');
