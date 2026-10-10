'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const build = require('../tools/build_plugins.cjs');
assert.equal(typeof build.poolStaticPropertyKeys, 'function', 'release builder needs the verified static-key representation');

const repeated = (key, count = 12) => Array.from({ length: count }, () => `o.${key}`).join('+');
const execute = source => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context;
};
const plain = value => JSON.parse(JSON.stringify(value));
const results = [];
function test(name, source, check) {
  const result = build.poolStaticPropertyKeys(source);
  assert.equal(result.error, undefined, `${name}: ${result.error}`);
  check(result, execute(source), execute(result.src));
  results.push(name);
}

test('same-function aliases preserve exported standalone re-evaluation',
  `globalThis.exported=function(o){return ${repeated('canonicalArtifactDigest')};};globalThis.result=exported({canonicalArtifactDigest:3});`,
  (r, before, after) => {
    assert.ok(r.aliases > 0);assert.ok(r.bytesSaved > 0);assert.equal(after.result, before.result);
    const isolated = vm.runInNewContext(`(${after.exported.toString()})`);
    assert.equal(isolated({canonicalArtifactDigest:3}), before.result, 'serialized function carries every new key constant inside its own body');
  });
test('getter count, optional receiver, call this, delete and update preserve execution order',
  `(function(){'use strict';let calls=0,reads=0;const o={canonicalArtifactDigest:1,get sourceIdentityRevision(){reads++;return function(){calls++;return this.canonicalArtifactDigest;};}};
    const values=[o.sourceIdentityRevision(),o?.sourceIdentityRevision(),null?.sourceIdentityRevision(),${repeated('canonicalArtifactDigest')}];
    o.canonicalArtifactDigest++;o.canonicalArtifactDigest+=2;delete o.sourceIdentityRevision;
    globalThis.result={values,calls,reads,value:o.canonicalArtifactDigest,keys:Object.keys(o)};})();`,
  (r, before, after) => {assert.ok(r.aliases > 0);assert.deepEqual(plain(after.result),plain(before.result));});
const describedObject = '{canonicalArtifactDigest:1,sourceIdentityRevision:2,get worldlineRevisionDigest(){return stored;},set worldlineRevisionDigest(v){stored=v;},longCanonicalMethod(){return this.canonicalArtifactDigest;},anonymousCanonicalMethod:function(){return 4;},__proto__:null}';
test('ordinary object keys preserve enumeration, descriptors, getter/setter and inferred method names',
  `(function(){let o,stored=0;const copies=[${Array.from({length:12},()=>describedObject).join(',')}];
    o=copies[0];o.worldlineRevisionDigest=7;const total=${repeated('canonicalArtifactDigest')}+${repeated('sourceIdentityRevision')};
    globalThis.result={keys:Object.keys(o),total,proto:Object.getPrototypeOf(o),value:o.worldlineRevisionDigest,methodName:o.longCanonicalMethod.name,anonymousName:o.anonymousCanonicalMethod.name,
      getterName:Object.getOwnPropertyDescriptor(o,'worldlineRevisionDigest').get.name,setterName:Object.getOwnPropertyDescriptor(o,'worldlineRevisionDigest').set.name,
      descriptors:Object.entries(Object.getOwnPropertyDescriptors(o)).map(([key,v])=>({key,enumerable:v.enumerable,configurable:v.configurable,writable:v.writable}))};})();`,
  (r, before, after) => {assert.ok(r.aliases > 0);assert.ok(r.objectKeysReplaced > 0);assert.deepEqual(plain(after.result),plain(before.result));});
test('strict directive, default parameters, shadowed names and hoisted calls remain safe',
  `(function(){'use strict';let A=6;function exported(o={canonicalArtifactDigest:2},v=o.canonicalArtifactDigest){let B=3;const nested=()=>A+B;return [this,${repeated('canonicalArtifactDigest')},v,nested()];}
    globalThis.result=exported();globalThis.exported=exported;})();`,
  (r, before, after) => {assert.ok(r.aliases > 0);assert.deepEqual(plain(after.result),plain(before.result));assert.match(r.src,/v=o\.canonicalArtifactDigest/,'parameter-default lookup stays outside body aliases');});
