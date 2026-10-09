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

// Commit 5 GUI state is deliberately common. It must not be captured in the
// LIBRA/GRADIA family-specific hub state, because switching draft engines must
// preserve the same scope-bound direction draft.
for (const field of [
  'narrativeDirectionDraft', 'narrativeDirectionDraftKey',
  'narrativeDirectionLoading', 'narrativeDirectionSaving',
  'narrativeDirectionError', 'narrativeDirectionLoadSerial'
]) assert.match(source, new RegExp(`${field}:`), `missing common GUI direction state: ${field}`);

assert.doesNotMatch(source,/const GUI_FAMILY_HUB_STATE_KEYS\s*=/,'retired family state must not fork the common direction draft');
assert.match(source,/const activeGuiResponseFamily = \(\) => 'libra'/);
const route=require('./helpers/libra_navigation_contract.cjs').navigation(source);
assert.deepEqual(route('story_arc_direction'),{pageId:'narrative',narrativeHubSection:'direction'},'retained direction deep link remains outside the retired response-generation workspace');

const currentPanel = between('const buildWorldManagerNarrativeCurrentPanel =', 'const narrativeDirectionScopeKey =');
assert.doesNotMatch(currentPanel, /앞으로의 서사 방향 설정|Gui\.narrativeHubSection\s*=\s*'direction'/,
  'Current Narrative must remain a latest-state reader, not a future-direction editor');

const directionBlock = between('const narrativeDirectionScopeKey =', 'const buildWorldManagerNarrativePanel =');
const loadBlock = between('const loadNarrativeDirectionDraft =', 'const saveNarrativeDirectionDraft =');
const saveBlock = between('const saveNarrativeDirectionDraft =', 'const clearNarrativeDirectionDraft =');
const clearBlock = between('const clearNarrativeDirectionDraft =', 'const buildNarrativeDirectionPanel =');
const panelBlock = between('const buildNarrativeDirectionPanel =', 'const buildWorldManagerNarrativePanel =');

for (const label of [
  '원하는 서사 방향', '완료 조건', '피해야 할 강제 전개', 'Soft Preferences', '잠금'
]) assert.ok(panelBlock.includes(label), `missing Narrative Direction field: ${label}`);
assert.match(panelBlock, /이 페이지는 앞으로 원하는 방향을 지정합니다\./);
assert.match(panelBlock, /현재까지 실제로 일어난 내용은 내러티브 > 현재 내러티브에서 관리합니다\./);
assert.doesNotMatch(directionBlock,
  /LibraMemoryCore\.setStoryArcDestination|storyArcDestinationDraft|planner-narrative-direction:v1|:story-arc/,
  'the shared GUI must use the public Direction API, not a legacy object or storage key');
assert.doesNotMatch(directionBlock,
  /rebuildStoryArc|rebuildWorldManager|refreshGuiSnapshot|nextBeats|다음 전개 제안|\.beats\b/,
  'Direction editing must not rebuild factual state or revive generated future-beat persistence');

