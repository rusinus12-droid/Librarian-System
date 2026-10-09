'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../tools/build_distribution.cjs'),'utf8');
const required=[
  'native_branch_host_lineage_test.cjs',
  'native_branch_flashback_runtime_test.cjs',
  'flashback_worldline_workspace_v129_runtime_test.cjs',
  'native_branch_hayaku_runtime_test.cjs',
  'hayaku_native_repair_worldline_race_test.cjs',
  'native_branch_lia_runtime_test.cjs',
  'native_branch_libra_runtime_test.cjs',
  'native_branch_libra_t7_continue_test.cjs',
  'native_branch_libra_precanonical_fork_test.cjs',
  'native_branch_libra_worldline_meta_test.cjs',
  'native_branch_libra_worldline_legacy_migration_test.cjs',
  'native_branch_libra_worldline_conflict_test.cjs',
  'libra_portable_multiverse_derived_rollback_p1_test.cjs',
  'libra_world_manager_worldline_transaction_rc2_test.cjs',
  'libra_host_worldline_gui_contract_test.cjs',
  'native_branch_retrace_gui_scope_test.cjs',
  'native_branch_server_metadata_test.cjs'
];
for(const name of required)assert.ok(source.includes(`'${name}'`),`release smoke must include ${name}`);
console.log(JSON.stringify({test:'native_branch_release_gate_contract',passed:required.length}));
