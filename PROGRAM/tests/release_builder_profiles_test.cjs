'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const builder=require('../tools/build_distribution.cjs');
const assets=require('../tools/release_asset_contract.cjs');

const version=fs.readFileSync(path.resolve(__dirname,'../VERSION.txt'),'utf8').trim();
assert.equal(builder.parseArgs(['--profile','release']).profile,'release');
assert.equal(builder.parseArgs(['--profile','source']).profile,'source');
assert.equal(builder.parseArgs(['--profile','all']).profile,'all');
assert.throws(()=>builder.parseArgs(['--profile','wat']),/distribution_profile_invalid/);
assert.equal(typeof builder.shouldCopyRuntimeProgram,'function');
assert.equal(typeof builder.shouldCopySourceProgram,'function');
assert.equal(builder.shouldCopySourceProgram('tests/distribution_builder_test.cjs'),true);
assert.equal(builder.shouldCopySourceProgram('docs/RELEASE_BUILDER_20260912.md'),true);
assert.equal(builder.shouldCopyRuntimeProgram('tests/distribution_builder_test.cjs'),false);
assert.equal(builder.shouldCopyRuntimeProgram('docs/RELEASE_BUILDER_20260912.md'),false);
assert.equal(builder.shouldCopyRuntimeProgram('server/server.cjs'),true);
assert.equal(builder.shouldCopyRuntimeProgram('plugins/Flashback_Memory.js'),true);
assert.equal(builder.shouldCopyRuntimeProgram('tools/build_distribution.cjs'),false);
assert.equal(builder.shouldCopyRuntimeProgram('tools/release_builder_ui.cjs'),false);
assert.equal(builder.shouldCopyRuntimeProgram('tools/runtime_release_validation.cjs'),true);
// The search kernel is a test oracle only since server Compute retired; it is not shipped.
assert.equal(builder.shouldCopyRuntimeProgram('sdk/MemorySuiteSearchKernel.source.cjs'),false);
assert.equal(builder.shouldCopyRuntimeProgram('sdk/MemorySuiteStorageClient.source.js'),true);
assert.equal(builder.shouldCopyRuntimeProgram('sdk/MemorySuiteComputeClient.source.js'),true);
assert.equal(builder.shouldCopyRuntimeProgram('sdk/MemorySuiteStorageClient.libra.source.js'),true);
assert.equal(builder.shouldCopyRuntimeProgram('sdk/MemorySuiteExecutionContract.source.js'),true,'program manifest runtime contract is required');
assert.equal(assets.expectedSourceAssetName(version),`Librarian-System-${version}-Source.zip`);
assert.equal(assets.parseAssetVersion(`Librarian-System-${version}-Source.zip`),null,'updater parser rejects developer source asset');
assert.equal(assets.parseSourceAssetVersion(`Librarian-System-${version}-Source.zip`),version);
assert.equal(assets.parseSourceAssetVersion(`Librarian-System-${version}.zip`),null);
const manifest=assets.buildUpdateManifest(path.resolve(__dirname,'..'));
assert.equal(manifest.assetName,`Librarian-System-${version}.zip`,'update manifest always names the user release');
for (const [file,profile] of [['배포본_만들기.sh','release'],['개발본_만들기.sh','source'],['전체_릴리즈_만들기.sh','all'],['배포본_만들기.bat','release'],['개발본_만들기.bat','source'],['전체_릴리즈_만들기.bat','all']]) {
  const body=fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
  assert.match(body,new RegExp(`--profile[ \"]+${profile}`),`${file} binds ${profile} profile`);
}
console.log('release_builder_profiles_test: PASS');
