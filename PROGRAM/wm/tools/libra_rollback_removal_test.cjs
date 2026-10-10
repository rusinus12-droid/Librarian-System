'use strict';
// Gate: 스냅샷 롤백 기능이 삭제되었는가 (턴 커밋 계층은 보존).
//
// 사용자 결정: "롤백, 리롤은 다시 만들 거라서 스냅샷 롤백 관련 기능을 삭제해"
//
// 삭제된 것 (실측):
//   - 롤백 전용 모듈 5파일 (05, 05a, 05b, 05c, 05d — 2,893줄):
//     SyncEngine + RollbackSnapshotManager + RollbackJournalManager
//     (저널·스냅샷·삭제감지·폴백·복원·비상스냅샷)
//   - 10e 의 롤백 툼스톤 3함수 (buildHybridRollbackTombstone,
//     hybridMetaMatchesRollbackCriteria, markHybridRollbackTombstones)
//   - MemoryState 롤백 상태 6필드 (rollbackSnapshotsByScope,
//     rollbackJournalBaselineByScope, rollbackJournalRestoredTurnByChatId,
//     rollbackJournalColdStartByScope, emergencySnapshotByScope, rollbackTracker)
//   - RP 연속성 pruneRollbackTurns + GUI 호출 2곳
//   - 09 의 내러티브 롤백 정리 체인 6함수 (collectNarrativeRollbackDeletedRefs
//     외) + recoverNarrativeFromSnapshotIfEmpty
//   - //@arg hybrid_rollback_rows + cfg 매핑
//
// 보존된 것 (턴 커밋 계층 — 실수로 지우면 안 됨):
//   - TurnRecordLedger, canonual commit guard, 05e~05k
//   - 10b/10c/10d 의 rollbackState/rollbackTombstone 행 필드
//     (provenanceStatus(retracted/superseded) 가 설정하고 회상 제외에 쓰인다
//      — 스냅샷 롤백과 이름만 같고 다른 살아있는 경로)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const dist = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
// 주석은 코드가 아니다 — 남겨둔 설명이 결함으로 잡히지 않게 벗겨낸다.
const code = dist.replace(/^\s*\/\/.*$/gm, '');

// ── A. 삭제된 모듈·심볼이 배포본에 없다 ──────────────────────────────────
const removedSymbols = [
  'RollbackJournalManager', 'RollbackSnapshotManager', 'SyncEngine',
  'getRollbackCandidates', 'captureBeforeRequest', 'recordAssistantCommit',
  'detectDeletedMessages', 'listSnapshots', 'loadSnapshot', 'buildChatFingerprint',
  'pruneRollbackTurns', 'collectNarrativeRollbackDeletedRefs',
  'narrativeRecordMatchesDeletedRefs', 'narrativeRefTextMatchesDeletedRefs',
  'filterNarrativeDeletedRefStrings', 'pruneNarrativeStateDeletedRefs',
  'recoverNarrativeFromSnapshotIfEmpty',
  'markHybridRollbackTombstones', 'buildHybridRollbackTombstone',
  'hybridMetaMatchesRollbackCriteria', 'isHybridRollbackTombstoned',
  'rollbackTracker', 'rollbackJournalBaselineByScope', 'rollbackJournalRestoredTurnByChatId',
  'rollbackJournalColdStartByScope', 'emergencySnapshotByScope', 'rollbackSnapshotsByScope',
  '__libraRollbackRestoredTurn', 'hybridRollbackRowsEnabled',
  'rollbackDeletedTurns', 'rollbackDeleteCandidates'
];
const stillPresent = removedSymbols.filter(s => code.includes(s));
assert('rollback_symbols_removed', stillPresent.length === 0, { remaining: stillPresent });

