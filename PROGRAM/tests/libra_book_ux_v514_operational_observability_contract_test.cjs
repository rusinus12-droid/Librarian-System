'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const between = (start, end) => {
  const i = source.indexOf(start); assert.notEqual(i, -1, `missing ${start}`);
  const j = source.indexOf(end, i + start.length); assert.notEqual(j, -1, `missing ${end}`);
  return source.slice(i, j);
};
const logSectionBody = source.match(/const SHARED_EXECUTION_LOG_SECTIONS = Object\.freeze\(\[([^\]]+)\]\)/)?.[1];
assert.ok(logSectionBody, 'shared execution-log sections remain declared');
const logSections = [...logSectionBody.matchAll(/'([^']+)'/g)].map(match => match[1]);
for (const section of ['memory', 'state', 'draft', 'recall', 'embedding', 'rebuild']) assert.ok(logSections.includes(section), 'execution log retains ' + section);
assert.ok(!logSections.includes('input_writer'), 'retired Input Writer log section stays absent');

const recall = between('const buildLibraRecallViewerPanel =', 'const buildLibraRecallPanel =');
assert.match(recall, /catalogBlockRouting/);
assert.match(recall, /Memory Lane/);
assert.match(recall, /confidence/);

const operational = between('const operationalScopeKey =', 'const buildStateTrackingAvailabilityPanel =');
for (const token of ['사서 시스템 상태','출력 감지','5턴 경계 복구','Memory Lane','State Replay','채팅 복사 연속성','장기 채팅 캐시','Compute Plane','Canonical Jobs']) assert.match(operational, new RegExp(token));
for (const token of ['getCaptureBackendState','loadPendingBoundaryStore','getWorldManagerRuntimeMeta','loadStateWorldlineMeta','listCanonicalJobs','recoverPendingLiveBoundaryAtStartup','rebuildCurrentStateForWorldline','setStateWorldline','rollbackStateWorldline']) assert.match(operational, new RegExp(token));
assert.match(operational, /schedule: false/);
assert.match(operational, /저장이 완료된 5턴 경계/);

const logs = between('const deleteFailedExecutionRun =', 'const buildGeneralSettingsPanel =');
assert.match(logs, /deleteFailedRun/);
assert.match(logs, /실패 기록 삭제/);
assert.match(logs, /최근 정본 작업/);
assert.match(logs, /canonicalJobsArchive: 'debug-recent'/);
assert.match(logs, /resumeCanonicalJob/);
assert.match(logs, /cancelCanonicalJob/);
assert.match(logs, /providerBudget/);
assert.match(logs, /reasoning/);

const debug = between('const buildDebugTab =', 'const buildGenerationPolicyPanel =');
assert.match(debug, /buildCanonicalJobsPanel\(\)/, 'recent canonical jobs belong inside Debug');

const approved=require('./helpers/libra_approved_gui_contract.cjs');
const general=approved.extract(source,'buildGeneralSettingsPanel');
// §34: the four stacked diagnostic panels are now ONE screen with a section rail. The contract is
// that every diagnostic surface remains reachable from 일반 · 진단, and that the section body is
// built lazily — asserted through the dispatcher rather than through four direct calls.
assert.match(general, /buildDiagnosticLogSection\(active\)/, 'General diagnostics must mount the consolidated debug log');
assert.doesNotMatch(general, /buildCanonicalJobsPanel\(\)/, 'General diagnostics must not mount a separate unbounded job archive');

const diagnosticDispatcher=approved.extract(source,'buildDiagnosticLogSection');
// §34.2: the DEFAULT section is now the unified log (list + search + detail); the other three keep
// their panels. Every previous surface is still reachable through the dispatcher.
assert.match(diagnosticDispatcher, /buildDiagnosticLogList\(\)/,
  'the default diagnostic section must render the unified log');
for (const reachable of ['buildSwallowedDiagPanel', 'buildWorldManagerDiagnosticsPanel', 'buildDebugTab']) {
  assert.match(diagnosticDispatcher, new RegExp(`${reachable}\\(\\)`),
    `the consolidated log must still reach ${reachable}`);
}
// 운영 상태 is reachable as its own rail section, not as the default body.
const healthReachable = between('const DIAGNOSTIC_LOG_SECTIONS =', 'const diagnosticLogRows =');
assert.match(healthReachable, /id: 'health'/, '운영 상태 must remain a rail section');
assert.match(between('const buildOperationalHealthPanel =', 'const buildSwallowedDiagPanel ='), /사서 시스템 상태/,
  'the operational health panel itself must survive');
const diagnosticSections = between('const DIAGNOSTIC_LOG_SECTIONS =', 'const buildDiagnosticLogSection =');
for (const id of ['health', 'swallowed', 'state_reflection', 'runtime']) {
  assert.match(diagnosticSections, new RegExp(`id: '${id}'`), `missing diagnostic section: ${id}`);
}
assert.match(general,/guiLazyDetails/,
  'the diagnostic body must be built lazily, not on every render');

assert.match(source, /CANONICAL_JOB_HISTORY_LIMIT = 12/);
assert.match(source, /Runtime\.warnings\.length > 60/);
assert.match(source, /Runtime\.stageTrace\.length > 32/);

const embedding=approved.extract(source,'buildApprovedEmbeddingOperations');
assert.match(embedding, /임베딩|벡터/);
assert.match(embedding, /getQueryCacheStats/);
assert.match(embedding, /clearQueryCache/);
assert.match(embedding, /runAutomaticLegacyVectorMigration/);

assert.match(source, /operationalHealth:\s*\{/);
assert.match(source, /pendingBoundaryRecovery/);
assert.match(source, /pairRevisionCache/);
// The legacy recall catalog (and its background upgrade) was retired by the unified memory engine
// (9c03c35); its long-running background work is now the memory-graph corpus build.
assert.doesNotMatch(source, /recallCatalogUpgradeInFlight/, 'retired recall-catalog upgrade stays absent');
const health = between('    operationalHealth: {', '    warnings: Runtime.warnings.slice(-20),');
assert.match(health, /memoryGraphBuildActive: LibraMemoryCore\.state\.memoryGraphCorpus\?\.inspect\(\)\.activeBuild === true/, 'operational health reports the unified corpus build in flight');
process.stdout.write('libra_book_ux_v514_operational_observability_contract_test: PASS\n');
