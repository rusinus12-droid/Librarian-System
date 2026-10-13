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
const countMatches = (value, pattern) => (value.match(pattern) || []).length;

const correctionOverlay = between('const worldManagerSnapshotView =', 'const stateTrackingSettingsForGui =');
const requestBlock = between('const worldManagerCorrectionRequest =', 'const worldManagerHeadHasCorrection =');
const saveBlock = between('const saveWorldManagerCorrectionDraft =', 'const buildWorldManagerCorrectionEditor =');
const editorBlock = between('const buildWorldManagerCorrectionEditor =', 'const buildWorldManagerRecordBrowser =');

for (const builder of [
  'buildWorldManagerCharactersPanel', 'buildWorldManagerRelationshipsPanel',
  'buildWorldManagerWorldPanel', 'buildWorldManagerNarrativeCurrentPanel'
]) assert.match(correctionOverlay, new RegExp(`const ${builder} =`), `missing correction-capable builder: ${builder}`);

for (const domain of [
  'characters', 'relationships', 'world', 'narrative_arc', 'narrative_thread', 'narrative_lock'
]) {
  assert.match(editorBlock, new RegExp(`domain==='${domain}'`), `missing editor branch: ${domain}`);
  assert.match(requestBlock, new RegExp(`draft\\.domain==='${domain}'`), `missing correction payload branch: ${domain}`);
}
assert.match(correctionOverlay, /editorDomain:'narrative_arc'/);
assert.match(correctionOverlay, /editorDomain:'narrative_thread'/);
assert.match(correctionOverlay, /editorDomain:'narrative_lock'/);

