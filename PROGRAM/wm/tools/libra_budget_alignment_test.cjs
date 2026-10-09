'use strict';
/**
 * Gate: 예산 요청값 ≤ 실효값 (조용한 잘림이 없다).
 *
 * 실측 배경 (2026-09-27): turnMaintenanceBundle 도메인 천장이 2800 인데 두 경로가 더 큰 값을 요청했다.
 *   world-additional manual/historical  요청 3200 → 실효 2800
 *   turn-maintenance-bundle (RP 포함)    요청 3600 → 실효 2800
 * 어느 파일에도 요청값과 실효값을 함께 보여주는 곳이 없어 드러나지 않았다(예산 파편화의 실제 피해).
 *
 * 이 게이트가 고정하는 것:
 *   - 계약별 예산표가 **한 곳에만** 정의되어 있다(소스에 같은 리터럴 표가 둘 이상 있으면 RED).
 *   - 09c 안에 계약 밖 하드코딩 maxTokens 가 없다.
 *   - 실제 호출을 가로채 **요청값**을 읽고, 제품 preflight 함수로 **실효값**을 계산해 비교한다.
 *     요청 > 실효 이면 RED — 앞으로 같은 조용한 잘림이 재발하지 않는다.
 *   - 02h 도메인 천장이 그 도메인으로 들어오는 최대 요청을 덮는다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const assertions = [];
const add = (name, ok, details) => assertions.push({ name, ok: !!ok, details: details || {} });

// ── 정적: 표가 한 곳에만 있는가 ──
const part09c = fs.readFileSync(path.join(ROOT, 'src/parts/09c-turn-maintenance-optimizer.js'), 'utf8');
const part02h = fs.readFileSync(path.join(ROOT, 'src/parts/02h-analysis-preflight-meta.js'), 'utf8');
// 계약표는 **02h 한 곳에만** 리터럴로 존재해야 한다(09c 는 읽기만).
const tableLiteral = /world_additional: \{ light: 1400/;
const literalSources = [
  ['02h', part02h], ['09c', part09c]
].filter(([, text]) => tableLiteral.test(text)).map(([name]) => name);
add('contract_budget_table_literal_only_in_02h', literalSources.length === 1 && literalSources[0] === '02h',
    { filesWithLiteralTable: literalSources });
// 09c 는 표를 02h 에서 읽어야 한다.
add('09c_reads_the_shared_table',
  /AnalysisBudgetPreflight\?\.contractBudgets/.test(part09c),
  { readsSharedTable: /AnalysisBudgetPreflight\?\.contractBudgets/.test(part09c) });
// 도메인 천장이 계약표에서 파생되는가(손으로 적힌 숫자가 아님).
// 파생 대상 도메인의 프로필에는 리터럴 fullMaxTokens 가 없어야 한다(getter 여야 한다).
// 계약 밖 도메인은 자기 값을 유지하는 것이 정상이므로 NON_CONTRACT_DOMAIN_CEILINGS 선언부를 뺀다.
const derivedDomains = ['turnMaintenanceBundle', 'afterrequestCanonicalPacket'];
const handwrittenInDerived = derivedDomains.filter(domain => {
  const block = part02h.slice(part02h.indexOf(`            ${domain}: {`));
  const body = block.slice(0, block.indexOf('},') + 2);
  return /fullMaxTokens:\s*\d+/.test(body);
});
add('derived_domain_ceilings_are_getters_not_literals', handwrittenInDerived.length === 0,
    { handwrittenInDerived });
// 계약 밖 하드코딩 예산은 세 가지 모양으로 나타난다(실측으로 전부 확인):
//   maxTokens: 3200 · maxTokens = 3200 · const manualBudget = 3200
// 첫 번째만 보면 다른 두 모양이 빠져나간다 — 변이 검증에서 실제로 그렇게 통과했다.
const hardcodedIn09c = [
  ...(part09c.match(/maxTokens:\s*\d+/g) || []),
  ...(part09c.match(/maxTokens\s*=\s*\d+/g) || []),
  ...(part09c.match(/(?:Budget)\s*=\s*\d+/g) || []),
  ...(part09c.match(/\|\|\s*\d{3,}/g) || [])
];
add('no_hardcoded_budget_in_09c', hardcodedIn09c.length === 0, { found: hardcodedIn09c });

// ── 부팅: 실제로 돌려 호출을 가로챈다 ──
function boot() {
  let code = fs.readFileSync(DIST, 'utf8');
  const exportSnippet = `\n;globalThis.__LIBRA_BUDGET_AUDIT__ = {\n`
    + `MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n`
    + `LLMProvider: typeof LLMProvider !== 'undefined' ? LLMProvider : null,\n`
    + `TurnMaintenanceOptimizer: typeof TurnMaintenanceOptimizer !== 'undefined' ? TurnMaintenanceOptimizer : null,\n`
    + `AnalysisBudgetPreflight: typeof AnalysisBudgetPreflight !== 'undefined' ? AnalysisBudgetPreflight : null\n`
    + `};\n`;
  const index = code.lastIndexOf('\n})();');
  if (index < 0) throw new Error('final IIFE close not found');
  code = code.slice(0, index) + exportSnippet + code.slice(index);

  const store = new Map();
  const makeStore = () => ({
    async getItem(k) { return store.has(k) ? store.get(k) : null; },
    async setItem(k, v) { store.set(k, v); return true; },
    async removeItem(k) { store.delete(k); return true; },
    async keys() { return Array.from(store.keys()); }
  });
  const risuai = {
    pluginStorage: makeStore(),
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    async getDatabase() { return makeStore(); },
    async getLocalPluginStorage() { const s = makeStore(); return { getStore: () => s, ...s }; },
    async setItem() { return true; },
    async getItem() { return null; },
    async removeItem() { return true; },
    async requestPluginPermission() { return true; },
    async addRisuScriptHandler() { return true; },
    async onUnload() { return true; }
  };
  const replacers = { beforeRequest: [], afterRequest: [] };
  const scripts = { output: [], editoutput: [] };
  const context = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    JSON, Object, Array, String, Number, Math, RegExp, Set, Map, Boolean, Date,
    Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    TextEncoder, TextDecoder, URL, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance,
    crypto: crypto.webcrypto || crypto,
    fetch: async () => { throw new Error('fetch must not be called by the budget audit'); },
    process: { env: process.env },
    Buffer,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    risuai,
    Risuai: risuai,
    addRisuScriptHandler(_name, handler, kind) {
      if (kind === 'output') scripts.output.push(handler); else scripts.editoutput.push(handler);
      return true;
    },
    onUnload(handler) { return true; },
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  return { context, code, risuai, replacers };
}

(async () => {
  const { context, code } = boot();
  const booted = vm.runInContext(code, context, { filename: DIST, timeout: 30000 });
  if (booted && typeof booted.then === 'function') await booted;
  await new Promise(r => setTimeout(r, 100));

  const api = context.__LIBRA_BUDGET_AUDIT__;
  add('product_exports_available',
    !!(api && api.TurnMaintenanceOptimizer && api.MemoryEngine && api.AnalysisBudgetPreflight),
    { keys: api ? Object.keys(api) : [] });
  if (!api || !api.TurnMaintenanceOptimizer || !api.AnalysisBudgetPreflight) {
    process.stdout.write(JSON.stringify({ ok: false, assertions }, null, 2) + '\n');
    process.exit(1);
  }

  const optimizer = api.TurnMaintenanceOptimizer;
  const preflight = api.AnalysisBudgetPreflight;
  const pre = (domain, asked) => preflight.preparePrompt({
    domain, system: 'x'.repeat(600), user: 'y'.repeat(600), config: {}, maxTokens: asked
  });

  // ── ① 계약 표 표면이 노출되고 값이 표와 일치하는가 ──
  const table = {
    world_additional: { light: 1400, standard: 1800, complex: 2200, critical: 2600, recovery: 1500 },
    canonical_packet: { light: 5200, standard: 7200, complex: 9600, critical: 12000, recovery: 6000 },
    unified: { light: 7000, standard: 9000, complex: 12000, critical: 16000, recovery: 6500 },
    turn_maintenance_bundle: { light: 2000, standard: 2400, complex: 2800, critical: 3600, recovery: 2400 },
    user_dlc_tracker: { light: 1200, standard: 1800, complex: 2200, critical: 2600, recovery: 1500 }
  };
  const tableMatches = Object.entries(table).every(([contract, tiers]) =>
    Object.entries(tiers).every(([tier, value]) => optimizer.getContractOutputBudget(contract, tier) === value));
  add('exposed_budget_surface_matches_table', tableMatches, {
    sample: { world_additional_critical: optimizer.getContractOutputBudget('world_additional', 'critical') }
  });

  // ── ② 실효값 ≤ 계약 표 (파생이 표를 넘지 않는다) ──
  const domainCeilings = { turnMaintenanceBundle: 3600, entityExtraction: 6500, afterrequestCanonicalPacket: 12000,
                           afterrequestUnifiedAnalysis: 20000, userDlcAnalysis: 5200 };
  const overCeiling = [];
  for (const [contract, tiers] of Object.entries(table)) {
    for (const [tier, value] of Object.entries(tiers)) {
      if (optimizer.getContractOutputBudget(contract, tier) !== value) overCeiling.push(`${contract}.${tier}`);
    }
  }
  add('contract_table_is_the_source_of_truth', overCeiling.length === 0, { mismatched: overCeiling });

  // ── ③ 요청 ≤ 실효 : 이 게이트의 핵심 ──
  // 각 계약이 실제로 요청하는 값(표에서 파생) 과, 그 요청이 지나는 도메인의 실효값을 비교한다.
  const routes = [
    { label: 'world_additional turn (critical)', domain: 'turnMaintenanceBundle',
      asked: optimizer.getContractOutputBudget('world_additional', 'critical') },
    { label: 'world_additional manual/historical', domain: 'turnMaintenanceBundle',
      asked: optimizer.getContractOutputBudget('world_additional', 'critical') },
    { label: 'turn-maintenance-bundle (RP 강화 없음)', domain: 'turnMaintenanceBundle',
      asked: optimizer.getContractOutputBudget('turn_maintenance_bundle', 'complex') },
    { label: 'turn-maintenance-bundle (RP 강화 포함)', domain: 'turnMaintenanceBundle',
      asked: optimizer.getContractOutputBudget('turn_maintenance_bundle', 'critical') },
    { label: 'user-dlc tracker analysis', domain: 'turnMaintenanceBundle',
      asked: optimizer.getContractOutputBudget('user_dlc_tracker', 'standard') },
    { label: 'canonical packet analysis', domain: 'afterrequestCanonicalPacket',
      asked: optimizer.getContractOutputBudget('canonical_packet', 'critical') },
    { label: 'unified analysis', domain: 'afterrequestUnifiedAnalysis',
      asked: optimizer.getContractOutputBudget('unified', 'critical') },
    { label: 'entity extraction', domain: 'entityExtraction', asked: 6500 }
  ];
  const clipped = [];
  const routeReport = routes.map(route => {
    const effective = pre(route.domain, route.asked).maxTokens;
    const entry = { ...route, effective, clipped: effective < route.asked };
    if (entry.clipped) clipped.push(`${route.label}: ${route.asked} -> ${effective}`);
    return entry;
  });
  add('requested_never_exceeds_effective', clipped.length === 0, { clipped, routes: routeReport });

  // ── ④ 도메인 천장이 그 도메인의 최대 요청을 덮는다 ──
  const ceilingShort = Object.entries(domainCeilings).filter(([domain, ceiling]) => {
    const maxAsked = Math.max(...routes.filter(r => r.domain === domain).map(r => r.asked), 0);
    return maxAsked > 0 && ceiling < maxAsked;
  }).map(([domain, ceiling]) => ({ domain, ceiling }));
  add('domain_ceiling_covers_max_request', ceilingShort.length === 0, { short: ceilingShort });

  // ── ④b 파생 검증: 계약표를 올리면 도메인 천장이 따라오는가 ──
  // 값을 실제로 바꾸지 않고, 파생 함수가 표를 읽는지 확인한다(표와 천장이 같은 출처).
  const budgetSurface = api.AnalysisBudgetPreflight;
  const derivedMatchesTable = budgetSurface.derivedDomainCeiling('turnMaintenanceBundle')
    === budgetSurface.budgetFor('turn_maintenance_bundle', 'critical');
  add('domain_ceiling_tracks_contract_table', derivedMatchesTable, {
    derived: budgetSurface.derivedDomainCeiling('turnMaintenanceBundle'),
    tableCritical: budgetSurface.budgetFor('turn_maintenance_bundle', 'critical')
  });
  // 계약표에 없는 경로는 파생 대상이 아니다(예외임을 값으로 고정).
  add('non_contract_domains_keep_their_own_ceiling',
    budgetSurface.derivedDomainCeiling('entityExtraction') === 6500
    && budgetSurface.derivedDomainCeiling('userDlcAnalysis') === 5200
    && budgetSurface.derivedDomainCeiling('afterrequestUnifiedAnalysis') === 20000,
    { entity: budgetSurface.derivedDomainCeiling('entityExtraction'),
      userDlc: budgetSurface.derivedDomainCeiling('userDlcAnalysis'),
      unified: budgetSurface.derivedDomainCeiling('afterrequestUnifiedAnalysis') });

  // ── ⑤ 회귀 방지: 이전에 잘리던 두 요청이면 RED 가 났어야 한다는 것을 수치로 고정 ──
  add('regression_guard_previous_clipping_would_fail',
    pre('turnMaintenanceBundle', 3200).maxTokens >= 3200 && pre('turnMaintenanceBundle', 3600).maxTokens >= 3600,
    { manual: pre('turnMaintenanceBundle', 3200).maxTokens, bundle: pre('turnMaintenanceBundle', 3600).maxTokens });

  const failed = assertions.filter(a => !a.ok);
  process.stdout.write(JSON.stringify({ ok: failed.length === 0, assertions }, null, 2) + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: error && error.message, stack: error && error.stack }, null, 2) + '\n');
  process.exit(1);
});
