'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const store = new Map();
let unload = null;
const storage = {
  async getItem(key) { return store.has(key) ? store.get(key) : null; },
  async setItem(key, value) { store.set(key, value); },
  async removeItem(key) { store.delete(key); }
};
const host = {
  pluginStorage: storage, safeLocalStorage: storage,
  async getArgument() { return undefined; }, async getArg() { return undefined; },
  async nativeFetch() { throw new Error('offline runtime test'); },
  async onUnload(handler) { unload = handler; return true; },
  async registerSetting() { return true; }, async registerButton() { return true; },
  async addRisuReplacer() { return true; }, async addRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }
};
const context = vm.createContext({
  risuai: host, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone, performance: globalThis.performance,
  Blob: globalThis.Blob, atob: globalThis.atob, btoa: globalThis.btoa
});
const plain = value => JSON.parse(JSON.stringify(value));
const waitFor = async predicate => {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA runtime load timeout');
};

(async () => {
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);
  const stages = ['librarian'];

  const budget = api.debugCreateCanonicalProviderBudget(stages);
  assert.equal(budget.schema, 'libra.canonical_provider_budget.v2');
  assert.equal(budget.profile, 'light');
  assert.deepEqual(plain(budget.activeStages), stages);
  assert.equal(budget.maxPhysicalCalls, 1);
  assert.equal(budget.perStageMax, 1);
  assert.equal(budget.maxCorrectiveAttemptsPerStage, 0);
  assert.equal(budget.maxInputTokens, 120000);
  assert.equal(budget.maxOutputTokens, 65536);
  assert.equal(budget.maxReasoningTokens, 32768);
  assert.equal(budget.maxTotalTokens, 185536);
  assert.deepEqual(plain(budget.usage), {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cachedInputTokens: 0, totalTokens: 0
  });

  const actualUsage = api.debugCanonicalProviderBudgetScenario({
    activeStages: stages,
    stage: 'librarian', maxTokens: 5000,
    systemPrompt: 'system contract', userPrompt: 'five turn evidence',
    result: {
      ok: true, content: '{"schema":"libra.canonical_artifact.v2"}',
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 500,
        completion_tokens_details: { reasoning_tokens: 300 },
        total_tokens: 1700
      }
    }
  });
  assert.equal(actualUsage.budget.totalCalls, 1);
  assert.deepEqual(plain(actualUsage.budget.usage), {
    inputTokens: 1200,
    outputTokens: 500,
    reasoningTokens: 300,
    cachedInputTokens: 0,
    totalTokens: 1700
  });
  assert.equal(actualUsage.budget.attempts[0].attemptType, 'initial');
  assert.equal(actualUsage.budget.attempts[0].usage.totalTokens, 1700);
  assert.equal(actualUsage.reservation.reasoningBudgetTokens, 32768,
    'the first heavy-profile call must receive one fair share of the request-wide reasoning budget');
  assert.equal(actualUsage.budget.attempts[0].remainingPhysicalCallSlots, 1);
  assert.equal(actualUsage.budget.attempts[0].effectiveReasoningBudgetTokens, 32768);
  assert.equal(actualUsage.budget.attempts[0].usageEstimated, false);

  const normalizedUsage = api.debugCanonicalProviderBudgetScenario({
    activeStages: stages,
    stage: 'librarian', maxTokens: 3000,
    result: {
      ok: true, content: '{}',
      usage: {
        inputTokens: 800,
        outputTokens: 400,
        thinkingTokens: 250,
        cachedInputTokens: 100,
        totalTokens: 1200
      }
    }
  });
  assert.deepEqual(plain(normalizedUsage.budget.usage), {
    inputTokens: 800,
    outputTokens: 400,
    reasoningTokens: 250,
    cachedInputTokens: 100,
    totalTokens: 1200
  }, 'Provider Manager normalized usage fields must be accounted without conversion loss');
  assert.equal(normalizedUsage.budget.attempts[0].usageEstimated, false);

  const implicitTotal = api.debugCanonicalProviderBudgetScenario({
    activeStages: stages,
    stage: 'librarian', maxTokens: 3000,
    result: {
      ok: true, content: '{}',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        completion_tokens_details: { reasoning_tokens: 300 }
      }
    }
  });
  assert.equal(implicitTotal.budget.usage.totalTokens, 1500,
    'reasoning included in OpenAI completion tokens must not be added to total a second time');
  assert.equal(implicitTotal.budget.attempts[0].usageEstimated, true,
    'missing provider-native total usage must remain marked as estimated');

  const lightBudget = api.debugCreateCanonicalProviderBudget(['librarian']);
  assert.deepEqual(plain({
    input: lightBudget.maxInputTokens,
    output: lightBudget.maxOutputTokens,
    reasoning: lightBudget.maxReasoningTokens,
    total: lightBudget.maxTotalTokens
  }), { input: 120000, output: 65536, reasoning: 32768, total: 185536 });
  const balancedBudget = api.debugCreateCanonicalProviderBudget(['librarian']);
  assert.deepEqual(plain({
    input: balancedBudget.maxInputTokens,
    output: balancedBudget.maxOutputTokens,
    reasoning: balancedBudget.maxReasoningTokens,
    total: balancedBudget.maxTotalTokens
  }), { input: 120000, output: 65536, reasoning: 32768, total: 185536 });

  const estimatedUsage = api.debugCanonicalProviderBudgetScenario({
    activeStages: ['librarian'],
    stage: 'librarian', maxTokens: 1200,
    systemPrompt: 's'.repeat(1200), userPrompt: 'u'.repeat(2400),
    content: '{"edits":[]}'
  });
  assert.ok(estimatedUsage.budget.usage.inputTokens > 0,
    'missing provider usage must use the conservative preflight estimate');
  assert.ok(estimatedUsage.budget.usage.outputTokens > 0,
    'missing provider usage must estimate visible output');
  assert.ok(estimatedUsage.budget.usage.totalTokens >= estimatedUsage.budget.usage.inputTokens + estimatedUsage.budget.usage.outputTokens);
  assert.equal(estimatedUsage.budget.attempts[0].usageEstimated, true);

  const repairSequence = api.debugCanonicalProviderBudgetSequence({
    activeStages: stages,
    steps: [
      { stage: 'librarian', attemptType: 'initial', maxTokens: 1200, content: '{}' },
      { stage: 'librarian', attemptType: 'authoritative_repair', maxTokens: 1200, content: '{"edits":[]}' }
    ]
  });
  assert.equal(repairSequence.budget.totalCalls, 1,
    'a rejected second corrective call must not consume the provider-call budget');
  assert.equal(repairSequence.budget.retryLedger.librarian.correctiveAttempts, 0);
  assert.equal(repairSequence.errors.length, 1);
  assert.equal(repairSequence.errors[0].code, 'canonical_provider_call_budget_exhausted');

  const lowReserve = api.debugCanonicalProviderBudgetSequence({
    activeStages: ['librarian'],
    overrides: { maxOutputTokens: 4000, maxTotalTokens: 10000 },
    persisted: {
      usage: { inputTokens: 0, outputTokens: 3500, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 3500 }
    },
    steps: [{ stage: 'librarian', maxTokens: 2000, content: '{}' }]
  });
  assert.equal(lowReserve.budget.totalCalls, 0);
  assert.equal(lowReserve.errors[0].code, 'canonical_provider_output_token_budget_exhausted');

  const promptOverflow = api.debugCanonicalProviderBudgetSequence({
    activeStages: ['librarian'],
    overrides: { maxInputTokens: 20000, maxTotalTokens: 30000 },
    steps: [{ stage: 'librarian', maxTokens: 4000, systemPrompt: 'a'.repeat(60000), userPrompt: 'b'.repeat(60000) }]
  });
  assert.equal(promptOverflow.budget.totalCalls, 0);
  assert.equal(promptOverflow.errors[0].code, 'canonical_provider_input_token_budget_exhausted');

  const postflight = api.debugCanonicalProviderBudgetScenario({
    activeStages: ['librarian'],
    overrides: { maxInputTokens: 10000, maxOutputTokens: 4000, maxReasoningTokens: 2000, maxTotalTokens: 14000 },
    stage: 'librarian', maxTokens: 2000,
    result: {
      ok: true, content: '{}',
      usage: { prompt_tokens: 1000, completion_tokens: 4500, total_tokens: 5500 }
    }
  });
  assert.match(postflight.budget.exhaustedReason, /postflight_output_token_budget/);
  const resumed = api.debugCanonicalProviderBudgetSequence({
    activeStages: ['librarian'],
    overrides: { maxInputTokens: 10000, maxOutputTokens: 4000, maxReasoningTokens: 2000, maxTotalTokens: 14000 },
    persisted: postflight.budget,
    steps: [{ stage: 'librarian', attemptType: 'authoritative_repair', maxTokens: 1000, content: '{}' }]
  });
  assert.equal(resumed.budget.totalCalls, 1,
    'resuming an exhausted budget must not add another provider call');
  assert.equal(resumed.errors[0].code, 'canonical_provider_budget_already_exhausted');

  if (unload) await unload();
  console.log('libra_provider_budget_runtime_test: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