assert.equal(countMatches(loadBlock, /api\.getNarrativeDirection\(/g), 1,
  'lazy load must call the public getter exactly once');
assert.equal(countMatches(saveBlock, /api\.setNarrativeDirection\(/g), 1,
  'save must call the public setter exactly once');
assert.equal(countMatches(saveBlock, /api\.getNarrativeDirection\(/g), 1,
  'save must perform one independent durable readback');
assert.equal(countMatches(clearBlock, /api\.clearNarrativeDirection\(/g), 1,
  'clear must call the public clearer exactly once');
assert.equal(countMatches(clearBlock, /api\.getNarrativeDirection\(/g), 1,
  'clear must perform one independent durable readback');
assert.match(saveBlock, /narrativeDirectionSemanticallyEqual/,
  'save must compare its receipt with physical readback semantically');
assert.match(clearBlock, /narrativeDirectionSemanticallyEqual/,
  'clear must compare its receipt with physical readback semantically');
assert.match(panelBlock, /loadNarrativeDirectionDraft\(/,
  'Direction data must be loaded lazily only after this internal page is rendered');

const narrativePanel = between('const buildWorldManagerNarrativePanel =', 'const stateTrackingSettingsForGui =');
assert.match(narrativePanel, /Gui\.narrativeHubSection\s*=\s*'current'/,
  'stale Narrative direction state must migrate back to current facts');
assert.doesNotMatch(narrativePanel, /buildNarrativeDirectionPanel\(\)/,
  'the Current Narrative hub must not mount future Planner directives');
assert.doesNotMatch(narrativePanel, /narrativeDirectionPending/,
  'the Commit 2 Direction placeholder must be retired');

assert.doesNotMatch(source,/const buildLibraDraftWorkspacePanel\s*=|const buildGradiaDraftWorkspacePanel\s*=/,'retired draft-family workspaces stay removed');
const storyOwner=require('./helpers/libra_navigation_contract.cjs').declaration(source,'buildBookStoryPanel');
assert.match(storyOwner,/buildNarrativeDirectionPanel\(/,'the active story owner retains the explicit user direction editor');

require('./helpers/libra_active_book_routes.cjs')(source);
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

const makeGuiHarness = () => {
  const state = {
    scopeKey: 'scope-a',
    getCalls: 0,
    setCalls: 0,
    clearCalls: 0,
    renders: 0,
    statuses: [],
    setPayload: null,
    setOptions: null,
    clearOptions: null,
    getQueue: [],
    setResult: null,
    clearResult: null
  };
  const context = {
    Object, Array, String, Number, Boolean, Math, JSON, Promise,
    setTimeout, clearTimeout,
    LibraMemoryCore: {
      peekSnapshot: () => ({ scope: { scopeKey: state.scopeKey } })
    },
    Gui: {
      narrativeDirectionDraft: null,
      narrativeDirectionDraftKey: '',
      narrativeDirectionLoading: false,
      narrativeDirectionSaving: false,
      narrativeDirectionError: '',
      narrativeDirectionLoadSerial: 0,
      narrativeHubSection: 'direction'
    },
    guiAsArray: value => Array.isArray(value) ? value : [],
    guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    text: value => String(value ?? ''),
    cloneJson: clone,
    queueGuiNavigationRender: () => { state.renders += 1; },
    renderSettingsGui: async () => { state.renders += 1; },
    guiSetStatus: (...args) => { state.statuses.push(args); },
    guiEl: (tag, attrs = {}, children = []) => ({ tag, attrs, children }),
    fieldNode: (label, node, note) => ({ label, node, note }),
    inputNode: (value, onInput, options) => ({ value, onInput, options }),
    checkboxNode: (value, label, onInput) => ({ value, label, onInput }),
    libraStatusBadge: (label, kind) => ({ label, kind }),
    confirm: () => true,
    __LIBRA__: {
      getNarrativeDirection: async options => {
        state.getCalls += 1;
        assert.deepEqual(clone(options), { scopeKey: state.scopeKey });
        if (!state.getQueue.length) throw new Error('unexpected Direction getter call');
        const next = state.getQueue.shift();
        if (next instanceof Error) throw next;
        return clone(next);
      },
      setNarrativeDirection: async (payload, options) => {
        state.setCalls += 1;
        state.setPayload = clone(payload);
        state.setOptions = clone(options);
        if (state.setResult instanceof Error) throw state.setResult;
        return clone(state.setResult);
      },
      clearNarrativeDirection: async options => {
        state.clearCalls += 1;
        state.clearOptions = clone(options);
        if (state.clearResult instanceof Error) throw state.clearResult;
        return clone(state.clearResult);
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`'use strict';\n${directionBlock}\nthis.directionApi = {
    narrativeDirectionScopeKey,
    narrativeDirectionSemanticallyEqual,
    loadNarrativeDirectionDraft,
    saveNarrativeDirectionDraft,
    clearNarrativeDirectionDraft,
    buildNarrativeDirectionPanel
  };`, context);
  return { state, context, api: context.directionApi };
};

const editDraft = (harness, patch = {}) => {
  Object.assign(harness.context.Gui.narrativeDirectionDraft, {
    goal: '두 사람이 다시 만나기 전까지 긴장을 높인다.',
    completionConditions: '실종 원인이 밝혀진다.\n증거가 검증된다.',
    doNotForce: '용서를 자동 확정하지 않는다.',
    softPreferences: '대화 중심\n단서 발견 중심',
    locked: true,
    dirty: true,
    ...patch
  });
};

const runGuiContract = async () => {
  const harness = makeGuiHarness();
  const exact = baseDirection();
  assert.equal(harness.api.narrativeDirectionSemanticallyEqual(exact, clone(exact)), true);
  assert.equal(harness.api.narrativeDirectionSemanticallyEqual(exact, { ...exact, revision: 8 }), false,
    'revision is part of the durable receipt');
  assert.equal(harness.api.narrativeDirectionSemanticallyEqual(exact, { ...exact, updatedAt: exact.updatedAt + 1 }), false,
    'updatedAt is part of the durable receipt');
  assert.equal(harness.api.narrativeDirectionSemanticallyEqual(exact, { ...exact, scopeKey: 'scope-b' }), false,
    'scope binding is part of the durable receipt');
  assert.equal(harness.api.narrativeDirectionSemanticallyEqual(exact, {
    ...exact, completionConditions: [...exact.completionConditions, 'extra']
  }), false, 'every persisted list is part of the durable receipt');

  harness.state.getQueue.push(baseDirection());
  await harness.api.loadNarrativeDirectionDraft();
  assert.equal(harness.state.getCalls, 1);
  assert.equal(harness.context.Gui.narrativeDirectionDraft.scopeKey, 'scope-a');
  assert.equal(harness.context.Gui.narrativeDirectionDraft.revision, 7);
  assert.equal(harness.context.Gui.narrativeDirectionDraft.completionConditions, '직접 원인이 밝혀진다.');
  assert.equal(harness.context.Gui.narrativeDirectionDraft.doNotForce, '사용자의 용서를 확정하지 않는다.');
  assert.equal(harness.context.Gui.narrativeDirectionDraft.softPreferences, '대화와 단서 중심');
  assert.equal(harness.context.Gui.narrativeDirectionDraft.dirty, false);

  editDraft(harness);
  const retained = harness.context.Gui.narrativeDirectionDraft;
  await harness.api.loadNarrativeDirectionDraft();
  assert.equal(harness.state.getCalls, 1,
    'rerender or response-family switch must not overwrite a same-scope dirty draft');
  assert.equal(harness.context.Gui.narrativeDirectionDraft, retained);

  const saved = baseDirection({
    revision: 8,
    goal: retained.goal,
    completionConditions: ['실종 원인이 밝혀진다.', '증거가 검증된다.'],
    doNotForce: ['용서를 자동 확정하지 않는다.'],
    softPreferences: ['대화 중심', '단서 발견 중심'],
    locked: true,
    updatedAt: 1700000001000
  });
  harness.state.setResult = saved;
  harness.state.getQueue.push(saved);
  await harness.api.saveNarrativeDirectionDraft();
  assert.equal(harness.state.setCalls, 1);
  assert.equal(harness.state.getCalls, 2);
  assert.deepEqual(harness.state.setOptions, { scopeKey: 'scope-a' });
  assert.deepEqual(harness.state.setPayload, {
    goal: saved.goal,
    completionConditions: saved.completionConditions,
    doNotForce: saved.doNotForce,
    softPreferences: saved.softPreferences,
    locked: true
  });
  assert.equal(harness.context.Gui.narrativeDirectionDraft.revision, 8);
  assert.equal(harness.context.Gui.narrativeDirectionDraft.dirty, false);
  assert.equal(harness.context.Gui.narrativeDirectionError, '');
  assert.ok(harness.state.statuses.some(args => args[1] === false),
    'exact save readback must publish success');

  editDraft(harness, { goal: 'readback mismatch draft' });
  const mismatchDraft = harness.context.Gui.narrativeDirectionDraft;
  const expected = baseDirection({ revision: 9, goal: 'readback mismatch draft', updatedAt: 1700000002000 });
  harness.state.setResult = expected;
  harness.state.getQueue.push({ ...expected, goal: 'different physical value' });
  const successesBeforeMismatch = harness.state.statuses.filter(args => args[1] === false).length;
  await harness.api.saveNarrativeDirectionDraft();
  assert.equal(harness.context.Gui.narrativeDirectionDraft, mismatchDraft,
    'save readback mismatch must retain the editable draft object');
  assert.equal(harness.context.Gui.narrativeDirectionDraft.goal, 'readback mismatch draft');
  assert.equal(harness.context.Gui.narrativeDirectionDraft.dirty, true);
  assert.ok(harness.context.Gui.narrativeDirectionError,
    'save readback mismatch must expose a sticky error');
  assert.equal(harness.state.statuses.filter(args => args[1] === false).length, successesBeforeMismatch,
    'save readback mismatch must not publish success');
  assert.ok(harness.state.statuses.at(-1)?.[1] === true,
    'save readback mismatch must publish an error status');

  const clearHarness = makeGuiHarness();
  clearHarness.state.getQueue.push(baseDirection());
  await clearHarness.api.loadNarrativeDirectionDraft();
  const cleared = baseDirection({
    revision: 8,
    goal: '', completionConditions: [], doNotForce: [], softPreferences: [],
    locked: false, updatedAt: 1700000003000
  });
  clearHarness.state.clearResult = cleared;
  clearHarness.state.getQueue.push(cleared);
  await clearHarness.api.clearNarrativeDirectionDraft();
  assert.equal(clearHarness.state.clearCalls, 1);
  assert.equal(clearHarness.state.getCalls, 2);
  assert.deepEqual(clearHarness.state.clearOptions, { scopeKey: 'scope-a' });
  assert.equal(clearHarness.context.Gui.narrativeDirectionDraft.goal, '');
  assert.equal(clearHarness.context.Gui.narrativeDirectionDraft.completionConditions, '');
  assert.equal(clearHarness.context.Gui.narrativeDirectionDraft.doNotForce, '');
  assert.equal(clearHarness.context.Gui.narrativeDirectionDraft.softPreferences, '');
  assert.equal(clearHarness.context.Gui.narrativeDirectionDraft.locked, false);
  assert.equal(clearHarness.context.Gui.narrativeDirectionDraft.dirty, false);

  const wrongScope = makeGuiHarness();
  wrongScope.state.getQueue.push(baseDirection({ scopeKey: 'scope-b' }));
  await wrongScope.api.loadNarrativeDirectionDraft();
  assert.equal(wrongScope.context.Gui.narrativeDirectionDraft, null,
    'a direction from another scope must never hydrate this page');
  assert.ok(wrongScope.context.Gui.narrativeDirectionError);
};

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
  await runGuiContract();
  await runCoreReadbackContract();
  process.stdout.write('libra_narrative_direction_gui_rc2_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
