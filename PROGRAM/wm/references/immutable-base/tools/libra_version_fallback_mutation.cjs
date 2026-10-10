'use strict';
// A deliberate stale-version mutation, parameterized by the observed release.
// This remains test-only: callers decide whether to use it in memory or in an isolated build.
function versionFallbackMutation(version){
 if(typeof version!=='string'||!version.trim())throw Error('declared plugin version missing');
 const escaped=version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return {find:new RegExp("return\\s+(['\"])"+escaped+"\\1\\s*;"),replace:"return '0.1';"};
}
module.exports={versionFallbackMutation};
