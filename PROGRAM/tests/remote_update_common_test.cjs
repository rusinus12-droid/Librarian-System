'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {compareVersions,checkLatest,REPOSITORY,expectedAssetName,normalizeAssetDigest}=require(path.resolve(__dirname,'../../UPDATER/update_common.cjs'));
assert.equal(REPOSITORY.owner,'rusinus12-droid');
assert.equal(compareVersions('0.3.52','0.3.51'),1);
assert.equal(expectedAssetName('0.3.52'),'Librarian-System-0.3.52.zip');
const digest='a'.repeat(64);
assert.equal(normalizeAssetDigest(`sha256:${digest}`),digest);
(async()=>{
  const fetchImpl=async()=>({ok:true,json:async()=>({draft:false,prerelease:false,tag_name:'v0.3.52',html_url:'https://example.invalid',assets:[{name:'Librarian-System-0.3.52.zip',browser_download_url:'https://example.invalid/release.zip',digest:`sha256:${digest}`} ]})});
  const r=await checkLatest({currentVersion:'0.3.51',fetchImpl});
  assert.equal(r.available,true);
  assert.equal(r.expectedAssetName,'Librarian-System-0.3.52.zip');
  assert.equal(r.officialAsset.sha256,digest);
  console.log('remote_update_common_test: PASS');
})().catch(e=>{console.error(e);process.exit(1)});
