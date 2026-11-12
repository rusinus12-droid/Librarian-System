'use strict';
// Build-time identities only. A shared version number does not authorize replacing
// a consumer's preserved SDK with the newer active-writer runtime.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Reviewed manager-only health and saved-server-address delta; local-only consumers retain their pin.
// 2026-11-12: the manager surface also exposes setServerUrl, so RE:TRACE can follow a changed server port.
// 2026-11-12: setServerAccessKey/getServerAccessKeyStatus, so RE:TRACE can reach a remote-access (Docker) server.
// 2026-11-13: https:// tunnel addresses for other devices, and one re-bootstrap after a server restart in remote mode.
const managerOnlyConsumerSha256='3cdd12016e56019dd7f557fb0db89b29ae200e786fc7d3891f9096d0052007d8';
// Explicit GRADIA-only read extension; other preserved consumers keep their prior pin.
// 2026-11-12: /bootstrap sends the saved access key of a remote-access (Docker) server.
// 2026-11-13: https:// tunnel addresses for other devices, and one re-bootstrap after a server restart in remote mode.
const gradiaReadOnlyConsumerSha256='c437b3a747456e4f67456ece1e48102b683b25f41e439b5a243b7ec0c5a2cc7e';
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
