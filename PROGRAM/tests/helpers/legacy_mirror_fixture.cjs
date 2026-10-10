'use strict';
// Upgrade/repair regression fixture only. Never enables a retired production setting.
const assert=require('node:assert/strict');
async function seedLegacyMirrorFixture(bridge,store,scopeInput=null){
 const scope=(await bridge.getScopeMode(scopeInput || await bridge.getCurrentScope())).scope;
 assert.ok(scope.scopeId,'upgrade fixture needs the SDK-normalized scope identity');
 await bridge.setScopeMode(scope,'server_only');
 const namespace=bridge.status().namespace,key='__memory_suite_internal_scope_routes_v1__:'+namespace;
 const registry=JSON.parse(await store.getItem(key));
 registry.entries[scope.scopeId]={...registry.entries[scope.scopeId],mode:'mirror',origin:'user_explicit',updatedAt:Math.max(Date.now(),Number(registry.entries[scope.scopeId]?.updatedAt||0)+1),source:'legacy_mirror_upgrade_fixture'};
 await store.setItem(key,JSON.stringify(registry));
 assert.equal((await bridge.getScopeMode(scope)).mode,'mirror');
 return {changed:true,from:'plugin_only',to:'mirror',fixture:'legacy_upgrade'};
}
module.exports={seedLegacyMirrorFixture};
