'use strict';
// Task 17 contract: the support matrix is complete, uses the vocabulary, and
// every non-green result carries remediation evidence. No feature may be omitted
// merely because it has no server implementation.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const dir=path.join(root,'docs/storage-mode-audit');
const STATUS=new Set(['verified_supported','conditionally_supported','intentionally_unsupported','defect','unverified']);
let passed=0;const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};

ok('support matrix markdown exists',fs.existsSync(path.join(dir,'STORAGE_MODE_SUPPORT_MATRIX.md')));
ok('support matrix csv exists',fs.existsSync(path.join(dir,'STORAGE_MODE_SUPPORT_MATRIX.csv')));
ok('remediation backlog exists',fs.existsSync(path.join(dir,'STORAGE_MODE_REMEDIATION_BACKLOG.md')));
ok('machine matrix exists',fs.existsSync(path.join(dir,'support_matrix.json')));

const inventory=JSON.parse(fs.readFileSync(path.join(dir,'feature_inventory.json'),'utf8'));
const matrix=JSON.parse(fs.readFileSync(path.join(dir,'support_matrix.json'),'utf8'));

ok('matrix covers every inventory feature',matrix.rows.length===inventory.features.length);
const inventoryIds=new Set(inventory.features.map(f=>f.featureId));
ok('matrix feature ids match inventory',matrix.rows.every(r=>inventoryIds.has(r.featureId)));

for(const row of matrix.rows){
  for(const field of ['plugin_only','mirror','server_only']) ok(`${row.featureId}: ${field} status valid`,STATUS.has(row[field]));
  const nonGreen=['mirror','server_only'].filter(m=>row[m]!=='verified_supported');
  if(nonGreen.length){
    ok(`${row.featureId}: non-green rows carry gaps`,Array.isArray(row.gaps)&&row.gaps.length===nonGreen.length);
    for(const gap of row.gaps){
      ok(`${row.featureId}/${gap.mode}: gap has entry point`,typeof gap.entryPoint==='string'&&gap.entryPoint.length>0);
      ok(`${row.featureId}/${gap.mode}: gap has expected result`,typeof gap.expected==='string'&&gap.expected.length>0);
      ok(`${row.featureId}/${gap.mode}: gap has severity`,/^P[0-3]$/.test(String(gap.severity)));
      ok(`${row.featureId}/${gap.mode}: gap has required change`,typeof gap.requiredChange==='string'&&gap.requiredChange.length>0);
    }
  }
}
ok('no unexpected defect status',matrix.rows.every(r=>r.plugin_only!=='defect'&&r.mirror!=='defect'&&r.server_only!=='defect'));
ok('totals count every feature',matrix.totals.features===inventory.features.length);
console.log(JSON.stringify({test:'storage_mode_support_matrix_contract',passed,features:matrix.rows.length}));
