'use strict';
/**
 * Gate: 내용 없는 기억 레코드가 의미 리콜을 오염시키던 결함.
 *
 * 실측 배경 (2026-09-27, qwen3-embedding:latest 4096D, 실제 저장 항목):
 *   세계 규칙 내용이 하나도 없는데 활성 경로(activePath)만 있다는 이유로
 *   회상 가능한 기억이 만들어졌다. 그 레코드의 검색 텍스트는 22자,
 *   실제 내용은 0자였고 — 무관 질의 top1 이었다 4/4.
 *
 *     무관 질의 최고 코사인   0.4489 → 레코드 제외 시 0.3959
 *     관련 질의 정답 rank1    3/8    → 4/8
 *
 *   수정 후: 내용 0자 레코드가 생성되지 않는다.
 *     A(전체)==B(내용없는레코드제외) → 무관 최고 0.3959, 무관 top1 시스템 0/4, 관련 rank1 4/8
 *
 * 이 게이트는 소스와 dist 가 실제로 그 조건을 지키는지 검사한다.
 * 모델을 다시 부르지 않는다 — 실측 근거는 위 수치로 고정한다.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const assertions = [];
const add = (name, ok, details) => assertions.push({ name, ok: !!ok, details: details || {} });

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hme = readSrc('src/parts/05e-canonical-turn-memory-helpers.js');
const compat = readSrc('src/parts/03c-compact-memory-payload-compat.js');
const recall = readSrc('src/parts/03d-compact-memory-recall-migration.js');
const dist = readSrc('dist/LIBRA World Manager Full.js');

// ① 활성 경로/분류만으로는 회상 기억을 만들지 않는다.
//    내용 신호 블록을 추출해, 그 안에 activePath/classification 이 들어 있으면 결함이다.
const contentSignalMatch = hme.match(/const hasWorldContentSignal = Boolean\(([\s\S]*?)\);/);
const contentSignalBody = contentSignalMatch ? contentSignalMatch[1] : '';
add('active_path_alone_does_not_create_memory',
  !!contentSignalMatch
    && !/meaningfulActivePath/.test(contentSignalBody)
    && !/Boolean\(classification\)/.test(contentSignalBody),
  { body: contentSignalBody.replace(/\s+/g, ' ').trim().slice(0, 140) });

// ② 내용 신호 목록에 실제 규칙 내용이 들어 있다
add('content_signal_requires_real_content',
  /const hasWorldContentSignal = Boolean\(/.test(hme)
    && /worldSummary/.test(hme) && /worldDescription/.test(hme)
    && /meaningfulHighlights\.length > 0/.test(hme)
    && /userWorldCorrection/.test(hme),
  {});

// ③ scene.summary 에 타입 이름을 넣지 않는다
add('scene_summary_not_type_name',
  !/summary: payload\.arcKey === 'world_rule_snapshot' \? 'world_rule_snapshot' : ''/.test(compat)
    && !/summary: classification \? `world:\$\{classification\}` : 'world_rule_snapshot'/.test(hme),
  {});

// ④ 검색/채점 텍스트가 내부 식별자 토큰을 걸러낸다
// 필터가 실제로 동작해야 한다 — 정규식이 살아 있고, 토큰 판정이 빈 문자열을 반환해야 한다.
const filterFn = recall.match(/const searchableIdentifier = \(value = ''\) => \{([\s\S]*?)\n        \};/);
const filterBody = filterFn ? filterFn[1] : '';
add('search_text_filters_identifier_tokens',
  /RECALL_IDENTIFIER_TOKEN_RE/.test(recall)
    && /searchableIdentifier/.test(recall)
    && /if \(RECALL_IDENTIFIER_TOKEN_RE\.test\(raw\)\) return '';/.test(filterBody),
  { active: /if \(RECALL_IDENTIFIER_TOKEN_RE\.test\(raw\)\) return '';/.test(filterBody) });
add('identifier_token_list_covers_world_snapshot',
  /world_rule_snapshot/.test(recall) && /narrative_source_record/.test(recall),
  {});

add('scoring_text_filters_identifier_tokens',
  /push\(searchableIdentifier\(payload\.arcKey\)/.test(recall)
    && /push\(searchableIdentifier\(payload\.arcRole\)/.test(recall),
  {});

// ⑤ 타입/kind/source 식별자가 검색 텍스트 항목에 남아 있지 않다
add('no_type_kind_source_in_search_parts',
  !/item\?\.type,\s*\n\s*\.\.\.\(Array\.isArray\(item\?\.subjects\)/.test(recall)
    && !/flatMap\(item => \[item\?\.text, item\?\.summary, item\?\.type\]\)/.test(recall)
    && !/flatMap\(item => \[item\?\.source, item\?\.kind, item\?\.text\]\)/.test(recall),
  {});

// ⑥ dist 에 반영되어 있다
add('dist_carries_fix',
  /hasWorldContentSignal/.test(dist) && /searchableIdentifier/.test(dist),
  {});

// ⑦ 실측 수치가 소스에 남아 있다 (회귀 시 원인 추적)
add('measured_evidence_recorded',
  /0\.4489/.test(hme) || /0\.4489/.test(recall) || /4\/4/.test(hme),
  {});

const failed = assertions.filter(a => !a.ok);
process.stdout.write(JSON.stringify({
  ok: failed.length === 0,
  suite: 'empty-memory-hub',
  summary: `${assertions.length - failed.length}/${assertions.length}`,
  assertions,
}, null, 1) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
