'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname,'../plugins/LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const startMarker = '/* LIBRA CANONICAL STATE PIPELINE V3 START */';
const endMarker = '/* LIBRA CANONICAL STATE PIPELINE V3 PURE CORE END */';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start + startMarker.length);
assert.ok(start >= 0 && end > start, 'canonical/state v3 pure-core markers are required');
const pureCore = source.slice(start, end + endMarker.length);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const compact = (value, limit = 900) => string(value).slice(0, limit);
const stableStringify = value => JSON.stringify(value, Object.keys(asObject(value)).sort());
  const createTextHasher = () => {
    let hash = 2166136261;
    let length = 0;
    return {
      update(value) {
        const body = String(value ?? '');
        for (let idx = 0; idx < body.length; idx += 1) {
          hash ^= body.charCodeAt(idx);
          hash = Math.imul(hash, 16777619);
        }
        hash ^= 31;
        hash = Math.imul(hash, 16777619);
        length += body.length + 1;
        return this;
      },
      digest() { return `${(hash >>> 0).toString(16).padStart(8, '0')}:${length}`; }
    };
  };


    const digest = value => {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      const hasher = createTextHasher();
      hasher.update(serialized);
      return hasher.digest();
    };


const stableHash = value => digest(value).slice(0, 24);

const context = {
  Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Set, Map,
  structuredClone: globalThis.structuredClone,
  safeClone: clone, clone, asObject, isPlainObject,
  asArray, string, text: string, compact, digest, stableHash, stableStringify,
  STATE_OBSERVATION_SCHEMA: 'libra.state_observation.v2',
  ENTITY_REGISTRY_SCHEMA: 'libra.entity_registry.v2',
  CONTINUITY_STATE_SCHEMA: 'libra.continuity_state.v2',
  CONTINUITY_STATE_PROVENANCE_VERSION: 3,
  CONTINUITY_STATE_RELATION_DIMENSIONS: Object.freeze([
    'trust', 'affection', 'attraction', 'fear', 'obligation', 'hostility', 'distance',
    'cooperation', 'authority', 'dependency', 'knowledge', 'other'
  ]),
  CURRENT_NARRATIVE_STATE_SCHEMA: 'libra.narrative_current_state.v2',
  nowIso: () => '2026-09-01T00:00:00.000Z'
};
vm.createContext(context);
const binder = require('./fixtures/libra_legacy_state_cas_binder.cjs'); // Frozen input for the live legacy CAS consumer.
const ns = source.indexOf('    const normalizeCurrentNarrativeState =');
const ne = source.indexOf('    const emptyContinuityState =', ns);
assert.ok(ns >= 0 && ne > ns);
const narrativeNormalizer = source.slice(ns,ne);
vm.runInContext(`${pureCore}\n${narrativeNormalizer}\n${binder}\nthis.api = {
 bindStateObservationCas, normalizeCurrentNarrativeState,
  buildCanonicalEntityRegistry,
  normalizeStateObservation,
  applyVerifiedStateObservation,
  statePipelinePatchRequiresVerifier,
  statePipelineFutureFieldEvidenceEligible
};`, context, { filename: 'libra-canonical-state-v3-pure-core.js', timeout: 2000 });
const api = context.api;

const entities=[{id:'c_ada',type:'person',name:'Ada',validated:true,aliases:[]},{id:'c_bea',type:'person',name:'Bea',validated:true,aliases:[]},{id:'w_room',type:'world',name:'Room',kind:'location',validated:true,aliases:[]}];
const registry={schema:'libra.entity_registry.v2',scopeKey:'cas-test',entities,byId:Object.fromEntries(entities.map(e=>[e.id,e])),fingerprint:'registry-test'};
const head=()=>({schema:'libra.continuity_state.v2',scopeKey:'cas-test',worldlineId:'main',throughTurn:5,
 characters:[{id:'c_ada',name:'Ada',aliases:[],state:{location:'library',posture:'sitting'},fieldEvidence:{}},{id:'c_bea',name:'Bea',state:{location:'park'}}],
 world:[{id:'w_room',name:'Room',state:{weather:'cloudy'},fieldEvidence:{}}],relationships:[],
 narrative:clone(api.normalizeCurrentNarrativeState({summary:'A promise remains open.'})),domainStatus:{}});
