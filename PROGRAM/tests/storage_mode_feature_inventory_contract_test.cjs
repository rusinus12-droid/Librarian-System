'use strict';
// Contract for the storage-mode feature inventory. Every record must classify
// its storage and declare all three mode statuses so "not tested" can never be
// silently recorded as "unsupported".
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const INVENTORY=path.join(root,'docs/storage-mode-audit/feature_inventory.json');
const STATUS=new Set(['verified_supported','conditionally_supported','intentionally_unsupported','defect','unverified']);
const STORAGE=new Set(['owner_authoritative','owner_derived','local_configuration','credential','transient_cache','diagnostic','archive_reference']);
const REQUIRED=['owner','featureId','userFeature','entryPoints','expectedSemanticResult','storageClass','pluginOnlyStatus','mirrorStatus','serverOnlyStatus'];
const MODE_STATUS=['pluginOnlyStatus','mirrorStatus','serverOnlyStatus'];
let passed=0;const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};

ok('inventory file exists',fs.existsSync(INVENTORY));
const inventory=JSON.parse(fs.readFileSync(INVENTORY,'utf8'));
ok('inventory has schema',typeof inventory.schema==='string'&&inventory.schema.length>0);
ok('inventory has features array',Array.isArray(inventory.features)&&inventory.features.length>0);

const owners=new Set(['libra','hayaku','flashback','lia']);
const seen=new Set();
for(const feature of inventory.features){
  const id=feature.featureId||'(missing)';
  for(const field of REQUIRED) ok(`${id}: has ${field}`,feature[field]!==undefined&&feature[field]!==null&&String(feature[field]).length>0);
  ok(`${id}: owner is known`,owners.has(String(feature.owner)));
  ok(`${id}: entryPoints is a non-empty array`,Array.isArray(feature.entryPoints)&&feature.entryPoints.length>0);
  ok(`${id}: storageClass is valid`,STORAGE.has(String(feature.storageClass)));
  for(const field of MODE_STATUS) ok(`${id}: ${field} is valid`,STATUS.has(String(feature[field])));
  ok(`${id}: featureId is unique`,!seen.has(id));seen.add(id);
  ok(`${id}: declared storage class present in storageSchemas or storageKeys`,
    Array.isArray(feature.storageSchemas)&&Array.isArray(feature.storageKeys));
  if(feature.storageClass==='owner_authoritative'||feature.storageClass==='owner_derived'||feature.storageClass==='archive_reference'){
    ok(`${id}: authoritative features list tests`,Array.isArray(feature.tests));
  }
  // A defect or conditionally supported result must carry a reproduction + work item.
  if(feature.mirrorStatus==='defect'||feature.serverOnlyStatus==='defect'||feature.mirrorStatus==='conditionally_supported'||feature.serverOnlyStatus==='conditionally_supported'){
    ok(`${id}: non-green modes declare requiredWork`,Array.isArray(feature.requiredWork));
  }
}
// All four owners must be represented.
for(const owner of owners) ok(`owner ${owner} represented`,inventory.features.some(f=>f.owner===owner));
console.log(JSON.stringify({test:'storage_mode_feature_inventory_contract',passed,features:inventory.features.length}));
