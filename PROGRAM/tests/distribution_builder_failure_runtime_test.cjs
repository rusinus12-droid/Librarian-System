'use strict';
// Separate integration probe; deliberately excluded from release_smoke to avoid recursive builds.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {shouldCopyProgram,preflightSourceReleaseGuides}=require('../tools/build_distribution.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'distribution-failure-'));
try {
  const source=path.resolve(__dirname,'..'),packageSource=path.resolve(source,'..'),packageTarget=path.join(root,'package'),target=path.join(packageTarget,'PROGRAM'),out=path.join(root,'output');
  fs.cpSync(source,target,{recursive:true,filter:file=>fs.statSync(file).isDirectory()||shouldCopyProgram(path.relative(source,file))});
  fs.cpSync(path.join(packageSource,'UPDATER'),path.join(packageTarget,'UPDATER'),{recursive:true});
  // Owned synthetic DATA is sufficient to prove the builder never mutates it.
  const syntheticData=path.join(packageTarget,'DATA');
  fs.mkdirSync(path.join(syntheticData,'stores','libra'),{recursive:true});
  fs.mkdirSync(path.join(syntheticData,'config'),{recursive:true});
  fs.writeFileSync(path.join(syntheticData,'stores','libra','owned-sentinel.bin'),Buffer.from([0,1,127,255]));
  fs.writeFileSync(path.join(syntheticData,'config','fixture.json'),JSON.stringify({fixture:'synthetic-only',preserve:true}));
  fs.copyFileSync(path.join(packageSource,'SHA256SUMS.txt'),path.join(packageTarget,'SHA256SUMS.txt'));
  fs.copyFileSync(path.resolve(source,'../0_설치_안내.txt'),path.join(packageTarget,'0_설치_안내.txt'));
  const dataSnapshot=JSON.stringify(fs.readdirSync(path.join(packageTarget,'DATA'),{recursive:true,withFileTypes:true}).map(entry=>[entry.parentPath||entry.path||'',entry.name,entry.isDirectory()?'d':require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(entry.parentPath||entry.path,entry.name))).digest('hex')]).sort());
  for(const name of ['업데이트.bat','업데이트.command','업데이트.sh'])fs.copyFileSync(path.join(packageSource,name),path.join(packageTarget,name));
  const original=fs.readFileSync(path.resolve(source,'../0_설치_안내.txt'),'utf8');
  const malformed=original.replace(/^- LIBRA \d+\.\d+\.\d+\r?$/m,'missing LIBRA inventory');
  assert.notEqual(malformed,original);
  assert.equal(typeof preflightSourceReleaseGuides,'function','the builder exposes its read-only three-guide preflight for this contract test');
  const guidePaths=['0_설치_안내.txt','PROGRAM/처음_읽어주세요.txt','PROGRAM/PACKAGE_CONTENTS.txt'];
  const guideFiles=guidePaths.map(relative=>path.join(packageTarget,...relative.split('/')));
  const guideSnapshot=guideFiles.map(file=>fs.readFileSync(file,'utf8'));
  for(let index=0;index<guideFiles.length;index++){
    const guideFile=guideFiles[index],before=guideSnapshot[index];
    const invalid=before.replace(/^- LIBRA \d+\.\d+\.\d+\r?$/m,'missing LIBRA inventory');
    assert.notEqual(invalid,before,`LIBRA inventory row exists in ${guidePaths[index]}`);
    fs.writeFileSync(guideFile,invalid);
    assert.throws(()=>preflightSourceReleaseGuides(packageTarget),/release_guide_inventory_invalid:LIBRA/,
      `the source preflight rejects malformed LIBRA inventory in ${guidePaths[index]}`);
    assert.deepEqual(guideFiles.map(file=>fs.readFileSync(file,'utf8')),
      guideSnapshot.map((value,guideIndex)=>guideIndex===index?invalid:value),
      'source preflight must read each guide without repairing or mutating any source guide');
    fs.writeFileSync(guideFile,before);
    assert.equal(fs.readFileSync(guideFile,'utf8'),before,'fixture guide restoration is physically read back');
  }
  assert.doesNotThrow(()=>preflightSourceReleaseGuides(packageTarget),'all three valid source guides pass preflight');
  const guide=guideFiles[0];fs.writeFileSync(guide,malformed);
  const startedAt=Date.now();
  const run=spawnSync(process.execPath,[path.join(target,'tools/build_distribution.cjs'),'--output-dir',out],{encoding:'utf8',timeout:275000});
  const elapsedMs=Date.now()-startedAt;
  assert.equal(run.error,undefined);assert.equal(run.status,1);assert.match(run.stderr,/release_guide_inventory_invalid:LIBRA/);
  const files=fs.readdirSync(out);assert.equal(files.length,1);assert.match(files[0], /^Librarian-System-\d+\.\d+\.\d+\.failed-.+\.json$/);
  const report=JSON.parse(fs.readFileSync(path.join(out,files[0]),'utf8'));
  assert.equal(report.phase,'source_preflight');assert.equal(report.artifactProduced,false);assert.match(report.error,/release_guide_inventory_invalid:LIBRA/);
  assert.ok(elapsedMs<30000,`malformed inventory rejects before smoke with a bounded preflight (${elapsedMs}ms)`);
  assert.equal(fs.readFileSync(guide,'utf8'),malformed,'builder must not repair source guides');
  const dataAfter=JSON.stringify(fs.readdirSync(path.join(packageTarget,'DATA'),{recursive:true,withFileTypes:true}).map(entry=>[entry.parentPath||entry.path||'',entry.name,entry.isDirectory()?'d':require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(entry.parentPath||entry.path,entry.name))).digest('hex')]).sort());
  assert.equal(dataAfter,dataSnapshot,'release smoke must not mutate source DATA');
  console.log('distribution_builder_failure_runtime_test: PASS (real builder rejects malformed inventory, retains failure report, removes staging, produces no ZIP, preserves source DATA)');
}finally{
  if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('distribution-failure-'))throw Error('unexpected fixture path');
  fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  assert.equal(fs.existsSync(root),false,'the package, DATA snapshot, failure report, and temporary build tree are removed after the test');
}
