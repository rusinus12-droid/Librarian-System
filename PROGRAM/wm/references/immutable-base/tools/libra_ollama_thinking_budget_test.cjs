'use strict';
/**
 * Gate: ollama 추론(thinking) 예산 결함.
 *
 * 실측 결함 (실모델):
 *   ollama 경로만 추론을 끄는 파라미터를 보내지 않아, thinking 모델이 num_predict 를
 *   전부 사고에 소진하고 content 를 비웠다.
 *     gemma-4-12B  num_predict 1000 → content 0자 / thinking 4262자 / done=length
 *     qwen3.5-9B   num_predict 1000 → content 0자 / thinking 4418자 / done=length
 *   예산을 늘리는 것으로는 해결되지 않는다 (4000 → content 0자 / thinking 17117자).
 *
 * 이 게이트는 제품 소스와 dist 가 실제로 보내는 요청 형태를 검사한다.
 * 모델을 다시 부르지 않으므로 빠르고, 실측 근거는 위 수치로 고정한다.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const assertions = [];
const add = (name, ok, details) => assertions.push({ name, ok: !!ok, details: details || {} });

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const src = readSrc('src/parts/06-api-providers-llm.js');
const dist = readSrc('dist/LIBRA World Manager Full.js');

// ① ollama 경로가 think 필드를 보낸다 (소스 + dist)
add('source_ollama_sends_think_field',
  /ollamaThinkingField/.test(src) && /think:\s*ollamaThink/.test(src),
  { sourceHasField: /ollamaThinkingField/.test(src) });

const ollamaBodySites = (src.match(/\.\.\.ollamaThinkingField/g) || []).length;
add('all_ollama_request_bodies_carry_think', ollamaBodySites >= 4,
  { sites: ollamaBodySites, expected: '>=4 (chat, chat-plain, generate, generate-raw)' });

const distSites = (dist.match(/think:\s*[a-zA-Z_$][\w$]*/g) || []).length;
add('dist_carries_think_field', /ollamaSupportsThinkField/.test(dist) && distSites >= 1,
  { distSites });

// ② think 는 reasoningAllowed 일 때만 true — 기본 설정(추론 off)에서는 false 여야 한다
add('think_false_when_reasoning_disabled',
  /const ollamaThink = tokenBudget\.reasoningAllowed === true;/.test(src),
  { line: 'ollamaThink = tokenBudget.reasoningAllowed === true' });

// 기본 reasoning 설정이 'none'/0 임을 함께 고정 (추론 off 가 제품 기본값)
const defaultEffortNone = /reasoningEffort:\s*'none'/.test(src);
const defaultBudgetZero = /const DEFAULT_REASONING_BUDGET_TOKENS = 0;/.test(src);
add('product_default_is_reasoning_off', defaultEffortNone && defaultBudgetZero,
  { defaultEffortNone, defaultBudgetZero });

// ③ num_predict 가 thinking 예산만큼 늘어난다 (추론을 켠 경우 대비)
add('num_predict_includes_reasoning_budget',
  /num_predict:\s*tokenBudget\.providerMaxTokens\s*\n?\s*\+ \(tokenBudget\.reasoningAllowed \? tokenBudget\.reasoningBudgetTokens : 0\)/.test(src)
    || /num_predict:\s*tokenBudget\.providerMaxTokens[\s\S]{0,120}reasoningBudgetTokens/.test(src),
  {});

// ④ think 미지원 모델 400 안전망
add('think_unsupported_400_falls_back',
  /noteOllamaThinkUnsupported/.test(src)
    && /does not support think/i.test(src)
    && /delete retryBody\.think/.test(src),
  { hasCache: /ollamaThinkUnsupported/.test(src) });

add('think_unsupported_cache_skips_field',
  /ollamaSupportsThinkField\(config\.llm\.model\)/.test(src),
  {});

// ⑤ 실측 근거 수치가 게이트에 결속되어 있다 (문서화된 결함)
add('measured_evidence_recorded',
  /content 0자 \/ thinking 4262자/.test(src) || /17117/.test(src),
  { note: '실측 수치가 소스 주석에 남아 있어야 회귀 시 원인 추적이 가능' });

const failed = assertions.filter(a => !a.ok);
const out = {
  ok: failed.length === 0,
  suite: 'ollama-thinking-budget',
  summary: `${assertions.length - failed.length}/${assertions.length}`,
  assertions,
};
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
