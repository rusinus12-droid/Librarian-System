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

const memory = between('const buildApprovedMockupMemory =', 'const buildApprovedMockupSettings =');
assert.match(source, /const SHARED_MEMORY_HUB_SECTIONS = Object\.freeze\(\['read', 'context', 'manage'\]\)/);
assert.match(memory, /loadCanonicalReaderPage\(false\)/);
assert.match(memory, /buildBookMemoryReaderProjection\(\)/);
assert.match(memory, /productMemoryManagement/);
assert.match(memory, /buildBookMemoryReaderProjection\(\)/);
assert.match(memory, /buildLibraMemoriesPanel\(\)/);
assert.match(memory, /buildCanonicalEvidenceDrawer\(\)/);
assert.doesNotMatch(memory, /id: 'runs', label: '실행 기록'/,
  'Memory stays content-focused; execution history belongs to the separate Logs page');
assert.doesNotMatch(memory, /continuity_state|memoryPipelineStage|buildAgentsTab/);

assert.match(source, /const SHARED_EXECUTION_LOG_SECTIONS = Object\.freeze\(\['memory','state','draft','recall','embedding','rebuild'\]\)/,
  'Logs retain all six receipt kinds; Input Writer receipts were retired');

// The retired shared pipeline shell no longer follows the World Manager overlay;
// the overlay now ends where the operational-health settings builders begin.
const overlay = between('const worldManagerSnapshotView =', 'const stateTrackingSettingsForGui =');
const snapshotGetter = between('const worldManagerSnapshotView =', 'const worldManagerDomainCopy =');
const synchronousDomainBuilders = [
  between('const buildWorldManagerCharactersCurrentPanel =', 'const buildWorldManagerRelationshipsCurrentPanel ='),
  between('const buildWorldManagerRelationshipsCurrentPanel =', 'const buildWorldManagerWorldCurrentPanel ='),
  between('const buildWorldManagerWorldCurrentPanel =', 'const resetWorldManagerPagedView ='),
  between('const buildWorldManagerCharactersPanel =', 'const buildWorldManagerNarrativeCurrentPanel ='),
  between('const buildWorldManagerNarrativeCurrentPanel =', 'const narrativeDirectionScopeKey =')
].join('\n');
const firstRenderBoundaries = [snapshotGetter, synchronousDomainBuilders].join('\n');
assert.match(snapshotGetter, /LibraMemoryCore\.peekSnapshot\(\)/);
assert.doesNotMatch(firstRenderBoundaries, /await\s|refreshSnapshot|getWorldManagerNarrative|getCanonicalMemories|getMemoryRuns/,
  'first render must use the in-memory snapshot only');
for (const mutation of [
  'addWorldManagerCorrection', 'appendStateCorrection', 'setWorldManagerCorrectionStatus',
  'rebuildWorldManager', 'rebuildCurrentStateForWorldline', 'setWorldManagerWorldline',
  'rollbackWorldManagerWorldline', 'createCanonicalCandidate', 'adoptCanonicalCandidate'
]) assert.doesNotMatch(firstRenderBoundaries, new RegExp(mutation), `${mutation} must not run across synchronous first-render boundaries`);

for (const builder of [
  'buildWorldManagerCharactersPanel', 'buildWorldManagerRelationshipsPanel',
  'buildWorldManagerWorldPanel', 'buildWorldManagerNarrativePanel'
]) assert.match(overlay, new RegExp(`const ${builder} =`), `missing shared snapshot builder: ${builder}`);

require('./helpers/libra_active_book_routes.cjs')(source);
const ownerRoutes = between('const buildApprovedMockupDestinationDetail =', 'const syncApprovedMockupShell =');
assert.match(ownerRoutes, /buildWorldManagerCharactersPanel\(\)/);
assert.match(ownerRoutes, /buildWorldManagerRelationshipsPanel\(\)/);
assert.match(ownerRoutes, /buildWorldManagerWorldPanel\(\)/);
assert.match(ownerRoutes, /buildWorldManagerNarrativePanel\(\)/);
assert.doesNotMatch(ownerRoutes, /buildLibraContinuityStatePanel|buildLibraStoryArcPanel|buildGradiaHomePanel|buildLibraHomePanel/);

const render = between('async function renderSettingsGuiOnce()', 'const hideSettingsGui =');
assert.doesNotMatch(render, /buildSharedHeaderStatusPanel\(\)|buildInsightRail\(\)/);
assert.match(render, /buildApprovedMockupDestinationDetail\(page\)/);

