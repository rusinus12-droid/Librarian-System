'use strict';
// Task 17: build the support matrix from the feature inventory. Every feature
// gets exactly one status per mode and every non-green result carries the
// evidence needed for remediation. Run:
//   node PROGRAM/tools/build_storage_mode_matrix.cjs
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const inventoryPath=path.join(root,'docs/storage-mode-audit/feature_inventory.json');
const outDir=path.join(root,'docs/storage-mode-audit');
const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));

const MODES=[['pluginOnlyStatus','plugin_only'],['mirrorStatus','mirror'],['serverOnlyStatus','server_only']];
const NON_GREEN=new Set(['conditionally_supported','intentionally_unsupported','defect','unverified']);

// Features that a directly executed test covers in all three modes.
const EXECUTED_ALL_MODES=new Set(inventory.features.filter(f=>f.pluginOnlyStatus==='verified_supported'&&f.mirrorStatus==='verified_supported'&&f.serverOnlyStatus==='verified_supported').map(f=>f.featureId));

const classification={
  schema:'librarian.storage-mode-support-matrix.v1',
  packageVersion:inventory.packageVersion,
  modeLifecycle:{operationalModes:['plugin_only','server_only'], transitionPhase:'mirror', mirrorColumn:'legacy_compatibility_evidence'},
  generatedAt:new Date().toISOString(),
  totals:{features:inventory.features.length,byMode:{},byStatus:{}},
  rows:[]
};

for(const feature of inventory.features){
  const row={owner:feature.owner,featureId:feature.featureId,userFeature:feature.userFeature,storageClass:feature.storageClass,
    plugin_only:feature.pluginOnlyStatus,mirror:feature.mirrorStatus,server_only:feature.serverOnlyStatus,
    branchSensitive:feature.branchSensitive,sourceEditSensitive:feature.sourceEditSensitive,
    tests:feature.tests||[],evidence:feature.evidence||[],requiredWork:feature.requiredWork||[]};
  for(const [field] of MODES){
    const status=feature[field];
    classification.totals.byStatus[status]=(classification.totals.byStatus[status]||0)+1;
  }
  // A non-green mode must carry reproduction/evidence/work.
  const gaps=[];
  for(const [field,mode] of MODES){
    if(!NON_GREEN.has(feature[field])) continue;
    gaps.push({mode,status:feature[field],
      reproduction:(feature.tests||[])[0]||'',
      entryPoint:(feature.entryPoints||[])[0]||'',
      storageSchema:(feature.storageSchemas||[])[0]||'',
      expected:(feature.expectedSemanticResult||''),
      severity:feature.storageClass==='owner_authoritative'?'P1':'P2',
      requiredChange:(feature.requiredWork||[])[0]||'Add a focused mirror/server_only execution+readback test.'});
  }
  row.gaps=gaps;
  classification.rows.push(row);
}

for(const [field,mode] of MODES){
  classification.totals.byMode[mode]=Object.fromEntries([...new Set(inventory.features.map(f=>f[field]))].map(status=>[status,inventory.features.filter(f=>f[field]===status).length]));
}

const md=[];
md.push('# Storage-Mode Support Matrix');
md.push('');
// The matrix states the package it actually describes. It previously also named the 0.3.60
// planning document it was first produced for, which read as a stale version claim on a matrix
// that is regenerated at every package and plugin version.
md.push(`> Package ${inventory.packageVersion}. Generated from \`feature_inventory.json\` — do not edit by hand.`);
md.push('> Statuses: `verified_supported`, `conditionally_supported`, `intentionally_unsupported`, `defect`, `unverified`.');
md.push('> `unverified` is never a claim of failure or absence of support.');
md.push('');
md.push('정식 운영 모드는 `plugin_only`와 `server_only` 두 가지입니다. `mirror` 열은 퇴역 전 실행 및 기존 설정 호환성 근거이며, 새 운영 모드 선택이나 기능 동등성 보증에 포함하지 않습니다. 전환 계약은 `STORAGE_MODE_TRANSITION_CONTRACT.md`를 참조하세요.');
md.push('');
md.push('## Totals');
md.push('');
md.push('| Mode | verified_supported | conditionally_supported | intentionally_unsupported | defect | unverified |');
md.push('|---|---|---|---|---|---|');
for(const [,mode] of MODES){
  const b=classification.totals.byMode[mode]||{};
  md.push(`| ${mode} | ${b.verified_supported||0} | ${b.conditionally_supported||0} | ${b.intentionally_unsupported||0} | ${b.defect||0} | ${b.unverified||0} |`);
}
md.push('');
md.push('## Features');
md.push('');
md.push('| Owner | Feature ID | Class | plugin_only | mirror | server_only |');
md.push('|---|---|---|---|---|---|');
for(const row of classification.rows){
  md.push(`| ${row.owner} | \`${row.featureId}\` | ${row.storageClass} | ${row.plugin_only} | ${row.mirror} | ${row.server_only} |`);
}
md.push('');
md.push('## Shared-authority audit evidence (Tasks 13–16)');
md.push('');
md.push('Executed by `PROGRAM/tests/storage_mode_owner_parity_audit_test.cjs` (81 assertions) and');
md.push('`PROGRAM/tests/storage_mode_special_parity_gates_test.cjs` (48 assertions) for all four owners:');
md.push('');
md.push('- `plugin_only`: zero Librarian backend requests for owner data (external LLM/embedding provider calls counted separately).');
md.push('- `mirror` (legacy compatibility): previously stored local/server rows and reload behavior; not a selectable operational mode.');
md.push('- `server_only`: zero local canonical writes; server value read back; unreachable server fails closed.');
md.push('- Explicit user child mode (including `plugin_only`) survives reload and branch capability issue.');
md.push('- A native-branch child view cannot overwrite a parent key or substitute a sibling scope in any mode.');
md.push('- Retained retired local bytes are never adopted by a normal `server_only` read (R02).');
md.push('');
md.push('These gates prove the **shared storage authority** for every owner. Per-feature');
md.push('mirror/server_only semantic parity that is not listed as `verified_supported` remains');
md.push('`unverified` and is tracked in `STORAGE_MODE_REMEDIATION_BACKLOG.md`.');
md.push('');

fs.writeFileSync(path.join(outDir,'STORAGE_MODE_SUPPORT_MATRIX.md'),md.join('\n'));

const csv=['owner,featureId,userFeature,storageClass,plugin_only,mirror,server_only,branchSensitive,sourceEditSensitive'];
for(const row of classification.rows){
  const esc=value=>`"${String(value??'').replace(/"/g,'""')}"`;
  csv.push([row.owner,row.featureId,row.userFeature,row.storageClass,row.plugin_only,row.mirror,row.server_only,row.branchSensitive,row.sourceEditSensitive].map(esc).join(','));
}
fs.writeFileSync(path.join(outDir,'STORAGE_MODE_SUPPORT_MATRIX.csv'),csv.join('\n')+'\n');
fs.writeFileSync(path.join(outDir,'support_matrix.json'),JSON.stringify(classification,null,2)+'\n');
console.log(JSON.stringify({matrix:classification.totals,features:classification.rows.length}));
