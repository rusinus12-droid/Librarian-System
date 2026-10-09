'use strict';
// Gate: 복제·전환 상속 후 **부모 스코프 식별자가 남지 않는다** (G4)
//
// 왜 필요한가 — 실측(도구 `tools/libra_copy_source_artifact_measure.cjs`):
//   복제본 7/7 엔트리가 부모 `scopeKey`/`chatId` 를 참조했다. `meta.integrity.scopeKey` 뿐 아니라
//   **payload 최상위 `scopeKey`/`chatId`** 였다(`lmai_integrated_packet_journal`,
//   `lmai_recall_feedback`, `lmai_entity_knowledge_vault`).
//
// 왜 해로운가 — 소비처가 **payload 의 scopeKey 로 엔트리를 찾는다**:
//   `08e:721 getManagedScopedEntryScope` → `payload.scopeKey || … || entry.meta.scopeKey`
//   `08e:753 findManagedScopedEntryIndex` → `exact = scope === normalizedScope` / `legacy = !scope`
//   상속 엔트리는 **부모 스코프**라 `exact` 도 `legacy` 도 아니다 → **-1(못 찾음)**
//   → 복제본에서 그 도메인 상태를 찾지 못하고 **새로 시작**한다.
//
// 정본 원리 (`HAYAKU …detachNativeChatCopySourceStorageArtifacts`): 복사본은 부모 저장소를
//   가리키는 산출물을 남기지 않는다(청소한다). 여기서는 **제거가 아니라 리스코프**로 닫는다 —
//   이미 넘어온 기억은 살리고 **식별자만 목적 스코프로** 접는다.
//
// 고정하는 계약:
//   E1 도구가 게이트가 실행할 수 있는 자리에 있다
//   E2 부모 복사본 hydrate 후 **payload scopeKey 가 목적 스코프**다 (실행)
//   E3 부모 chatId 참조가 **남지 않는다** (실행)
//   E4 소비처 매칭(`findManagedScopedEntryIndex` 규칙)이 **찾아낸다** (실행 — 진짜 목적)
//   E5 `meta.integrity.scopeKey` 도 접힌다 (G3 계약 유지)
//   E6 상속된 기억 **본문은 보존**된다 (과잉 제거 금지)
//   E7 (대조군) 부모 쪽 엔트리는 **부모 스코프를 그대로** 갖는다 (부모를 훼손하지 않는다)
//   E8 저장소 키와 active scope 가 분리된다
//   E9 도구가 실제 파싱을 했다 (빈 결과 통과 금지)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'tools/libra_copy_source_artifact_measure.cjs');

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── E1/E9: 도구 실행 + 실제 파싱 ──
let probe = null;
try {
  const out = execFileSync(process.execPath, [PROBE], { timeout: 120000, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  probe = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
} catch (e) {
  const out = String((e && e.stdout) || '');
  if (out.indexOf('{') >= 0) { try { probe = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch (_) {} }
}
assert('measure_tool_ran', !!probe, { note: '측정 도구가 실행되어야 한다' });
if (probe) {
  assert('measure_tool_parsed',
    Number(probe.childEntryCount) > 0 && Number(probe.parentEntryCount) > 0,
    { childEntryCount: probe.childEntryCount, parentEntryCount: probe.parentEntryCount,
      note: '★ 빈 결과로 공허하게 통과하지 않도록 실제 건수를 확인한다' });

  const leaks = probe.leaks || [];
  const byKind = (kind) => leaks.filter(l => (l.where || '').includes(kind));

  // ── E2/E3: 부모 식별자 누출 0 ──
  assert('no_parent_scope_identifier_leaks',
    leaks.length === 0,
    { leakCount: leaks.length,
      scopeLeaks: leaks.filter(l => (l.fields || []).includes('scopeKey')).length,
      chatIdLeaks: leaks.filter(l => (l.fields || []).includes('chatId')).length,
      sample: leaks.slice(0, 3),
      note: '★ 복제본이 부모 스코프/채팅을 참조하면 소비처가 엔트리를 못 찾는다' });

  // ── E4: 소비처 매칭이 찾아낸다 (진짜 목적) ──
  //   `08e:753` 규칙을 그대로 재현: exact(스코프 일치) 또는 legacy(스코프 없음)
  const matchResult = probe.consumerMatch || null;
  assert('consumer_lookup_finds_inherited_entry',
    matchResult && matchResult.found === true,
    { matchResult,
      note: '★ 08e:753 규칙(exact|legacy)으로 찾지 못하면 복제본은 그 도메인을 새로 시작한다' });

  // ── E5: integrity 스코프도 접힘 (G3 계약 유지) ──
  assert('integrity_scope_rescoped',
    Number(probe.integrityScopeLeaks || 0) === 0,
    { integrityScopeLeaks: probe.integrityScopeLeaks,
      note: 'G3 계약(`meta.integrity.scopeKey`)이 상속 경로에서도 유지되어야 한다' });

  // ── E6: 본문 보존 ──
  assert('inherited_content_preserved',
    probe.contentPreserved === true && Number(probe.childEntryCount) === Number(probe.parentEntryCount),
    { contentPreserved: probe.contentPreserved, childEntryCount: probe.childEntryCount, parentEntryCount: probe.parentEntryCount,
      note: '리스코프는 식별자만 바꾼다 — 넘어온 기억을 지우면 안 된다' });

  // ── E7: 대조군 — 부모 훼손 금지 ──
  assert('parent_scope_untouched',
    probe.parentStillParent === true,
    { parentStillParent: probe.parentStillParent,
      note: '★ 부모 엔트리는 부모 스코프를 그대로 가져야 한다(브랜치는 분기지 이동이 아니다)' });

  // ── E8: 저장소/active 분리 ──
  assert('copy_storage_and_active_scope_isolated',
    probe.storageKeyDistinct === true && probe.activeScopeIsCopy === true,
    { storageKeyDistinct: probe.storageKeyDistinct, activeScopeIsCopy: probe.activeScopeIsCopy });
}

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, passed: assertions.filter(a => a.ok).length, total: assertions.length, assertions }, null, 2));
process.exit(ok ? 0 : 1);
