'use strict';
// Real source packaging and version rollback; kept out of release_smoke to avoid nested distributions.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const builder=require('../tools/build_distribution.cjs');
const {readZipEntries}=require('../tools/zip_writer.cjs');

test('explicit offline qualification survives a real version bump and failed-build rollback',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'release-qualification-test-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'..'),rootSource=path.dirname(source),root=path.join(temp,'package'),program=path.join(root,'PROGRAM');
 fs.cpSync(source,program,{recursive:true,filter:file=>fs.statSync(file).isDirectory()||builder.shouldCopySourceProgram(path.relative(source,file))});
 fs.cpSync(path.join(rootSource,'UPDATER'),path.join(root,'UPDATER'),{recursive:true});
 for(const file of ['0_설치_안내.txt','업데이트.sh','업데이트.bat','업데이트.command','update-manifest.json','SHA256SUMS.txt'])fs.copyFileSync(path.join(rootSource,file),path.join(root,file));
 const assets=require(path.join(program,'tools/release_asset_contract.cjs'));
 assets.writeUpdateManifest(root,{qualification:'offline_candidate',overwrite:true});
 const manifestPath=path.join(program,'program-manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 manifest.qualification={status:'offline_candidate',updaterEligible:false,publicationReady:false};fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 const current=fs.readFileSync(path.join(program,'VERSION.txt'),'utf8').trim(),version=builder.nextPatchVersion(current),out=path.join(temp,'out');
 const env={...process.env,LIBRARIAN_PACKAGE_QUALIFICATION:''};
 const run=spawnSync(process.execPath,[path.join(program,'tools/build_distribution.cjs'),'--profile','source','--offline-candidate','--version',version,'--output-dir',out],{env,encoding:'utf8',timeout:120000});
 assert.equal(run.status,0,run.stderr||String(run.error));
 const update=JSON.parse(fs.readFileSync(path.join(root,'update-manifest.json'),'utf8'));
 assert.equal(update.version,version);assert.equal(update.qualification,'offline_candidate');assert.equal(update.updaterEligible,false);
 assert.equal(JSON.parse(fs.readFileSync(manifestPath,'utf8')).qualification.status,'offline_candidate');
 assert.throws(()=>assets.validateUpdateManifest(update),/manifest_unqualified_candidate/);
 const base=`Librarian-System-${version}-Source-Offline-Candidate`;
 const report=JSON.parse(fs.readFileSync(path.join(out,base+'.build-report.json'),'utf8'));
 assert.equal(report.publicationSmokePassed,false);assert.equal(report.updaterEligible,false);
 const entry=readZipEntries(path.join(out,base+'.zip')).find(row=>row.name.endsWith('/update-manifest.json'));
 assert.ok(entry);assert.equal(JSON.parse(entry.bytes.toString('utf8')).qualification,'offline_candidate');
 const files=['VERSION.txt','server/server.cjs','release-policy.json','server/portable/logical_migration.cjs','server/portable/transfer_manager.cjs','tools/portable_export_stopped.cjs','처음_읽어주세요.txt','PACKAGE_CONTENTS.txt','program-manifest.json','docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json'].map(p=>path.join(program,p));
 files.push(...['0_설치_안내.txt','update-manifest.json','SHA256SUMS.txt'].map(p=>path.join(root,p)));
 const snapshot=()=>files.map(p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
 const before=snapshot();
 const failed=spawnSync(process.execPath,[path.join(program,'tools/build_distribution.cjs'),'--profile','source','--offline-candidate','--version',builder.nextPatchVersion(version),'--output-dir',path.join(root,'invalid-output')],{env,encoding:'utf8',timeout:30000});
 assert.notEqual(failed.status,0);assert.match(failed.stderr,/distribution_output_must_be_outside_source_package/);assert.deepEqual(snapshot(),before);
});
