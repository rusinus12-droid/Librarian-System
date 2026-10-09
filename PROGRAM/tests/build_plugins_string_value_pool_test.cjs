'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');
const builder=require('../tools/build_plugins.cjs');
const repeated=(value,count=12)=>Array.from({length:count},()=>JSON.stringify(value)).join(',');
const execute=source=>{const context=vm.createContext({});vm.runInContext(source,context);return context;};
const plain=value=>JSON.parse(JSON.stringify(value));
const results=[];
function test(name,source,check){const pooled=builder.poolStaticPropertyKeys(source);assert.equal(pooled.error,undefined,name);const before=execute(source),after=execute(pooled.src);check(pooled,before,after,source);results.push(name);}

test('repeated runtime values reuse exact strings inside their own function',
 `(function(){globalThis.result=[${repeated('libra.canonical_artifact.v5')}];})();`,
 (r,before,after)=>{assert.ok(r.literalValuesReplaced>0,'VALUE string sites need a verified representation');assert.ok(r.bytesSaved>0);assert.deepEqual(plain(after.result),plain(before.result));});

for(const value of ['prompt: return exact JSON with canonical source identity','schema\u0000with\nline\tand"quotes"\\slash','\ud800','\udfff','\ud800\udfff','\u2028\u2029','__proto__','constructor','toString'])
 test(`exact UTF16 value ${JSON.stringify(value)}`,
  `(function(){const rows=[${repeated(value,24)}];globalThis.result={rows,lengths:rows.map(x=>x.length),units:rows.map(x=>Array.from({length:x.length},(_,i)=>x.charCodeAt(i))),json:JSON.stringify(rows)};})();`,
  (r,before,after)=>{assert.ok(r.literalValuesReplaced>0);assert.deepEqual(plain(after.result),plain(before.result));});

test('prompts, JSON, throw messages and optional calls preserve value and ordering',
 `(function(){const events=[];const receiver={receive(x){events.push(['call',this===receiver,x]);return x;}};
  const values=[${Array.from({length:8},()=>`receiver?.receive('canonical prompt value with exact profile')`).join(',')}];
  null?.receive('canonical prompt value with exact profile');let thrown;try{throw new Error('canonical prompt value with exact profile');}catch(error){thrown=error.message;}
  globalThis.result={events,values,thrown,json:JSON.stringify({schema:'canonical prompt value with exact profile',prompt:'canonical prompt value with exact profile'})};})();`,
 (r,before,after)=>{assert.ok(r.literalValuesReplaced>0);assert.deepEqual(plain(after.result),plain(before.result));});

test('Proxy getter, setter, delete and receiver order stay unchanged',
 `(function(){const events=[];const target={value:1,call(x){events.push(['this',this===proxy]);return x;}};const proxy=new Proxy(target,{get(o,k,r){events.push(['get',k]);return Reflect.get(o,k,r);},set(o,k,v,r){events.push(['set',k,v]);return Reflect.set(o,k,v,r);},deleteProperty(o,k){events.push(['delete',k]);return Reflect.deleteProperty(o,k);}});
  const values=[${Array.from({length:8},()=>`proxy.call('exact proxy payload value')`).join(',')}];proxy.value='exact proxy payload value';delete proxy.value;
  globalThis.result={values,events};})();`,
 (r,before,after)=>{assert.ok(r.literalValuesReplaced>0);assert.deepEqual(plain(after.result),plain(before.result));});

test('strict directives, default parameters, hoisted calls and standalone closures',
 `"use strict";globalThis.exported=function exported(value='preserved parameter value'){const A='original local';function nested(){"use strict";return [${repeated('standalone nested payload')}];}return {values:[${repeated('standalone outer payload')}],nested:nested(),value,A};};globalThis.result=exported();`,
 (r,before,after)=>{assert.ok(r.literalValuesReplaced>0);assert.deepEqual(plain(after.result),plain(before.result));assert.ok(r.src.includes("value='preserved parameter value'"));assert.ok(r.src.includes('"use strict";'));
  const standalone=vm.runInNewContext(`(${after.exported.toString()})`);assert.deepEqual(plain(standalone()),plain(before.result));assert.equal(after.exported.name,before.exported.name);assert.equal(after.exported.length,before.exported.length);});

test('observed function source and borrowed source reflection remain byte-exact',
 `(function(){function f(){return [${repeated('function source exact literal payload')}];}const bag={};bag.render=f;function serialize(value){return value.toString();}globalThis.result=[bag.render.toString(),serialize(f),String.call(null,f),f()];})();`,
 (r,before,after)=>{assert.deepEqual(plain(after.result),plain(before.result));assert.equal(r.literalValuesReplaced||0,0);});

test('object, member and computed-expression key subtrees are excluded',
 `(function(){const objects=[${Array.from({length:12},()=>`{'literal-key-that-stays-raw':1,['computed-'+'key-that-stays-raw']:2}`).join(',')}];const o=objects[0];globalThis.result=[${Array.from({length:12},()=>`o['literal-key-that-stays-raw']+o['computed-'+'key-that-stays-raw']`).join(',')}];})();`,
 (r,before,after,source)=>{assert.equal(r.literalValuesReplaced||0,0);const expected=source.replace('(function(){','(function(){let A="literal-key-that-stays-raw";').replaceAll("'literal-key-that-stays-raw':1",'[A]:1');assert.equal(r.src,expected);assert.deepEqual(plain(after.result),plain(before.result));});