for (const field of ['anchorTurn', 'basisFingerprint', 'supersedes']) {
  assert.match(requestBlock, new RegExp(`${field}:`), `correction request must carry ${field}`);
}
assert.match(requestBlock, /target:\{domain:'characters',mode:'profile_patch'\}/);
assert.match(requestBlock, /target:\{domain:'relationships',mode:'profile_patch'\}/);
assert.match(requestBlock, /target:\{domain:'world',mode:'profile_patch'\}/);
assert.equal(countMatches(saveBlock, /api\.addWorldManagerCorrection\(/g), 1,
  'profile save must call its public correction API exactly once');
assert.equal(countMatches(saveBlock, /api\.addWorldManagerNarrativeCorrection\(/g), 1,
  'narrative save must call its public correction API exactly once');
assert.doesNotMatch(saveBlock, /appendStateCorrection|rebuildWorldManager|rebuildCurrentStateForWorldline|rebuildContinuityForManifest/,
  'GUI save must not append or rebuild separately from the public correction transaction');

const receiptIndex = saveBlock.indexOf('result?.replay?.appliedCorrections');
const resultHeadIndex = saveBlock.indexOf('worldManagerHeadHasCorrection(result.head||result.currentHead');
const refreshIndex = saveBlock.indexOf('await refreshGuiSnapshot(false)');
const readbackIndex = saveBlock.indexOf('worldManagerHeadHasCorrection(snapshot?.continuityState');
const clearIndex = saveBlock.indexOf('Gui.worldManagerEditDraft=null');
const successIndex = saveBlock.indexOf("success='교정을 저장하고 Current Head replay/readback을 확인했습니다.'");
for (const [label, index] of [
  ['replay receipt', receiptIndex], ['returned Head provenance', resultHeadIndex],
  ['snapshot refresh', refreshIndex], ['refreshed Head provenance', readbackIndex],
  ['draft clear', clearIndex], ['success state', successIndex]
]) assert.ok(index >= 0, `missing save gate: ${label}`);
assert.ok(receiptIndex < resultHeadIndex && resultHeadIndex < refreshIndex && refreshIndex < readbackIndex
  && readbackIndex < clearIndex && clearIndex < successIndex,
'success and draft clear must occur only after replay, provenance, and refreshed readback');

require('./helpers/libra_active_book_routes.cjs')(source);
assert.doesNotMatch(source, /const renderActiveTab\s*=/,
  'the retired response-family renderer is not a fallback behind the approved six-destination app');

const clone = value => JSON.parse(JSON.stringify(value));
const baseSnapshot = () => ({
  manifest: { frontiers: { observedTurn: 14, committedTurn: 10 } },
  totals: { memories: 2 },
  memories: [{ memoryId: 'm1' }, { memoryId: 'm2' }],
  continuityState: {
    status: 'ready', throughTurn: 10, updatedAt: '2026-08-31T00:00:00.000Z',
    basis: { sourceCount: 2, sourceFingerprint: 'fp-current-head' },
    characters: [{
      id: 'c1', name: 'Ada', aliases: ['A'], state: { mood: 'calm' },
      correctionProvenance: { correctionId: 'old-character-correction' }
    }],
    relationships: [{
      id: 'r1', subjectId: 'c1', subjectName: 'Ada', targetId: 'c2', targetName: 'Ben',
      dimension: 'trust', state: 'growing', certainty: 'confirmed',
      correctionProvenance: { correctionId: 'old-relationship-correction' }
    }],
    world: [{
      id: 'w1', name: 'Archive', kind: 'location', aliases: ['Vault'], state: { open: true },
      correctionProvenance: { correctionId: 'old-world-correction' }
    }],
    narrative: {
      summary: 'They entered the archive.', momentum: 'Cautious discovery', updatedThroughTurn: 10,
      correctionProvenance: { correctionId: 'old-narrative-correction' },
      arcs: [{
        id: 'a1', title: 'Archive mystery', status: 'active', phase: 'developing', summary: 'The seal is unexplained.',
        centralPressure: 'Time', participants: ['c1'], worldRefs: ['w1'],
        correctionProvenance: { correctionId: 'old-arc-correction' }
      }],
      threads: [{
        id: 't1', arcId: 'a1', type: 'mystery', summary: 'Who sealed the room?', status: 'open', participants: ['c1'],
        correctionProvenance: { correctionId: 'old-thread-correction' }
      }],
      locks: [{
        id: 'l1', summary: 'The door is sealed', status: 'active',
        correctionProvenance: { correctionId: 'old-lock-correction' }
      }],
      motifs: [], turningPoints: []
    },
    domainStatus: {
      characters: { status: 'ready', throughTurn: 10 },
      relationships: { status: 'ready', throughTurn: 10 },
      world: { status: 'ready', throughTurn: 10 },
      narrative: { status: 'ready', throughTurn: 10 }
    }
  }
});

const makeNode = (tag, attrs = {}, children = []) => ({
  tag, attrs, children: (Array.isArray(children) ? children : [children]).filter(Boolean)
});
const findNodes = (node, predicate, found = []) => {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, found);
  } else if (Array.isArray(node.children)) {
    for (const child of node.children) findNodes(child, predicate, found);
  }
  return found;
};

