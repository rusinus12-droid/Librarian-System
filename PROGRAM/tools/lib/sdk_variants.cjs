'use strict';
// Build-time identities only. A shared version number does not authorize replacing
// a consumer's preserved SDK with the newer active-writer runtime.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Reviewed manager-only health and saved-server-address delta; local-only consumers retain their pin.
// 2026-11-12: the manager surface also exposes setServerUrl, so RE:TRACE can follow a changed server port.
const managerOnlyConsumerSha256='3664d32e131cc8f812b1bb7505ce9bbd42e642a4ec730031598967a837ebc994';
// Explicit GRADIA-only read extension; other preserved consumers keep their prior pin.
const gradiaReadOnlyConsumerSha256='1c96e747a1625fc9044a1c5ef889fef7756948352c5bd95ff6898f8388a2c7f4';
const STORAGE_VARIANTS=Object.freeze({
 'Flashback_Memory.js':Object.freeze({variant:'core3-standard-flashback',source:'sdk/MemorySuiteStorageClient.flashback.source.js',embedsCompute:false}),
 'HAYAKU_Locator_Continuity.js':Object.freeze({variant:'core3-standard-hayaku',source:'sdk/MemorySuiteStorageClient.source.js',embedsCompute:false}),
 'LIBRA.js':Object.freeze({variant:'libra-control-plane-preroute',source:'sdk/MemorySuiteStorageClient.libra.source.js',embedsCompute:false}),
 'RETRACE.js':Object.freeze({variant:'preserved-manager-only',embeddedSha256:managerOnlyConsumerSha256,embedsCompute:false}),
 'GRADIA.js':Object.freeze({variant:'preserved-readonly-three-owner',embeddedSha256:gradiaReadOnlyConsumerSha256,embedsCompute:false})
});
const storagePattern=()=>/\/\* LIBRARIAN SYSTEM STORAGE SDK v[^\r\n]+[\s\S]*?\r?\n  return bridge;\r?\n\r?\n};/g;
const sha=bytes=>crypto.createHash('sha256').update(String(bytes).replace(/\r\n/g,'\n')).digest('hex');
function extractStorageSdk(text,name){
 const blocks=[...text.matchAll(storagePattern())];
 const markers=(text.match(/\/\* LIBRARIAN SYSTEM STORAGE SDK v/g)||[]).length;
 if(blocks.length!==1||markers!==1)throw Error('storage_sdk_embed_ambiguous:'+name);
 return blocks[0][0];
}
function expectedStorageSdk(programDir,name,text){
 const spec=STORAGE_VARIANTS[name];if(!spec)throw Error('storage_sdk_variant_unknown:'+name);
 if(spec.source)return fs.readFileSync(path.join(programDir,spec.source),'utf8').trimEnd();
 const embedded=extractStorageSdk(text,name);
 if(sha(embedded)!==spec.embeddedSha256)throw Error('preserved_storage_sdk_changed:'+name);
 return embedded;
}
function storageVariantMetadata(programDir){
 return Object.fromEntries(Object.entries(STORAGE_VARIANTS).map(([name,spec])=>[name,{variant:spec.variant,source:spec.source||null,sha256:spec.source?sha(fs.readFileSync(path.join(programDir,spec.source),'utf8').trimEnd()):spec.embeddedSha256,synchronization:spec.source?'canonical-variant':'verify-preserved-only'}]));
}
module.exports={STORAGE_VARIANTS,extractStorageSdk,expectedStorageSdk,storageVariantMetadata};
