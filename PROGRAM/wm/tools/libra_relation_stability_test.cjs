'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const relationCore = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^08(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const processor = read('src/parts/12-processors-world-entity.js');
const cold = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^04(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
// 스냅샷 롤백 모듈(05/05a~05d)은 삭제됐다. retraction 계약은 남은 턴 커밋·저널
// 계층이 계속 지켜야 하므로 05e 이후 파트를 대상으로 검사한다.
const commitLayer = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^05(?:[e-k]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const gui = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^15(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => read(path.join('src', 'parts', name)))
  .join('');
const checks = [];
const assert = (name, ok, detail='') => { checks.push({name,ok:!!ok,detail}); if(!ok) throw new Error(name); };
try {
  assert('relation_timeline_schema', /libra\.relation\.timeline\.v1/.test(relationCore));
  assert('relation_delta_schema', /libra\.relation\.delta\.v1/.test(relationCore));
  assert('deterministic_relation_delta_id', /relation_delta::\$\{TokenizerEngine\.simpleHash/.test(relationCore));
  assert('relation_projection_recomputed', /const recomputeRelationProjection/.test(relationCore));
  assert('negative_delta_supported', /Math\.max\(-1, Math\.min\(1,/.test(relationCore));
  assert('legacy_relation_peak_merge_removed', !/mergeNullableRelationScore/.test(relationCore));
  assert('legacy_relation_type_floor_removed', !/getRelationFloors|harmonizeRelationMetrics/.test(relationCore));
  assert('axes_no_peak_max_merge', !/for \(const key of Object\.keys\(next\)\) next\[key\] = Math\.max/.test(relationCore));
  assert('timeline_compaction_retains_reversible_provenance', /compactRelationHistoryEvent/.test(relationCore) && /reversible_history_compaction/.test(relationCore) && /provenanceRetained:\s*true/.test(relationCore));
  assert('timeline_has_hard_bound', /RELATION_TIMELINE_LIMIT\s*=\s*96/.test(relationCore));
  assert('compacted_history_is_retractable', /allRelationTimelineEvents\(timeline\)/.test(relationCore) && /timeline\.history/.test(relationCore));
  assert('same_source_upsert', /upsertRelationTimelineEvent/.test(relationCore) && /findIndex\(item => item\.id === event\.id\)/.test(relationCore));
  // 스냅샷 롤백 기계(08b의 capture/discard/restore + MAX_ROLLBACK_SNAPSHOTS)는
  // 완전히 제거됐다. retractRelationTimelineEvents 의 **유일한 프로덕션 호출자**가
  // restore 안에 있었으므로, 이 함수도 이제 공개 API 표면으로만 남아 있다.
  // 계약: 정의는 살아 있어 수동 복원·미래 재구현이 가능해야 하고, 죽은 스냅샷
  // 기계가 되살아나면 안 된다.
  assert('relation_event_retraction_available',
    /const retractRelationTimelineEvents = /.test(relationCore)
    && !/rollbackSnapshots/.test(relationCore)
    && !/captureRollbackSnapshot|restoreRollbackSnapshot/.test(relationCore));
  // 스냅샷이 담던 필드 목록 자체가 사라졌다 — 죽은 페이로드가 재발하지 않는지 확인.
  assert('relation_rollback_snapshot_payload_removed',
    !/metaSourceTurn: target\.meta\?\.sourceTurn/.test(relationCore)
    && !/rollback_snapshot_restore/.test(relationCore));
  // reroll(supersede) 은 턴 커밋 계층의 계약으로 남는다.
  assert('superseded_relation_event_supported', /'superseded'/.test(relationCore) || /'superseded'/.test(commitLayer), {});
  assert('inactive_relation_events_not_prompted', /filter\(isActiveRelationEvent\)/.test(relationCore) && /eventLedger\.filter\(isActiveRelationLedgerItem\)/.test(relationCore));
  assert('relation_auxiliary_provenance_retracted', /relation\?\.eventLedger/.test(relationCore) && /relation\?\.evidence/.test(relationCore) && /ledgerEvent\.status = nextStatus/.test(relationCore));
  assert('relationship_assessment_recomputes_confidence', /const definitionConfidence = stage === 'first_contact'/.test(relationCore) && /const evidenceCount = getRelationEvidenceCount\(source\)/.test(relationCore));
  assert('live_input_separates_delta_and_absolute', /relationDelta:\s*\{/.test(processor) && /details:\s*\{[\s\S]{0,240}closeness:\s*relationDetails\.closeness/.test(processor));
  assert('cold_missing_metrics_do_not_reset_zero', /Number\.isFinite\(Number\(metrics\.closeness\)\).*undefined/.test(cold));
  assert('gui_relation_floor_removed', !/const floors = \(\(\) =>/.test(gui) && !/d\.details\.closeness = Math\.max/.test(gui));
  assert('gui_uses_canonical_manual_projection', /applyManualRelationProjection/.test(relationCore) && /EntityManager\.applyManualRelationProjection/.test(gui));
  assert('manual_projection_supports_nullable_scores', /preserveNullableScores/.test(relationCore) && /details\.closeness == null/.test(relationCore));
  const dynamic = spawnSync(process.execPath, [path.join(root,'tools','libra_relation_timeline_test.cjs')], {cwd:root,encoding:'utf8'});
  assert('dynamic_relation_timeline_suite', dynamic.status===0, dynamic.status===0 ? 'passed' : ((dynamic.stdout||'')+(dynamic.stderr||'')).slice(-4000));
  const result={ok:true,checks,checkedAt:new Date().toISOString()};
  fs.mkdirSync(path.join(root,'test-output'),{recursive:true});
  fs.writeFileSync(path.join(root,'test-output','relation-stability-test.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch (e) {
  const result={ok:false,checks,error:String(e&&e.stack||e),checkedAt:new Date().toISOString()};
  fs.mkdirSync(path.join(root,'test-output'),{recursive:true});
  fs.writeFileSync(path.join(root,'test-output','relation-stability-test.json'),JSON.stringify(result,null,2));
  console.error(JSON.stringify(result,null,2)); process.exit(1);
}
