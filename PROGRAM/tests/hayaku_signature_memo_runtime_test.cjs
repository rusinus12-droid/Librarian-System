'use strict';
// Regression: exact duplicate semantics, owned synchronous memo only; arbitrary inputs stay live.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const file=process.env.HAYAKU_TEST_PLUGIN||path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),source=fs.readFileSync(file,'utf8');
const start=source.indexOf('  const packetCoreRecallEntriesDuplicate ='),end=source.indexOf('  const CONTINUITY_EVIDENCE_LANES =',start);assert(start>0&&end>start);
const context=vm.createContext({assert});vm.runInContext(`
const localRecallBody=row=>[row.publicText,row.publicProfile].filter(value=>typeof value==='string').join('\\n').trim();
const localRecallSourceKey=row=>[row.packetHash||row.locator?.sourceHash||'',row.axis||'',row.id||row.publicRef||'',row.publicText||''].join('\\u0001');
${source.slice(start,end)}
globalThis.__original=packetCoreRecallEntriesDuplicate;
globalThis.__factory=typeof createPacketCoreRecallDuplicateComparator==='function'?createPacketCoreRecallDuplicateComparator:null;
globalThis.__token=typeof packetCoreRecallSignatureOwner==='object'?packetCoreRecallSignatureOwner:null;
`,context);
assert.equal(typeof context.__factory,'function','owned comparator factory must exist');
const results=vm.runInContext(`(()=>{
 let tests=0;const check=(condition,label)=>{assert(condition,label);tests++;};
 const row=(id,body='same',extra={})=>({id,axis:'world',publicText:body,visibility:{privacy:'public'},lifecycle:{status:'active'},locator:{messageIndex:3},...extra});
 const entry=row=>({row});const original=__original;
 // Exact comparator and collision-like input matrix. Deliberately equal declared hashes do not become authority.
 const rows=[row('a'),row('b'),row('c','different'),row('d','same',{axis:'narrative'}),row('e','same',{visibility:{privacy:'private'}}),row('f','same',{lifecycle:{status:'closed'}}),row('g','same',{locator:{sourcePairIndex:8,messageIndex:3}}),row('h','same',{packetHash:'same-declared-hash'}),row('i','same',{packetHash:'same-declared-hash'}),row('j','same',{publicProfile:'extra'}),row('k','same',{visibility:null,lifecycle:undefined}),row('l','same',{visibility:{b:1,a:2}}),row('m','same',{visibility:{a:2,b:1}})];
 const owned=__factory(__token);for(const left of rows)for(const right of rows)check(owned(entry(left),entry(right))===original(entry(left),entry(right)),'exact matrix');
 check(owned(null,entry(rows[0]))===false,'null left');check(owned({},entry(rows[0]))===false,'missing row');
 const fresh=__factory(__token),a=row('x'),b=row('y');check(fresh(entry(a),entry(b)),'initial duplicate');
 b.publicText='else';check(__factory(__token)(entry(a),entry(b))===original(entry(a),entry(b)),'fresh invocation after body mutation');
 b.publicText='same';b.visibility.privacy='private';check(__factory(__token)(entry(a),entry(b))===original(entry(a),entry(b)),'fresh invocation after nested mutation');
 // No private option means no caching even after arbitrary row mutation or transparent proxy traps.
 const external=__factory(),custom=__factory({}),u=row('u'),v=row('v');check(external(entry(u),entry(v)),'external initial');v.lifecycle.status='closed';check(external(entry(u),entry(v))===original(entry(u),entry(v)),'external live mutation');
 let getCount=0;const proxy=new Proxy(row('proxy'),{get(target,key,receiver){if(key==='publicText'){getCount++;return getCount%2?'same':'changed';}return Reflect.get(target,key,receiver);}});
 getCount=0;const expected=original(entry(u),entry(proxy));const expectedCount=getCount;getCount=0;check(external(entry(u),entry(proxy))===expected&&getCount===expectedCount,'arbitrary proxy remains original');
 getCount=0;check(custom(entry(u),entry(proxy))===expected&&getCount===expectedCount,'forged owner remains original');
 // An internal fallback row with an accessor/custom serializer is never retained; callbacks can reenter arbitrary route.
 let value='same',reentered=0;const accessor=row('accessor');Object.defineProperty(accessor,'publicText',{get(){reentered++;custom(entry(row('r1')),entry(row('r2')));return value;},enumerable:true});
 const mixed=__factory(__token);check(mixed(entry(u),entry(accessor))===original(entry(u),entry(accessor)),'accessor fallback');value='changed';check(mixed(entry(u),entry(accessor))===original(entry(u),entry(accessor)),'accessor remains live');check(reentered>0,'reentrant getter exercised');
 let status='active';const serialized=row('serializer');serialized.lifecycle={toJSON(){return {status};}};const mixed2=__factory(__token);check(mixed2(entry(u),entry(serialized))===original(entry(u),entry(serialized)),'custom serialization fallback');status='closed';check(mixed2(entry(u),entry(serialized))===original(entry(u),entry(serialized)),'custom serializer not memoized');
 const proto=Object.create({privacy:'public'}),protoRow=row('prototype','same',{visibility:proto});check(__factory(__token)(entry(u),entry(protoRow))===original(entry(u),entry(protoRow)),'custom prototype fallback');
 const affected=row('affected'),peer=row('peer'),scope=__factory(__token);check(scope(entry(affected),entry(peer)),'prime owned rows');const trigger=row('trigger');Object.defineProperty(trigger,'id',{get(){affected.publicText='changed by getter';return 'trigger';}});scope(entry(peer),entry(trigger));check(scope(entry(affected),entry(peer))===original(entry(affected),entry(peer)),'custom fallback disables memo after reentrant mutation');
 return {tests,accessorCalls:reentered};})()`,context);
console.log(JSON.stringify({test:'hayaku_signature_memo_runtime',...results}));