for (const [name, body] of [
  ['eval', `const o={canonicalArtifactDigest:2};globalThis.result=eval('o.canonicalArtifactDigest');return ${repeated('canonicalArtifactDigest')};`],
  ['with', `const o={canonicalArtifactDigest:2};with(o){globalThis.result=canonicalArtifactDigest;}return ${repeated('canonicalArtifactDigest')};`],
  ['Function', `const o={canonicalArtifactDigest:2};globalThis.result=Function('return 2')();return ${repeated('canonicalArtifactDigest')};`]
]) test(`${name} scope is left unchanged`, `(function(){${body}})();`, (r,before,after)=>{assert.equal(r.src,`(function(){${body}})();`);assert.ok(r.skipped);assert.equal(after.result,before.result);});
test('observed function-source text remains byte-exact',
  `(function(){const exact=function(o){return ${repeated('canonicalArtifactDigest')};};globalThis.result=exact.toString();globalThis.value=exact({canonicalArtifactDigest:2});})();`,
  (r,before,after)=>{assert.equal(after.result,before.result);assert.equal(after.value,before.value);});
test('class and shorthand keys are untouched; public strings remain exact',
  `(function(){const canonicalArtifactDigest=3;class C{canonicalArtifactDigest(){return 1;}}const o={canonicalArtifactDigest,sourceIdentityRevision:'libra.canonical_artifact.v5'};
    globalThis.result={v:${repeated('canonicalArtifactDigest')},keys:Object.keys(o),method:new C().canonicalArtifactDigest(),schema:o.sourceIdentityRevision};})();`,
  (r,before,after)=>{assert.deepEqual(plain(after.result),plain(before.result));assert.ok(r.src.includes('{canonicalArtifactDigest,'));assert.ok(r.src.includes('class C{canonicalArtifactDigest()'));assert.ok(r.src.includes("'libra.canonical_artifact.v5'"));});
assert.equal(build.poolStaticPropertyKeys('const = broken').src,'const = broken','invalid input must never produce a new artifact');
for (const [name, setup, target] of [
  ['block shadow', `let f=function(o){return ${repeated('canonicalArtifactDigest')};};{let f=1;}`, 'f'],
  ['catch shadow', `let f=function(o){return ${repeated('canonicalArtifactDigest')};};try{throw 2;}catch(f){}`, 'f'],
  ['assignment alias', `function f(o){return ${repeated('canonicalArtifactDigest')};}let g;g=f;`, 'g'],
  ['destructured alias', `function f(o){return ${repeated('canonicalArtifactDigest')};}const {g}={g:f};`, 'g'],
  ['logical selection', `function f(o){return ${repeated('canonicalArtifactDigest')};}const g=true&&f;`, 'g'],
  ['expression arrow factory', `const factory=()=>function(o){return ${repeated('canonicalArtifactDigest')};};const g=factory();`, 'g'],
  ['template coercion', `function f(o){return ${repeated('canonicalArtifactDigest')};}const g=f;`, 'g'],
  ['callee reflection', `function f(o){globalThis.exact=arguments.callee.toString();return ${repeated('canonicalArtifactDigest')};}`, 'f']
]) test(`${name} function source stays byte-exact`,
  `(function(){${setup}globalThis.result=[${target}({canonicalArtifactDigest:2}),${target}.toString(),String(${target}),\`\${${target}}\`,''+${target},globalThis.exact];})();`,
  (r,before,after)=>assert.deepEqual(plain(after.result),plain(before.result)));
for (const [name, declaration, read] of [
  ['instance field', `class Exported{value=${repeated('canonicalArtifactDigest')};}`, 'new Exported().value'],
  ['static field', `class Exported{static value=${repeated('canonicalArtifactDigest')};}`, 'Exported.value'],
  ['method body', `class Exported{run(o){return ${repeated('canonicalArtifactDigest')};}}`, 'new Exported().run(o)']
]) test(`${name} class source is excluded`,
  `(function(){const o={canonicalArtifactDigest:2};${declaration}globalThis.exported=Exported;globalThis.result=[${read},Exported.toString()];})();`,
  (r,before,after)=>{
    assert.equal(r.aliases,0);assert.deepEqual(plain(after.result),plain(before.result));
    const isolated=vm.runInNewContext(`(${after.exported.toString()})`,{o:{canonicalArtifactDigest:2}});
    assert.equal(name==='instance field'?new isolated().value:name==='static field'?isolated.value:new isolated().run({canonicalArtifactDigest:2}),24);
  });
