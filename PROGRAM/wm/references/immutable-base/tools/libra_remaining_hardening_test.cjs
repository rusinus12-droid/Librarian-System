'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const partsDir = path.join(root, 'src', 'parts');
const partFiles = fs.readdirSync(partsDir).filter(name => name.endsWith('.js')).sort();
const allParts = partFiles.map(name => read(path.join('src', 'parts', name))).join('\n');

const checks = [];
const assertCheck = (name, condition, detail = null) => {
  const row = { name, ok: !!condition, detail };
  checks.push(row);
  if (!condition) {
    const error = new Error(`Remaining-hardening assertion failed: ${name}`);
    error.detail = detail;
    throw error;
  }
};
const writeResult = error => {
  const result = { ok:!error, checks, ...(error ? { error:String(error.stack || error), detail:error.detail || null } : {}), checkedAt:new Date().toISOString() };
  const outDir = path.join(root, 'test-output');
  fs.mkdirSync(outDir, { recursive:true });
  fs.writeFileSync(path.join(outDir, 'remaining-hardening-test.json'), JSON.stringify(result, null, 2));
  (error ? console.error : console.log)(JSON.stringify(result, null, 2));
  if (error) process.exitCode = 1;
};
async function verifyRuntimeContracts() {
  const {verifySnapshotAdmission,verifyIsolatedGraphPersistence}=require('./libra_behavior_contract_helpers.cjs');
  assertCheck('active_chat_snapshot_admission_behavior',Boolean(await verifySnapshotAdmission()));
  assertCheck('hme_isolated_node_persistence_behavior',Boolean(await verifyIsolatedGraphPersistence()));
}

