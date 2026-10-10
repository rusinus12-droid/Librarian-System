'use strict';
// LIBRA manifest CAS (LIBRA_COMMIT_CONFLICT).
//
// THE DEFECT: `saveManifest` (LIBRA.js) was a WHOLE-DOCUMENT overwrite —
//
//     manifest.updatedAt = nowIso();
//     await storage.setJson(key.manifest(scope), manifest);     // no merge, no CAS
//
// so two writers that each loaded the manifest and later saved it would have the
// later save silently revert the earlier one's INDEPENDENT fields (inFlight, stats,
// failedBatches, branchGuard, worldlineMeta, portableImports, inheritedMemories).
// Flashback's equivalent (`saveScopeManifestCore`) compares a MANIFEST_STORAGE_READ
// basis and throws FLASHBACK_COMMIT_CONFLICT; LIBRA had no such guard.
//
// THE FIX: `loadManifest` stamps a symbol-keyed basis carrying the manifest's
// write-revision; `saveManifest` refuses to publish when another in-plugin writer
// has committed the same key since, throwing LIBRA_COMMIT_CONFLICT (not retried —
// replaying a stale document is the lost update).
//
// This test drives the real functions via the plugin slice, then:
//   1. proves a STALE document is rejected (the lost update is impossible), and
//   2. proves a FRESH document still commits (the guard is not a blanket refusal).
//
// RED: LIBRA_TEST_PLUGIN=<pre-fix LIBRA.js> — the stale write is ACCEPTED and the
// other writer's field is silently reverted, so the assertion FAILS.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const targetPath = process.env.LIBRA_TEST_PLUGIN
  ? path.resolve(process.env.LIBRA_TEST_PLUGIN)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(targetPath, 'utf8');

const MANIFEST_SCHEMA = 'libra.manifest.v1';
const SCOPE_KEY = 'cas-scope';
const MANIFEST_KEY = `libra:v1:scope:${SCOPE_KEY}:manifest`;

// Evaluate the load/save pair plus the helpers they need.
const startMarker = 'const safeManifestBasis';
const endMarker = 'const WORLD_ADDITIONAL_REMOVAL_MIGRATION_KEY';
let start = source.indexOf(startMarker);
let end = source.indexOf(endMarker, start);
// loadManifest/saveManifest live ABOVE that marker, so slice a wider window around them.
const loadAt = source.indexOf('const loadManifest = async (');
const saveAt = source.indexOf('const saveManifest = async (scope, manifest) =>');
assert.ok(loadAt >= 0 && saveAt > loadAt, 'loadManifest/saveManifest must be locatable');
const saveEnd = source.indexOf('const WORLD_ADDITIONAL_REMOVAL_MIGRATION_KEY', saveAt);
assert.ok(saveEnd > saveAt, 'saveManifest end marker');
const core = source.slice(loadAt, saveEnd);
// The basis helpers + schema constants.
const helperStart = source.indexOf('const MANIFEST_SCHEMA =');
const helperEnd = source.indexOf('const HOST_WORLDLINE_META_SCHEMA', helperStart);
const helpers = source.slice(helperStart, helperEnd);
const normalizeStartMarker = 'const normalizeManifestReadSnapshot =';
const normalizeEndMarker = 'const loadManifest = async (';
const normalizeStart = source.indexOf(normalizeStartMarker);
const normalizeEnd = source.indexOf(normalizeEndMarker, normalizeStart + normalizeStartMarker.length);
assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, 'normalizeManifestReadSnapshot must be locatable');
const manifestNormalizer = source.slice(normalizeStart, normalizeEnd);

const values = new Map();
const rawStore = {
  async getItem(key) { const k = String(key); return values.has(k) ? values.get(k) : null; },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return Array.from(values.keys()); }
};
let failVerifiedRead177 = false;
const storage = {
  async getVerifiedJson(key, owner, fallback = null) { if (failVerifiedRead177) throw Error("verified read failure177"); return this.getStoredJson(key, fallback); },
  async getStoredJson(key, fallback = null) {
    const raw = await rawStore.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    try { return JSON.parse(String(raw)); } catch (_) { return fallback; }
  },
  async getJson(key, fallback = null) { return await this.getStoredJson(key, fallback); },
  async setJson(key, value) { return await rawStore.setItem(key, JSON.stringify(value)); },
  async keys() { return await rawStore.keys(); },
  async remove(key) { return await rawStore.removeItem(key); }
};

