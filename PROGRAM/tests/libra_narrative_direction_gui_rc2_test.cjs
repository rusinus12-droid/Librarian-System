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

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const countMatches = (value, pattern) => (value.match(pattern) || []).length;

// The 사서의 여백 editor was removed from the almanac: it stored a direction that no response request read.
// The GUI must not keep a dead editor, while the public storage API below stays intact for existing data.
for (const name of ['loadNarrativeDirectionDraft', 'saveNarrativeDirectionDraft', 'clearNarrativeDirectionDraft', 'LIBRA_APPROVED_MARGIN_RESET_DIALOG_HTML'])
  assert.doesNotMatch(source, new RegExp(`const ${name}\\s*=`), `${name} is retired with the margin editor`);
assert.doesNotMatch(source, /narrativeDirectionDraft:/, 'no GUI draft state remains for the retired margin');
const story = between('const buildApprovedMockupStory = () =>', 'const buildApprovedManageView =');
assert.doesNotMatch(story, /사서의 여백|margin-form|directionField/, 'the almanac renders no margin editor');
assert.ok(countMatches(source, /function getNarrativeDirection\(/g) > 0, 'the public direction API remains');

const baseDirection = (patch = {}) => ({
  schema: 'libra.planner_narrative_direction.v1',
  scopeKey: 'scope-a',
  revision: 7,
  goal: '긴장을 천천히 높인다.',
  completionConditions: ['직접 원인이 밝혀진다.'],
  doNotForce: ['사용자의 용서를 확정하지 않는다.'],
  softPreferences: ['대화와 단서 중심'],
  locked: false,
  source: 'user',
  updatedAt: 1700000000000,
  ...patch
});

// The existing public API remains the storage authority, but Commit 5 must
// close its optimistic-write gap: set/clear may only resolve after an exact
// readback from the established scope-native key.
const completionCore = between(
  'const __LIBRA_NARRATIVE_DIRECTION_LEGACY_SCHEMA =',
  'function __libraCompletionLegacyToNarrative'
);

const makeCoreHarness = ({ corruptWrites = false } = {}) => {
  const state = { store: new Map(), readKeys: [], writeKeys: [], corruptWrites };
  const context = {
    Object, Array, String, Number, Boolean, Math, Date, JSON, Promise,
    structuredClone,
    pluginStorageGet: async key => {
      state.readKeys.push(key);
      return clone(state.store.get(key));
    },
    pluginStorageSet: async (key, value) => {
      state.writeKeys.push(key);
      const next = clone(value);
      if (state.corruptWrites) next.goal = `${next.goal} [corrupted]`;
      state.store.set(key, next);
    },
    localStorage: null,
    Risuai: null,
    RisuAI: null,
    risuai: null
  };
  vm.createContext(context);
  vm.runInContext(`'use strict';\n${completionCore}\nthis.coreApi = {
    getNarrativeDirection,
    setNarrativeDirection,
    clearNarrativeDirection
  };`, context);
  return { state, context, api: context.coreApi };
};

const runCoreReadbackContract = async () => {
  const key = 'libra:v1:scope:scope-a:planner-narrative-direction:v1';
  const harness = makeCoreHarness();
  harness.state.store.set(key, baseDirection({ revision: 2 }));
  const saved = await harness.api.setNarrativeDirection({
    goal: '새 방향',
    completionConditions: ['조건 A'],
    doNotForce: ['강제 금지 A'],
    softPreferences: ['선호 A'],
    locked: true
  }, { scopeKey: 'scope-a' });
  assert.equal(saved.revision, 3);
  assert.equal(saved.goal, '새 방향');
  assert.deepEqual(clone(saved), clone(harness.state.store.get(key)),
    'setter result must be the exact durable readback');
  assert.ok(harness.state.readKeys.length >= 2,
    'setter must read current state and then read the stored result back');
  assert.ok(harness.state.readKeys.every(item => item === key));
  assert.ok(harness.state.writeKeys.every(item => item === key));
  assert.ok(![...harness.state.readKeys, ...harness.state.writeKeys].some(item => item.endsWith(':story-arc')),
    'Direction API must never touch the legacy Story Arc key');

  const cleared = await harness.api.clearNarrativeDirection({ scopeKey: 'scope-a' });
  assert.equal(cleared.revision, 4);
  assert.equal(cleared.goal, '');
  assert.deepEqual(clone(cleared.completionConditions), []);
  assert.deepEqual(clone(cleared.doNotForce), []);
  assert.deepEqual(clone(cleared.softPreferences), []);
  assert.equal(cleared.locked, false);
  assert.deepEqual(clone(cleared), clone(harness.state.store.get(key)),
    'clear result must also be the exact durable readback');

  const corrupt = makeCoreHarness({ corruptWrites: true });
  corrupt.state.store.set(key, baseDirection({ revision: 4 }));
  await assert.rejects(
    corrupt.api.setNarrativeDirection({ goal: 'cannot claim success' }, { scopeKey: 'scope-a' }),
    /readback|mismatch|storage/i,
    'a semantically corrupted physical write must fail closed'
  );
};

(async () => {
  await runCoreReadbackContract();
  process.stdout.write('libra_narrative_direction_gui_rc2_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
