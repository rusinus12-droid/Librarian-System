'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const M=require('../../UPDATER/core/migration-required.cjs'),identity=require('../../UPDATER/core/data-identity.cjs');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'librarian-wm-migration-admission-')),p=x=>path.join(root,x);
 for(const d of ['PROGRAM','DATA/config','UPDATER','.update/PROGRAM.next','.update/candidate/DATA','.update/DATA.next'])fs.mkdirSync(p(d),{recursive:true});
 for(const d of ['PROGRAM','.update/PROGRAM.next'])fs.writeFileSync(p(d+'/VERSION.txt'),'0.3.71\n');
 fs.writeFileSync(p('DATA/runtime-token.txt'),'synthetic-only-'.repeat(5));
 fs.writeFileSync(p('.update/DATA.next/retained.txt'),'do not destroy a prepared candidate on refusal');
 return {root,p,receipt:{updatePolicy:'migration_required',targetVersion:'0.3.71',programNext:p('.update/PROGRAM.next'),releaseDataTemplate:p('.update/candidate/DATA')}};
}
function put(f,rel,value='retained synthetic WM evidence'){
 const file=f.p('DATA/'+rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);return file;
}
const cases=[
 ['empty WM slot',f=>fs.mkdirSync(f.p('DATA/stores/wm'),{recursive:true})],
 ['orphan WAL',f=>put(f,'stores/wm/wm.sqlite-wal')],
 ['selected import',f=>put(f,'config/wm-import-selection.json')],
 ['prepared selection',f=>put(f,'config/wm-import-selection.json.prepared-plan')],
 ['unselected import',f=>put(f,'migrations/wm-imports/operation/wm.sqlite.import-plan.json')],
 ['component restore plan',f=>put(f,'migrations/component-restore-plans/plan.json')],
 ['component restore receipt',f=>put(f,'migrations/component-restore-receipts/receipt.json')],
 ['historical WM component',f=>put(f,'backups/manual/cut/manifest.json',JSON.stringify({schema:'memory-suite.backup-bundle.v2',components:{wm:{file:'wm-cut.sqlite'}}}))],
 ['historical unsupported coverage',f=>put(f,'backups/manual/cut/manifest.json',JSON.stringify({schema:'memory-suite.backup-bundle.v2',coverage:{wm:'unsupported'}}))],
 ['orphan WM backup',f=>put(f,'backups/manual/cut/wm-cut.sqlite-wal')],
 ['unclassified renamed backup',f=>put(f,'backups/manual/cut/retained.sqlite')],
 ['unreadable backup metadata',f=>put(f,'backups/manual/cut/manifest.json','{')],
 ['ambiguous backup metadata',f=>put(f,'backups/manual/cut/manifest.json',JSON.stringify({schema:'memory-suite.backup.v1'}))],
 ['opaque backup archive',f=>put(f,'backups/exports/retained.zip')],
 ['oversized backup metadata',f=>put(f,'backups/manual/cut/manifest.json',' '.repeat(1024*1024+1))],
 ['dangling WM symlink',f=>{fs.mkdirSync(f.p('DATA/stores'),{recursive:true});fs.symlinkSync('missing-target',f.p('DATA/stores/wm'));}]
];
(async()=>{
 let checks=0;
 for(const [name,seed]of cases){const f=fixture();try{
  seed(f);let stopped=0;
  const hooks={fetchHealth:async()=>null,stopServer:async()=>{stopped++;throw Error('UNSAFE_STOP_REACHED');}};
  await assert.rejects(()=>M.applyMigrationRequired({rootDir:f.root,receipt:f.receipt,hooks}),/migration_wm_state_requires_explicit_handoff/,name);
  assert.equal(stopped,0,name+': original server is not stopped');
  assert.equal(fs.existsSync(identity.identityPath(f.p('DATA'))),false,name+': no DATA seed is created');
  assert.equal(fs.existsSync(f.p('UPDATER/update-state.json')),false,name+': no update decision is created');
  await assert.rejects(()=>M.buildMigratedDataNext({rootDir:f.root,receipt:f.receipt}),/migration_wm_state_requires_explicit_handoff/,name+': direct entry point');
  assert.equal(fs.readFileSync(f.p('.update/DATA.next/retained.txt'),'utf8'),'do not destroy a prepared candidate on refusal');checks++;
  await assert.rejects(()=>require('../../UPDATER/core/program-only.cjs').applyProgramOnly({rootDir:f.root,receipt:{...f.receipt,updatePolicy:'program_only'},hooks}),/program_only_wm_state_requires_identity_safe_rollback/,name+': copied checkpoint rollback is not WM identity-safe');
  assert.equal(fs.existsSync(identity.identityPath(f.p('DATA'))),false,name+': program-only refusal does not seed DATA');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}}
 const clean=fixture();try{
  put(clean,'backups/manual/legacy/manifest.json',JSON.stringify({schema:'memory-suite.backup.v1',stores:{libra:{file:'libra.sqlite'}},coverage:{wm:'absent'}}));
  assert.equal(M.assertNoWmMigrationState(clean.p('DATA')).wm,'absent');checks++;
  const legacy={schema:'memory-suite.backup.v1',id:'synthetic-legacy',kind:'manual',createdAt:'2026-10-10T00:00:00Z',createdAtMs:1791590400000,stores:{libra:{file:'libra.sqlite'}}};
  const bundle=require('../server/portable/backup_bundle_v2.cjs').wrapBackup(legacy,null,{wmCoverage:'absent'});
  put(clean,'backups/manual/bundle/manifest.json',JSON.stringify(bundle));
  assert.equal(M.assertNoWmMigrationState(clean.p('DATA')).wm,'absent','actual v2 producer with explicit absence is admitted');checks++;
 }finally{fs.rmSync(clean.root,{recursive:true,force:true});}
 // The actual builder emits only these five exact inert template markers.
 const marker='This directory is intentionally empty in a clean Librarian System distribution.\n';
 const markerDirs=['auto','manual','pre-migration','deleted-scopes','recovery-quarantine'];
 const template=fixture();try{
  for(const dir of markerDirs)put(template,'backups/'+dir+'/.keep.txt',marker);
  for(const policy of ['migration_required','program_only'])assert.equal(require('../../UPDATER/core/wm-update-admission.cjs').assertWmUpdateAdmission(template.p('DATA'),policy).wm,'absent');checks++;
  for(const dir of markerDirs){const file=template.p('DATA/backups/'+dir+'/.keep.txt');for(const altered of [marker+'retained state','X'+marker.slice(1)]){fs.writeFileSync(file,altered);assert.throws(()=>M.assertNoWmMigrationState(template.p('DATA')),/migration_wm_state_requires_explicit_handoff/);checks++;}fs.writeFileSync(file,marker);}
  for(const rel of ['backups/unknown/.keep.txt','backups/manual/nested/.keep.txt','backups/manual/retained.sqlite']){const file=put(template,rel,marker);assert.throws(()=>M.assertNoWmMigrationState(template.p('DATA')),/migration_wm_state_requires_explicit_handoff/);fs.rmSync(file);checks++;}
  put(template,'stores/wm/wm.sqlite-wal','WM evidence beside valid template markers');assert.throws(()=>M.assertNoWmMigrationState(template.p('DATA')),/migration_wm_state_requires_explicit_handoff/);checks++;
 }finally{fs.rmSync(template.root,{recursive:true,force:true});}
 const late=fixture();try{
  const inode=fs.statSync(late.p('DATA')).ino;let starts=0;
  await assert.rejects(()=>M.applyMigrationRequired({rootDir:late.root,receipt:late.receipt,hooks:{
   fetchHealth:async()=>null,
   stopServer:async()=>{if(!fs.existsSync(late.p('DATA/stores/wm')))put(late,'stores/wm/wm.sqlite-wal','retained at the stop boundary');return {wasRunning:true};},
   startServer:async(p,data,options)=>{starts++;assert.equal(p,late.p('PROGRAM'));assert.equal(options.verifyMode,false);return {version:'0.3.71',dataInstanceId:identity.capture(data).dataInstanceId,dataIdentityContract:identity.contract,maintenanceMode:false};}
  }}),/migration_wm_state_requires_explicit_handoff/);
  assert.equal(starts,1,'existing running pair restarts after post-stop refusal');
  assert.equal(fs.statSync(late.p('DATA')).ino,inode,'rollback retains physical DATA directory');
  assert.equal(fs.readFileSync(late.p('DATA/stores/wm/wm.sqlite-wal'),'utf8'),'retained at the stop boundary');
  assert.equal(JSON.parse(fs.readFileSync(late.p('UPDATER/update-state.json'))).status,'rolled_back');checks++;
 }finally{fs.rmSync(late.root,{recursive:true,force:true});}
 console.log('remote_update_wm_migration_admission_test: PASS ('+checks+' early/direct/post-stop and absence controls; successful WM migration remains unsupported)');
})().catch(error=>{console.error(error);process.exitCode=1;});
