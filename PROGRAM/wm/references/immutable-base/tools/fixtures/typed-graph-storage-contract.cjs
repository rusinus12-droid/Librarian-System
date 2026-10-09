'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
// Storage key format and scope hash are the existing HmeDerivedCacheStore contract.
const scopeHash=scope=>{const value=String(scope).trim();let hash=0;for(let i=0;i<value.length;i++){hash=((hash<<5)-hash)+value.charCodeAt(i);hash|=0}return Math.abs(hash).toString(36)};
const graphKeyFor=snapshot=>`libra:v1:hme-derived:${scopeHash(snapshot.scopeKey)}:typed-graph`;
const hash=value=>'sha256:'+crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function assertOnlyTypedGraphWrite(before,after,snapshot,units){
 const key=graphKeyFor(snapshot),without=store=>[...store].filter(([k])=>k!==key).sort(([a],[b])=>a.localeCompare(b));
 assert.deepEqual(without(after),without(before),'all other keys and bytes, including canonical/foreign/other derived kinds, stay unchanged');
 assert(after.has(key),'exact current-scope typed graph key exists');
 const saved=JSON.parse(after.get(key)),{checksum,...payload}=saved;
 assert.equal(saved.schema,'libra.hme.typed_source_graph.v1');assert.equal(checksum,hash(payload));
 assert.equal(saved.binding.schema,saved.schema);assert.equal(saved.binding.scopeKey,snapshot.scopeKey);
 assert.equal(saved.binding.resetGeneration,snapshot.resetGeneration||0);assert.equal(saved.graph.scopeKey,snapshot.scopeKey);
 const valid=Array.from(units).filter(u=>u.scopeKey===snapshot.scopeKey&&['memory','entity','world','narrative'].includes(u.family));
 const counts=new Map();for(const u of valid)counts.set(u.entry.key,(counts.get(u.entry.key)||0)+1);
 const rows=valid.map(u=>[u.identity,hash([u.persistentContentHash,u.locator,counts.get(u.entry.key)])]);
 assert.equal(saved.revision,hash([saved.binding,rows]),'revision binds exact captured current source inventory');
 assert.equal(saved.totalNodes,valid.length,'small fixture retains its complete source inventory');
 assert.deepEqual(saved.graph.nodes.map(n=>n.rowId).sort(),valid.map(u=>u.identity).sort());
 const byId=new Map(valid.map(u=>[u.identity,u])),fingerprints=new Map(rows);
 for(const node of saved.graph.nodes){assert.equal(node.contentHash,byId.get(node.rowId).persistentContentHash);assert.equal(node.sourceFingerprint,fingerprints.get(node.rowId))}
 return saved;
}
module.exports={graphKeyFor,assertOnlyTypedGraphWrite};