// 레거시 허용 목록은 남긴다 — 사용자가 이미 저장한 롤백 엔트리가
// 턴 계산·항목 분류를 오염시키지 않게 '읽기 쪽'에서 계속 걸러내야 한다.
// (하야쿠/ Hypa V3 잔존 데이터를 읽기 쪽에서만 허용하는 것과 같은 관례.)
const legacyTolerantFiles = ['01g-lore-concurrent-persistence.js', '02h-analysis-preflight-meta.js'];
const legacyOk = legacyTolerantFiles.every(f => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'parts', f), 'utf8');
  return src.includes('lmai_rollback_journal') || src.includes('lmai_rollback_snapshot');
});
assert('legacy_entry_tolerance_kept', legacyOk, { note: '기존 저장 데이터 무해 처리' });

// 롤백 전용 파일이 실제로 사라졌는가
const rollbackFiles = ['05-rollback-turn-commit.js', '05a-rollback-journal-core.js',
  '05b-rollback-snapshot-selection.js', '05c-rollback-fallback-supersession.js',
  '05d-rollback-restore-capture-commit.js'];
const filesStillThere = rollbackFiles.filter(f => fs.existsSync(path.join(ROOT, 'src', 'parts', f)));
assert('rollback_files_deleted', filesStillThere.length === 0, { remaining: filesStillThere });

// 매니페스트에 없다
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'build-manifest.json'), 'utf8'));
const manifestFiles = manifest.parts.map(p => p.file.replace('parts/', ''));
const inManifest = rollbackFiles.filter(f => manifestFiles.includes(f));
assert('rollback_parts_removed_from_manifest', inManifest.length === 0, { remaining: inManifest });
assert('manifest_still_has_turn_commit_parts',
  ['05e-canonical-turn-memory-helpers.js', '05f-turn-ledgers.js', '05g-commit-guard-maintenance-records.js',
   '05j-pending-turn-manager.js'].every(f => manifestFiles.includes(f)), {});

// ── B. 턴 커밋 계층 보존 ─────────────────────────────────────────────────
const preserved = ['TurnRecordLedger', 'buildCanonicalTurnCommitGuard', 'upsertRecord', 'deriveMaxTurn',
  'reconcileCanonicalTurnCommitGuard'];
const missingPreserved = preserved.filter(s => !dist.includes(s));
assert('turn_commit_layer_preserved', missingPreserved.length === 0, { missing: missingPreserved });

// ── C. 살아있는 retraction 경로 보존 (provenanceStatus 기반) ─────────────
assert('provenance_retraction_path_preserved',
  /provenanceStatus/.test(code) && /retracted/.test(code), {});
assert('hybrid_row_schema_preserved',
  /normalizeHybridRollbackState/.test(code) && /rollbackState/.test(code) && /rollbackTombstone/.test(code),
  { note: 'provenanceStatus 가 설정하고 10c/10d 가 읽는 살아있는 행 필드' });

// ── D. arg 선언 정리 ─────────────────────────────────────────────────────
const argsSrc = fs.readFileSync(path.join(ROOT, 'src', 'parts', '00-plugin-shell-and-args.js'), 'utf8');
assert('hybrid_rollback_rows_arg_removed', !argsSrc.includes('hybrid_rollback_rows'), {});
assert('other_hme_args_kept', argsSrc.includes('hybrid_scope_index'), {});

// ── E. 잔존 호출 없음 ────────────────────────────────────────────────────
const srcFiles = fs.readdirSync(path.join(ROOT, 'src', 'parts')).filter(f => f.endsWith('.js'));
const danglingCallers = [];
for (const f of srcFiles) {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'parts', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const sym of ['RollbackJournalManager', 'RollbackSnapshotManager', 'SyncEngine',
    'pruneRollbackTurns', 'recoverNarrativeFromSnapshotIfEmpty', 'markHybridRollbackTombstones',
    'isHybridRollbackTombstoned']) {
    if (new RegExp(`\\b${sym}\\b`).test(s)) danglingCallers.push(`${f}:${sym}`);
  }
}
assert('no_dangling_rollback_calls', danglingCallers.length === 0, { dangling: danglingCallers.slice(0, 10) });

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
