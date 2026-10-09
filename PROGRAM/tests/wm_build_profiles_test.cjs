 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const program=path.resolve(__dirname,'..'),builder=require('../tools/build_plugins.cjs'),distribution=require('../tools/build_distribution.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wm-profiles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
function api(){assert.equal(typeof builder.buildPlugins,'function','explicit profile builder API is required');return builder.buildPlugins;}
test('wm_profiles_share_filename_not_output_directory',()=>{
 assert.equal(builder.PLUGINS.wm?.file,'plugins/LIBRA_World_Manager.js');assert.equal(builder.PLUGINS.wm?.owner,'wm');
 assert.equal(typeof builder.parseBuildArgs,'function');
 const source=builder.parseBuildArgs(['--profile','source']),release=builder.parseBuildArgs(['--profile','release']);
 assert.equal(source.outDir,path.resolve(program,'../.development/build/Full'));assert.equal(release.outDir,path.resolve(program,'../.development/build/Min'));assert.notEqual(source.outDir,release.outDir);
 assert.throws(()=>builder.parseBuildArgs(['--profile','release','--no-minify']),/BUILD_PROFILE_TRANSFORM_CONFLICT/);
 assert.throws(()=>builder.parseBuildArgs(['--no-minify','--profile','release']),/BUILD_PROFILE_TRANSFORM_CONFLICT/);
});
test('wm_source_profile_builds_full_only',async t=>{
 const outDir=temp(t),generated=fs.readFileSync(path.join(program,'plugins/LIBRA_World_Manager.js'));
 const report=await api()({profile:'source',outDir});assert.equal(report.rows.length,7);assert.equal(report.profile,'source');
 assert.equal(report.rows.filter(r=>r.variant==='Min').length,0);assert.ok(report.rows.every(r=>r.wrote&&r.variant==='Full'&&!r.minified));
 const wm=report.rows.find(r=>r.plugin==='wm');assert.equal(wm.receipt.filename,'LIBRA_World_Manager.js');assert.deepEqual(wm.receipt.transforms,[]);assert.equal(wm.receipt.outputSha256,sha(fs.readFileSync(path.join(outDir,wm.receipt.filename))));
 for(const [owner,row]of Object.entries(builder.PLUGINS))if(owner!=='wm')assert.equal(sha(fs.readFileSync(path.join(outDir,path.basename(row.file)))),sha(fs.readFileSync(path.join(program,row.file))),'source Full keeps existing public/developer surfaces');
 assert.equal(sha(fs.readFileSync(path.join(program,'plugins/LIBRA_World_Manager.js'))),wm.receipt.outputSha256);
});
test('wm_release_profile_builds_min_only',async t=>{
 const outDir=temp(t),before=fs.readFileSync(path.join(program,'plugins/LIBRA_World_Manager.js'));
 const report=await api()({profile:'release',only:'wm',outDir});assert.equal(report.rows.length,1);const wm=report.rows[0];assert.equal(wm.variant,'Min');assert.equal(wm.minified,true);assert.equal(wm.receipt.profile,'release');
 assert.equal(wm.receipt.inputDigest,sha(JSON.stringify((await require('../tools/build_wm_source.cjs').assembleWmSource({wmRoot:path.join(program,'wm'),verifyPins:true})).inputs)));
 assert.equal(wm.staticKeyPool.aliases,0);assert.equal(wm.testSurfaceBlocksRemoved,0);assert.equal(wm.budget.headroomBytes,0);assert.equal(wm.budget.maximumBytes,wm.bytes);
 assert.deepEqual(fs.readdirSync(outDir).sort(),['LIBRA_World_Manager.js','ultralight-build-report.json']);assert.deepEqual(fs.readFileSync(path.join(program,'plugins/LIBRA_World_Manager.js')),before);
 assert.deepEqual(wm.receipt.transforms,[{tool:'terser',version:'5.51.2',compress:{passes:2,negate_iife:false},mangle:false,directiveComments:'preserved',propertyPooling:false}]);
});
test('wm_source_and_release_bind_identical_assembly_inputs',async t=>{
 const a=await api()({profile:'source',only:'wm',outDir:path.join(temp(t),'Full')}),b=await api()({profile:'release',only:'wm',outDir:path.join(temp(t),'Min')});
 assert.equal(a.rows[0].receipt.inputDigest,b.rows[0].receipt.inputDigest);assert.notEqual(a.rows[0].receipt.outputSha256,b.rows[0].receipt.outputSha256);
});
test('wm_source_package_has_reproducible_inputs',()=>{
 const pins=JSON.parse(fs.readFileSync(path.join(program,'wm/BASE-PINS.json')));
 for(const row of pins.files)assert.equal(distribution.shouldCopySourceProgram('wm/'+pins.base+'/'+row.file),true,row.file);
 for(const relative of ['wm/BASE-PINS.json','wm/src/build-manifest.json','wm/tools/build-portable.cjs','wm/build-support/package-lock.json','wm/references/frozen-B/dist/LIBRA World Manager Full.js','wm/references/frozen-B/dist/LIBRA World Manager.js'])assert.equal(distribution.shouldCopySourceProgram(relative),true,relative);
 for(const relative of ['wm/dist/evil.js','wm/references/frozen-B/dist/unpinned.js','wm/references/immutable-base/dist/unpinned.js','wm/evidence/result.json','wm/test-output/result.json','wm/provenance/result.json','wm/credentials.json','wm/backup/data.json','wm/DATA/value.json'])assert.equal(distribution.shouldCopySourceProgram(relative),false,relative);
});
test('wm_runtime_package_excludes_development_tree',()=>{
 for(const relative of ['wm/BASE-PINS.json','wm/src/build-manifest.json','wm/references/frozen-B/dist/LIBRA World Manager.js','.development/build/Full/LIBRA_World_Manager.js','tools/build_wm_source.cjs','tests/wm_build_profiles_test.cjs'])assert.equal(distribution.shouldCopyRuntimeProgram(relative),false,relative);
 assert.equal(distribution.shouldCopyRuntimeProgram('plugins/LIBRA_World_Manager.js'),true);
});
test('wm_stale_generated_source_is_rejected_before_release_output',async t=>{
 const fixture=temp(t);fs.mkdirSync(path.join(fixture,'plugins'));fs.symlinkSync(path.join(program,'wm'),path.join(fixture,'wm'));fs.writeFileSync(path.join(fixture,'plugins/LIBRA_World_Manager.js'),'//@name libra_world_manager\n// stale generated source\n');
 const outDir=path.join(fixture,'Min');await assert.rejects(api()({programDir:fixture,profile:'release',only:'wm',outDir}),/WM_STALE_GENERATED_SOURCE/);assert.equal(fs.existsSync(outDir),false);
});
test('wm_explicit_profile_controls_historical_fixture_and_labels',()=>{
 const helper=require('../wm/tools/wm-historical-fixture-paths.cjs');assert.equal(typeof helper.artifactProfile,'function');
 assert.equal(helper.artifactProfile({profile:'source',artifact:'LIBRA_World_Manager.js'}),'source');assert.equal(helper.artifactProfile({profile:'release',artifact:'anything Full.js'}),'release');
 assert.equal(helper.artifactProfile({artifact:'LIBRA World Manager Full.js'}),'source');assert.equal(helper.artifactProfile({artifact:'LIBRA World Manager.js'}),'release');assert.throws(()=>helper.artifactProfile({profile:'bogus'}),/WM_FIXTURE_PROFILE_INVALID/);
});
test('wm_offline_candidate_packaging_cannot_claim_release_qualification',()=>{
 assert.equal(typeof distribution.buildOfflineCandidate,'function');assert.equal(distribution.parseArgs([]).profile,'release');
 const contract=require('../tools/release_asset_contract.cjs');assert.equal(contract.buildUpdateManifest(program).components.wm,'6.0.0');
 assert.throws(()=>contract.validateUpdateManifest({...contract.buildUpdateManifest(program),qualification:'offline_candidate',updaterEligible:false}),/release_asset_manifest_unqualified_candidate/);
 assert.equal(contract.parseAssetVersion('Librarian-System-0.3.71-Offline-Candidate.zip'),null);
 for(const file of ['개발본_만들기.sh','개발본_만들기.bat'])assert.match(fs.readFileSync(path.join(program,file),'utf8'),/--profile source/);
 for(const file of ['배포본_만들기.sh','배포본_만들기.bat'])assert.match(fs.readFileSync(path.join(program,file),'utf8'),/--profile release/);
});