try {
  const core = partFiles.filter(name => /^01(?:-|[a-z]).*\.js$/i.test(name))
    .map(name => read(path.join('src', 'parts', name)))
    .join('');
  const recall = read('src/parts/07-token-recall-embedding-emotion.js');
  const commit = partFiles.filter(name => /^05(?:-|[a-z]).*\.js$/i.test(name))
    .map(name => read(path.join('src', 'parts', name)))
    .join('');
  const streaming = partFiles.filter(name => /^13(?:-|[a-z]).*\.js$/i.test(name))
    .map(name => read(path.join('src', 'parts', name)))
    .join('');
  const archive = partFiles.filter(name => /^09(?:-|[a-z]).*\.js$/i.test(name))
    .map(name => read(path.join('src', 'parts', name)))
    .join('\n');
  const hme = partFiles.filter(name => /^10(?:-|[a-z]).*\.js$/i.test(name))
    .map(name => read(path.join('src', 'parts', name)))
    .join('');
  // 스냅샷 롤백 삭제 후 retraction 은 관계·엔티티 계층(08)이 담당한다.
  const relationSource = partFiles.filter(name => /^08(?:-|[a-z]).*\.js$/i.test(name))
    .map(name => read(path.join('src', 'parts', name)))
    .join('');
  const harness = read('tools/libra_97_test_harness.cjs');

  assertCheck('direct_injection_default', /libraInjectionMode\s*:\s*['"]direct['"]/.test(core));
  assertCheck('projection_bundle_default_off', /libraProjectionRecallBundle\s*:\s*['"]off['"]/.test(core));
  assertCheck('projection_always_active_default_false', /libraProjectionAlwaysActive\s*:\s*false/.test(recall));
  assertCheck('no_legacy_lorebook_writes', !/\.lorebook\s*=/.test(allParts));
  assertCheck('canonical_global_lore_write', /globalLore\s*=/.test(core));
  assertCheck('legacy_lorebook_read_only_fallback', /globalLore[\s\S]{0,300}lorebook/.test(core));

  assertCheck('no_persistent_synthetic_fallback', !/fallbackSyntheticId/.test(commit + '\n' + streaming));
  assertCheck('retired_complex_world_detector_has_no_runtime_reference', !/ComplexWorldDetector|complexAnalysis/.test(commit + '\n' + streaming));
  assertCheck('no_forced_synthetic_anchor_commit', !/합성\s*앵커/.test(streaming));
  assertCheck('commit_requires_actual_message_id', /resolvedMessageId/.test(commit) && /latestIds/.test(commit));
  assertCheck('commit_blocks_while_streaming', /if\s*\(chat\?\.isStreaming\s*===\s*true\)\s*return\s*\{\s*status:\s*['\"]waiting['\"]/.test(commit));
  assertCheck('risu_generation_chat_id_is_message_anchor', /msg\?\.chatId/.test(commit) && /generationInfo\?\.generationId/.test(commit));
  assertCheck('after_request_commit_reacquires_current_chat', /await refreshCommitContext\(\)/.test(commit) && /resolveActiveChatContext/.test(commit));
  assertCheck('post_editoutput_message_can_anchor_pending_turn', /hostPersistedAfterRequest/.test(commit) && /(?:currentLatest|latest)\.currentMessageCount === pendingMessageCount \+ 1/.test(commit));
  assertCheck('historical_assistant_hash_can_anchor_backlog_turn', /findPersistedAssistantSnapshotByHash/.test(commit) && /historicalAssistantMatch/.test(commit));
  assertCheck('post_editoutput_acceptance_remains_bounded', /latestMessageTime >= pendingCreatedAt - 2000/.test(commit) && !/fallbackSyntheticId/.test(commit));

  // 스냅샷 롤백 모듈이 provenanceStatus='retracted' 를 설정했다. 그 모듈은 삭제됐고,
  // retraction 은 08 계열의 relation/entity 계층이 계속 담당한다.
  assertCheck('provenance_retracted_status', /provenanceStatus|'retracted'/.test(commit) || /'retracted'/.test(relationSource) || /'retracted'/.test(commit));
  assertCheck('provenance_superseded_status', /provenanceStatus/.test(commit) || /'superseded'/.test(relationSource));
  assertCheck('hme_filters_retracted', /provenanceStatus\s*===\s*['"]retracted['"]/.test(hme));
  assertCheck('hme_filters_superseded', /provenanceStatus\s*===\s*['"]superseded['"]/.test(hme));

  assertCheck('context_aware_budget_resolution', /resolveContextAwareInjectionBudget/.test(streaming));
  assertCheck('boundary_preserving_block_fitting', /fitInjectionBlocksToBudget/.test(streaming));
  assertCheck('budget_audit_alias_valid', /const\s+globalHardcapResult\s*=\s*fittedInjection/.test(streaming));
  assertCheck('target_budget_fallback_preserved', /injectionBudgetMaxTokens/.test(recall) && /getInjectionBudgetPresetTokens\(['\"]max['\"]\)/.test(recall));
  assertCheck('no_legacy_whole_tail_cap_call', !/enforceGlobalInjectionHardCap\s*\(\s*uncappedContextStr/.test(streaming));

  assertCheck('persistent_archive_shard_schema', /libra\.persistent_memory_shard\.v1/.test(archive));
  assertCheck('persistent_archive_manifest_schema', /libra\.persistent_memory_manifest\.v1/.test(archive));
  assertCheck('persistent_archive_wal_schema', /libra\.persistent_memory_wal\.v1/.test(archive));
  assertCheck('archive_namespaced_keys', /libra:v1:/.test(archive));
  assertCheck('archive_readback_verification', /readPersistentShard/.test(archive) && /checksum/.test(archive));
  assertCheck('archive_ack_only_delete', /ackedIds/.test(archive) && /ackedIds/.test(hme));

  assertCheck('sharded_managed_lore_pack', /PACK_TARGET_CHARS/.test(core) && /PACK_MAX_ENTRIES/.test(core));
  assertCheck('deterministic_pack_fingerprint', /entryPackFingerprint/.test(core) && /stableHash/.test(core));
  assertCheck('pack_cache_byte_budget', /PACK_CACHE_BASE_BYTES/.test(core) && /packContentCacheBytes/.test(core));
  assertCheck('unpack_cache_byte_budget', /UNPACK_CACHE_BASE_BYTES/.test(core) && /unpackContainerCacheBytes/.test(core));
  assertCheck('pack_has_no_dynamic_last_update', !/lastUpdate\s*:\s*Date\.now\(\)/.test(core.slice(core.indexOf('const LibraLoreConsolidator'), core.indexOf('const LIBRA_HIDDEN_OPERATIONAL_DEFAULTS'))));

  assertCheck('identity_database_excludes_character_snapshot', /LIBRA_IDENTITY_DB_READ_KEYS\s*=\s*Object\.freeze\(\[['"]personas['"],\s*['"]selectedPersona['"]\]\)/.test(core)
    && /getLibraIdentityDatabase/.test(core)
    && /getLibraIdentityDatabase\(\)/.test(streaming));

  assertCheck('hme_graph_incremental_row_patch', /incrementallyPatchHmeGraphIndexRows/.test(hme) && /mode:\s*['\"]incremental_row_patch['\"]/.test(hme));
  assertCheck('hme_row_upsert_uses_incremental_graph', /graphResult\s*=\s*incrementallyPatchHmeGraphIndexRows/.test(hme));
  assertCheck('hme_incremental_graph_uses_canonical_row_ids', /const\s+changedRowIds\s*=\s*\[\]/.test(hme)
    && /changedRowIds\.push\(String\(row\.id\)\)/.test(hme)
    && /incrementallyPatchHmeGraphIndexRows\([\s\S]{0,220}changedRowIds/.test(hme));


  assertCheck('cold_reanalysis_exact_assertion', /cold_only_reanalysis_exactly_idempotent/.test(harness));
  assertCheck('cold_reanalysis_requires_exact_counts', /afterReanalysis\.totalLore\s*===\s*afterCold\.totalLore/.test(harness)
    && /afterReanalysis\.memories\s*===\s*afterCold\.memories/.test(harness)
    && /afterReanalysis\.hmeRows\s*===\s*afterCold\.hmeRows/.test(harness));

  // 체크포인트 드레인 예산 — 실측에 맞춘 값이어야 한다 (커밋 `1c1440f`).
  //   종전 30s 는 턴 60+ 에서 정착 **직전에** 끊겨 `drain_not_settled` 를 만들었다
  //   (실측: 필요 45.4s vs 예산 30s, 최대 관측 46.7s @ turn 90).
  //   이 예산은 **하네스 전용**이고 제품 상한은 아래 최종 드레인 240s(=5분)다.
  const checkpointBudget = (() => {
    const m = /LIBRA_CHECKPOINT_WAIT_MS\s*\|\|\s*(\d+)/.exec(harness);
    return m ? Number(m[1]) : 0;
  })();
  assertCheck('checkpoint_drain_budget_matches_measured_settle',
    checkpointBudget >= 90000,
    { budgetMs: checkpointBudget, requiredMs: 90000, measuredMaxMs: 46700,
      note: '측정 최대 46.7s 보다 충분히 커야 정착 직전에 끊기지 않는다' });
  assertCheck('checkpoint_budget_below_product_cap',
    checkpointBudget > 0 && checkpointBudget <= 240000,
    { budgetMs: checkpointBudget, productCapMs: 240000,
      note: '체크포인트 예산이 제품 상한(최종 드레인 240s·5분)을 넘으면 계약이 뒤집힌다' });
  assertCheck('drain_timeout_reports_unmet_conditions',
    /unmet\.push\(`committed/.test(harness) && /unmet\.push\(`analyzed/.test(harness),
    { note: '★ 타임아웃 시 **어느 조건**이 안 맞았는지 남겨야 재진단이 가능하다(종전엔 판정 불가)' });
  assertCheck('checkpoint_summary_carries_unmet',
    /unmet:\s*Array\.isArray\(drain\.unmet\)/.test(harness),
    { note: '수집한 unmet 을 결과에 실어야 게이트가 원인을 보여준다' });

  verifyRuntimeContracts().then(() => writeResult()).catch(writeResult);
} catch (error) {
  writeResult(error);
}
