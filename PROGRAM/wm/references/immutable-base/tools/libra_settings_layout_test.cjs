'use strict';
// Gate: 설정 화면이 실제로 접이식 그룹으로 정리되어 보이는가.
//
// 배경 (실측): 설정 탭 마크업에는 .ss 섹션이 평면으로 나열돼 있지만,
// GUI 런타임의 composeSettingsPanelLayout() (15a) 이 그것들을 .acc 접이식
// 그룹으로 재구성한다 — 제목·힌트·열림 상태·순서까지 지정한다.
// 즉 "복잡하다"는 판단은 마크업만 보고 내린 오진이었다.
//
// 이 게이트가 단언하는 계약 (런타임 재배치 기준):
//   1) composeSettingsPanelLayout 이 .ss 섹션을 .acc 로 변환한다
//   2) 각 그룹에 사용자용 한국어 제목이 붙는다 (원시 h3 를 노출하지 않음)
//   3) 일부 그룹은 기본 열림이고, 토글 핸들러가 위임으로 배선된다
//   4) 신규 노출 설정이 그 재배치 대상 섹션 안에 있다 (그룹에서 빠지지 않음)
//   5) 재배치는 멱등하다 (두 번 호출해도 중복 생성하지 않음)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const read = (f) => fs.readFileSync(path.join(PARTS, f), 'utf8');
function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
const assertions = [];

const session = read('15a-gui-session-data.js');
const gui = read('15-gui-and-exports.js');

// ── 1. 재배치 함수와 팩토리 ──────────────────────────────────────────────
assertions.push(assert('settings_layout_composer_exists',
  /const composeSettingsPanelLayout = \(\) => \{/.test(session),
  { found: /composeSettingsPanelLayout/.test(session) }));

assertions.push(assert('accordion_factory_exists',
  /const makeGuiAccordion = \(index, title, nodes = \[\], options = \{\}\) => \{/.test(session),
  {}));

assertions.push(assert('composer_is_invoked',
  /composeSettingsPanelLayout\(\);/.test(session),
  {}));

// ── 2. .ss 섹션이 .acc 로 변환된다 ───────────────────────────────────────
assertions.push(assert('composer_converts_ss_sections_to_accordions',
  /classList\?\.contains\('ss'\)/.test(session) && /makeGuiAccordion\(/.test(session),
  {}));

// ── 3. 사용자용 한국어 제목 매핑 ─────────────────────────────────────────
const wantedTitles = [
  'LLM 프로필과 작업별 배정',
  '모델 세부 설정과 Flex Service Tier',
  '임베딩과 기억 검색',
  '분석 범위와 내부 데이터'
];
const missingTitles = wantedTitles.filter(t => !session.includes(t));
assertions.push(assert('accordion_titles_are_user_facing', missingTitles.length === 0, {
  missing: missingTitles
}));

// ── 4. 열림 상태 + 토글 위임 ─────────────────────────────────────────────
assertions.push(assert('accordion_open_states_defined',
  /open: true/.test(session) && /open: \/Flex\|Service Tier\|Embedding\|임베딩\//.test(session),
  {}));

assertions.push(assert('accordion_toggle_delegated',
  /closest\?\.\('\.acc-h'\)/.test(session) && /classList\.toggle\('open'\)/.test(session),
  {}));

// ── 5. 멱등성 (중복 생성 방지) ───────────────────────────────────────────
assertions.push(assert('composer_is_idempotent',
  /libraLayoutComposed === '1'/.test(session),
  {}));

// ── 6. 재배치가 신규 설정 섹션을 포함한다 ────────────────────────────────
const dataSectionStart = gui.indexOf('⚖ 데이터 작성 & 가중치');
const dataSection = gui.slice(dataSectionStart, dataSectionStart + 12000);
const newSettingIds = ['swmode', 'swsim', 'swimp', 'swrec', 'sreg', 'sscprof', 'smaxlimit', 'sthr', 'ssimthr',
  'sinjbp', 'sinjbtok', 'semotion', 'ssecret', 'svault', 'scbs', 'screfl', 'spsync', 'sswi', 'sstream',
  'sbypass', 'srag', 'shme', 'shmegraph', 'shmedbg', 'srplt', 'srplttl', 'srplchars', 'sapara'];
const notInSection = newSettingIds.filter(id => !new RegExp(`id="${id}"`).test(dataSection));
assertions.push(assert('new_settings_live_in_a_composed_section', notInSection.length === 0, {
  missingFromDataSection: notInSection
}));

// ── 7. 재배치가 응답 개선 섹션을 '작동 방식' 으로 별도 배치한다 ──────────
// ── 8. 표시 번호가 01..N 순차인가 (중복·건너뜀 방지) ────────────────────
assertions.push(assert('accordion_index_numbers_are_sequential',
  /accordions\.forEach\(\(acc, order\) =>/.test(session) &&
  /String\(order \+ 1\)\.padStart\(2, '0'\)/.test(session) &&
  !/makeGuiAccordion\(1, 'LLM 프로필과 작업별 배정'/.test(session),
  {}));

assertions.push(assert('response_section_is_separated_as_work_mode',
  /prototype-work-mode/.test(session) && /작동 방식/.test(session),
  {}));

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
