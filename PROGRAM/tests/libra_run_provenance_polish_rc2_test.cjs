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

const executionPanel = between('const loadExecutionReceiptPage =', 'const buildSharedExecutionLogsPanel =');
assert.match(executionPanel, /listExecutionReceipts\(\{ kind, limit: 20, cursor:/,
  'the Logs workspace must read normalized execution receipts');
assert.match(executionPanel, /getExecutionReceiptDetail\(\{ kind, id,/,
  'receipt details must hydrate through the read-only receipt API');
assert.doesNotMatch(source, /const buildLibraRunsPanel\s*=/,
  'the retired memory-run status panel must remain physically absent');

// Domain cards require a source badge with the authority mapping fixed by the
// plan, rather than the current two-state AI/user label.
const worldManagerGui = between('const worldManagerSnapshotView =', 'const stateTrackingSettingsForGui =');
assert.match(worldManagerGui, /const worldManagerSourceBadge\s*=/,
  'missing World Manager source-badge resolver');
for (const label of ['사용자 교정', 'Character ito', 'World ito', 'Plot ito', 'Ariadne', '이전 데이터 이관', '출처 미확인']) {
  assert.match(worldManagerGui, new RegExp(label), `missing source badge label: ${label}`);
}
assert.match(worldManagerGui, /worldManagerSourceBadge\s*\(/,
  'World Manager cards do not render the source-badge resolver');

const sourceBadgeFragment = between('const worldManagerCorrectionId =', 'const buildWorldManagerSnapshotNotice =');
const sourceContext = {
  text: value => String(value ?? ''),
  guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  libraStatusBadge: (label, kind) => ({ label, kind })
};
Object.assign(sourceContext,require('./fixtures/librarian_production_bindings.cjs')(source));
vm.createContext(sourceContext);
vm.runInContext(`${sourceBadgeFragment}\nthis.worldManagerSourceBadge = worldManagerSourceBadge;`, sourceContext);
const badgeLabel = (domain, row, view) => sourceContext.worldManagerSourceBadge(domain, row, view).label;
assert.equal(badgeLabel('characters', { correctionProvenance: { correctionId: 'c1' } }, {}), '사용자 교정');
assert.equal(badgeLabel('characters', {}, { domainStatus: { characters: { source: 'character_ito' } } }), 'Character ito');
assert.equal(badgeLabel('world', {}, { domainStatus: { world: { source: 'world_ito' } } }), 'World ito');
assert.equal(badgeLabel('narrative', {}, { domainStatus: { narrative: { status: 'ready', source: 'plot_ito' } }, narrative: { source: 'plot_ito' } }), 'Plot ito');
assert.match(badgeLabel('narrative', {}, { domainStatus: { narrative: { status: 'ready', source: 'ariadne_seed', reason: 'ariadne_seed_fallback' } }, narrative: { source: 'ariadne_seed' } }), /^Ariadne/);
assert.equal(badgeLabel('narrative_arc', { evidence: { source: 'legacy_story_arc_migration' } }, { domainStatus: { narrative: { status: 'ready' } } }), '이전 데이터 이관');
for (const [domain, view, forbidden] of [
  ['characters', { domainStatus: { characters: { status: 'ready' } } }, 'Character ito'],
  ['world', { domainStatus: { world: { status: 'ready' } } }, 'World ito'],
  ['narrative', { domainStatus: { narrative: { status: 'ready' } }, narrative: {} }, 'Plot ito']
]) {
  const unknownLabel = badgeLabel(domain, {}, view);
  assert.match(unknownLabel, /출처 미확인/,
    `a legacy ${domain} Head without provenance must be labelled as unknown`);
  assert.doesNotMatch(unknownLabel, new RegExp(forbidden),
    `a legacy ${domain} Head without provenance must not be relabelled as ${forbidden}`);
}

// Runtime meta remains a bounded diagnostics read, but the retired Home/status
// dashboard must not remain as dead GUI code.
const guiState = between('const Gui = {', 'function canonicalJobElapsed');
for (const field of ['worldManagerRuntimeMeta', 'worldManagerRuntimeMetaLoading', 'worldManagerRuntimeMetaError']) {
  assert.match(guiState, new RegExp(`${field}:`), `missing GUI runtime-meta state: ${field}`);
}
assert.doesNotMatch(source, /const (?:loadWorldManagerRuntimeMeta|scheduleWorldManagerRuntimeMetaLoad|replayWorldManagerFromHome|openWorldManagerDiagnostics)\s*=/,
  'retired Home runtime-meta adapters must remain physically absent');

assert.doesNotMatch(source, /const buildSharedHomeOverviewPanel =|const buildSharedHeaderStatusPanel =|const buildInsightRail =|const buildActiveDraftSummaryCard =/,
  'retired Home, status, insight, and draft-summary builders must be physically absent');

process.stdout.write(`libra_run_provenance_polish_rc2_test: PASS (${path.basename(sourcePath)})\n`);