const basis={scopeKey:'cas-test',worldlineId:'main',memoryId:'mem6',revision:1,sourceDigest:'s6',artifactDigest:'a6',turnRange:{start:6,end:10},entityRegistryFingerprint:registry.fingerprint};
const assertion={assertionId:'fact_a',domain:'character',certainty:'confirmed',temporalRole:'current_sequence',evidenceRefs:['t10-a'],evidenceSpans:[{ref:'t10-a',quote:'Ada entered the hallway and stood.'}]};
const patch=(id,set,extra={})=>({patchId:id,operation:'upsert',entityId:'c_ada',set,clear:[],evidenceByField:Object.fromEntries(Object.keys(set).map(k=>[k,{assertionIds:['fact_a']}])) ,...extra});
const observation=(patches,domain='character')=>({schema:'libra.state_observation.v2',domain,basis,reviews:[{entityId:'c_ada',outcome:'changed',assertionIds:['fact_a'],reviewedFields:[]}],patches,diagnostics:[]});
const apply=(base,obs,options={})=>api.applyVerifiedStateObservation(base,obs,registry,{assertions:[assertion],requireAssertionEvidence:true,verifierDecisions:{},...options});
let passed=0;
function test(name,run){run();passed++;console.log('PASS '+name);}
test('ST-01 same target split patches use one baseline',()=>{
 const base=head(),saved=clone(base),obs=observation([patch('move',{location:'hall'}),patch('stand',{posture:'standing'})]);
 const bound=api.bindStateObservationCas(obs,base,registry),r=apply(base,bound);
 assert.equal(r.atomicRejected,false);assert.equal(r.appliedPatches.length,2);assert.equal(r.head.characters[0].state.location,'hall');assert.equal(r.head.characters[0].state.posture,'standing');assert.deepEqual(base,saved);
});
test('ST-02 external record edit still rejects',()=>{
 const base=head(),bound=api.bindStateObservationCas(observation([patch('move',{location:'hall'}),patch('stand',{posture:'standing'})]),base,registry);
 base.characters[0].state.location='external';const r=apply(base,bound);assert.equal(r.atomicRejected,true);assert.equal(r.head.characters[0].state.location,'external');assert.ok(r.rejectedPatches.some(p=>p.code==='stale_record_hash'));
});
test('field token alone still detects real external changes',()=>{
 const base=head(),bound=api.bindStateObservationCas(observation([patch('move',{location:'hall'})]),base,registry);delete bound.patches[0].expectedRecordHash;
 base.characters[0].state.location='external';const r=apply(base,bound);assert.equal(r.atomicRejected,true);assert.ok(r.rejectedPatches.some(p=>p.code==='stale_field_hash:location'));
});
test('ST-05 untouched fields remain unchanged',()=>{const base=head(),r=apply(base,api.bindStateObservationCas(observation([patch('move',{location:'hall'})]),base,registry));assert.equal(r.head.characters[0].state.posture,'sitting');assert.deepEqual(r.head.characters[1],base.characters[1]);});
test('ST-07 same field incompatible values rejected, not last wins',()=>{const base=head(),r=apply(base,api.bindStateObservationCas(observation([patch('one',{location:'hall'}),patch('two',{location:'park'})]),base,registry));assert.equal(r.atomicRejected,true);assert.equal(r.head.characters[0].state.location,'library');assert.ok(r.rejectedPatches.every(p=>p.code==='state_patch_intra_job_conflict'));});
test('ST-07 set and clear collision rejected',()=>{const base=head(),r=apply(base,api.bindStateObservationCas(observation([patch('one',{location:'hall'}),patch('two',{}, {operation:'clear_fields',clear:['location'],evidenceByField:{location:{assertionIds:['fact_a']}}})]),base,registry),{verifierDecisions:{two:'approve'}});assert.equal(r.atomicRejected,true);assert.equal(r.head.characters[0].state.location,'library');});
test('ST-07 contradiction within one patch rejected',()=>{const base=head(),r=apply(base,api.bindStateObservationCas(observation([patch('one',{location:'hall'},{clear:['location']})]),base,registry));assert.equal(r.atomicRejected,true);});
test('equivalent same field proposals are idempotent',()=>{const base=head(),r=apply(base,api.bindStateObservationCas(observation([patch('one',{location:'hall'}),patch('two',{location:'hall'})]),base,registry));assert.equal(r.atomicRejected,false);assert.equal(r.appliedPatches.length,1);});
test('duplicate patch IDs rejected',()=>{const base=head(),r=apply(base,api.bindStateObservationCas(observation([patch('one',{location:'hall'}),patch('one',{posture:'standing'})]),base,registry));assert.equal(r.atomicRejected,true);});
test('unapproved future-shaping patch does not invalidate independent low-risk field',()=>{const base=head(),r=apply(base,api.bindStateObservationCas(observation([patch('move',{location:'hall'}),patch('wish',{goals:'sail away'})]),base,registry));assert.equal(r.atomicRejected,false);assert.equal(r.head.characters[0].state.location,'hall');assert.equal(r.head.characters[0].state.goals,undefined);assert.equal(r.rejectedPatches.length,1);});
test('world split patches use unchanged baseline',()=>{const base=head(),obs=observation([patch('one',{weather:'sunny'},{entityId:'w_room'}),patch('two',{availability:'open'},{entityId:'w_room'})],'world');const r=apply(base,api.bindStateObservationCas(obs,base,registry));assert.equal(r.atomicRejected,false);assert.equal(r.head.world[0].state.weather,'sunny');assert.equal(r.head.world[0].state.availability,'open');});
test('new relationship split patches not self-conflicted',()=>{const base=head(),extra={entityId:'',subjectId:'c_ada',targetId:'c_bea',dimension:'trust'};const obs=observation([patch('one',{value:'guarded'},extra),patch('two',{reason:'promise'},extra)],'relationship');const r=apply(base,api.bindStateObservationCas(obs,base,registry),{verifierDecisions:{one:'approve',two:'approve'}});assert.equal(r.atomicRejected,false);assert.equal(r.head.relationships.length,1);assert.equal(r.head.relationships[0].state.reason,'promise');});
test('directional relationships remain separate',()=>{const base=head(),obs=observation([patch('one',{value:'guarded'},{subjectId:'c_ada',targetId:'c_bea',dimension:'trust'}),patch('two',{value:'trusting'},{subjectId:'c_bea',targetId:'c_ada',dimension:'trust'})],'relationship');const r=apply(base,api.bindStateObservationCas(obs,base,registry),{verifierDecisions:{one:'approve',two:'approve'}});assert.equal(r.atomicRejected,false);assert.equal(r.head.relationships.length,2);assert.notEqual(r.head.relationships[0].id,r.head.relationships[1].id);});
test('narrative split fields use normalized baseline',()=>{const base=head(),obs=observation([patch('one',{summary:'A new promise is active.'}),patch('two',{momentum:'steady'})],'narrative');const r=apply(base,api.bindStateObservationCas(obs,base,registry),{verifierDecisions:{one:'approve',two:'approve'}});assert.equal(r.atomicRejected,false);assert.equal(r.head.narrative.summary,'A new promise is active.');assert.equal(r.head.narrative.momentum,'steady');});
console.log(JSON.stringify({test:'libra_state_baseline_cas_v1',passed,scope:'production binder + reducer, no provider or storage'}));
