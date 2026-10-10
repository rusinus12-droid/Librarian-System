'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const section = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const neutralizeSource = section(
  'const scopeNeutralizeManualStateDispositionPatch =',
  'const manualStateDispositionPatchIsScopeNeutral ='
);
const saveDispositionSource = section(
  'const saveCanonicalManualStateDisposition = async',
  'const saveContinuityOverride = async'
);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const continuityStateNameKey = value => string(value).normalize('NFKC').toLocaleLowerCase();
const digest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value ?? null))
  .digest('hex');

const helperContext = { Object, Array, String, Number, Boolean, JSON, Map, Set, clone, asObject, asArray, string, continuityStateNameKey };
vm.createContext(helperContext);
vm.runInContext(`${neutralizeSource}\nthis.neutralize = scopeNeutralizeManualStateDispositionPatch;`, helperContext,
  { filename: 'libra-manual-scope-neutralizer.js', timeout: 2000 });

const headAtT5 = {
  throughTurn: 5,
  characters: [
    { id: 'char_alice', name: 'Alice', aliases: ['Al', 'Shared'] },
    { id: 'char_amy', name: 'Amy', aliases: ['Aim', 'Shared'] }
  ],
  relationships: [],
  world: [
    { id: 'world_home', name: 'Home', aliases: ['Base', 'Shared Place'], kind: 'location' },
    { id: 'world_ship', name: 'Ship', aliases: ['Vessel', 'Shared Place'], kind: 'location' }
  ],
  narrative: { summary: 'T5 state' }
};
const headAtT10 = clone(headAtT5);
headAtT10.throughTurn = 10;
headAtT10.characters.push({ id: 'char_future', name: 'Future', aliases: ['Tomorrow'] });

const failures = [];
const expectScopeReject = (name, patch) => {
  let error = null;
  try { helperContext.neutralize({ patch: clone(patch), head: clone(headAtT5) }); }
  catch (caught) { error = caught; }
  if (!error) failures.push(`scope-neutralization accepted ${name}`);
};

expectScopeReject('character id/name mismatch', {
  characters: [{ id: 'char_alice', name: 'Amy', state: { mood: 'wrong target' } }]
});
expectScopeReject('relationship subject id/name mismatch', {
  relationships: [{
    subjectId: 'char_alice', subjectName: 'Amy',
    targetId: 'char_amy', targetName: 'Amy', state: 'wrong subject'
  }]
});
expectScopeReject('relationship target id/name mismatch', {
  relationships: [{
    subjectId: 'char_alice', subjectName: 'Alice',
    targetId: 'char_amy', targetName: 'Alice', state: 'wrong target'
  }]
});
expectScopeReject('world id/name mismatch', {
  world: [{ id: 'world_home', name: 'Ship', kind: 'location', state: { open: false } }]
});
expectScopeReject('ambiguous character alias', {
  characters: [{ name: 'Shared', state: { mood: 'ambiguous' } }]
});
expectScopeReject('ambiguous relationship alias', {
  relationships: [{ subjectName: 'Shared', targetName: 'Amy', state: 'ambiguous' }]
});
expectScopeReject('ambiguous world alias', {
  world: [{ name: 'Shared Place', kind: 'location', state: { open: false } }]
});

const exact = clone(helperContext.neutralize({
  patch: {
    characters: [{ id: 'char_alice', name: 'Alice', state: { mood: 'steady' } }],
    relationships: [{
      subjectId: 'char_alice', subjectName: 'Alice',
      targetId: 'char_amy', targetName: 'Amy', state: 'trusted'
    }],
    world: [{ id: 'world_home', name: 'Home', kind: 'location', state: { open: true } }]
  },
  head: headAtT5
}));
assert.equal(Object.hasOwn(exact.characters[0], 'id'), false);
assert.equal(exact.characters[0].name, 'Alice');
assert.equal(Object.hasOwn(exact.relationships[0], 'subjectId'), false);
assert.equal(Object.hasOwn(exact.relationships[0], 'targetId'), false);
assert.equal(exact.relationships[0].subjectName, 'Alice');
assert.equal(exact.relationships[0].targetName, 'Amy');
assert.equal(Object.hasOwn(exact.world[0], 'id'), false);
assert.equal(exact.world[0].name, 'Home');

let prefixReject = null;
try {
  helperContext.neutralize({
    patch: { characters: [{ id: 'char_future', name: 'Future', state: { mood: 'not yet present' } }] },
    head: headAtT5
  });
} catch (error) { prefixReject = error; }
assert.match(String(prefixReject?.message || prefixReject), /canonical_manual_state_disposition_character_id_unbound/,
  'the fixture proves that the exact T5 prefix Head rejects a T10-only entity');