const nowIso = () => new Date().toISOString();
const string = value => String(value ?? '').trim();
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const stableDraftHash = value => `h${String(value).length}:${String(value).slice(0, 16)}`;
const key = { manifest: scope => `libra:v1:scope:${scope.scopeKey || scope}:manifest` };
const scope = { scopeKey: SCOPE_KEY, characterId: 'cas-char', chatId: 'cas-chat' };
const PREFIX = 'libra:v1';

const context = vm.createContext({
  storage, nowIso, string, asObject, asArray, clone, stableDraftHash, key, PREFIX,
  MANIFEST_SCHEMA,
  hostWorldlineIdForScope: () => 'cas-worldline',
  HOST_WORLDLINE_META_SCHEMA: 'libra.worldline_meta.v1',
  // Stubs for the normalizers used inside load/save.
  normalizeHostWorldlineMeta: value => ({ schema: 'libra.worldline_meta.v1', ...asObject(value), scopeKey: SCOPE_KEY }),
  defaultHostWorldlineMeta: (s, createdAt) => ({ schema: 'libra.worldline_meta.v1', scopeKey: s?.scopeKey || SCOPE_KEY, createdAt }),
  historicalHostWorldlineMetaFromNativeCopy: () => null,
  normalizeBranchGuard: value => asObject(value),
  normalizeFailedCanonicalBatches: value => asObject(value),
  normalizeLibraArchiveRef: value => value || null,
  refreshCanonicalFrontiers: () => {},
  defaultManifest: (s, observedTurn) => ({
    schema: MANIFEST_SCHEMA, scopeKey: s?.scopeKey || SCOPE_KEY, characterId: 'cas-char', chatId: 'cas-chat',
    version: 'test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    worldlineMeta: { schema: 'libra.worldline_meta.v1', scopeKey: s?.scopeKey || SCOPE_KEY, worldlineId:'cas-worldline' },
    frontiers: { observedTurn, committedTurn: 0, contiguousCommittedTurn: 0, firstGapStartTurn: 0, contiguousMemoryCount: 0 },
    branchGuard: {}, memories: {}, inheritedMemories: [], archiveRef: null, runIds: [],
    inFlight: null, failedBatches: {},
    stats: { commits: 0, failures: 0, ariadneFailures: 0, itoFailures: 0, partialCommits: 0, staleDiscards: 0, recalls: 0, embeddings: 0, handoffImports: 0 }
  }),
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, Promise, Set, Map, JSON, Object, Array, Number, Math, Error, Date
});

vm.runInContext(`${helpers}\n${manifestNormalizer}\n${core}\nthis.loadManifest = loadManifest;\nthis.saveManifest = saveManifest;`, context, {
  filename: 'LIBRA-manifest-cas.js'
});


(async()=>{
 const {loadManifest,saveManifest}=context;const results=[];
 async function check(name,fn){try{await fn();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:String(error.stack||error)});}}
 await check('required existing manifest rejects physical absence',async()=>{
  values.clear();await assert.rejects(()=>loadManifest(scope,12,{requireExisting:true}),e=>e?.code==='LIBRA_MANIFEST_DURABLE_RELOAD_UNAVAILABLE');assert.equal(values.size,0);
 });
 await check('ordinary first manifest creation remains available',async()=>{values.clear();const fresh=await loadManifest(scope,12);fresh.freshControl='kept';await saveManifest(scope,fresh);assert.equal(JSON.parse(values.get(MANIFEST_KEY)).freshControl,'kept');});
 await check('required existing manifest reads current owner bytes',async()=>{const found=await loadManifest(scope,12,{requireExisting:true});assert.equal(found.freshControl,'kept');});
 await check('required existing manifest rejects foreign owner',async()=>{const old=values.get(MANIFEST_KEY),foreign={...JSON.parse(old),characterId:'foreign'};values.set(MANIFEST_KEY,JSON.stringify(foreign));try{await assert.rejects(()=>loadManifest(scope,12,{requireExisting:true}),e=>e?.code==='LIBRA_MANIFEST_DURABLE_RELOAD_UNAVAILABLE');assert.equal(values.get(MANIFEST_KEY),JSON.stringify(foreign));}finally{values.set(MANIFEST_KEY,old);}});
 await check('required existing manifest cannot turn read failure into empty owner',async()=>{const old=values.get(MANIFEST_KEY);failVerifiedRead177=true;try{await assert.rejects(()=>loadManifest(scope,12,{requireExisting:true}),/verified read failure177/);assert.equal(values.get(MANIFEST_KEY),old);}finally{failVerifiedRead177=false;}});
 console.log(JSON.stringify({test:'libra_required_manifest_reload',passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,results},null,2));process.exitCode=results.some(r=>!r.ok)?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