test('class bodies and field initializers are excluded',
 `(function(){class C{field=[${repeated('class field exact payload')}];static other=[${repeated('class static exact payload')}];method(){return [${repeated('class method exact payload')}];}}globalThis.result=[new C().field,C.other,new C().method()];})();`,
 (r,before,after)=>{assert.equal(r.literalValuesReplaced||0,0);assert.deepEqual(plain(after.result),plain(before.result));});

test('template and tagged-template expression literals are excluded',
 `(function(){const tag=(parts,...values)=>[parts.raw,values];globalThis.result=[${Array.from({length:12},()=> '`raw\n${"template expression exact payload"}`').join(',')},tag\`raw\\n\${"template expression exact payload"}\`];})();`,
 (r,before,after)=>{assert.equal(r.literalValuesReplaced||0,0);assert.deepEqual(plain(after.result),plain(before.result));});

test('expression arrows and parameter literal values are excluded',
 `const f=()=>[${repeated('expression arrow exact payload')}];function g(a='parameter exact payload',b='parameter exact payload',c='parameter exact payload'){return [a,b,c];}globalThis.result=[f(),g()];`,
 (r,before,after)=>{assert.equal(r.literalValuesReplaced||0,0);assert.deepEqual(plain(after.result),plain(before.result));});

test('delete literal operands keep their value-expression semantics',
 `(function(){globalThis.result=[${Array.from({length:12},()=>`delete 'literal delete expression payload'`).join(',')}];})();`,
 (r,before,after)=>{assert.equal(r.literalValuesReplaced||0,0);assert.deepEqual(plain(after.result),plain(before.result));});

test('strict delete literal stays valid while ordinary copies remain pooled',
 `(function(){"use strict";globalThis.result=[delete 'strict literal delete payload',${repeated('strict literal delete payload')}];})();`,
 (r,before,after)=>{assert.ok(r.literalValuesReplaced>0);assert.ok(r.src.includes("delete 'strict literal delete payload'"));assert.deepEqual(plain(after.result),plain(before.result));});

test('compact keyword boundaries keep return, throw, typeof, in and case tokens apart',
 `globalThis.exported=function(o){switch(o){case"exact keyword payload":break;}let e;try{throw"exact keyword payload";}catch(x){e=x;}return[${repeated('exact keyword payload')},typeof"exact keyword payload","exact keyword payload"in{} ,e];};globalThis.result=exported('exact keyword payload');`,
 (r,before,after)=>{assert.ok(r.literalValuesReplaced>0);assert.deepEqual(plain(after.result),plain(before.result));});

test('null prototype data values and parsed key offsets invert without collisions',
 `(function(){const rows=[${Array.from({length:12},()=>`{__proto__:null,'long data key': 'long data value'}`).join(',')}];globalThis.result=rows.map(x=>[Object.getPrototypeOf(x)===null,Object.keys(x),x['long data key']]);})();`,
 (r,before,after)=>{assert.ok(r.literalValuesReplaced>0);assert.deepEqual(plain(after.result),plain(before.result));});

test('computed accessor descriptor source remains byte-exact',
 `(function(){const o={get ['run'](){return [${repeated('computed getter source exact payload')}];}};const getter=Object.getOwnPropertyDescriptor(o,'run').get;globalThis.result=[getter.toString(),o.run];})();`,
 (r,before,after)=>{assert.equal(r.literalValuesReplaced||0,0);assert.deepEqual(plain(after.result),plain(before.result));});

for(const descriptor of ["const d=Object.getOwnPropertyDescriptor(o,'run');const getter=d.get;", "const key='run';const getter=Object.getOwnPropertyDescriptor(o,key).get;", "const getter=Object['getOwnPropertyDescriptor'](o,'run')['get'];"])
 test(`all accessor scopes preserved through ${descriptor}`,
  `(function(){const o={get ['run'](){function nested(){return [${repeated('accessor descendant literal payload')}];}return [${repeated('accessor body literal payload')},nested()];}};${descriptor}globalThis.result=[getter.toString(),o.run];})();`,
  (r,before,after)=>{assert.equal(r.literalValuesReplaced||0,0);assert.deepEqual(plain(after.result),plain(before.result));});

for(const [name,body] of [['eval',"eval('1')"],['Function',"Function('return 1')()"],['with',"with({a:1}){}"]]) {
 const source=`(function(){${body};globalThis.result=[${repeated('dynamic scope exact payload')}];})();`;
 test(`${name} leaves the whole source unchanged`,source,(r,before,after)=>{assert.equal(r.src,source);assert.ok(r.skipped);assert.deepEqual(plain(after.result),plain(before.result));});
}
console.log(JSON.stringify({test:'build_plugins_string_value_pool',passed:results.length,results}));
