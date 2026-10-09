'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const closeIndex = code.lastIndexOf('\n})();');
if (closeIndex < 0) throw new Error('plugin IIFE close not found');
code = code.slice(0, closeIndex)
  + '\n;globalThis.__LIBRA_PROFILE_TEST_API__={LLMProvider,resolveLLMRouteProfile};\n'
  + code.slice(closeIndex);

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this._id = '';
    this.className = '';
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._innerHTML = '';
    this.textContent = '';
  }
  set id(value) { this._id = String(value || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(value) { this._innerHTML = String(value || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id) this.ownerDocument?._register(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector() { return null; }
}

class FakeDocument {
  constructor() {
    this._ids = Object.create(null);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }
  _register(el) { if (el?.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(selector) {
    if (selector === 'head') return this.head;
    if (selector === 'body') return this.body;
    return null;
  }
}

const assertions = [];
const assertCase = (name, ok, detail = null) => assertions.push({ name, ok: !!ok, detail });

(async () => {
  const document = new FakeDocument();
  const storage = new Map();
  let retryCalls = 0;
  let abortObserved = false;
  let capturedOpenAiBody = null;
  let capturedResponsesBody = null;
  let lastProviderRequest = null;
  let profileScenario = 'network';
  let primaryProfileCalls = 0;
  let auxProfileCalls = 0;
  const encoder = new TextEncoder();

  const nativeFetch = async (url, init = {}) => {
    const target = String(url || '');
    lastProviderRequest = { url: target, headers: { ...(init.headers || {}) }, method: init.method || 'GET' };
    if (target.includes('profile-primary.test')) {
      primaryProfileCalls += 1;
      if (profileScenario === 'abort') {
        return await new Promise((resolve, reject) => {
          const abort = () => reject(init.signal?.reason || new DOMException('Aborted', 'AbortError'));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener?.('abort', abort, { once: true });
        });
      }
      throw new TypeError('network failed for primary profile');
    }
    if (target.includes('profile-aux.test')) {
      auxProfileCalls += 1;
      return new Response('{"choices":[{"message":{"content":"AUX_PROFILE_OK"}}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (target.includes('/stream-test')) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode([
            'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}',
            '',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            ''
          ].join('\n')));
          setTimeout(() => {
            controller.enqueue(encoder.encode([
              'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":3}}}',
              '',
              'data: [DONE]',
              ''
            ].join('\n')));
            controller.close();
          }, 10);
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (target.includes('/retry-test')) {
      retryCalls += 1;
      if (retryCalls === 1) {
        return new Response('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '0' } });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/abort-test')) {
      return await new Promise((resolve, reject) => {
        const abort = () => {
          abortObserved = true;
          reject(init.signal?.reason || new DOMException('Aborted', 'AbortError'));
        };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener?.('abort', abort, { once: true });
      });
    }
    if (target.includes('/responses')) {
      capturedResponsesBody = JSON.parse(String(init.body || '{}'));
      return new Response('{"id":"resp_test","output":[{"type":"message","content":[{"type":"output_text","text":"RESPONSES_OK"}]}],"usage":{"input_tokens":6,"output_tokens":2,"total_tokens":8}}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (target.includes('/models')) {
      return new Response('{"data":[{"id":"model-z","context_length":32000},{"id":"model-a","context_window":128000}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (target.includes('/chat/completions')) {
      capturedOpenAiBody = JSON.parse(String(init.body || '{}'));
      return new Response('{"choices":[{"message":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected nativeFetch URL: ${target}`);
  };

  const Risuai = {
    apiVersion: '3.0',
    nativeFetch,
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(key) { return key === 'activity_dashboard' ? 'off' : undefined; },
    pluginStorage: {
      async getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      async setItem(key, value) { storage.set(key, String(value)); },
      async removeItem(key) { storage.delete(key); }
    },
    async getCharacter() { return null; },
    async registerSetting() {},
    async registerButton() {},
    async requestPluginPermission() { return false; },
    async onUnload() {}
  };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    URL,
    Promise,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    Response,
    Headers,
    AbortController,
    DOMException,
    structuredClone: global.structuredClone,
    performance: { now: () => Date.now() },
    document,
    Risuai,
    risuai: Risuai,
    __LIBRA_PROVIDER_TEST_HOOKS__: true,
    globalThis: null,
    window: null
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 50));

  const api = context.__LIBRA_PROVIDER_TEST_API__;
  assertCase('provider_test_api_exported', !!api && typeof api.resolveProviderOutputBudget === 'function');
  const small = api.resolveProviderOutputBudget(
    { maxCompletionTokens: 16000, reasoningEffort: 'medium', reasoningBudgetTokens: 0 },
    { maxTokens: 300 },
    'gpt'
  );
  assertCase('small_task_cap_not_inflated', small.providerMaxTokens === 300 && small.reasoningAllowed === false, small);

  const capped = api.resolveProviderOutputBudget(
    { maxCompletionTokens: 900, reasoningEffort: 'none', reasoningBudgetTokens: 0 },
    { maxTokens: 2000 },
    'generic'
  );
  assertCase('profile_cap_is_absolute_ceiling', capped.providerMaxTokens === 900, capped);

  const thinking = api.resolveProviderOutputBudget(
    { maxCompletionTokens: 12000, reasoningEffort: 'none', reasoningBudgetTokens: 8192 },
    { maxTokens: 1800 },
    'gemini'
  );
  assertCase('reasoning_budget_preserves_visible_room', thinking.providerMaxTokens === 1800 && thinking.reasoningBudgetTokens === 1170 && thinking.minimumVisibleTokens === 630, thinking);

  const openAi = api.getProvider('openai');
  await openAi.callLLM({
    llm: {
      provider: 'openai',
      url: 'https://unit.test',
      key: 'unit-key',
      model: 'gpt-5',
      temp: 0.2,
      timeout: 3000,
      stream: false,
      maxCompletionTokens: 16000,
      reasoningEffort: 'medium',
      reasoningBudgetTokens: 0
    }
  }, 'system', 'user', { maxTokens: 800, retryPolicy: { enabled: false } });
  assertCase('openai_adapter_uses_task_cap', capturedOpenAiBody?.max_completion_tokens === 800 && capturedOpenAiBody?.max_tokens === undefined, capturedOpenAiBody);
  const jsonModeResult = await openAi.callLLM({
    llm: {
      provider: 'ollama_cloud', url: 'https://unit.test', key: 'unit-key', model: 'glm-test', temp: 0.8,
      timeout: 3000, stream: true, maxCompletionTokens: 16000, reasoningEffort: 'none', reasoningBudgetTokens: 0
    }
  }, 'Return JSON only.', 'user', { maxTokens: 1200, jsonMode:true, forceJsonMode:true, forceNonStreaming:true, disableReasoning:true, retryPolicy:{ enabled:false } });
  assertCase('openai_compatible_json_mode_is_deterministic_nonstreaming_and_reports_finish_reason', capturedOpenAiBody?.response_format?.type === 'json_object' && capturedOpenAiBody?.temperature === 0 && capturedOpenAiBody?.stream !== true && capturedOpenAiBody?.max_tokens === 1200 && jsonModeResult.finishReason === 'stop' && jsonModeResult.truncated === false && jsonModeResult.jsonModeRequested === true, { capturedOpenAiBody, jsonModeResult });

  const directProviders = api.listDirectProviders();
  assertCase(
    'direct_provider_registry_is_exposed',
    directProviders.length >= 20
      && directProviders.some(item => item.key === 'deepseek')
      && directProviders.some(item => item.key === 'cloudflare-ai-gateway')
      && directProviders.some(item => item.key === 'vercel-ai'),
    directProviders
  );
  assertCase('direct_provider_aliases_are_normalized', api.normalizeProviderKey('venice') === 'venice-ai' && api.normalizeProviderKey('ollama_cloud') === 'ollama_cloud');
  assertCase(
    'provider_endpoint_join_avoids_duplicate_api_version',
    api.resolveEndpoint('together', 'https://api.together.xyz/v1', 'chat') === 'https://api.together.xyz/v1/chat/completions'
      && api.resolveEndpoint('fireworks', 'https://api.fireworks.ai/inference/v1/chat/completions', 'models') === 'https://api.fireworks.ai/inference/v1/models'
  );

  const deepseek = api.getProvider('deepseek');
  await deepseek.callLLM({
    llm: {
      provider: 'deepseek', key: 'deepseek-key', model: 'deepseek-chat', temp: 0.2,
      timeout: 3000, stream: false, requestFormat: 'chat_completions', reasoningPreset: 'deepseek',
      reasoningEffort: 'none', reasoningBudgetTokens: 0, maxCompletionTokens: 1000
    }
  }, 'system', 'user', { maxTokens: 256, retryPolicy: { enabled: false } });
  assertCase('deepseek_uses_official_chat_endpoint', lastProviderRequest?.url === 'https://api.deepseek.com/chat/completions', lastProviderRequest);

  const fireworks = api.getProvider('fireworks');
  const responsesResult = await fireworks.callLLM({
    llm: {
      provider: 'fireworks', key: 'fireworks-key', model: 'accounts/fireworks/models/test',
      timeout: 3000, stream: false, requestFormat: 'responses', reasoningEffort: 'low',
      reasoningBudgetTokens: 0, maxCompletionTokens: 1000
    }
  }, 'system instruction', 'user input', { maxTokens: 300, retryPolicy: { enabled: false } });
  assertCase(
    'responses_adapter_uses_native_shape',
    lastProviderRequest?.url === 'https://api.fireworks.ai/inference/v1/responses'
      && capturedResponsesBody?.max_output_tokens === 300
      && capturedResponsesBody?.input?.[0]?.content?.[0]?.type === 'input_text'
      && responsesResult.content === 'RESPONSES_OK',
    { lastProviderRequest, capturedResponsesBody, responsesResult }
  );

  const listedModels = await api.listModels('together', { key: 'together-key', force: true, timeout: 3000 });
  assertCase(
    'dynamic_model_list_is_normalized',
    lastProviderRequest?.url === 'https://api.together.xyz/v1/models'
      && listedModels.map(item => item.id).join(',') === 'model-a,model-z'
      && listedModels[0].contextWindow === 128000,
    { lastProviderRequest, listedModels }
  );

  let cloudflareTemplateError = null;
  try {
    await api.getProvider('cloudflare-ai-gateway').callLLM({
      llm: {
        provider: 'cloudflare-ai-gateway',
        url: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1/chat/completions',
        key: 'cf-key', model: 'openai/gpt-4.1', timeout: 3000, stream: false,
        requestFormat: 'chat_completions', reasoningEffort: 'none', reasoningBudgetTokens: 0, maxCompletionTokens: 200
      }
    }, 'system', 'user', { maxTokens: 100, retryPolicy: { enabled: false } });
  } catch (error) { cloudflareTemplateError = error; }
  assertCase('cloudflare_placeholder_url_is_rejected', cloudflareTemplateError?.code === 'MISSING_URL', cloudflareTemplateError?.message || '');

  const provider = api.createBaseProvider();
  const streamed = await provider._fetchStream(
    'https://unit.test/stream-test',
    { 'content-type': 'application/json' },
    { stream: true },
    3000,
    { provider: 'openai', retryPolicy: { enabled: false } }
  );
  assertCase('stream_reads_usage_after_finish_reason', streamed.content === 'OK' && streamed.usage.total_tokens === 15 && streamed.usage.cached_input_tokens === 3, streamed);
  assertCase('stream_waits_for_transport_done', streamed.streamMeta.generationDone === true && streamed.streamMeta.transportDone === true, streamed.streamMeta);

  const retried = await provider._fetch(
    'https://unit.test/retry-test',
    { 'content-type': 'application/json' },
    { test: true },
    3000,
    { retryPolicy: { enabled: true, maxRetries: 1, minDelayMs: 1, maxDelayMs: 50, deadlineAt: Date.now() + 3000 } }
  );
  assertCase('transient_429_retried_once', retryCalls === 2 && retried.ok === true, { retryCalls, retried });

  const abortController = new AbortController();
  const abortedCall = provider._fetch(
    'https://unit.test/abort-test',
    { 'content-type': 'application/json' },
    { test: true },
    3000,
    { signal: abortController.signal, retryPolicy: { enabled: false } }
  );
  setTimeout(() => abortController.abort(new DOMException('Unit abort', 'AbortError')), 20);
  let abortError = null;
  try { await abortedCall; } catch (error) { abortError = error; }
  assertCase('abort_signal_reaches_native_fetch', abortObserved === true && !!abortError, { abortObserved, error: abortError?.message || '' });

  const dashboard = context.LIBRA_ActivityDashboard;
  dashboard.reset();
  dashboard.recordLLM('aux', {
    prompt_tokens: 10,
    completion_tokens: 5,
    reasoning_tokens: 2,
    cached_content_token_count: 4,
    total_tokens: 15
  }, { foreground: false, label: 'background-test' });
  const dashboardState = dashboard.getState();
  assertCase('background_aux_usage_is_counted', dashboardState.auxLlmCalls === 1 && dashboardState.tokens.total === 15, dashboardState);
  assertCase('cached_tokens_not_counted_as_reasoning', dashboardState.tokens.reasoning === 2 && dashboardState.tokens.cachedInput === 4, dashboardState.tokens);

  const profileApi = context.__LIBRA_PROFILE_TEST_API__;
  const profileConfig = {
    useLLM: true,
    debug: false,
    llm: {
      provider: 'openai', url: 'https://profile-primary.test', key: 'unit-key', model: 'primary-model',
      timeout: 3000, stream: false, reasoningEffort: 'none', reasoningBudgetTokens: 0, maxCompletionTokens: 500
    },
    auxLlm: {
      enabled: true, provider: 'openai', url: 'https://profile-aux.test', key: 'unit-key', model: 'aux-model',
      timeout: 3000, stream: false, reasoningEffort: 'none', reasoningBudgetTokens: 0, maxCompletionTokens: 500
    }
  };
  const profileCall = () => profileApi.LLMProvider.call(profileConfig, 'system', 'user', {
    profile: 'primary', maxTokens: 120, retry: false, maxRetries: 0,
    allowProfileFailover: true, deadlineAt: Date.now() + 10000,
    label: 'profile-failover-test', domain: 'provider_test', dashboardForeground: false
  });
  const firstFailover = await profileCall();
  const secondFailover = await profileCall();
  const callsBeforeCircuitSkip = { primary: primaryProfileCalls, aux: auxProfileCalls };
  const circuitFailover = await profileCall();
  const healthAfterCircuit = profileApi.LLMProvider.getProfileHealthSnapshot();
  assertCase(
    'transient_primary_failure_uses_aux_once',
    firstFailover.content === 'AUX_PROFILE_OK'
      && firstFailover.profileFailover?.usedProfile === 'aux'
      && firstFailover.profileFailover?.circuitSkipped === false,
    firstFailover.profileFailover
  );
  assertCase(
    'two_failures_open_primary_circuit',
    healthAfterCircuit.some(item => item.profiles.includes('primary') && item.healthy === false && item.consecutiveFailures === 2),
    healthAfterCircuit
  );
  assertCase(
    'open_circuit_skips_primary_transport',
    callsBeforeCircuitSkip.primary === 2
      && primaryProfileCalls === callsBeforeCircuitSkip.primary
      && auxProfileCalls === callsBeforeCircuitSkip.aux + 1
      && circuitFailover.profileFailover?.circuitSkipped === true,
    { callsBeforeCircuitSkip, primaryProfileCalls, auxProfileCalls, metadata: circuitFailover.profileFailover }
  );
  assertCase(
    'route_resolver_prefers_healthy_profile',
    profileApi.resolveLLMRouteProfile('storyAuthor', profileConfig, 'primary') === 'aux'
  );
  assertCase(
    'provider_health_is_in_runtime_metrics',
    context.LIBRA_Metrics.snapshot().providerHealth.some(item => item.profiles.includes('primary') && item.healthy === false),
    context.LIBRA_Metrics.snapshot().providerHealth
  );

  profileApi.LLMProvider.resetProfileHealth();
  profileScenario = 'abort';
  const auxBeforeAbort = auxProfileCalls;
  const cancelledController = new AbortController();
  cancelledController.abort(new DOMException('User cancelled', 'AbortError'));
  let cancelledError = null;
  try {
    await profileApi.LLMProvider.call(profileConfig, 'system', 'user', {
      profile: 'primary', maxTokens: 120, retry: false, maxRetries: 0,
      allowProfileFailover: true, signal: cancelledController.signal,
      deadlineAt: Date.now() + 10000, label: 'profile-cancel-test', domain: 'provider_test'
    });
  } catch (error) { cancelledError = error; }
  assertCase(
    'user_abort_never_fails_over',
    !!cancelledError && auxProfileCalls === auxBeforeAbort,
    { error: cancelledError?.message || '', auxBeforeAbort, auxProfileCalls }
  );

  profileApi.LLMProvider.resetProfileHealth();
  profileScenario = 'network';
  const sameEndpointConfig = {
    ...profileConfig,
    auxLlm: { ...profileConfig.llm, enabled: true }
  };
  const primaryBeforeSameEndpoint = primaryProfileCalls;
  let sameEndpointError = null;
  try {
    await profileApi.LLMProvider.call(sameEndpointConfig, 'system', 'user', {
      profile: 'primary', maxTokens: 120, retry: false, maxRetries: 0,
      allowProfileFailover: true, deadlineAt: Date.now() + 10000,
      label: 'same-endpoint-test', domain: 'provider_test'
    });
  } catch (error) { sameEndpointError = error; }
  assertCase(
    'same_endpoint_profiles_are_not_called_twice',
    !!sameEndpointError && primaryProfileCalls === primaryBeforeSameEndpoint + 1,
    { error: sameEndpointError?.message || '', primaryBeforeSameEndpoint, primaryProfileCalls }
  );

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'llm_provider_hardening_test.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