const makeUiHarness = (snapshotValue = baseSnapshot()) => {
  const state = {
    snapshot: snapshotValue,
    events: [], statuses: [], refreshCalls: 0, renderCalls: 0,
    refreshHandler: null, draftPresentAtRefresh: null, draftAtRender: undefined
  };
  const context = {
    LibraMemoryCore: { peekSnapshot: () => state.snapshot },
    CONTINUITY_STATE_RELATION_DIMENSIONS: Object.freeze([
      'trust', 'affection', 'attraction', 'fear', 'obligation', 'hostility', 'distance',
      'cooperation', 'authority', 'dependency', 'knowledge', 'other'
    ]),
    Gui: {
      narrativeHubSection: 'current', worldManagerSelectedCharacterId: '',
      worldManagerSelectedRelationshipId: '', worldManagerSelectedWorldId: '',
      worldManagerSelectedArcId: '', worldManagerSelectedThreadId: '', worldManagerSelectedLockId: '',
      worldManagerEditDraft: null, worldManagerEditError: '', worldManagerSaving: false
    },
    guiAsArray: value => Array.isArray(value) ? value : [],
    guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    text: value => String(value ?? ''),
    guiEl: makeNode,
    guiLazyDetails: (attrs, summary, factory) => makeNode('details', attrs, [summary, factory()]),
    libraFormatTime: value => String(value || ''),
    queueGuiNavigationRender: () => { state.events.push('navigate-render'); },
    buildLibraHubTabs: () => makeNode('tabs'),
    libraStatusBadge: (label, kind) => makeNode('badge', { label, kind }),
    fieldNode: (label, node, note) => makeNode('field', { label, note }, [node]),
    optionNodes: (items, selected) => items.map(item => {
      const pair = Array.isArray(item) ? item : [item, item];
      return makeNode('option', { value: String(pair[0]), text: String(pair[1]), selected: String(pair[0]) === String(selected) });
    }),
    cloneJson: clone,
    refreshGuiSnapshot: async () => {
      state.events.push('refresh');
      state.refreshCalls += 1;
      state.draftPresentAtRefresh = !!context.Gui.worldManagerEditDraft;
      return state.refreshHandler ? state.refreshHandler() : state.snapshot;
    },
    renderSettingsGui: async () => {
      state.events.push('render');
      state.renderCalls += 1;
      state.draftAtRender = context.Gui.worldManagerEditDraft;
    },
    guiSetStatus: (...args) => {
      state.events.push('status');
      state.statuses.push(args);
    }
  };
  Object.assign(context, require('./fixtures/librarian_production_bindings.cjs')(source));
  vm.createContext(context);
  vm.runInContext(`'use strict';\n${correctionOverlay}\nthis.api = {
    worldManagerSnapshotView, openWorldManagerCorrectionEditor, worldManagerCorrectionRequest,
    worldManagerHeadHasCorrection, saveWorldManagerCorrectionDraft, buildWorldManagerCorrectionEditor,
    buildWorldManagerCharactersPanel, buildWorldManagerRelationshipsPanel,
    buildWorldManagerWorldPanel, buildWorldManagerNarrativeCurrentPanel, buildWorldManagerNarrativePanel
  };`, context);
  return { context, state, api: context.api };
};

const ui = makeUiHarness();
const view = ui.api.worldManagerSnapshotView();
const head = ui.state.snapshot.continuityState;
const panelTrees = [
  ui.api.buildWorldManagerCharactersPanel(), ui.api.buildWorldManagerRelationshipsPanel(),
  ui.api.buildWorldManagerWorldPanel(), ui.api.buildWorldManagerNarrativePanel()
];
const actionDomains = panelTrees.flatMap(tree => findNodes(tree, node => node?.attrs?.dataset?.worldCorrectionAction)
  .map(node => node.attrs.dataset.worldCorrectionAction));
for (const domain of ['characters', 'relationships', 'world', 'narrative_arc', 'narrative_thread', 'narrative_lock']) {
  assert.ok(actionDomains.includes(domain), `rendered Current Head must expose the ${domain} correction action`);
}

const editorRows = {
  characters: head.characters[0], relationships: head.relationships[0], world: head.world[0],
  narrative_arc: head.narrative.arcs[0], narrative_thread: head.narrative.threads[0], narrative_lock: head.narrative.locks[0]
};
const expectedSupersedes = {
  characters: 'old-character-correction', relationships: 'old-relationship-correction', world: 'old-world-correction',
  narrative_arc: 'old-arc-correction', narrative_thread: 'old-thread-correction', narrative_lock: 'old-lock-correction'
};
for (const [domain, row] of Object.entries(editorRows)) {
  ui.context.Gui.worldManagerEditDraft = null;
  ui.api.openWorldManagerCorrectionEditor(domain, row, view);
  const draft = ui.context.Gui.worldManagerEditDraft;
  assert.equal(draft.domain, domain);
  assert.equal(draft.anchorTurn, 10);
  assert.equal(draft.basisFingerprint, 'fp-current-head');
  assert.equal(draft.supersedes, expectedSupersedes[domain]);
  const editor = ui.api.buildWorldManagerCorrectionEditor(domain, row, view, true);
  assert.equal(findNodes(editor, node => node?.attrs?.dataset?.worldCorrectionEditor === domain).length, 1,
    `${domain} must render a concrete correction editor`);
  const request = ui.api.worldManagerCorrectionRequest(draft);
  assert.equal(request.options.anchorTurn, 10);
  assert.equal(request.options.basisFingerprint, 'fp-current-head');
  assert.equal(request.options.supersedes, expectedSupersedes[domain]);
  if (domain === 'characters' || domain === 'relationships' || domain === 'world') {
    assert.equal(request.method, 'profile');
    assert.equal(request.options.target.domain, domain);
    assert.equal(request.options.target.mode, 'profile_patch');
    assert.ok(Array.isArray(request.options.patch[domain]));
  } else {
    assert.equal(request.method, 'narrative');
    assert.equal(request.patch.schema, 'libra.narrative_patch.v1');
    assert.equal(request.patch.source, 'user_correction');
    const key = domain === 'narrative_arc' ? 'arcs' : domain === 'narrative_thread' ? 'threads' : 'locks';
    assert.ok(Array.isArray(request.patch[key]));
  }
}

