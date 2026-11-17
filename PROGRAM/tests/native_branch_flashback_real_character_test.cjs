'use strict';
// A real RisuAI character has `chaId` and no `id`. Flashback then labels its storage scope with
// the character's name, while host lineage names the character by chaId. The native-branch
// capability compared the two and rejected every real branch with
// MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_INVALID, so the child chat inherited nothing and every
// turn showed as missing. The fixtures hid it: their character has id === chaId.
// This reruns the whole native-branch runtime test with a character in the real shape.
const assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
const run=spawnSync(process.execPath,[path.join(__dirname,'native_branch_flashback_runtime_test.cjs')],
  {env:{...process.env,FLASHBACK_REAL_CHARACTER_SHAPE:'1'},encoding:'utf8',timeout:180000});
const output=String(run.stdout||'')+String(run.stderr||'');
assert.ok(!output.includes('MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_INVALID'),output.slice(-1500));
assert.equal(run.status,0,output.slice(-1500));
console.log('native_branch_flashback_real_character_test: PASS');
