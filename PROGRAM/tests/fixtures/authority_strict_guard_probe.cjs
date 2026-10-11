'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
function capture(options={}){
 if(!process.env.LIBRA_NETWORK_AUDIT&&!options.guard)return null;
 const path=options.guard||(process.env.NODE_OPTIONS?.match(/--require[= ]([^ ]*\/no-network\.cjs)/)?.[1]);
 assert(path&&require.cache[require.resolve(path)],'strict guard inherited and loaded before fixture');
 const refs=[[global,'fetch'],[global,'WebSocket'],[global,'EventSource'],[require('node:net').Socket.prototype,'connect'],[require('node:net').Server.prototype,'listen']];
 for(const [name,methods] of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dns',['lookup','resolve']],['node:dgram',['createSocket']]])for(const method of methods)refs.push([require(name),method]);
 const hooks=refs.map(([obj,name])=>[obj,name,obj[name]]),sha256=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
 return Object.freeze({verify(){for(const [obj,name,ref] of hooks)assert.equal(obj[name],ref,'fixture must preserve strict audited hook '+name);return {strictHookIdentity:true,strictHookCount:hooks.length,guardSha256:sha256};}});
}
module.exports={capture};
