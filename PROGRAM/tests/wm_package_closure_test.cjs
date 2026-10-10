'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const program=path.resolve(__dirname,'..'),root=path.resolve(program,'../..'),evidence=process.env.P0B_PACKAGE_EVIDENCE||path.join(root,'evidence');
const sourceFile=path.join(process.env.P0B_SOURCE_PACKAGE_DIR||path.join(evidence,'P0b-developer-package'),'Librarian-System-0.3.71-Source-Offline-Candidate.zip');
const releaseFile=path.join(evidence,'P0b-distribution-package/Librarian-System-0.3.71-Offline-Candidate.zip');
const {readZipEntries}=require('../tools/zip_writer.cjs');const {PLUGINS}=require('../tools/release_metadata.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function entries(file){assert.ok(fs.existsSync(file),'explicit candidate package required');return new Map(readZipEntries(file).map(row=>[row.name.slice(row.name.indexOf('/')+1),row]));}
let source,release;test.before(()=>{source=entries(sourceFile);release=entries(releaseFile)});
test('wm_candidate_packages_bind_seven_profile_artifacts_and_manifest_checksums',()=>{
 for(const [profile,rows]of [['source',source],['release',release]]){
 const plugins=[...rows.keys()].filter(k=>k.startsWith('PROGRAM/plugins/')&&k.endsWith('.js'));assert.equal(plugins.length,7);assert.deepEqual(plugins.map(p=>path.basename(p)).sort(),Object.values(PLUGINS).map(([file])=>file).sort());
 const manifest=JSON.parse(rows.get('PROGRAM/program-manifest.json').bytes),update=JSON.parse(rows.get('update-manifest.json').bytes);assert.equal(Object.keys(manifest.plugins).length,7);assert.equal(manifest.plugins.wm,'6.0.0');assert.equal(manifest.qualification.status,'offline_candidate');assert.equal(update.qualification,'offline_candidate');assert.equal(update.updaterEligible,false);assert.equal(update.publicationReady,false);
 assert.throws(()=>require('../tools/release_asset_contract.cjs').validateUpdateManifest(update),/release_asset_manifest_unqualified_candidate/);
 for(const file of plugins){assert.equal(manifest.files[file.slice(8)].sha256,rows.get(file).sha256);assert.equal(manifest.files[file.slice(8)].bytes,rows.get(file).bytes.length);}
 for(const line of rows.get('SHA256SUMS.txt').bytes.toString().trim().split('\n')){const match=line.match(/^([a-f0-9]{64})  \.\/(.+)$/);assert.ok(match);assert.equal(rows.get(match[2])?.sha256,match[1],match[2]);}
 for(const [owner,[file]]of Object.entries(PLUGINS)){const built=fs.readFileSync(path.join(evidence,profile==='source'?'P0b-source-1':'P0b-release-1',file));assert.equal(rows.get('PROGRAM/plugins/'+file).sha256,sha(built),profile+' '+owner);}
 }
});
test('wm_candidate_source_catalog_includes_only_explicit_pinned_reference_dist_inputs',()=>{
 const pins=JSON.parse(source.get('PROGRAM/wm/BASE-PINS.json').bytes),catalog=JSON.parse(source.get('PROGRAM/wm/build-support/source-fixture-catalog.json').bytes).files,manifest=JSON.parse(source.get('PROGRAM/program-manifest.json').bytes);
 assert.equal(pins.files.length,530);assert.equal(Object.keys(catalog).length,636);
 for(const [relative,digest]of Object.entries(catalog)){assert.equal(source.get('PROGRAM/wm/'+relative)?.sha256,digest,relative);assert.equal(manifest.files['wm/'+relative]?.sha256,digest,relative+' source catalog manifest');}
 for(const file of source.keys())if(file.includes('/dist/'))assert.ok(Object.hasOwn(catalog,file.replace(/^PROGRAM\/wm\//,'')),file);
 for(const file of source.keys())assert.doesNotMatch(file,/^PROGRAM\/wm\/(?:dist|evidence|provenance|verification|test-output|DATA|backups?)(?:\/|$)/);
});
test('wm_candidate_runtime_excludes_full_development_and_private_state',()=>{
 for(const file of release.keys())assert.doesNotMatch(file,/^(?:\.development\/|PROGRAM\/(?:wm|tests)\/)|^PROGRAM\/tools\/(?:build_plugins|build_wm_source|build_distribution|build_offline_candidate)\.cjs$|Full\.js$/);
 for(const rows of [source,release])for(const file of rows.keys())assert.doesNotMatch(file,/(?:^|\/)(?:credentials?(?:\.[^/]*)?|\.env(?:\.[^/]*)?|runtime-token\.txt|compute-(?:signing|pairing)-key\.txt|[^/]+\.(?:sqlite(?:-(?:wal|shm))?|db|log))(?:$|\/)/i);
});
