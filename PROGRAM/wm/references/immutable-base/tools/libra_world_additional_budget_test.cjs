'use strict';
/**
 * Gate: 계약별 출력 예산(world_additional)이 실측에서 관측된 잘림을 실제로 덮는가.
 *
 * 실측 배경 (2026-09-27, 실제 출하 프롬프트 + 로컬 모델 gemma-4-12b / qwen3.5-9b, 캡처 8턴):
 *   worldAdditional 계약 9건 × 2모델.
 *     성공 최대 2,980자  @ num_predict 1300 (standard tier)
 *     실패 2건 3,468 / 3,474자 @ 1300 → done=length, 최상위 '}' 3개 부족 (분석 결과 소실)
 *     유일한 light(1000) 실행은 1,319자로 통과 — 조이는 것은 light 가 아니라 standard 였다.
 *   → 테이블을 { light 1400, standard 1800, complex 2200, critical 2600, recovery 1500 } 로 올렸다.
 *
 * 이 게이트가 고정하는 것:
 *   - 사다리 순서가 뒤집히지 않았다 (light < standard < complex < critical).
 *     light 만 올리면 light > standard 가 되어 "가벼운 턴" 배분이 뒤집힌다 — 그 변이를 실제로 잡는다.
 *   - standard tier 가 실측 최대 사용량(3,500자 ≈ 1,520토큰)을 덮는다.
 *   - 실제 함수를 실행해 tier→maxTokens 매핑을 읽는다 (소스 텍스트 대조만 하지 않는다).
 *   - 예산이 02h domain profile(turnMaintenanceBundle.fullMaxTokens)보다 작아 테이블이 지배적이다.
 *     → 02h 만 올리는 변경은 이 경로에 아무 효과가 없다는 사실도 함께 고정한다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const assertions = [];

function loadOptimizer() {
  const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
  const exportSnippet = `\n;globalThis.__LIBRA_BUDGET_EXPORTS__ = {\n`
    + `TurnMaintenanceOptimizer: typeof TurnMaintenanceOptimizer !== 'undefined' ? TurnMaintenanceOptimizer : null\n`
    + `};\n`;
  const idx = code.lastIndexOf('\n})();');
  if (idx < 0) throw new Error('final IIFE close not found');
  const patched = code.slice(0, idx) + exportSnippet + code.slice(idx);
  const context = {
    console,
    JSON, Object, Array, String, Number, Math, RegExp, Set, Map, Boolean, Date,
    Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    TextEncoder, TextDecoder, URL, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance,
    crypto: require('crypto').webcrypto || require('crypto'),
    fetch: async () => { throw new Error('fetch must not be called by the budget gate'); },
    process: { env: process.env },
    Buffer,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    // risuai 스텁: 부팅만 되면 되고 이 게이트는 호스트를 쓰지 않는다.
    risuai: {
      apiVersion: '3.0',
      async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
      async getArgument() { return undefined; },
      async getDatabase() { const m = new Map(); return { getItem: async (k) => (m.has(k) ? m.get(k) : null), setItem: async (k, v) => { m.set(k, v); return true; }, removeItem: async (k) => { m.delete(k); return true; }, keys: async () => Array.from(m.keys()) }; },
      async getLocalPluginStorage() { const m = new Map(); const store = { getItem: async (k) => (m.has(k) ? m.get(k) : null), setItem: async (k, v) => { m.set(k, v); return true; }, removeItem: async (k) => { m.delete(k); return true; }, keys: async () => Array.from(m.keys()) }; return { getStore: () => store, ...store }; },
      async setItem() { return true; },
      async getItem() { return null; },
      async removeItem() { return true; },
      async requestPluginPermission() { return true; },
      addRisuScriptHandler() { return true; },
      onUnload() { return true; }
    },
    globalThis: null
  };
  context.Risuai = context.risuai;
  context.globalThis = context;
  vm.createContext(context);
  return { context, patched };
}

// 부팅은 비동기다: dist 의 최상위 IIFE 가 Promise 를 반환하므로 await 하지 않으면 내부 초기화가
// 끝나기 전에 export 를 읽게 되고 `TurnMaintenanceOptimizer` 가 undefined 로 나온다
// (이 게이트의 첫 실행에서 실제로 그렇게 실패했다).
async function boot() {
  const { context, patched } = loadOptimizer();
  const result = vm.runInContext(patched, context, { filename: 'dist/LIBRA World Manager Full.js', timeout: 30000 });
  if (result && typeof result.then === 'function') await result;
  await new Promise(resolve => setTimeout(resolve, 100));
  return context.__LIBRA_BUDGET_EXPORTS__;
}

const add = (name, ok, details) => assertions.push({ name, ok: !!ok, details: details || {} });

async function main() {
const exportsApi = await boot();
const optimizer = exportsApi && exportsApi.TurnMaintenanceOptimizer;
add('optimizer_exposed', !!(optimizer && typeof optimizer.getAnalysisExecutionPlan === 'function'),
    { keys: exportsApi ? Object.keys(exportsApi) : [] });
if (!optimizer || typeof optimizer.getAnalysisExecutionPlan !== 'function') {
  process.stdout.write(JSON.stringify({ ok: false, assertions }, null, 2) + '\n');
  process.exit(1);
}

const plan = (payload, worker, options) => optimizer.getAnalysisExecutionPlan(payload, worker, options || {});

// tier 를 실제로 유도한다: score 는 payload 에서 계산되므로 네 가지 payload 로 사다리를 훑는다.
// (점수 규칙을 여기서 복제하지 않고, 나온 tier 를 그대로 읽는다.)
// payload 키와 임계값은 제품의 실제 점수식(09c:2-22)에서 그대로 읽었다. 임계값을 추측하면
// tier 를 못 밟아 사다리 단언이 "검사 1개"로 무력해진다(첫 실행에서 실제로 그랬다).
//   evidenceChars >=1800 → +1, >=5000 → +2, >=10000 → +3
//   focusedEntities >=4 → +1, >=7 → +2   ·  relationTexts >=6 → +1  ·  recentTurns >=8 → +1
//   hostPromptEvidenceText >=4500 → +1   ·  worldCanonCustomActive +2 ·  worldAdditionalCustomActive +1
//   plannerOrchestrationActive +1        ·  strictUserMsg >=1600 +1
const payloads = {
  light: {},                                                                     // score 0
  standard: { evidenceText: 'x'.repeat(2000) },                                  // score 1  -> standard(2 미만) 확인용
  standard2: { evidenceText: 'x'.repeat(2000), focusedEntities: [1, 2, 3, 4] },   // score 2  -> standard
  complex: { evidenceText: 'x'.repeat(2000), focusedEntities: [1, 2, 3, 4], worldCanonCustomActive: true, worldAdditionalCustomActive: true }, // 4 -> complex
  critical: { evidenceText: 'x'.repeat(2000), focusedEntities: [1, 2, 3, 4], worldCanonCustomActive: true, worldAdditionalCustomActive: true, plannerOrchestrationActive: true, recentTurns: [1, 2, 3, 4, 5, 6, 7, 8] } // 7 -> critical
};

const observed = {};
for (const [label, payload] of Object.entries(payloads)) {
  const p = plan(payload, 'world_additional');
  observed[label] = { tier: p.tier, maxTokens: p.maxTokens, score: p.score };
}
add('tier_ladder_exercised', Object.values(observed).every(item => Number(item.maxTokens) > 0), observed);

const byTier = {};
for (const item of Object.values(observed)) byTier[item.tier] = item.maxTokens;

// ① 사다리 순서: 뒤집히면 "가벼운 턴" 배분이 무의미해진다 (light 만 올린 변이가 여기서 RED)
const ladderOk = Number(byTier.light || 0) < Number(byTier.standard || 0)
  && Number(byTier.standard || 0) < Number(byTier.complex || 0)
  && Number(byTier.complex || 0) < Number(byTier.critical || 0);
add('world_additional_ladder_strictly_increasing', ladderOk, byTier);

// ② standard 가 실측 최대 사용량을 덮는다. 3,500자 / 2.3 자·토큰 ≈ 1,522 토큰.
const MEASURED_MAX_ANSWER_CHARS = 3500;
const MEASURED_CHARS_PER_TOKEN = 2.3;
const measuredNeed = Math.ceil(MEASURED_MAX_ANSWER_CHARS / MEASURED_CHARS_PER_TOKEN);
add('world_additional_standard_covers_measured_max', Number(byTier.standard || 0) >= measuredNeed,
  { standard: byTier.standard, measuredNeed, measuredMaxChars: MEASURED_MAX_ANSWER_CHARS });

// ③ 회귀 방지: 이전 값(standard 1300)이면 실측 최대를 못 덮는다는 것을 수치로 못 박는다.
add('previous_standard_was_below_measured_need', 1300 < measuredNeed,
  { previousStandard: 1300, measuredNeed });

// ④ light 도 잘림을 만들지 않을 만큼은 되어야 한다 (실측 light 통과는 1,319자).
const lightNeed = Math.ceil(1319 / MEASURED_CHARS_PER_TOKEN);
add('world_additional_light_covers_observed_pass', Number(byTier.light || 0) >= lightNeed,
  { light: byTier.light, lightNeed });

// ⑤ 회복 모드는 critical 보다 낮아도 되지만 light 보다는 낮으면 안 된다(사다리 안쪽 값).
const recovery = plan(payloads.standard, 'world_additional', { recoveryMode: true });
add('world_additional_recovery_is_within_ladder',
  Number(recovery.maxTokens) >= Number(byTier.light || 0) && Number(recovery.maxTokens) <= Number(byTier.critical || 0),
  { recovery: recovery.maxTokens, light: byTier.light, critical: byTier.critical });

// ⑥ 다른 계약은 건드리지 않았다.
// 다른 계약은 손대지 않았다 — 테이블 값 자체를 고정한다(같은 payload 로 나온 tier 의 값이 원래 값인지).
const CANONICAL_TABLE = { light: 5200, standard: 7200, complex: 9600, critical: 12000, recovery: 6000 };
const UNIFIED_TABLE = { light: 7000, standard: 9000, complex: 12000, critical: 16000, recovery: 6500 };
const canonical = plan(payloads.complex, 'canonical_packet');
const unified = plan(payloads.complex, 'unified');
add('canonical_packet_table_unchanged',
  CANONICAL_TABLE[canonical.tier] === canonical.maxTokens,
  { canonical: canonical.maxTokens, tier: canonical.tier, expectedForTier: CANONICAL_TABLE[canonical.tier] });
add('unified_table_unchanged',
  UNIFIED_TABLE[unified.tier] === unified.maxTokens,
  { unified: unified.maxTokens, tier: unified.tier, expectedForTier: UNIFIED_TABLE[unified.tier] });

// ⑦ 02h domain profile 이 테이블보다 크다는 사실을 고정한다 — 02h 만 올리는 변경은 효과가 없다.
const preflightSrc = fs.readFileSync(path.join(ROOT, 'src/parts/02h-analysis-preflight-meta.js'), 'utf8');
const m = preflightSrc.match(/turnMaintenanceBundle:\s*\{[\s\S]*?fullMaxTokens:\s*(\d+)/);
const domainFullMax = m ? Number(m[1]) : 0;
add('turn_bundle_domain_ceiling_does_not_bind_table', domainFullMax > Number(byTier.critical || 0),
  { domainFullMaxTokens: domainFullMax, tableCritical: byTier.critical });

const failed = assertions.filter(a => !a.ok);
process.stdout.write(JSON.stringify({
  ok: failed.length === 0,
  assertions,
  observed: { worldAdditional: observed, byTier, recovery: recovery.maxTokens, canonical: canonical.maxTokens, unified: unified.maxTokens }
}, null, 2) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: error && error.message, stack: error && error.stack }, null, 2) + '\n');
  process.exit(1);
});