const provenance = correctionId => ({ correctionId });
const profileHead = correctionId => ({
  characters: [{ id: 'c1', correctionProvenance: provenance(correctionId) }]
});
const narrativeHead = correctionId => ({
  narrative: {
    correctionProvenance: provenance(correctionId),
    arcs: [{ id: 'a1', correctionProvenance: provenance(correctionId) }]
  }
});

const runProfileSuccess = async () => {
  const harness = makeUiHarness();
  const localView = harness.api.worldManagerSnapshotView();
  harness.api.openWorldManagerCorrectionEditor('characters', harness.state.snapshot.continuityState.characters[0], localView);
  harness.state.events.length = 0;
  let profileCalls = 0;
  let narrativeCalls = 0;
  let receivedOptions;
  const correctionId = 'new-character-correction';
  const committedHead = profileHead(correctionId);
  harness.context.__LIBRA__ = {
    addWorldManagerCorrection: async options => {
      harness.state.events.push('public-profile');
      profileCalls += 1;
      receivedOptions = options;
      return { ok: true, correctionId, replay: { ok: true, appliedCorrections: [correctionId] }, head: committedHead };
    },
    addWorldManagerNarrativeCorrection: async () => {
      narrativeCalls += 1;
      throw new Error('wrong public API branch');
    }
  };
  harness.state.refreshHandler = () => ({ continuityState: committedHead });
  await harness.api.saveWorldManagerCorrectionDraft();
  assert.equal(profileCalls, 1);
  assert.equal(narrativeCalls, 0);
  assert.equal(receivedOptions.anchorTurn, 10);
  assert.equal(receivedOptions.basisFingerprint, 'fp-current-head');
  assert.equal(receivedOptions.supersedes, 'old-character-correction');
  assert.equal(harness.state.refreshCalls, 1);
  assert.equal(harness.state.draftPresentAtRefresh, true, 'draft must still exist while durable readback is pending');
  assert.equal(harness.context.Gui.worldManagerEditDraft, null);
  assert.equal(harness.state.draftAtRender, null, 'successful readback may clear the draft before the final render');
  assert.deepEqual(harness.state.events, ['public-profile', 'refresh', 'render', 'status']);
  assert.equal(harness.state.statuses.length, 1);
  assert.equal(harness.state.statuses[0][1], false);
};

