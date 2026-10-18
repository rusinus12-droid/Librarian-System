'use strict';
// Build-time identities only. A shared version number does not authorize replacing
// a consumer's preserved SDK with the newer active-writer runtime.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const preservedConsumerSha256='93711f7bb78faaf46d18bda64da7108710b37b0865a44a67fbbd2e831fb004bb';
// Reviewed manager-only health delta; local-only consumers retain their pin.
const managerOnlyConsumerSha256='8a74a8a9045f1821c238e1e14652fc44b4efb44c63ca13bfca5aa7c78b434cf4';
// Explicit GRADIA-only read extension; other preserved consumers keep their prior pin.
const gradiaReadOnlyConsumerSha256='a8f8bf6c735527c235d98d420c86b6b6ef05727fcf95a2dc9691f95c0ed22619';
const STORAGE_VARIANTS=Object.freeze({
 'Flashback_Memory.js':Object.freeze({variant:'core3-standard-flashback',source:'sdk/MemorySuiteStorageClient.source.js',embedsCompute:false}),
 'HAYAKU_Locator_Continuity.js':Object.freeze({variant:'core3-standard-hayaku',source:'sdk/MemorySuiteStorageClient.source.js',embedsCompute:false}),
 'LIBRA.js':Object.freeze({variant:'libra-control-plane-preroute',source:'sdk/MemorySuiteStorageClient.libra.source.js',embedsCompute:false}),
 'LIA_Persona_Linker.js':Object.freeze({variant:'preserved-local-only',embeddedSha256:preservedConsumerSha256,embedsCompute:false}),
 'RETRACE.js':Object.freeze({variant:'preserved-manager-only',embeddedSha256:managerOnlyConsumerSha256,embedsCompute:false}),
 'GRADIA.js':Object.freeze({variant:'preserved-readonly-three-owner',embeddedSha256:gradiaReadOnlyConsumerSha256,embedsCompute:false})
});
const storagePattern=()=>/\/\* LIBRARIAN SYSTEM STORAGE SDK v[^\r\n]+[\s\S]*?\r?\n  return bridge;\r?\n\r?\n};/g;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
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