for (const [name, setup, expression] of [
  ['call', '', 'f.toString.call(f)'],['apply','','f.toString.apply(f,[])'],['bind','','f.toString.bind(f)()'],
  ['Reflect.apply','','Reflect.apply(f.toString,f,[])'],['extracted toString','const stringify=f.toString;','stringify.call(f)'],
  ['String alias','const stringify=String;','stringify(f)'],['computed key',"const key='toString';",'f[key]()'],
  ['bound String','const stringify=String.bind(null);','stringify(f)']
]) test(`${name} reflected source stays byte-exact`,
  `(function(){function f(o){return ${repeated('canonicalArtifactDigest')};}${setup}globalThis.result=${expression};})();`,
  (r,before,after)=>assert.equal(after.result,before.result));
for (const [name, setup, expression] of [
  ['global assigned member','globalThis.exported=f;','globalThis.exported.toString()'],
  ['object assigned member','const bag={};bag.render=f;','bag.render.toString()'],
  ['serializer argument','function serialize(value){return value.toString();}','serialize(f)'],
  ['prefilled String bind','','String.bind(null,f)()'],['String call','','String.call(null,f)'],['String apply','','String.apply(null,[f])']
]) test(`${name} indirect reflected source stays byte-exact`,
  `(function(){function f(o){return ${repeated('canonicalArtifactDigest')};}${setup}globalThis.result=${expression};})();`,
  (r,before,after)=>assert.equal(after.result,before.result));
test('method and accessor source prefixes re-evaluate without an outer key alias',
  `(function(){globalThis.exported={longCanonicalMethod(o){return ${repeated('canonicalArtifactDigest')};},get canonicalArtifactDigest(){const o={canonicalArtifactDigest:2};return ${repeated('canonicalArtifactDigest')};},set sourceIdentityRevision(v){const o={canonicalArtifactDigest:v};globalThis.value=${repeated('canonicalArtifactDigest')};}};})();`,
  (r,before,after)=>{
    assert.ok(r.aliases>0);
    const method=vm.runInNewContext(`({${after.exported.longCanonicalMethod.toString()}})`);
    const getter=vm.runInNewContext(`({${Object.getOwnPropertyDescriptor(after.exported,'canonicalArtifactDigest').get.toString()}})`);
    const setterContext=vm.createContext({});
    const setter=vm.runInContext(`({${Object.getOwnPropertyDescriptor(after.exported,'sourceIdentityRevision').set.toString()}})`,setterContext);
    assert.equal(method.longCanonicalMethod({canonicalArtifactDigest:2}),24);assert.equal(getter.canonicalArtifactDigest,24);
    setter.sourceIdentityRevision=2;assert.equal(setterContext.value,24);assert.equal(Object.getOwnPropertyDescriptor(after.exported,'sourceIdentityRevision').set.name,'set sourceIdentityRevision');
  });
const aliasChain=Array.from({length:16000},(_,i)=>`const alias${i}=${i?`alias${i-1}`:'f'};`).join('');
test('large actual-release alias graphs preserve reflection without call-stack recursion',
  `(function(){function f(o){return ${repeated('canonicalArtifactDigest')};}${aliasChain}globalThis.result=String(alias15999);})();`,
  (r,before,after)=>assert.equal(after.result,before.result));
for(const [name,first,expression] of [['computed reflection key',"'toString'",'f[alias15999]()'],['String coercer','String','alias15999(f)']]) {
  const chain=Array.from({length:16000},(_,i)=>`const alias${i}=${i?`alias${i-1}`:first};`).join('');
  test(`large ${name} graph preserves exact source`,
    `(function(){function f(o){return ${repeated('canonicalArtifactDigest')};}${chain}globalThis.result=${expression};})();`,
    (r,before,after)=>assert.equal(after.result,before.result));
}
console.log(JSON.stringify({test:'build_plugins_property_key_pool',passed:results.length,results}));