const runNarrativeSuccess = async () => {
  const harness = makeUiHarness();
  const localView = harness.api.worldManagerSnapshotView();
  harness.api.openWorldManagerCorrectionEditor('narrative_arc', harness.state.snapshot.continuityState.narrative.arcs[0], localView);
  harness.state.events.length = 0;
  let profileCalls = 0;
  let narrativeCalls = 0;
  let receivedPatch;
  let receivedOptions;
  const correctionId = 'new-arc-correction';
  const committedHead = narrativeHead(correctionId);
  harness.context.__LIBRA__ = {
    addWorldManagerCorrection: async () => {
      profileCalls += 1;
      throw new Error('wrong public API branch');
    },
    addWorldManagerNarrativeCorrection: async (patch, options) => {
      harness.state.events.push('public-narrative');
      narrativeCalls += 1;
      receivedPatch = patch;
      receivedOptions = options;
      return { ok: true, correctionId, replay: { ok: true, appliedCorrections: [correctionId] }, currentHead: committedHead };
    }
  };
  harness.state.refreshHandler = () => ({ continuityState: committedHead });
  await harness.api.saveWorldManagerCorrectionDraft();
  assert.equal(profileCalls, 0);
  assert.equal(narrativeCalls, 1);
  assert.equal(receivedOptions.anchorTurn, 10);
  assert.equal(receivedOptions.basisFingerprint, 'fp-current-head');
  assert.equal(receivedOptions.supersedes, 'old-arc-correction');
  assert.equal(receivedPatch.schema, 'libra.narrative_patch.v1');
  assert.equal(receivedPatch.arcs[0].id, 'a1');
  assert.equal(harness.state.refreshCalls, 1);
  assert.equal(harness.context.Gui.worldManagerEditDraft, null);
  assert.deepEqual(harness.state.events, ['public-narrative', 'refresh', 'render', 'status']);
  assert.equal(harness.state.statuses[0][1], false);
};

const runFailureGate = async ({ name, result, refreshValue, expectedRefreshCalls }) => {
  const harness = makeUiHarness();
  const localView = harness.api.worldManagerSnapshotView();
  harness.api.openWorldManagerCorrectionEditor('characters', harness.state.snapshot.continuityState.characters[0], localView);
  const retainedDraft = harness.context.Gui.worldManagerEditDraft;
  harness.state.events.length = 0;
  let publicCalls = 0;
  harness.context.__LIBRA__ = {
    addWorldManagerCorrection: async () => {
      harness.state.events.push('public-profile');
      publicCalls += 1;
      return result;
    },
    addWorldManagerNarrativeCorrection: async () => { throw new Error('wrong public API branch'); }
  };
  harness.state.refreshHandler = () => refreshValue;
  await harness.api.saveWorldManagerCorrectionDraft();
  assert.equal(publicCalls, 1, `${name}: public API must be called once`);
  assert.equal(harness.state.refreshCalls, expectedRefreshCalls, `${name}: unexpected refresh count`);
  assert.equal(harness.context.Gui.worldManagerEditDraft, retainedDraft, `${name}: failed save must retain the editable draft`);
  assert.ok(harness.context.Gui.worldManagerEditError, `${name}: failed save must expose an error`);
  assert.equal(harness.state.statuses.length, 1, `${name}: failed save must publish one status`);
  assert.equal(harness.state.statuses[0][1], true, `${name}: failed save status must be an error`);
  assert.ok(!harness.state.statuses.some(args => args[1] === false), `${name}: failed save must not publish success`);
};

const runSharedRouteFixture = () => require('./helpers/libra_active_book_routes.cjs')(source);
(async () => {
  await runProfileSuccess();
  await runNarrativeSuccess();
  const correctionId = 'failed-character-correction';
  await runFailureGate({
    name: 'missing applied replay receipt',
    result: { ok: true, correctionId, replay: { ok: true, appliedCorrections: [] }, head: profileHead(correctionId) },
    refreshValue: { continuityState: profileHead(correctionId) }, expectedRefreshCalls: 0
  });
  await runFailureGate({
    name: 'missing returned Head provenance',
    result: { ok: true, correctionId, replay: { ok: true, appliedCorrections: [correctionId] }, head: { characters: [] } },
    refreshValue: { continuityState: profileHead(correctionId) }, expectedRefreshCalls: 0
  });
  await runFailureGate({
    name: 'missing refreshed Head provenance',
    result: { ok: true, correctionId, replay: { ok: true, appliedCorrections: [correctionId] }, head: profileHead(correctionId) },
    refreshValue: { continuityState: { characters: [] } }, expectedRefreshCalls: 1
  });
  runSharedRouteFixture();
  process.stdout.write('libra_world_manager_correction_gui_rc2_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
