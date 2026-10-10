'use strict';
// A synthetic pre-existing local route for tests that mutate routing authority.
// Fresh registry-absent admission is deliberately tested elsewhere, not seeded here.
const assert=require('node:assert/strict');
async function establishExplicitLocalRoute(fixture,scope){
 const scopeKey=scope?.scopeKey;assert.equal(typeof scopeKey,'string');assert(scopeKey);
 const key='__memory_suite_internal_scope_routes_v1__:flashback';
 const stores=[fixture.pluginStorage,fixture.safeLocalStorage||fixture.host?.safeLocalStorage];
 assert(stores.every(store=>store?.values instanceof Map),'explicit synthetic stores are required');
 const existing=stores.map(store=>store.values.get(key)).filter(value=>value!=null);
 const registry=existing.length?JSON.parse(existing[0]):{schema:'memory-suite.scope-routing.v1',version:1,namespace:'flashback',entries:{}};
 assert.equal(registry.schema,'memory-suite.scope-routing.v1');assert.equal(registry.namespace,'flashback');assert(registry.entries&&typeof registry.entries==='object');
 assert(!registry.entries[scopeKey]||registry.entries[scopeKey].mode==='plugin_only','fixture must not silently change an existing route');
 registry.legacyGlobalModeImported=true;
 registry.entries[scopeKey]={...JSON.parse(JSON.stringify(scope)),scopeId:scopeKey,scopeKey,mode:'plugin_only',origin:'user_explicit',updatedAt:1};
 const bytes=JSON.stringify(registry);for(const store of stores)store.values.set(key,bytes);
 return {key,bytes};
}
module.exports={establishExplicitLocalRoute};
