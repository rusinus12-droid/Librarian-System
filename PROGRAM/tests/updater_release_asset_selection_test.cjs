'use strict';
const assert=require('node:assert/strict');
const {checkLatest}=require('../../UPDATER/update_common.cjs');
(async()=>{
 const release={draft:false,prerelease:false,tag_name:'v9.9.9',html_url:'https://example.invalid/release',assets:[
  {name:'Librarian-System-9.9.9-Source.zip',browser_download_url:'https://example.invalid/source',digest:'sha256:'+'b'.repeat(64)},
  {name:'Librarian-System-9.9.9.zip',browser_download_url:'https://example.invalid/release',digest:'sha256:'+'a'.repeat(64)}
 ]};
 const fetchImpl=async()=>({ok:true,json:async()=>release});
 const result=await checkLatest({currentVersion:'9.9.8',fetchImpl});
 assert.equal(result.officialAsset.name,'Librarian-System-9.9.9.zip');
 assert.equal(result.officialAsset.url,'https://example.invalid/release');
 assert.notEqual(result.officialAsset.name,'Librarian-System-9.9.9-Source.zip');
 console.log('updater_release_asset_selection_test: PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
