'use strict';
const path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const tests=['flashback','lia','libra','hayaku'].map(owner=>`native_branch_${owner}_storage_modes_runtime_test.cjs`);
const modes=['plugin_only','server_only'];let passed=0;
for(const mode of modes){
 for(const file of tests){
  const result=spawnSync(process.execPath,[path.join(__dirname,file)],{encoding:'utf8',env:{...process.env,NATIVE_BRANCH_MODE:mode},timeout:120000});
  if(result.status!==0){process.stderr.write(result.stdout||'');process.stderr.write(result.stderr||'');throw new Error(`native_branch_storage_matrix_failed:${mode}:${file}:status=${result.status}`);}
  const line=(result.stdout||'').trim().split(/\r?\n/).filter(Boolean).at(-1)||'';let row={};try{row=JSON.parse(line)}catch{}
  assert.equal(row.mode,mode,`reported mode mismatch for ${file}`);passed++;console.log(`PASS ${mode} ${file}`);
 }
}
console.log(JSON.stringify({test:'native_branch_storage_modes_matrix',passed,modes,owners:tests.length}));
