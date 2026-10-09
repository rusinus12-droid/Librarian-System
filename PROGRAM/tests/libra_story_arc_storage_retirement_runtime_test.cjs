'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const sourcePath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const start = source.indexOf("const __LIBRA_NARRATIVE_COMPLETION_V2 = 'libra.narrative_completion.v2';");
const endMarker = 'queueMicrotask(__libraCompletionInstallPublicApi);';
const end = source.indexOf(endMarker, start);
assert.notEqual(start, -1, 'Narrative completion layer start missing');
assert.notEqual(end, -1, 'Narrative completion layer end missing');
const completionSource = source.slice(start, end + endMarker.length);

const values = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const host = {
  async getPluginStorage(key) {
    if (arguments.length === 0) return Object.fromEntries(values.entries());
    return values.has(String(key)) ? values.get(String(key)) : null;
  },
  async setPluginStorage(key, value) {
    if (arguments.length === 1 && key && typeof key === 'object') {
      values.clear();
      for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
      return true;
    }
    values.set(String(key), value);
    return true;
  }
};
const sandbox = {
  risuai: host,
  __LIBRA__: {},
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  queueMicrotask,
  structuredClone: globalThis.structuredClone,
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Math,
  Set,
  Map
};
vm.runInNewContext(completionSource, sandbox, { filename: 'narrative-completion-runtime.js' });