const scope = { scopeKey: 'scope:manual-anchor' };
const candidateKey = 'memory:manual-anchor:t1:r2';
const candidate = {
  schema: 'libra.canonical_memory.v1', status: 'candidate', scopeKey: scope.scopeKey,
  memoryId: 'mem_t1_manual', revision: 2, sourceDigest: 'source-t1',
  turnRange: { start: 1, end: 5 }, text: 'manual T5',
  manualAuthority: { contentHash: 'content-t5', authorityHash: 'authority-t5' }
};
const variant = { variantId: 'variant-t1-manual', key: candidateKey, origin: 'manual_edit', status: 'candidate' };
let job = {
  schema: 'libra.canonical_job.v1', jobId: 'job-t1-manual', state: 'awaiting_choice',
  candidateId: variant.variantId, comparison: { candidate: { key: candidateKey } }
};
const manifest = {
  schema: 'libra.manifest.v1', scopeKey: scope.scopeKey,
  memories: {
    1: { key: 'memory:t1:r1', status: 'committed', turnRange: { start: 1, end: 5 } },
    6: { key: 'memory:t6:r1', status: 'committed', turnRange: { start: 6, end: 10 } }
  },
  inheritedMemories: []
};
let storedCandidate = clone(candidate);
let candidateWrites = 0;
const saveContext = {
  Object, Array, String, Number, Boolean, JSON, Map, Set,
  clone, asObject, asArray, string, continuityStateNameKey,
  assertPortableMemoryIdle: () => {},
  enqueue: async (_scopeKey, task) => await task(),
  resolveContext: async () => ({ scope, chat: { message: [] } }),
  loadCanonicalJob: async () => clone(job),
  buildPairs: () => [],
  loadManifest: async () => clone(manifest),
  findCanonicalVariant: async () => ({ variant: clone(variant) }),
  storage: {
    getJson: async key => String(key) === candidateKey ? clone(storedCandidate) : null,
    setJson: async (key, value) => {
      assert.equal(String(key), candidateKey);
      candidateWrites += 1;
      storedCandidate = clone(value);
    }
  },
  validateCanonicalManualAuthority: () => true,
  loadContinuityState: async () => clone(headAtT10),
  // These are deliberately available as implementation-neutral prefix seams.
  // A source repair may use one of them; every seam returns the T5 Head.
  loadCanonicalPrefixContinuityState: async () => clone(headAtT5),
  loadManualStateDispositionAnchorHeads: async () => ({ beforeTargetHead: clone(headAtT5), throughOriginalTargetHead: clone(headAtT5) }),
  assertManualStateDispositionAnchorCas: async () => true,
  rebuildCurrentStateForWorldlineUnlocked: async () => ({ ok: true, head: clone(headAtT5) }),
  rebuildStateFromCanonicalChain: async () => ({ ok: true, head: clone(headAtT5) }),
  normalizeStateCorrectionPayload: ({ patch, target }) => ({ patch: clone(patch), target: clone(target) }),
  CANONICAL_MANUAL_STATE_DISPOSITION_SCHEMA: 'libra.canonical_manual_state_disposition.v1',
  manualStateDispositionIntentDigest: value => digest(value),
  validateManualStateDispositionIntent: ({ intent }) => clone(intent),
  nowIso: () => '2026-09-01T02:00:00.000Z',
  assertCanonicalStoredValue: async () => clone(storedCandidate),
  updateCanonicalJob: async (_scope, patch) => {
    job = { ...job, ...clone(patch) };
    return clone(job);
  }
};
vm.createContext(saveContext);
vm.runInContext(`${neutralizeSource}\n${saveDispositionSource}\nthis.saveDisposition = saveCanonicalManualStateDisposition;`, saveContext,
  { filename: 'libra-manual-sparse-anchor-save.js', timeout: 3000 });

(async () => {
  const candidateBefore = clone(storedCandidate);
  const jobBefore = clone(job);
  let anchorError = null;
  try {
    await saveContext.saveDisposition({
      jobId: job.jobId, mode: 'sparse_correction', target: { domain: 'characters', mode: 'profile_patch' },
      patch: { characters: [{ id: 'char_future', name: 'Future', state: { mood: 'not present at T5' } }] }
    });
  } catch (error) { anchorError = error; }
  if (!anchorError) {
    failures.push('historical T5 sparse disposition accepted a T10-only entity from the latest Head');
  } else if (!/canonical_manual_state_disposition_character_id_unbound/.test(String(anchorError?.message || anchorError))) {
    failures.push(`historical T5 sparse disposition failed for the wrong reason: ${anchorError?.message || anchorError}`);
  }
  if (anchorError) {
    assert.deepEqual(storedCandidate, candidateBefore, 'anchor validation rejects before candidate mutation');
    assert.deepEqual(job, jobBefore, 'anchor validation rejects before job mutation');
    assert.equal(candidateWrites, 0, 'anchor validation rejects before any candidate write');
  }
  if (/scopeNeutralizeManualStateDispositionPatch\(\{ patch, head: currentHead \}\)/.test(saveDispositionSource)) {
    failures.push('saveCanonicalManualStateDisposition still neutralizes against the latest currentHead');
  }

  if (failures.length) {
    throw new assert.AssertionError({
      message: `manual sparse anchor/scope contract failures:\n- ${failures.join('\n- ')}`
    });
  }
  process.stdout.write(`libra_manual_sparse_anchor_scope_contract_test: PASS (${path.basename(sourcePath)})\n`);
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
