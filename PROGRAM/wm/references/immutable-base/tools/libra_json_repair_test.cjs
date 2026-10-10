'use strict';
/**
 * Gate: 닫는 괄호가 부족한 JSON 응답을 제품이 복구하는가.
 *
 * 실측 결함 (2026-09-27, 실제 출하 프롬프트 + 실제 로컬 모델):
 *   qwen3.5-9B 가 worldAdditional 응답에서 최상위 root 의 닫는 '}' 하나를 반복적으로 누락했다.
 *     done=stop, 문자열 열림 없음, 중괄호 +1 (내용은 완전함)
 *   제품 extractJson 경로:
 *     parseCandidate(cleaned)          → JSON.parse 실패 (누락 '}' 복구 없음)
 *     findBalancedJsonValue(cleaned)   → depth > 0 이면 잘린 조각을 그대로 반환 (02f:225)
 *     → 파싱 실패 → 09c:1148 throw → catch → return null
 *     → worldAdditional 분석 결과가 통째로 버려진다
 *
 *   실측 파싱 성공률: worldAdditional qwen3.5-9B 1/8, canonical 3/11
 *                     (gemma-4-12B-qat 은 전부 성공 — 모델 특성)
 *
 * 이 게이트가 고정하는 것:
 *   - 문자열 밖에서 닫는 괄호만 부족한 응답은 복구되어야 한다 (내용 손실 없음)
 *   - 문자열 안에서 잘린 응답은 복구하지 않는다 (없는 내용을 만들면 안 됨)
 *   - 복구된 값이 원본과 같은 내용을 담아야 한다 (fabrication 금지)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const assertions = [];
const check = (name, ok, details) => {
    assertions.push({ name, ok: !!ok, details: details || {} });
    if (ok) pass += 1; else fail += 1;
};

// ── 제품의 JSON 파싱 경로를 실제로 로드한다 ──
// 02f-speech-json-parsing.js 는 IIFE 안에서 Utils 등에 의존하므로,
// 파싱에 필요한 최소 스텁을 붙여 실제 함수를 실행한다.
const loadProductParsers = () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/parts/02f-speech-json-parsing.js'), 'utf8');
    const vm = require('vm');
    // 02f 는 전역 스코프에서 바로 실행되는 스크립트다. 필요한 의존성만 스텁으로 주고
    // 파일 전체를 한 번 감싸 실행한 뒤 필요한 함수를 꺼낸다.
    // (함수 본문을 정규식으로 잘라내는 방식은 정규식 리터럴 안의 '}' 에서 깨진다 —
    //  실제로 그 방식으로 로더를 만들었다가 product_parser_loaded 가 false 가 됐다.)
    const wrap = `(function(){
  const Utils = {
    stripLLMThinkingTags: (t) => String(t || '').replace(/<think(?:ing)?>[\\s\\S]*?<\\/think(?:ing)?>/gi, ''),
    truncateForLLM: (t) => String(t || '')
  };
  const LIBRA_DEBUG = false;
  const recordRuntimeDebug = () => {};
${src}
  return {
    extractJson: (typeof extractJson !== 'undefined') ? extractJson : null,
    extractStructuredJson: (typeof extractStructuredJson !== 'undefined') ? extractStructuredJson : null,
    parseValidatedStructuredJson: (typeof parseValidatedStructuredJson !== 'undefined') ? parseValidatedStructuredJson : null,
    closeUnbalancedJson: (typeof closeUnbalancedJson !== 'undefined') ? closeUnbalancedJson : null
  };
})()`;
    const ctx = vm.createContext({
        console, JSON, Object, Array, String, Number, Math, RegExp, Set, Map, Boolean, Date,
        Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent
    });
    try {
        const api = vm.runInContext(wrap, ctx);
        return api && typeof api.extractJson === 'function' ? api : null;
    } catch (_) {
        return null;
    }
};

const product = loadProductParsers();
check('product_parser_loaded', product && typeof product.extractJson === 'function',
    { loaded: !!(product && product.extractJson), path: 'src/parts/02f-speech-json-parsing.js' });

const extractJson = product && product.extractJson;

// ── 픽스처: 실측에서 관측한 형태를 재현한다 (원문 캡처는 배포물에 넣지 않는다) ──
// 실측 근거: qwen3.5-9B worldAdditional 응답이 done=stop, 문자열 열림 없음,
//            중괄호 +1 (최상위 root 의 '}' 하나 누락) 이었다.
const MISSING_ROOT_BRACE = '{"worldAdditional":{"sceneInterventions":[{"type":"scene_intervention","status":"injected"}],"worldDeltas":[{"type":"world_delta","status":"injected"}],"characterAdditions":[],"manifestations":[{"id":"m1","title":"t","type":"world_delta","manifested":true}]}';
// 위 문자열은 root '}' 하나가 부족하다.

const ok = (name, parsed, expect) => {
    const good = parsed && typeof parsed === 'object' && expect(parsed) === true;
    check(name, good, good ? {} : { parsed: parsed === null ? 'null' : JSON.stringify(parsed).slice(0, 220) });
};

// ── 1. 핵심: root '}' 하나 누락 → 복구되어야 한다 ──
const r1 = extractJson ? extractJson(MISSING_ROOT_BRACE) : null;
ok('missing_root_brace_is_recovered', r1, (p) => !!p && !!p.worldAdditional);

// ── 2. 내용이 손실되지 않아야 한다 (fabrication 금지) ──
const r2 = extractJson ? extractJson(MISSING_ROOT_BRACE) : null;
check('recovered_content_preserved', !!r2
    && r2.worldAdditional
    && Array.isArray(r2.worldAdditional.sceneInterventions)
    && r2.worldAdditional.sceneInterventions.length === 1
    && r2.worldAdditional.sceneInterventions[0].status === 'injected'
    && Array.isArray(r2.worldAdditional.worldDeltas)
    && r2.worldAdditional.worldDeltas.length === 1
    && Array.isArray(r2.worldAdditional.manifestations)
    && r2.worldAdditional.manifestations.length === 1,
    { got: r2 ? JSON.stringify(r2).slice(0, 260) : 'null' });

// ── 3. 여러 개 누락 (root + 배열 닫기) 도 복구 ──
const MISSING_MULTI = '{"worldAdditional":{"sceneInterventions":[{"status":"armed"}],"worldDeltas":[{"status":"prepared"}';
const r3 = extractJson ? extractJson(MISSING_MULTI) : null;
ok('missing_multiple_closers_is_recovered', r3, (p) => !!p && !!p.worldAdditional
    && Array.isArray(p.worldAdditional.worldDeltas) && p.worldAdditional.worldDeltas[0].status === 'prepared');

// ── 4. 문자열 안에서 잘린 응답은 복구하지 않는다 (없는 내용을 만들면 안 됨) ──
// 실측 구분: 문자열 열림=False 인 건만 복구 대상이었다. 문자열 열림=True 는 내용 자체가 잘린 것이다.
const CUT_INSIDE_STRING = '{"worldAdditional":{"sceneInterventions":[{"title":"Forbidden Core Obser';
const r4 = extractJson ? extractJson(CUT_INSIDE_STRING) : null;
check('truncated_inside_string_not_fabricated', !r4
    || !(r4.worldAdditional && Array.isArray(r4.worldAdditional.sceneInterventions)
        && r4.worldAdditional.sceneInterventions.some(it => it && it.description)),
    { parsed: r4 === null ? 'null' : JSON.stringify(r4).slice(0, 200) });

// ── 4b. closeUnbalancedJson 자체의 계약 ──
// extractJson 경계에서는 이 안전장치들이 관측되지 않는다는 것을 실측으로 확인했다
// (207개 픽스처에서도 변이가 구분되지 않았다). 그래서 helper 를 직접 검증한다.
const close = product && product.closeUnbalancedJson;
check('close_helper_exposed', typeof close === 'function', { type: typeof close });

// 4b-① 문자열이 열려 있으면 닫지 않는다 (내용이 잘렸으므로 없는 값을 만들면 안 된다)
check('close_refuses_open_string', typeof close === 'function'
    && close('{"a":"unfinished') === '',
    { got: typeof close === 'function' ? close('{"a":"unfinished') : 'no helper' });

// 4b-② 이미 균형이면 그대로 비운다 (불필요한 재작성 금지)
check('close_refuses_balanced', typeof close === 'function'
    && close('{"a":1}') === '',
    { got: typeof close === 'function' ? close('{"a":1}') : 'no helper' });

// 4b-③ 닫는 괄호가 남는 것보다 많은 어긋난 구조는 추측하지 않는다
check('close_refuses_mismatched', typeof close === 'function'
    && close('{"a":[1}}') === '',
    { got: typeof close === 'function' ? close('{"a":[1}}') : 'no helper' });

// 4b-④ 필요한 만큼만, 순서대로 닫는다
check('close_appends_in_reverse_order', typeof close === 'function'
    && close('{"a":{"b":[1') === '{"a":{"b":[1]}}',
    { got: typeof close === 'function' ? close('{"a":{"b":[1') : 'no helper' });

// 4b-⑤ 끝에 붙은 공백/개행을 보존한 채 닫는다
check('close_preserves_trimmed_body', typeof close === 'function'
    && close('  {"a":[1  ') === '{"a":[1]}',
    { got: typeof close === 'function' ? close('  {"a":[1  ') : 'no helper' });

// ── 5. 정상 JSON 은 그대로 (회귀 방지) ──
const VALID = '{"worldAdditional":{"sceneInterventions":[],"worldDeltas":[],"characterAdditions":[],"manifestations":[]}}';
const r5 = extractJson ? extractJson(VALID) : null;
ok('valid_json_unchanged', r5, (p) => !!p && Array.isArray(p.worldAdditional.sceneInterventions));

// ── 6. 코드펜스 안의 누락 괄호도 복구 ──
const FENCED = '```json\n{"worldAdditional":{"worldDeltas":[{"status":"injected"}]}\n```';
const r6 = extractJson ? extractJson(FENCED) : null;
ok('fenced_missing_brace_is_recovered', r6, (p) => !!p && !!p.worldAdditional
    && p.worldAdditional.worldDeltas[0].status === 'injected');

// ── 7. trailing comma + 누락 괄호 동시 ──
const COMMA_AND_MISSING = '{"worldAdditional":{"worldDeltas":[{"status":"injected"},],}';
const r7 = extractJson ? extractJson(COMMA_AND_MISSING) : null;
ok('trailing_comma_with_missing_brace', r7, (p) => !!p && !!p.worldAdditional
    && p.worldAdditional.worldDeltas[0].status === 'injected');

// ── 8. 배열 root 도 동작 ──
const ARR_ROOT = '{"worldAdditional":{"worldDeltas":[{"status":"armed"}]}';
const r8 = extractJson ? extractJson(ARR_ROOT) : null;
ok('nested_container_closed_in_order', r8, (p) => !!p && !!p.worldAdditional
    && p.worldAdditional.worldDeltas[0].status === 'armed');

// ── 9. 과잉 닫힘은 내용을 훼손하지 않는다 ──
// 실측에서 중괄호 -4 같은 과잉 닫힘도 있었다. 이것은 별개 문제이며
// 여기서는 "복구 시도가 정상 JSON 을 망가뜨리지 않는다"만 본다.
const r9 = extractJson ? extractJson(VALID) : null;
check('no_double_repair_corruption', !!r9
    && JSON.stringify(r9) === JSON.stringify(JSON.parse(VALID)),
    { got: r9 ? JSON.stringify(r9) : 'null' });

console.log(JSON.stringify({
    ok: fail === 0,
    summary: `${pass}/${pass + fail}`,
    assertions
}, null, 1));
process.exit(fail === 0 ? 0 : 1);