const fixture = {
  manifest: { frontiers: { observedTurn: 14, committedTurn: 10 } },
  totals: { memories: 2 },
  memories: [{ memoryId: 'm1' }, { memoryId: 'm2' }],
  continuityState: {
    status: 'ready', throughTurn: 10, updatedAt: '2026-08-31T00:00:00.000Z',
    basis: { sourceCount: 2, sourceFingerprint: 'fp' },
    characters: [{ id: 'c1', name: 'Ada', aliases: ['A'], state: { mood: 'calm' } }],
    relationships: [{ id: 'r1', subjectId: 'c1', subjectName: 'Ada', targetId: 'c2', targetName: 'Ben', dimension: 'trust', state: 'growing', certainty: 'confirmed' }],
    world: [{ id: 'w1', name: 'Archive', kind: 'place', state: { open: true } }],
    narrative: {
      summary: 'They entered the archive.', momentum: 'Cautious discovery', updatedThroughTurn: 10,
      arcs: [{ id: 'a1', title: 'Archive mystery', status: 'active', phase: 'developing' }],
      threads: [{ id: 't1', summary: 'Who sealed the room?', status: 'open' }],
      locks: [{ id: 'l1', summary: 'The door is sealed', status: 'active' }], motifs: [], turningPoints: []
    },
    domainStatus: {
      characters: { status: 'ready', throughTurn: 10 }, relationships: { status: 'ready', throughTurn: 10 },
      world: { status: 'ready', throughTurn: 10 }, narrative: { status: 'ready', throughTurn: 10 }
    }
  }
};
const frozen = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) frozen(child);
  return value;
};
frozen(fixture);
const before = JSON.stringify(fixture);
let peekCalls = 0;
const context = {
  LibraMemoryCore: { peekSnapshot: () => { peekCalls += 1; return fixture; } },
  Gui: {
    narrativeHubSection: 'current', worldManagerSelectedCharacterId: '', worldManagerSelectedRelationshipId: '',
    worldManagerSelectedWorldId: '', worldManagerSelectedArcId: ''
  },
  Runtime: { pipelineWorkStatus: {}, inFlight: false },
  guiAsArray: value => Array.isArray(value) ? value : [],
  guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  text: value => String(value ?? ''),
  guiEl: (tag, attrs = {}, children = []) => ({ tag, attrs, children: Array.isArray(children) ? children.filter(Boolean) : [children].filter(Boolean) }),
  guiLazyDetails: (attrs, summary, factory) => ({ tag: 'details', attrs, children: [summary, factory()] }),
  libraFormatTime: value => String(value || ''),
  queueGuiNavigationRender: () => {},
  buildLibraHubTabs: () => ({ tag: 'tabs' }),
  libraStatusBadge: (label, kind) => ({ tag: 'badge', label, kind }),
  activeGuiResponseFamily: () => 'gradia',
  gradiaGuiRuntime: () => ({ gradiaWritingMode: 'rp', internalDraftLanguage: 'ko', injectionMode: 'sga' }),
  gradiaWritingModeCopy: () => ({ label: 'RP 모드' }),
  INTERNAL_DRAFT_LANGUAGE_DEFS: { ko: { label: '한국어' } },
  normalizeInternalDraftLanguage: value => value || 'ko',
  simpleLengthLabelForRuntime: () => '2,000~3,000자',
  LIBRA_RESPONSE_MODE_UI: { classic: { label: 'Classic' }, sga: { label: 'GRADIA' } },
  normalizeResponseInjectionMode: value => value || 'classic',
  sharedNavigate: () => {},
  pipelineWorkStageLabel: value => String(value || '')
};
Object.assign(context, require('./fixtures/librarian_production_bindings.cjs')(source));
  vm.createContext(context);
vm.runInContext(`'use strict';\n${overlay}\nthis.api = { worldManagerSnapshotView, buildWorldManagerCharactersPanel, buildWorldManagerRelationshipsPanel, buildWorldManagerWorldPanel, buildWorldManagerNarrativePanel };`, context);

const view = context.api.worldManagerSnapshotView();
assert.equal(view.throughTurn, 10);
assert.equal(view.characters.length, 1);
assert.equal(view.relationships.length, 1);
assert.equal(view.world.length, 1);
assert.equal(view.narrative.summary, 'They entered the archive.');
for (const name of [
  'buildWorldManagerCharactersPanel', 'buildWorldManagerRelationshipsPanel', 'buildWorldManagerWorldPanel',
  'buildWorldManagerNarrativePanel'
]) assert.doesNotThrow(() => context.api[name](), `${name} must render from the same frozen snapshot`);
assert.equal(JSON.stringify(fixture), before, 'snapshot render must not mutate canonical or continuity data');
assert.ok(peekCalls >= 5, 'each first-render workspace builder must resolve through peekSnapshot');

process.stdout.write('libra_world_manager_shared_snapshot_rc2_test: PASS\n');
