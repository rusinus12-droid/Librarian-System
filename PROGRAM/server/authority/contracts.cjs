'use strict';
const { createHash } = require('node:crypto');
const OWNERS = Object.freeze(['libra', 'hayaku', 'flashback', 'lia', 'retrace']);
const CONTRACT = 'memory-suite.server-authority.v1';
const SCHEMA_VERSION = 1;
// OWNERS/CONTRACT/SCHEMA_VERSION remain the historical five-owner v1 codec.
// New core3 preparation must select its versioned profile explicitly.
const CORE3_OWNERS = Object.freeze(['libra', 'hayaku', 'flashback']);
const LEGACY_AUTHORITY_PROFILE = 'memory-suite.authority-profile.legacy5.v1';
const CORE3_AUTHORITY_PROFILE = 'memory-suite.authority-profile.core3.v2';
const PROFILES = Object.freeze({
  [LEGACY_AUTHORITY_PROFILE]: Object.freeze({ id:LEGACY_AUTHORITY_PROFILE, owners:OWNERS, contract:CONTRACT, schemaVersion:1, marker:'memory-suite.server-authority-activation.v1', qualificationContract:'memory-suite.initial-owner-qualification.v1', qualificationScope:'isolated-owner-backend.v1' }),
  [CORE3_AUTHORITY_PROFILE]: Object.freeze({ id:CORE3_AUTHORITY_PROFILE, owners:CORE3_OWNERS, contract:'memory-suite.server-authority.v2', schemaVersion:2, marker:'memory-suite.server-authority-activation.v2', qualificationContract:'memory-suite.initial-owner-qualification.v2', qualificationScope:'isolated-core3-owner-backend.v2' })
});
function authorityProfile(value = LEGACY_AUTHORITY_PROFILE) { if(typeof value!=='string'||!Object.hasOwn(PROFILES,value))fail('INVALID_AUTHORITY_PROFILE');return PROFILES[value]; }
function markerProfile(marker) {
  if(marker?.schema===PROFILES[LEGACY_AUTHORITY_PROFILE].marker&&!Object.hasOwn(marker,'authorityProfile'))return PROFILES[LEGACY_AUTHORITY_PROFILE];
  if(marker?.schema===PROFILES[CORE3_AUTHORITY_PROFILE].marker&&marker.authorityProfile===CORE3_AUTHORITY_PROFILE)return PROFILES[CORE3_AUTHORITY_PROFILE];
  fail('AUTHORITY_QUARANTINED');
}
function witnessProfile(witness) {
  if(witness?.contract===CONTRACT&&!Object.hasOwn(witness,'authorityProfile'))return PROFILES[LEGACY_AUTHORITY_PROFILE];
  if(witness?.contract===PROFILES[CORE3_AUTHORITY_PROFILE].contract&&witness.authorityProfile===CORE3_AUTHORITY_PROFILE)return PROFILES[CORE3_AUTHORITY_PROFILE];
  fail('AUTHORITY_QUARANTINED');
}
function profileNamespace(value, profileId) { const profile=authorityProfile(profileId);if(!profile.owners.includes(value))fail('AUTHORITY_OWNER_NOT_IN_PROFILE');return value; }
const OWNER_SCHEMA_VERSION = 3;
const OWNER_RECEIPT_CONTRACT = 'memory-suite.owner-write-receipt.v2';
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function canonical(value) {
  const seen = new Set(); let nodes = 0;
  function encode(v, depth) {
    if (++nodes > 65536 || depth > 32) fail('INVALID_AUTHORITY_JSON');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) fail('INVALID_AUTHORITY_JSON'); return JSON.stringify(v); }
    if (typeof v === 'string') { if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) fail('INVALID_AUTHORITY_JSON'); return JSON.stringify(v); }
    if (!v || typeof v !== 'object' || seen.has(v)) fail('INVALID_AUTHORITY_JSON');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (!array && proto !== Object.prototype && proto !== null) fail('INVALID_AUTHORITY_JSON');
    if (Object.getOwnPropertySymbols(v).length) fail('INVALID_AUTHORITY_JSON');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const [key, d] of Object.entries(descriptors)) if ('get' in d || 'set' in d || (!d.enumerable && !(array && key === 'length'))) fail('INVALID_AUTHORITY_JSON');
    seen.add(v); let out;
    if (array) {
      if (Object.keys(v).length !== v.length) fail('INVALID_AUTHORITY_JSON');
      for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, String(i))) fail('INVALID_AUTHORITY_JSON');
      out = '[' + v.map(x => encode(x, depth + 1)).join(',') + ']';
    } else out = '{' + Object.keys(v).sort().map(k => encode(k, depth + 1) + ':' + encode(v[k], depth + 1)).join(',') + '}';
    seen.delete(v); return out;
  }
  const result = encode(value, 0); if (Buffer.byteLength(result) > 1048576) fail('INVALID_AUTHORITY_JSON'); return result;
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(canonical(value));
function boundedInteger(value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_AUTHORITY_INTEGER'); return value; }
function increment(value) { boundedInteger(value); if (value === MAX_COUNTER) fail('COUNTER_EXHAUSTED'); return value + 1; }
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,240}$/.test(value)) fail('INVALID_AUTHORITY_ID'); return value; }
function namespace(value) { if (!OWNERS.includes(value)) fail('INVALID_AUTHORITY_OWNER'); return value; }
function operationKey(value) { if (!value || typeof value !== 'object') fail('INVALID_OPERATION'); return { generation:identifier(value.generation), namespace:namespace(value.namespace), operationId:identifier(value.operationId) }; }
function physicalBinding(value) { if (!value || typeof value !== 'object') fail('INVALID_PHYSICAL_BINDING'); const result = { dataInstanceId:identifier(value.dataInstanceId), dataIdentityContract:value.dataIdentityContract, controlStoreId:identifier(value.controlStoreId) }; if (result.dataIdentityContract !== 'memory-suite.physical-data-identity.v1') fail('INVALID_PHYSICAL_BINDING'); return result; }
function intent(value) {
  const result = { ...operationKey(value), fingerprint:value.fingerprint, operationClass:value.operationClass };
  if (!/^[a-f0-9]{64}$/.test(result.fingerprint || '') || !['kv','batch','maintenance','fence'].includes(result.operationClass)) fail('INVALID_OPERATION');
  if (value.expectedRoute !== undefined) result.expectedRoute = clone(value.expectedRoute);
  return result;
}
function synchronous(work) { if (typeof work !== 'function' || ['AsyncFunction','AsyncGeneratorFunction','GeneratorFunction'].includes(work.constructor?.name)) fail('ASYNC_AUTHORITY_WORK'); }
function noPromise(result) { if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('ASYNC_AUTHORITY_WORK'); } return result; }
module.exports = { OWNERS, CONTRACT, SCHEMA_VERSION, CORE3_OWNERS, LEGACY_AUTHORITY_PROFILE, CORE3_AUTHORITY_PROFILE, authorityProfile, markerProfile, witnessProfile, profileNamespace, OWNER_SCHEMA_VERSION, MAX_COUNTER, OWNER_RECEIPT_CONTRACT, fail, canonical, hash, clone, boundedInteger, increment, identifier, namespace, operationKey, physicalBinding, intent, synchronous, noPromise };
