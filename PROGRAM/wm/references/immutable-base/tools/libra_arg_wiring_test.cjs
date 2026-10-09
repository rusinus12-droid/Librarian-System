'use strict';
// Gate: //@arg 선언과 실제 소비/GUI 노출의 정합성.
//
// 배경 (실측):
//  ① getVal 로 소비되는데 //@arg 선언이 없는 arg 20개 — 사용자가 RisuAI 인자
//     화면에서 설정할 방법이 없다 (기본값만 적용됨).
//  ② //@arg 로 선언됐지만 GUI 설정 화면에 노출되지 않은 arg — 선언은 있어도
//     실제로 바꿀 수 없다.
//
// 이 게이트가 단단언하는 계약:
//   1) 소비되는 모든 getVal arg 는 //@arg 로 선언되어 있다
//   2) 핵심 사용자 설정 arg 는 GUI 가 읽는 element id 로 연결되어 있다
//   3) 선언 제거(은퇴)한 arg 는 소비되지도 GUI 에도 없다
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
const assertions = [];
const read = (f) => fs.readFileSync(path.join(PARTS, f), 'utf8');

const shell = read('00-plugin-shell-and-args.js');
const init = read('14-main-initialization.js');
const guiMarkup = read('15-gui-and-exports.js');
const guiConfig = read('15c-gui-settings-config.js');
const guiEvents = read('15d-gui-events-finalize.js');

// ── 1. 선언 집합 ─────────────────────────────────────────────────────────
const declared = new Set();
for (const m of shell.matchAll(/^\/\/@arg\s+(\S+)\s+\S+\s+.*$/gm)) declared.add(m[1]);

// ── 2. 소비 집합 (getVal 2번째 인자 + readRuntimeArg/getRuntimeArgVal/hasRuntimeArgValue 리터럴) ──
const consumed = new Map();
const parts = fs.readdirSync(PARTS).filter(f => f.endsWith('.js'));
for (const f of parts) {
  const s = read(f);
  for (const m of s.matchAll(/getVal\(\s*'[^']*'\s*,\s*'([a-z0-9_]+)'/g)) consumed.set(m[1], f);
  for (const m of s.matchAll(/(?:hasRuntimeArgValue|getRuntimeArgVal|readRuntimeArg)\(\s*'([a-z0-9_]+)'/g)) consumed.set(m[1], f);
}

const undeclared = [...consumed.keys()].filter(k => !declared.has(k)).sort();
assertions.push(assert('every_consumed_arg_is_declared', undeclared.length === 0, {
  count: undeclared.length, undeclared
}));

// ── 3. 은퇴(arg 제거)한 것은 소비되지도 않아야 한다 ──────────────────────
const retiredArgs = [
  'world_additional_enabled', 'world_additional_mode', 'world_additional_user_impact_limit',
  'world_additional_auto_integrate', 'world_canon_custom_text', 'world_canon_custom_force',
  'world_additional_custom_text', 'world_additional_custom_force'
];
const stillConsumed = retiredArgs.filter(k => consumed.has(k));
assertions.push(assert('retired_args_are_neither_declared_nor_consumed',
  stillConsumed.length === 0 && retiredArgs.every(k => !declared.has(k)),
  { stillConsumed, stillDeclared: retiredArgs.filter(k => declared.has(k)) }));

// ── 4. 핵심 사용자 설정이 GUI 에 노출되어 있다 ───────────────────────────
// arg → GUI 가 읽는 element id. GUI 는 arg 이름이 아니라 id 로 값을 읽는다
// (buildSettingsConfigFromUI 가 overlay.querySelector('#id') 로 수집).
const ARG_TO_GUI_ID = {
  // 회상 / 가중치
  weight_mode: 'swmode', w_sim: 'swsim', w_imp: 'swimp', w_rec: 'swrec',
  scoring_profile: 'sscprof', recall_evidence_gate: 'sreg',
  // 기억
  max_limit: 'smaxlimit', threshold: 'sthr', sim_threshold: 'ssimthr',
  // HME
  hybrid_memory_engine: 'shme', hme_associative_graph: 'shmegraph', hme_graph_debug: 'shmedbg',
  // 주입
  injection_budget_preset: 'sinjbp',
  // 토글류
  emotion_enabled: 'semotion', secret_knowledge_enabled: 'ssecret',
  entity_knowledge_vault_enabled: 'svault', cbs_enabled: 'scbs',
  character_source_reflection_enabled: 'screfl', persona_binding_sync_enabled: 'spsync',
  section_world_inference_enabled: 'sswi',
  // 스트리밍 / 우회
  response_streaming_compat_enabled: 'sstream', bypass_aux_requests: 'sbypass',
  // RP 장기기억
  rp_long_term_memory_enabled: 'srplt', rp_long_term_long_ttl: 'srplttl',
  // 유지보수
  after_request_parallel_analysis: 'sapara',
  // 초기 분석
  cold_start_scope_preset: 'scsp',
};

const missingInMarkup = [];
const missingInReader = [];
for (const [arg, id] of Object.entries(ARG_TO_GUI_ID)) {
  if (!new RegExp(`id="${id}"`).test(guiMarkup)) missingInMarkup.push(`${arg}(${id})`);
  // GUI 가 그 id 를 실제로 읽어 설정에 넣는지
  if (!new RegExp(`#${id}['"]`).test(guiConfig)) missingInReader.push(`${arg}(${id})`);
}
assertions.push(assert('key_settings_have_gui_markup', missingInMarkup.length === 0, {
  count: missingInMarkup.length, missing: missingInMarkup
}));
assertions.push(assert('key_settings_are_read_by_gui', missingInReader.length === 0, {
  count: missingInReader.length, missing: missingInReader
}));

// ── 5. GUI 가 읽는 id 는 마크업에 실제로 존재한다 (오타/삭제 방지) ───────
const markupIds = new Set([...guiMarkup.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
const readIds = new Set();
for (const s of [guiConfig, guiEvents, guiMarkup]) {
  for (const m of s.matchAll(/querySelector\(\s*['"]#([a-zA-Z0-9_-]+)['"]\s*\)/g)) readIds.add(m[1]);
}
// 의도적으로 마크업에서 뺀 필드(자연어 입력만 노출하는 설계)는 허용한다.
// libra_gui_health_review_test 의 gui_user_dlc_*_hides_engineering_fields 가
// 그 숨김을 계약으로 단언하고 있다.
const INTENTIONALLY_HIDDEN_IDS = new Set([
  'udlc-world-kind', 'udlc-world-title', 'udlc-world-concept', 'udlc-world-prompt',
  'btn-register-user-dlc-world',
  'udlc-analysis-label', 'udlc-analysis-content', 'btn-register-user-dlc-analysis',
  'udlc-tracker-label', 'udlc-tracker-instruction', 'udlc-tracker-values',
  'udlc-tracker-update-mode', 'btn-register-user-dlc-tracker',
  'udlc-world-analysis-prompt', 'udlc-entity-prompt'
]);
const danglingReads = [...readIds].filter(id => !markupIds.has(id) && !INTENTIONALLY_HIDDEN_IDS.has(id)).sort();
assertions.push(assert('gui_reads_only_existing_ids', danglingReads.length === 0, {
  count: danglingReads.length, dangling: danglingReads.slice(0, 12),
  allowedHidden: INTENTIONALLY_HIDDEN_IDS.size
}));

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
