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

const guiState = between('const Gui = {', 'function canonicalJobElapsed');
for (const field of [
  'worldManagerHistoryDomain', 'worldManagerCorrectionFilter',
  'worldManagerHistoryCursor', 'worldManagerCorrectionCursor',
  'worldManagerHistoryTab', 'worldManagerHistoryItems', 'worldManagerCorrectionItems',
  'worldManagerHistoryDetails', 'worldManagerCorrectionMutationId',
  'worldManagerCanonicalMemoryFocus'
]) assert.match(guiState, new RegExp(`${field}:`), `missing shared Commit 4 GUI state: ${field}`);

const overlay = between('const worldManagerSnapshotView =', 'const stateTrackingSettingsForGui =');
for (const helper of [
  'buildWorldManagerHistoryCorrectionsPanel',
  'loadWorldManagerHistoryPage',
  'loadWorldManagerCorrectionsPage',
  'loadWorldManagerHistoryDetail',
  'setWorldManagerCorrectionLifecycle',
  'openWorldManagerReplacementCorrection',
  'jumpToWorldManagerCanonicalMemory'
]) assert.match(overlay, new RegExp(`const ${helper} =`), `missing Commit 4 GUI helper: ${helper}`);

assert.match(overlay, /listWorldManagerHistory\s*\(/, 'History UI must use the paged public History API');
assert.match(overlay, /listWorldManagerCorrections\s*\(/, 'Correction UI must use the paged public Correction API');
assert.match(overlay, /getWorldManagerHistoryDetail\s*\(/, 'History detail must use the detail public API');
assert.match(overlay, /setWorldManagerCorrectionStatus\s*\(/, 'lifecycle actions must use the correction transaction API');
assert.match(overlay, /loadCanonicalReaderDetail\s*\(/, 'canonical jump must use the scope-bound Reader loader');
assert.match(source, /getCanonicalReaderChapter\(\{\s*\.\.\.identity,\s*expectedScopeKey:\s*ticket\.scopeKey\s*\}\)/, 'Reader loader must retain exact public API and scope binding');
assert.doesNotMatch(overlay, /getWorldManagerCorrections\s*\(/,
  'the GUI must not use the compatibility API that loads the complete correction journal');
assert.doesNotMatch(overlay, /stateCorrections|continuityDelta\s*\(|storage\.(?:get|set|remove)|runLLMModel/,
  'History/Correction GUI must not touch storage keys, Delta writers, or an LLM directly');

for (const label of ['변화 기록', '사용자 교정', '적용 중', '재검토 필요', '롤백 뒤 휴면', '대체됨', '삭제됨']) {
  assert.match(overlay, new RegExp(label), `missing user-facing History/Correction label: ${label}`);
}
const historyUi = between('const buildWorldManagerHistoryCorrectionsPanel =', 'const buildWorldManagerDiagnosticsPanel =');
assert.doesNotMatch(historyUi, /worldCorrectionStatus|worldCorrectionReplaceAction|교정 상태|사용자 교정|buildLibraHubTabs/, 'diagnostics must not restore the retired correction tab');
assert.match(overlay, /supersedes/, 'replacement correction must retain an explicit supersedes link');

const publicApi = between('const publicApi = Object.freeze({', 'let retraceIpcRetryTimer');
for (const api of [
  'listWorldManagerHistory', 'getWorldManagerHistoryDetail', 'listWorldManagerCorrections'
]) assert.match(publicApi, new RegExp(`async ${api}\\s*\\(`), `missing public Commit 4 API: ${api}`);

const readerLifecycle = between('const canonicalReaderIdentityKey =', 'const canonicalEvidenceLayerCopy =');
assert.match(readerLifecycle, /Gui\.canonicalReaderSelected\s*=\s*\{ \.\.\.identity, scopeKey: binding\.scopeKey \}/,
  'a History jump must select the exact Reader identity with its current scope');
assert.match(readerLifecycle, /Gui\.canonicalReaderDetail = detail/,
  'a History jump must hydrate the validated Reader Chapter');
assert.match(overlay, /bookNavigate\('memory'\)/,
  'a History jump must enter the Reader view');

const clone = value => JSON.parse(JSON.stringify(value));
const makeNode = (tag, attrs = {}, children = []) => ({
  tag,
  attrs,
  children: (Array.isArray(children) ? children : [children]).filter(Boolean)
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
const click = node => {
  assert.equal(typeof node?.attrs?.onClick, 'function', 'expected a rendered clickable action');
  return node.attrs.onClick({ target: node });
};
const settle = async () => {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
};

const baseHead = corrected => ({
  status: 'ready', throughTurn: 10, updatedAt: '2026-08-31T00:00:00.000Z', worldlineId: 'main',
  basis: { sourceCount: 2, sourceFingerprint: 'fp-current-head' },
  characters: [{
    id: 'c1', name: 'Ada', aliases: ['A'], state: { mood: 'calm' },
    ...(corrected ? { correctionProvenance: { correctionId: 'corr-active' } } : {})
  }],
  relationships: [{
    id: 'r1', subjectId: 'c1', subjectName: 'Ada', targetId: 'c2', targetName: 'Ben',
    dimension: 'trust', state: 'growing', certainty: 'confirmed'
  }],
  world: [{ id: 'w1', name: 'Archive', kind: 'location', aliases: ['Vault'], state: { open: true } }],
  narrative: {
    summary: 'They entered the archive.', momentum: 'Cautious discovery', updatedThroughTurn: 10,
    arcs: [{ id: 'a1', title: 'Archive mystery', status: 'active', phase: 'developing' }],
    threads: [{ id: 't1', arcId: 'a1', type: 'mystery', summary: 'Who sealed the room?', status: 'open' }],
    locks: [{ id: 'l1', summary: 'The door is sealed', status: 'active' }], motifs: [], turningPoints: []
  },
  domainStatus: {
    characters: { status: 'ready', throughTurn: 10 }, relationships: { status: 'ready', throughTurn: 10 },
    world: { status: 'ready', throughTurn: 10 }, narrative: { status: 'ready', throughTurn: 10 }
  }
});
const baseSnapshot = corrected => ({
  scope: { scopeKey: 'scope:test' },
  manifest: { frontiers: { observedTurn: 14, committedTurn: 10 } },
  totals: { memories: 2 }, memories: [], continuityState: baseHead(corrected)
});
const historyItem = {
  memoryId: 'mem_000006', revision: 2, turnRange: { start: 6, end: 10 }, status: 'committed',
  domains: { characters: { changed: 1 }, relationships: { changed: 0 }, world: { changed: 0 }, narrative: { changed: 1 } },
  narrativeSummary: 'The archive opened.', updatedAt: '2026-08-31T00:00:00.000Z'
};
const correctionItem = {
  schema: 'libra.state_correction.v1', correctionId: 'corr-active', scopeKey: 'scope:test',
  worldlineId: 'main', anchor: { throughTurn: 10 }, basisFingerprint: 'fp-current-head',
  target: { domain: 'characters', mode: 'profile_patch' },
  after: { characters: [{ id: 'c1', name: 'Ada', aliases: ['A'], state: { mood: 'calm' } }] },
  policy: 'point_in_time_override', status: 'active',
  createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
};

const makeHarness = ({ corrected = true } = {}) => {
  const state = {
    snapshot: baseSnapshot(corrected),
    calls: { history: [], corrections: [], detail: [], lifecycle: [], canonical: [] },
    navigations: [], statuses: [], renders: 0, refreshCalls: 0,
    historyResult: { items: [clone(historyItem)], nextCursor: 'history-next', hasMore: true },
    correctionResult: { items: [clone(correctionItem)], nextCursor: '', hasMore: false },
    detailResult: { ...clone(historyItem), patch: { characters: [{ op: 'upsert', id: 'c1' }] } },
    lifecycleResult: null,
    canonicalResult: { memoryId: historyItem.memoryId, revision: historyItem.revision, scopeKey: 'scope:test', worldlineId: 'main', text: 'canonical detail', detailLoaded: true },
    refreshResult: null
  };
  const context = {
    LibraMemoryCore: { peekSnapshot: () => state.snapshot },
    Gui: {
      visible: true, bookPage: 'people', openSerial: 1,
      narrativeHubSection: 'current',
      worldManagerDomainSections: { characters: 'current', relationships: 'current', world: 'current' },
      worldManagerSelectedCharacterId: '', worldManagerSelectedRelationshipId: '', worldManagerSelectedWorldId: '',
      worldManagerSelectedArcId: '', worldManagerSelectedThreadId: '', worldManagerSelectedLockId: '',
      worldManagerEditDraft: null, worldManagerEditError: '', worldManagerSaving: false,
      worldManagerHistoryDomain: 'all', worldManagerCorrectionFilter: 'active',
      worldManagerHistoryCursor: '', worldManagerCorrectionCursor: '', worldManagerHistoryTab: 'history',
      worldManagerHistoryItems: [], worldManagerCorrectionItems: [], worldManagerHistoryDetails: {},
      worldManagerHistoryLoaded: false, worldManagerCorrectionsLoaded: false,
      worldManagerHistoryLoading: false, worldManagerCorrectionsLoading: false,
      worldManagerHistoryHasMore: false, worldManagerCorrectionHasMore: false,
      worldManagerHistoryError: '', worldManagerCorrectionError: '',
      worldManagerCorrectionMutationId: '', worldManagerCanonicalMemoryFocus: null,
      memoryHubSection: 'memories'
    },
    guiAsArray: value => Array.isArray(value) ? value : [],
    guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    text: value => String(value ?? ''),
    guiEl: makeNode,
    guiLazyDetails: (attrs, summary, factory) => makeNode('details', attrs, [summary, factory()]),
    libraFormatTime: value => String(value || ''),
    libraStatusBadge: (label, kind) => makeNode('badge', { label, kind }),
    fieldNode: (label, node, note) => makeNode('field', { label, note }, [node]),
    optionNodes: (items, selected) => items.map(item => {
      const pair = Array.isArray(item) ? item : [item, item];
      return makeNode('option', { value: String(pair[0]), text: String(pair[1]), selected: String(pair[0]) === String(selected) });
    }),
    cloneJson: clone,
    buildLibraHubTabs: (definitions, selected, onSelect, ariaLabel) => makeNode('tabs', { ariaLabel },
      definitions.map(definition => makeNode('button', {
        text: definition.label,
        dataset: { hubTab: definition.id },
        onClick: () => {
          if (definition.id === selected) return;
          onSelect(definition.id);
          context.queueGuiNavigationRender();
        }
      }))),
    queueGuiNavigationRender: () => { state.renders += 1; },
    renderSettingsGui: async () => { state.renders += 1; },
    refreshGuiSnapshot: async () => {
      state.refreshCalls += 1;
      return state.refreshResult || state.snapshot;
    },
    guiSetStatus: (...args) => { state.statuses.push(args); },
    sharedNavigate: page => { state.navigations.push(page); },
    bookNavigate: page => { context.Gui.bookPage=page; context.Gui.memoryHubSection='read'; state.navigations.push(page); },
    canonicalReaderIdentityKey: value => `${String(value?.memoryId || '').trim()}:r${Number(value?.revision || 0)}:w:${String(value?.worldlineId || 'main').trim()}`,
    confirm: () => true,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console,
    __LIBRA__: {
      listWorldManagerHistory: async options => {
        state.calls.history.push(clone(options));
        return clone(state.historyResult);
      },
      listWorldManagerCorrections: async options => {
        state.calls.corrections.push(clone(options));
        return clone(state.correctionResult);
      },
      getWorldManagerHistoryDetail: async options => {
        state.calls.detail.push(clone(options));
        return clone(state.detailResult);
      },
      setWorldManagerCorrectionStatus: async (correctionId, status) => {
        state.calls.lifecycle.push({ correctionId, status });
        return clone(state.lifecycleResult || {
          ok: true,
          correction: { ...correctionItem, correctionId, status },
          replay: { ok: true, appliedCorrections: status === 'active' ? [correctionId] : [] },
          head: baseHead(status === 'active')
        });
      },
      getCanonicalReaderChapter: async options => {
        state.calls.canonical.push(clone(options));
        return clone(state.canonicalResult);
      },
      addWorldManagerCorrection: async () => { throw new Error('not expected in this test'); },
      addWorldManagerNarrativeCorrection: async () => { throw new Error('not expected in this test'); }
    }
  };
  Object.assign(context, require('./fixtures/librarian_production_bindings.cjs')(source));
  vm.createContext(context);
  vm.runInContext(`'use strict';\n${overlay}\n${readerLifecycle}\nthis.api = {
    worldManagerSnapshotView,
    buildWorldManagerCharactersPanel, buildWorldManagerRelationshipsPanel,
    buildWorldManagerWorldPanel, buildWorldManagerNarrativePanel,
    buildWorldManagerHistoryCorrectionsPanel, buildWorldManagerDiagnosticsPanel,
    loadWorldManagerHistoryPage, loadWorldManagerCorrectionsPage,
    loadWorldManagerHistoryDetail, setWorldManagerCorrectionLifecycle,
    openWorldManagerReplacementCorrection, jumpToWorldManagerCanonicalMemory
  };`, context);
  return { context, state, api: context.api };
};

// A domain page and the nested History/Correction panel both use `history`.
// Prefer the deepest/last rendered tab so switching back from Corrections clicks
// the nested `변화 기록` tab instead of the already-selected outer entry.
const findTab = (tree, id) => findNodes(tree, node => node?.attrs?.dataset?.hubTab === id).at(-1);
const findDatasetAction = (tree, name) => findNodes(tree, node => node?.attrs?.dataset?.[name])[0];

const renderCurrentMustStayLazy = async () => {
  const harness = makeHarness();
  harness.api.buildWorldManagerCharactersPanel();
  harness.api.buildWorldManagerRelationshipsPanel();
  harness.api.buildWorldManagerWorldPanel();
  harness.api.buildWorldManagerNarrativePanel();
  await settle();
  assert.equal(harness.state.calls.history.length, 0, 'Current Head first render must not load History');
  assert.equal(harness.state.calls.corrections.length, 0, 'Current Head first render must not load Correction Journal rows');
  assert.equal(harness.state.calls.detail.length, 0, 'Current Head first render must not load Delta detail');
};

const everyDomainMustEnterTheSharedLazyHistory = async () => {
  for (const [domain,builder] of [['characters','buildWorldManagerCharactersPanel'],['relationships','buildWorldManagerRelationshipsPanel'],['world','buildWorldManagerWorldPanel'],['narrative','buildWorldManagerNarrativePanel']]) {
    const harness=makeHarness();
    for(const legacy of ['current','structure','evidence','history']) {
      harness.context.Gui.worldManagerDomainSections={[domain]:legacy};
      harness.context.Gui.narrativeHubSection=legacy;
      const tree=harness.api[builder]();
      assert.equal(findNodes(tree,n=>n.tag==='tabs').length,0,domain+' detail must be a single view');
      assert.equal(findDatasetAction(tree,'worldManagerHistoryDomain'),undefined);
      await settle();
      assert.equal(harness.state.calls.history.length,0,'old tab state must not load history');
      assert.equal(harness.state.calls.corrections.length,0,'old tab state must not load corrections');
    }
    harness.context.Gui.worldManagerHistoryDomain=domain;
    const diagnostic=harness.api.buildWorldManagerDiagnosticsPanel();
    await settle();
    assert.equal(harness.state.calls.history.length,1);
    assert.equal(harness.state.calls.history[0].domain,domain);
    assert.equal(findTab(diagnostic,'corrections'),undefined);
  }
};

const openHistoryAndCorrectionsLazily = async () => {
  const harness = makeHarness();
  harness.context.Gui.worldManagerHistoryDomain='characters';
  harness.context.Gui.worldManagerHistoryTab='corrections';
  let tree=harness.api.buildWorldManagerDiagnosticsPanel();
  await settle();
  assert.equal(harness.state.calls.history.length,1);
  assert.equal(harness.state.calls.corrections.length,0);
  assert.deepEqual(harness.state.calls.history[0],{domain:'characters',limit:20,cursor:''});
  assert.equal(findTab(tree,'corrections'),undefined);
  tree=harness.api.buildWorldManagerDiagnosticsPanel();
  const detailAction = findDatasetAction(tree, 'worldHistoryDetailAction');
  assert.ok(detailAction, 'History metadata card must render a detail action');
  click(detailAction);
  await settle();
  assert.equal(harness.state.calls.detail.length, 1, 'detail action must load exactly one Delta detail');
  assert.deepEqual(harness.state.calls.detail[0], { memoryId: historyItem.memoryId, revision: historyItem.revision, worldlineId: 'main' });

  tree = harness.api.buildWorldManagerDiagnosticsPanel();
  const jumpAction = findDatasetAction(tree, 'worldHistoryCanonicalJump');
  assert.ok(jumpAction, 'loaded History detail must render a Canonical Memory jump');
  click(jumpAction);
  await settle();
  assert.equal(harness.state.calls.canonical.length, 1, 'canonical jump must load one exact Canonical Memory detail');
  assert.deepEqual(harness.state.calls.canonical[0], { memoryId: historyItem.memoryId, revision: historyItem.revision, worldlineId: 'main', expectedScopeKey: 'scope:test' });
  assert.equal(harness.context.Gui.canonicalReaderSelected.memoryId, historyItem.memoryId);
  assert.equal(harness.context.Gui.canonicalReaderDetail.revision, historyItem.revision);
  assert.equal(harness.context.Gui.memoryHubSection, 'read');
  assert.equal(harness.state.navigations.at(-1), 'memory');
};

// Legacy lifecycle APIs remain available; removing navigation must not change stored corrections.
const prepareCorrectionPanel = async harness => {
  harness.context.Gui.worldManagerHistoryDomain='characters';
  await harness.api.loadWorldManagerCorrectionsPage(false);
};

const lifecycleFailureMustPreserveUiState = async ({ name, lifecycleResult, refreshResult, expectedRefreshCalls }) => {
  const harness = makeHarness();
  harness.state.refreshResult = refreshResult;
  let tree = await prepareCorrectionPanel(harness);
  const beforeItems = clone(harness.context.Gui.worldManagerCorrectionItems);
  const retainedDraft = { key: `retained-${name}`, values: { note: 'keep me' } };
  harness.context.Gui.worldManagerEditDraft = retainedDraft;
  harness.state.lifecycleResult = lifecycleResult;
  await harness.api.setWorldManagerCorrectionLifecycle(correctionItem,'suspended');
  await settle();
  assert.equal(harness.state.calls.lifecycle.length, 1, `${name}: lifecycle API must be called once`);
  assert.equal(harness.state.refreshCalls, expectedRefreshCalls, `${name}: unexpected refreshed Head readback count`);
  assert.deepEqual(harness.context.Gui.worldManagerCorrectionItems, beforeItems,
    `${name}: failed receipt/readback must not optimistically replace the displayed correction page`);
  assert.equal(harness.context.Gui.worldManagerEditDraft, retainedDraft,
    `${name}: unrelated in-progress correction draft must be retained`);
  assert.ok(harness.context.Gui.worldManagerCorrectionError, `${name}: failure must remain visible in the correction panel`);
  assert.ok(!harness.state.statuses.some(args => args[1] === false), `${name}: failure must not publish a success toast`);
};

const replacementMustUseCurrentBasis = async () => {
  const harness = makeHarness();
  const tree = await prepareCorrectionPanel(harness);
  harness.api.openWorldManagerReplacementCorrection(correctionItem);
  await settle();
  assert.equal(harness.context.Gui.worldManagerEditDraft.supersedes, correctionItem.correctionId);
  assert.equal(harness.context.Gui.worldManagerEditDraft.anchorTurn, 10);
  assert.equal(harness.context.Gui.worldManagerEditDraft.basisFingerprint, 'fp-current-head');
  assert.equal(harness.state.navigations.at(-1), 'characters');
};

(async () => {
  await renderCurrentMustStayLazy();
  await everyDomainMustEnterTheSharedLazyHistory();
  await openHistoryAndCorrectionsLazily();
  await lifecycleFailureMustPreserveUiState({
    name: 'receipt failure',
    lifecycleResult: { ok: false, code: 'STATE_CORRECTION_TRANSACTION_FAILED' },
    refreshResult: null,
    expectedRefreshCalls: 0
  });
  await lifecycleFailureMustPreserveUiState({
    name: 'Head readback failure',
    lifecycleResult: {
      ok: true,
      correction: { ...correctionItem, status: 'suspended' },
      replay: { ok: true, appliedCorrections: [] },
      head: baseHead(false)
    },
    refreshResult: baseSnapshot(true),
    expectedRefreshCalls: 1
  });
  await replacementMustUseCurrentBasis();
  process.stdout.write('libra_world_manager_history_corrections_gui_rc2_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
