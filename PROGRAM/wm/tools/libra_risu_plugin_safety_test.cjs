'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const partsDir = path.join(root, 'src', 'parts');
const core = fs.readdirSync(partsDir)
  .filter(name => /^01(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const commit = fs.readdirSync(partsDir)
  .filter(name => /^05(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const provider = read('src/parts/07-token-recall-embedding-emotion.js');
const streaming = fs.readdirSync(partsDir)
  .filter(name => /^13(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const afterRequestWorker = read('src/parts/13d-after-request-worker-unload.js');
const entity = fs.readdirSync(partsDir)
  .filter(name => /^08(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const processor = read('src/parts/12-processors-world-entity.js');
const utils = fs.readdirSync(partsDir)
  .filter(name => /^03(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const gui = fs.readdirSync(partsDir)
  .filter(name => /^15(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const memoryEngine = fs.readdirSync(partsDir)
  .filter(name => /^10(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const coldStart = fs.readdirSync(partsDir)
  .filter(name => /^04(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const allRuntimeSources = [core, commit, streaming, gui, coldStart, memoryEngine, read('src/parts/11-translation-reflection-cbs.js')].join('\n');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  if (!ok) throw new Error(name);
};

try {
  check('after_request_replacer_is_identity', /const libraAfterRequestReplacer = \(content, type\) => \{[\s\S]{0,360}return content;/.test(streaming));
  check('after_request_work_is_detached', /setTimeout\(\(\) => \{[\s\S]{0,120}drainAfterRequestWorkerQueue/.test(streaming));
  check('after_request_drain_timer_is_centralized', /const requestAfterRequestWorkerDrain =/.test(streaming)
    && (streaming.match(/afterRequestWorkerTimer = setTimeout/g) || []).length === 1);
  const pendingRegistrationIndex = afterRequestWorker.indexOf('const pending = alreadyFinalizedBeforeRegister');
  const dashboardBeginIndex = afterRequestWorker.indexOf('ActivityDashboardCore.beginRequest', pendingRegistrationIndex);
  check('dashboard_opens_only_after_new_turn_anchor', pendingRegistrationIndex >= 0
    && dashboardBeginIndex > pendingRegistrationIndex
    && /if \(pending\) \{[\s\S]{0,240}ActivityDashboardCore\.beginRequest/.test(afterRequestWorker));
  check('duplicate_turn_replay_is_terminal', /already_finalized_turn_anchor/.test(afterRequestWorker)
    && /analysisStatus:\s*'done'/.test(afterRequestWorker)
    && /terminalAt:\s*Date\.now\(\)/.test(afterRequestWorker));
  const pendingReplayProof = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'libra_risu_pending_replay_guard_test.cjs')], { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  check('active_pending_anchor_blocks_durable_replay', pendingReplayProof.status === 0,
    pendingReplayProof.stdout + pendingReplayProof.stderr + (pendingReplayProof.error?.message || ''));
  check('after_request_worker_does_not_self_replay', !/finally \{[\s\S]{0,260}scheduleDurableTurnReplay\(job/.test(afterRequestWorker)
    && !/if \(targetStillActive\) \{[\s\S]{0,120}scheduleDurableTurnReplay/.test(afterRequestWorker));
  check('pending_finalize_retry_is_bounded', /PENDING_FINALIZE_RETRY_MAX_ATTEMPTS/.test(core)
    && /PENDING_FINALIZE_RETRY_MAX_AGE_MS/.test(core)
    && /pending finalize retry limit reached/.test(commit));
  check('stream_output_handler_is_synchronous', /const outputHandler = \(content\) => \{[\s\S]{0,180}scheduleOutputCapture[\s\S]{0,100}return content;/.test(streaming));
  check('invalid_editoutput_registration_removed', !/addScriptHandler\(['"]editoutput['"]/.test(streaming));

  check('explicit_target_resolver_fails_closed', /const resolveChatContextByTarget/.test(core)
    && /target_character_mismatch/.test(core)
    && /target_chat_mismatch/.test(core)
    && /preferred_chat_not_found/.test(core));
  check('targeted_chat_and_character_writers', /setChatToIndex/.test(core) && /setCharacterToIndex/.test(core));
  check('canonical_commit_checks_persist_result', /canonical turn persist failed/.test(commit));
  check('all_lore_persist_calls_handle_result', /requireSuccessfulLorePersist/.test(core)
    && !/^\s*await persistLoreToActiveChat\(/m.test(allRuntimeSources));
  check('maintenance_uses_explicit_target', /turn-maintenance-explicit-target/.test(commit) && /maintenance target chat mismatch/.test(commit));
  check('cross_scope_runtime_transaction_guard', /ScopedRuntimeTransaction/.test(core) && /scoped_runtime_transaction_busy/.test(streaming));

  check('raw_turn_wal_precedes_analysis', /const DurableTurnLedger/.test(commit)
    && /libra\.v5\.ltm\.turn-ledger/.test(commit)
    && /record_write_failed/.test(commit)
    && /listPending/.test(commit));
  check('origin_identity_includes_scope_and_request_id', /requestId: String\(payload\?\.requestId/.test(streaming)
    && /scopeKey: String\(payload\?\.scopeKey/.test(streaming));
  check('retry_origin_claims_latest', /provider fallback invokes beforeRequest again/.test(streaming)
    && /const entry = queue\[queue\.length - 1\]/.test(streaming));
  check('equal_responses_not_text_only_deduped', /origin\.scopeKey[\s\S]{0,160}origin\.requestSequence/.test(streaming));

  check('terminal_assistant_prefill_preserved', /getHostSafeTailInsertIndex/.test(streaming)
    && /return list\.length - 1/.test(streaming));
  check('host_messages_are_opaque', /existing roles, multimodal parts, memo\/cache fields/.test(streaming)
    && /requestContainer\.messages\.slice\(\)/.test(streaming));
  check('gemini_original_parts_preserved', /Preserve every host Gemini message \(inlineData, functionCall/.test(streaming)
    && /if \(Array\.isArray\(msg\?\.parts\)\) return msg;/.test(streaming));
  check('libra_custom_prefill_not_in_main_injection', /adding a[\s\S]{0,100}assistant prefill here changes/.test(core)
    && !/const buildFullSystemPrompt[\s\S]{0,280}buildPrefillBlock\(\)/.test(core));
  check('unknown_context_injection_is_conservative', /injectionUnknownHostCapTokens:\s*4000/.test(provider));

  check('absolute_analysis_deadline', /afterRequestAnalysisBudgetMs/.test(commit)
    && /__analysisDeadlineAt/.test(provider)
    && /awaitWithinAnalysisDeadline/.test(provider));
  check('reload_epoch_invalidates_old_workers', /LIBRA_RUNTIME_EPOCH_KEY/.test(core)
    && /invalidateLibraRuntimeEpoch\(\)/.test(streaming)
    && /runtime epoch invalidated before canonical commit/.test(commit));
  check('before_request_disables_embedding_network', /embeddingAllowed:\s*false/.test(streaming)
    && /vars\?\.embeddingAllowed !== false/.test(memoryEngine));

  check('canonical_memory_keeps_user_turn', /buildTurnPayload\(user, ai/.test(commit)
    && /attachToPayload\(payload, user, ai/.test(commit));
  check('pov_facts_not_shared_by_focus', /const allowed = new Set\(\[['"]user['"], ['"]player['"], ['"]main_request['"]\]/.test(utils));
  check('source_turn_is_trusted_and_propagated', /options\?\.sourceTurn/.test(processor)
    && /sourceTurn,\s*\n\s*source: sourceMode/.test(processor));
  // 워터마크 갱신은 엔티티·관계 각각 1곳이다 (스냅샷에 담던 사본 2곳은 제거됨).
  // 남은 2곳이 실제 단조 증가 지점인지 확인한다.
  check('entity_and_relation_monotonic_watermarks', (entity.match(/allowVolatileState/g) || []).length >= 8
    && /entity\.meta\.sourceTurn = Math\.max\(priorSourceTurn, sourceTurn\)/.test(entity)
    && /relation\.meta\.sourceTurn = Math\.max\(priorSourceTurn, sourceTurn\)/.test(entity));
  check('response_language_detection_retained_without_retired_injection', /detectMainResponseLanguageTarget/.test(core)
    && /mainResponseLanguageTarget/.test(commit)
    && !/internalDataLanguageGuardEnabled|internal_data_language_guard_enabled/.test(core));

  const result = { ok: true, checks, checkedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-output', 'risu-plugin-safety-test.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = { ok: false, checks, error: String(error && error.stack || error), checkedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-output', 'risu-plugin-safety-test.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