const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  await tick();
  const api = sandbox.__LIBRA__;
  for (const name of [
    'getStoryArc',
    'setStoryArcDestination',
    'clearStoryArc',
    'migrateStoryArcToNarrativeIfNeeded'
  ]) assert.equal(typeof api[name], 'function', `${name} compatibility API missing`);

  const scopeKey = 'scope-story-arc-retirement-current';
  const stateKey = `libra:v1:scope:${scopeKey}:continuity-state`;
  const legacyKey = `libra:v1:scope:${scopeKey}:story-arc`;
  const markerKey = `libra:v1:scope:${scopeKey}:story-arc-migration:v1`;
  const directionKey = `libra:v1:scope:${scopeKey}:planner-narrative-direction:v1`;
  const currentHead = {
    schema: 'libra.continuity_state.v2',
    narrative: {
      schema: 'libra.narrative_current_state.v2',
      revision: 7,
      summary: 'CURRENT NARRATIVE MUST WIN',
      primaryArcId: 'arc-current',
      arcs: [{ id: 'arc-current', title: 'Current Arc', status: 'active', phase: 'rising', centralPressure: 'Current pressure' }],
      threads: [{ id: 'thread-open', arcId: 'arc-current', type: 'question', status: 'open', summary: 'Current question' }],
      locks: [{ id: 'lock-current', status: 'active', summary: 'Current lock' }],
      momentum: 'Current momentum',
      updatedThroughTurn: 25
    },
    domainStatus: { narrative: { status: 'ready' } }
  };
  const legacyArc = {
    schema: 'libra.story_arc.v1',
    summary: 'LEGACY MUST NOT OVERWRITE',
    basis: { throughTurn: 10 },
    continuityState: {
      currentNarrativeState: 'LEGACY MUST NOT OVERWRITE',
      activeThreads: ['Legacy open thread'],
      resolvedThreads: ['Legacy resolved thread'],
      recentTurningPoints: ['Legacy turning point']
    }
  };
  values.set(stateKey, JSON.stringify(currentHead));
  values.set(legacyKey, JSON.stringify(legacyArc));
  const legacyBefore = values.get(legacyKey);

  const projection = await api.getStoryArc({ scopeKey });
  assert.equal(projection.schema, 'libra.story_arc.compatibility_projection.v2');
  assert.equal(projection.summary, 'CURRENT NARRATIVE MUST WIN');
  assert.equal(projection.continuityState.currentNarrativeState, 'CURRENT NARRATIVE MUST WIN');
  assert.deepEqual(Array.from(projection.continuityState.activeThreads), ['Current question']);
  assert.deepEqual(Array.from(projection.continuityState.narrativeLocks), ['Current lock']);
  assert.equal(values.get(legacyKey), legacyBefore, 'legacy Story Arc source was mutated');
  assert.equal(values.get(markerKey).status, 'legacy_preserved_current_narrative_kept');
  const persistedCurrent = JSON.parse(values.get(stateKey));
  assert.equal(persistedCurrent.narrative.summary, 'CURRENT NARRATIVE MUST WIN');

  const setDirection = await api.setStoryArcDestination({
    goal: 'Future preference only',
    completionConditions: ['Reach the archive'],
    doNotForce: ['Do not force a confession'],
    locked: true
  }, { scopeKey });
  assert.equal(setDirection.schema, 'libra.planner_narrative_direction.v1');
  assert.equal(setDirection.goal, 'Future preference only');
  assert.equal(values.get(directionKey).goal, 'Future preference only');
  const directedProjection = await api.getStoryArc({ scopeKey });
  assert.equal(directedProjection.destination.goal, 'Future preference only');
  assert.equal(values.get(legacyKey), legacyBefore, 'direction compatibility write touched legacy Story Arc');

  const cleared = await api.clearStoryArc({ scopeKey });
  assert.equal(cleared.goal, '');
  assert.deepEqual(Array.from(cleared.completionConditions), []);
  assert.deepEqual(Array.from(cleared.doNotForce), []);
  assert.equal(values.get(legacyKey), legacyBefore, 'clear compatibility action touched legacy Story Arc');

  const legacyScope = 'scope-story-arc-retirement-migrate';
  const legacyStateKey = `libra:v1:scope:${legacyScope}:continuity-state`;
  const legacySourceKey = `libra:v1:scope:${legacyScope}:story-arc`;
  const legacyMarkerKey = `libra:v1:scope:${legacyScope}:story-arc-migration:v1`;
  const legacyDirectionKey = `libra:v1:scope:${legacyScope}:planner-narrative-direction:v1`;
  const oldArc = {
    schema: 'libra.story_arc.v1',
    summary: 'Legacy migration source',
    basis: { throughTurn: 15 },
    continuityState: {
      currentNarrativeState: 'Legacy migration source',
      currentPhase: 'developing',
      centralPressure: 'Legacy pressure',
      activeThreads: ['Legacy open'],
      resolvedThreads: ['Legacy resolved'],
      recentTurningPoints: ['Legacy turn'],
      narrativeLocks: ['Legacy lock']
    },
    destination: {
      goal: 'Migrated future preference',
      completionConditions: ['Condition'],
      doNotForce: ['No force'],
      locked: true,
      source: 'user'
    }
  };
  values.set(legacyStateKey, JSON.stringify({ schema: 'libra.continuity_state.v2', domainStatus: {} }));
  values.set(legacySourceKey, JSON.stringify(oldArc));
  const oldArcBefore = values.get(legacySourceKey);

  const migration = await api.migrateStoryArcToNarrativeIfNeeded({ scopeKey: legacyScope });
  assert.equal(migration.status, 'migrated');
  assert.equal(values.get(legacySourceKey), oldArcBefore, 'migration must preserve the legacy source record');
  const migratedHead = values.get(legacyStateKey);
  assert.equal(migratedHead.narrative.source, 'legacy_story_arc_migration');
  assert.equal(migratedHead.narrative.summary, 'Legacy migration source');
  assert.equal(values.get(legacyMarkerKey).verified, true);
  assert.equal(values.get(legacyDirectionKey).goal, 'Migrated future preference');

  const secondMigration = await api.migrateStoryArcToNarrativeIfNeeded({ scopeKey: legacyScope });
  assert.deepEqual(clone(secondMigration), clone(migration), 'verified migration must be idempotent');
  assert.equal(values.get(legacySourceKey), oldArcBefore, 'idempotent migration touched legacy source');

  process.stdout.write(`libra_story_arc_storage_retirement_runtime_test: PASS (${path.basename(sourcePath)})\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
