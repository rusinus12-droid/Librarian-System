'use strict';
// LIA feature check against a real OpenAI-compatible chat model (plugin_only mode).
//
// Boots the shipped plugins/LIA_Persona_Linker.js in the native runtime fixture, opens
// the real GUI (openUI) inside jsdom, and drives every LLM-backed feature through the
// production provider transport (callIndependentProvider -> callOpenAICompat -> liaFetch
// -> api.nativeFetch). Only nativeFetch is redirected: model URLs go to the real network,
// LIA server URLs (127.0.0.1:47630) are refused because the mode is plugin_only. The
// transformSource seam only *exposes* private functions and records setStatus messages;
// no production function is replaced.
// Also checks the afterRequest emotion-asset attach (no LLM) and the world-lore reranker.
//
//   RAG_EVAL_LLM_URL (…/v1)  RAG_EVAL_LLM_KEY or OLLAMA_KEY  RAG_EVAL_LLM_MODEL
//   NODE_USE_ENV_PROXY=1 behind a proxy; NODE_PATH must resolve jsdom.
// Usage: node tools/rag_eval/lia_feature_llm_check.cjs [--provider custom|ollama_cloud] [--thinking auto|off] [--json out.json] [--only a,b] [--timeout-ms 180000]
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createFixture } = require('../../tests/fixtures/lia_native_runtime_fixture.cjs');

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const llmBase = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const llmKey = String(process.env.RAG_EVAL_LLM_KEY || process.env.OLLAMA_KEY || '');
const llmModel = String(process.env.RAG_EVAL_LLM_MODEL || 'deepseek-v4.1-flash:cloud');
// LIA provider key stored in the config: 'custom' (generic OpenAI-compatible) or e.g. 'ollama_cloud'.
const liaProvider = String(option('--provider') || process.env.RAG_EVAL_LIA_PROVIDER || 'custom');
// --thinking off stores the user-facing "thinking disabled" setting (reasoningPreset off, thinkingType disabled).
const thinkingOff = String(option('--thinking') || 'auto') === 'off';
if (!llmBase || !llmKey) throw new Error('RAG_EVAL_LLM_URL and RAG_EVAL_LLM_KEY (or OLLAMA_KEY) are required');
const providerTimeoutMs = Math.max(5000, Math.min(300000, Number(option('--timeout-ms') || 180000)));
const only = new Set(String(option('--only') || '').split(',').map(s => s.trim()).filter(Boolean));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => String(text ?? '').split(llmKey).join('[key]');
const clip = (text, n = 220) => { const s = redact(typeof text === 'string' ? text : JSON.stringify(text)); return s.length > n ? `${s.slice(0, n)}…` : s; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

// ---- fixture world -------------------------------------------------------
const lore = (key, comment, content, extra = {}) => ({ key, secondkey: '', comment, content, mode: 'normal', alwaysActive: false, insertorder: 10, selective: false, ...extra });
const characterPatch = {
  name: 'Captain Aria Venn',
  desc: 'Captain Aria Venn commands the Ember Watch, the city guard of Velmora, a rain-soaked port kingdom ruled by the Tide Council. '
    + 'She is stern, scarred, and loyal to the crown. Her trusted healer Brother Tomas runs the Lantern Infirmary, and the smuggler queen Mira Saltwhisper '
    + 'controls the Undertide docks. {{user}} is a newly sworn recruit of the Ember Watch.',
  personality: 'Disciplined, dry humor, protective of her recruits, distrustful of mages.',
  scenario: 'Night patrol in the flooded lower districts of Velmora after a string of tide-magic thefts.',
  firstMessage: 'Aria tosses you a lantern. "Keep it lit, recruit. The Undertide eats careless people."',
  globalLore: [
    lore('Velmora, Tide Council', 'World Rules', 'Velmora is a human kingdom. Tide magic is outlawed for everyone except licensed Tide Wardens; unlicensed casting is punished by exile. No elves or beastfolk live in Velmora.', { alwaysActive: true, insertorder: 120 }),
    lore('Ember Watch, recruit', 'Ember Watch', 'The Ember Watch is the city guard. Recruits carry storm lanterns, swear an oath to the Tide Council, and serve one year in the lower districts.'),
    lore('Undertide, docks, smuggler', 'Undertide', 'The Undertide is the flooded dock district controlled by Mira Saltwhisper, a smuggler who trades in stolen tide-glass.'),
    lore('Lantern Infirmary, Tomas', 'Lantern Infirmary', 'Brother Tomas, a soft-spoken monk, treats wounded guards for free at the Lantern Infirmary.'),
    lore('tide-glass', 'Tide-glass', 'Tide-glass stores tide magic; possessing it without a Warden license is a crime.'),
    lore('names, naming', 'Naming Culture', 'Velmoran names are short and maritime: Aria, Tomas, Mira, Kell, Brin. Family names describe the sea (Saltwhisper, Venn, Gullmarch).'),
    lore('bakery, bread', 'Bakery', 'The Gullmarch bakery sells cheap rye bread every morning.'),
    lore('weather', 'Weather', 'It rains most nights in autumn.'),
    lore('festival', 'Lantern Festival', 'Once a year the city floats paper lanterns to honor drowned sailors.'),
    lore('horses', 'Stables', 'The palace stables keep twelve grey horses.'),
  ],
};
const chatTurns = [
  ['I keep the lantern raised and scan the flooded alley. "Captain, I grew up on these docks. I know where the smugglers hide their skiffs."', 'Aria raises an eyebrow. "A dock rat in my Watch. Fine. Lead the way, but stay behind my shield."'],
  ['I hesitate at the Undertide gate. "Mira Saltwhisper once paid my mother\'s debts. I owe her, but I swore an oath to the Council." I clench my jaw.', 'Aria studies you. "Divided loyalties get guards killed. Choose before the tide turns."'],
  ['I step forward anyway, voice steady. "My oath comes first. I will report the tide-glass, even if it costs me my old friends."', 'Aria nods slowly, something like respect in her scarred face.'],
  ['I bandage a wounded guard with my own scarf and carry him toward the Lantern Infirmary. "Brother Tomas taught me field dressing when I was a kid."', 'Brother Tomas meets you at the door. "Gentle hands, as always. Bring him in."'],
  ['I laugh nervously as rain pours down. "I hate the rain, Captain, but I am not going to quit. Give me the night watch again tomorrow."', 'Aria smirks. "Stubborn. Good. Night watch it is, recruit."'],
];
const chatMessages = chatTurns.flatMap(([user, assistant], index) => [
  { role: 'user', is_user: true, chatId: `u${index + 1}`, data: user },
  { role: 'char', is_user: false, chatId: `a${index + 1}`, data: assistant },
]);

// ---- source seam: expose only ---------------------------------------------
function expose(source) {
  const runtimeAnchor = '    globalThis[LIA_RUNTIME_INSTANCE_KEY] = {';
  const methodAnchor = '      getLiveSyncCaptureState:';
  if (!source.includes(runtimeAnchor) || !source.includes(methodAnchor)) throw new Error('LIA exposure anchors not found');
  source = source.replace(runtimeAnchor, `
    { const __liaCheckSetStatus = setStatus; setStatus = (message, tone = "info") => { try { api.__liaCheckStatus?.(String(message), tone); } catch (_) {} return __liaCheckSetStatus(message, tone); }; }
${runtimeAnchor}`);
  source = source.replace(methodAnchor, `
      liaCheck: {
        getContext: (o) => getContext(o), readContextOptions: () => readContextOptions(), readLLMConfig: () => readLLMConfig(),
        testProviderConnection: (c) => testProviderConnection(c), generateWorldBlueprint: (c, o) => generateWorldBlueprint(c, o),
        runLiaMockupAction: (a, b) => runLiaMockupAction(a, b), handleLiaMockupClick: (e) => handleLiaMockupClick(e),
        runPersonaAudit: () => runPersonaAudit(), buildPersonaAuditFixPlan: (m) => buildPersonaAuditFixPlan(m),
        handlePersonaEmotionAssetAfterRequest: (c, t) => handlePersonaEmotionAssetAfterRequest(c, t),
        writePersonaVisualAssetStore: (s) => writePersonaVisualAssetStore(s), readStoredWorldBlueprintVault: () => readWorldBlueprintVault(),
        readStoredResultVault: () => readStoredResultVault(), getLLMResultOverride: () => getLLMResultOverride(),
        selectAuditRecommendations: (ids) => { preservedPersonaAuditSelection = new Set(ids.map(String)); },
        state: () => ({ randomCandidates: preservedRandomCandidates, selectedRandom: preservedSelectedRandomCandidateId, characterCandidates: preservedCharacterCandidates,
          selectedCharacter: preservedSelectedCharacterCandidateId, audit: preservedPersonaAudit, auditFixPlan: preservedPersonaAuditFixPlan,
          evolution: preservedPersonaEvolution, translation: preservedTranslationText, llmResultText: preservedLLMResultText }),
      },
${methodAnchor}`);
  return source;
}

// ---- transport -------------------------------------------------------------
const llmLog = [];
let blockedServer = 0;
function makeNativeFetch() {
  return async (url, init = {}) => {
    const target = String(url || '');
    if (/127\.0\.0\.1:47630|localhost:47630/.test(target)) { blockedServer += 1; throw new Error('LIA server offline (plugin_only check)'); }
    if (!target.startsWith(llmBase)) throw new Error(`unexpected network target refused by check: ${target.slice(0, 80)}`);
    let body = {};
    try { body = JSON.parse(String(init.body || '{}')); } catch (_) {}
    const row = { url: target.slice(llmBase.length), model: body.model, maxTokens: body.max_tokens ?? body.max_completion_tokens, responseFormat: body.response_format?.type || '', reasoningEffort: body.reasoning_effort, startedAt: performance.now(), ms: 0, status: 0, finish: '', contentChars: 0, error: '' };
    llmLog.push(row);
    try {
      const response = await fetch(target, init);
      row.status = response.status;
      const text = await response.text();
      row.ms = Math.round(performance.now() - row.startedAt);
      try { const data = JSON.parse(text); row.finish = data?.choices?.[0]?.finish_reason || ''; row.contentChars = String(data?.choices?.[0]?.message?.content || '').length; row.reasoningChars = String(data?.choices?.[0]?.message?.reasoning || '').length; row.usage = data?.usage; row.contentHead = clip(data?.choices?.[0]?.message?.content || '', 400); } catch (_) {}
      if (!response.ok) row.error = clip(text, 300);
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      row.ms = Math.round(performance.now() - row.startedAt);
      row.error = clip(error?.message || error, 300);
      throw error;
    }
  };
}

// ---- DOM -----------------------------------------------------------------
function installDom(f) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://risu.local/' });
  const w = dom.window;
  if (!w.CSS) w.CSS = {};
  if (typeof w.CSS.escape !== 'function') w.CSS.escape = value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
  if (!w.HTMLDialogElement?.prototype?.showModal && w.HTMLDialogElement) { w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { this.open = false; }; }
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.focus = function () {};
  for (const name of ['document', 'window', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'FileReader', 'Image', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'SVGElement', 'DocumentFragment', 'HTMLTemplateElement']) {
    if (w[name] !== undefined) f.context[name] = typeof w[name] === 'function' && /^[a-z]/.test(name) ? w[name].bind(w) : w[name];
  }
  return dom;
}

// ---- run -------------------------------------------------------------------
const results = [];
async function feature(name, trigger, fn) {
  if (only.size && !only.has(name)) return;
  const before = llmLog.length;
  const startedAt = performance.now();
  const row = { feature: name, trigger, ok: false, llmCalls: 0, ms: 0, evidence: '', error: '' };
  try {
    const out = await Promise.race([fn(), sleep(Math.max(600000, providerTimeoutMs * 4)).then(() => { throw new Error('check timeout'); })]);
    row.ok = out?.ok !== false;
    row.evidence = clip(out?.evidence ?? out, 600);
    if (out?.error) row.error = clip(out.error, 600);
  } catch (error) {
    row.error = clip(error?.stack || error?.message || error, 900);
  }
  row.ms = Math.round(performance.now() - startedAt);
  const calls = llmLog.slice(before);
  row.llmCalls = calls.length;
  row.calls = calls.map(c => ({ reasoningEffortSent: c.reasoningEffort, contentHead: row.ok ? undefined : c.contentHead, ms: c.ms, status: c.status, finish: c.finish, maxTokens: c.maxTokens, responseFormat: c.responseFormat, contentChars: c.contentChars, reasoningChars: c.reasoningChars, usage: c.usage, error: c.error }));
  results.push(row);
  process.stderr.write(`[${row.ok ? 'ok' : 'FAIL'}] ${name} calls=${row.llmCalls} ${row.ms}ms ${row.ok ? row.evidence.slice(0, 160) : row.error.slice(0, 300)}\n`);
}

async function main() {
  const statusLog = [];
  let openUI = null;
  let afterRequestReplacer = null;
  let characterWrites = 0;
  const f = await createFixture('official', {
    transformSource: expose,
    configureApi(api, { values, liveChat, db }) {
      Object.assign(db.characters[0], characterPatch);
      liveChat.message = chatMessages;
      values.set('dynamicPersonaLorebookGeneratorLLMConfig', JSON.stringify({
        provider: liaProvider, endpoint: `${llmBase}/chat/completions`, model: llmModel, apiKey: llmKey,
        temp: 0.4, timeout: providerTimeoutMs, maxCompletionTokens: 8192, requestFormat: 'chat_completions',
        ...(thinkingOff ? { reasoningPreset: 'off', reasoningEffort: 'none', thinkingType: 'disabled' } : {}),
      }));
      api.nativeFetch = makeNativeFetch();
      api.registerSetting = async (_name, callback) => { openUI = callback; return true; };
      const addReplacer = api.addRisuReplacer;
      api.addRisuReplacer = async (type, handler) => { if (type === 'afterRequest') afterRequestReplacer = handler; return await addReplacer(type, handler); };
      api.readImage = async () => new Uint8Array(PNG);
      api.setCharacter = async next => { characterWrites += 1; Object.assign(db.characters[0], next); return true; };
      api.__liaCheckStatus = (message, tone) => statusLog.push({ message: redact(message), tone });
    },
  });
  process.stderr.write('[check] fixture booted\n');
  const dom = installDom(f);
  const lia = f.runtime.liaCheck;
  const lastStatus = since => statusLog.slice(since).filter(s => s.tone === 'ok' || s.tone === 'error').pop() || statusLog[statusLog.length - 1] || {};
  const actionResult = async (action, button) => {
    const mark = statusLog.length;
    const result = await lia.runLiaMockupAction(action, button);
    const status = lastStatus(mark);
    return { result, status, ok: result !== false && status.tone !== 'error' };
  };
  const el = id => f.context.document.getElementById(id);
  try {
    if (typeof openUI !== 'function') throw new Error('openUI was not registered');
    process.stderr.write('[check] opening GUI\n');
    await openUI();
    process.stderr.write('[check] GUI open\n');
    await sleep(300);
    if (!el('dpg-preview-root')) throw new Error('GUI root not rendered');

    await feature('lore_rerank', 'getContext() -> rerankWorldLoreEntriesWithCompute (local) + debugRerankWorldLoreWithCompute', async () => {
      const ctx = await lia.getContext();
      const selected = ctx.worldLoreRerank?.selected || [];
      const labels = selected.map(e => e.label || e.comment);
      const query = { ...ctx, characterDescription: [{ label: 'Query', content: 'tide magic law smuggling tide-glass Undertide' }] };
      const ranked = await f.runtime.debugRerankWorldLoreWithCompute(ctx.loreCandidates, query, 4);
      const top = (ranked.selected || []).map(e => e.label || e.comment);
      const status = f.runtime.debugWorldLoreComputeStatus();
      const kernelEntries = ctx.loreCandidates.map((e, position) => ({ position, loreId: e.loreId, key: e.key, secondkey: e.secondkey || '', comment: e.comment, content: e.content, mode: e.mode, alwaysActive: e.alwaysActive === true, insertorder: e.insertorder || 0, source: e.source, score: e.score || 0 }));
      const kernel = JSON.parse(JSON.stringify(f.runtime.debugWorldLoreComputeLocal({ version: 'lia_lore_reranker_v2', purpose: 'world', topK: 3, query: 'Undertide docks smuggler Mira Saltwhisper', entries: kernelEntries })));
      const kernelTop = kernel.selected.map(e => kernelEntries[e.position]?.comment ?? kernelEntries.find(k => k.loreId === e.loreId)?.comment);
      const relevant = ['World Rules', 'Undertide', 'Tide-glass'].filter(l => top.includes(l) || labels.includes(l));
      const noise = ['Stables', 'Bakery'].filter(l => top.slice(0, 3).includes(l));
      return { ok: labels[0] === 'World Rules' && relevant.length >= 2 && !noise.length && kernelTop.includes('Undertide') && !kernelTop.includes('Stables'), evidence: { candidates: ctx.loreCandidates.length, contextSelected: labels, queryTop4: top, smugglerQueryTop: kernelTop, mode: status.mode, blockedServerCalls: blockedServer } };
    });

    await feature('testProviderConnection', 'GUI #dpg-test-llm click handler -> testProviderConnection(readLLMConfig())', async () => {
      const button = el('dpg-test-llm');
      if (!button) throw new Error('#dpg-test-llm not rendered');
      const mark = statusLog.length;
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < providerTimeoutMs / 250 && !statusLog.slice(mark).some(s => s.tone === 'ok' || s.tone === 'error'); i += 1) await sleep(250);
      const status = lastStatus(mark);
      return { ok: status.tone === 'ok', evidence: status.message, error: status.tone === 'error' ? status.message : '' };
    });

    await feature('generateWorldBlueprint', 'direct generateWorldBlueprint(ctx,{force:true,config:readLLMConfig()}) (= [data-lia-refresh-blueprint] handler)', async () => {
      const ctx = await lia.getContext(lia.readContextOptions());
      const state = await lia.generateWorldBlueprint(ctx, { force: true, config: lia.readLLMConfig() });
      const vault = await lia.readStoredWorldBlueprintVault();
      const bp = state.blueprint || {};
      return { ok: Boolean(state.generated && vault.some(i => i.key === state.key)), evidence: { stored: vault.length, hardConstraints: bp.hardConstraints?.length, safeCreativeSpace: bp.safeCreativeSpace?.length, summary: clip(bp.summary, 160) } };
    });

    await feature('generateRandomCandidates', 'runLiaMockupAction("candidate", {variant:random}) (#random-cand-go)', async () => {
      const button = f.context.document.createElement('button');
      button.dataset.ctx = JSON.stringify({ variant: 'random' });
      const out = await actionResult('candidate', button);
      const st = lia.state();
      return { ok: out.ok && st.randomCandidates.length === 3, evidence: { candidates: st.randomCandidates.map(c => `${c.name} (${c.role || c.speciesRace || ''})`), status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('runLLMRewrite_random', 'select candidate via [data-lia-candidate-id] click, runLiaMockupAction("generate") (#btn-cand-go)', async () => {
      const st = lia.state();
      if (!st.randomCandidates.length) throw new Error('no random candidates (previous step failed)');
      const pick = f.context.document.createElement('button');
      pick.dataset.liaCandidateId = st.randomCandidates[0].id;
      el('dpg-preview-root').append(pick);
      await lia.handleLiaMockupClick({ target: pick, preventDefault() {} });
      pick.remove();
      if (lia.state().selectedRandom !== st.randomCandidates[0].id) throw new Error('candidate selection did not register');
      const out = await actionResult('generate', null);
      const result = lia.getLLMResultOverride();
      const vault = await lia.readStoredResultVault();
      return { ok: out.ok && Boolean(result?.personaPrompt && result?.personaSpec?.name), evidence: { personaName: result?.personaName, specName: result?.personaSpec?.name, expected: st.randomCandidates[0].name, promptChars: result?.personaPrompt?.length, vaultItems: vault.length, status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('rerollPersonaFields', 'runLiaMockupAction("reroll-field", [data-regen=speech])', async () => {
      const before = lia.getLLMResultOverride()?.personaSpec;
      if (!before) throw new Error('no persona draft (previous step failed)');
      const button = f.context.document.createElement('button');
      button.dataset.regen = 'speech';
      const out = await actionResult('reroll-field', button);
      const after = lia.getLLMResultOverride()?.personaSpec || {};
      const unchanged = ['name', 'gender', 'age', 'origin'].filter(k => String(before[k]) === String(after[k]));
      return { ok: out.ok && after.speech && after.speech !== before.speech, evidence: { speechBefore: clip(before.speech, 80), speechAfter: clip(after.speech, 80), nonTargetUnchanged: unchanged, status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('runPersonaAudit', 'direct runPersonaAudit() (= [data-lia-run-audit] handler)', async () => {
      const audit = await lia.runPersonaAudit();
      return { ok: Number.isFinite(audit?.score), evidence: { score: audit.score, verdict: audit.verdict, hard: audit.hardConflicts?.length, soft: audit.softRisks?.length, recommendations: audit.recommendations?.length } };
    });

    await feature('buildPersonaAuditFixPlan', 'direct buildPersonaAuditFixPlan(hard|selected) (= [data-lia-build-*-fix] handler)', async () => {
      const audit = lia.state().audit;
      if (!audit) throw new Error('no audit (previous step failed)');
      let mode = 'hard';
      if (!audit.hardConflicts?.length) { mode = 'selected'; lia.selectAuditRecommendations(audit.recommendations.map((_, i) => i).slice(0, 2)); }
      if (mode === 'selected' && !audit.recommendations?.length) return { ok: false, error: 'audit produced neither hard conflicts nor recommendations; nothing to plan' };
      const plan = await lia.buildPersonaAuditFixPlan(mode);
      return { ok: Array.isArray(plan?.changes), evidence: { mode, changes: plan.changes.length, fields: plan.changes.map(c => c.field || c.key).slice(0, 6) } };
    });

    await feature('runPersonaEvolution', 'runLiaMockupAction("run-evolution") (#lia-run-evolution)', async () => {
      const out = await actionResult('run-evolution', null);
      const evo = lia.state().evolution;
      return { ok: out.ok && Array.isArray(evo?.suggestions), evidence: { suggestions: evo?.suggestions?.length, fields: (evo?.suggestions || []).map(s => s.field).slice(0, 6), status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('translateCurrentPersona', 'runLiaMockupAction("translate") (#lia-translate-persona)', async () => {
      const out = await actionResult('translate', null);
      const text = lia.state().translation;
      const hangul = (String(text).match(/[가-힣]/g) || []).length;
      return { ok: out.ok && hangul > 20, evidence: { chars: String(text).length, hangul, head: clip(text, 100), status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('generateCharacterCandidates', 'runLiaMockupAction("candidate", {variant:character})', async () => {
      const button = f.context.document.createElement('button');
      button.dataset.ctx = JSON.stringify({ variant: 'character' });
      const out = await actionResult('candidate', button);
      const st = lia.state();
      return { ok: out.ok && st.characterCandidates.length > 0, evidence: { candidates: st.characterCandidates.map(c => c.name), autoSelected: Boolean(st.selectedCharacter), status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('runLLMRewrite_character', 'select character candidate, runLiaMockupAction("generate")', async () => {
      const st = lia.state();
      if (!st.characterCandidates.length) throw new Error('no character candidates (previous step failed)');
      const target = st.characterCandidates.find(c => /tomas/i.test(c.name)) || st.characterCandidates[0];
      const pick = f.context.document.createElement('button');
      pick.dataset.liaCandidateId = target.id;
      el('dpg-preview-root').append(pick);
      await lia.handleLiaMockupClick({ target: pick, preventDefault() {} });
      pick.remove();
      const out = await actionResult('generate', null);
      const result = lia.getLLMResultOverride();
      return { ok: out.ok && result?.generationMode === 'character' && Boolean(result?.personaPrompt), evidence: { target: target.name, specName: result?.personaSpec?.name, mode: result?.generationMode, status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('runManualLivePersonaAnalysis', 'runLiaMockupAction("update-five") (#upd-go) -> analyzeLivePersonaBatch', async () => {
      const out = await actionResult('update-five', el('upd-go'));
      const key = [...f.values.keys()].find(k => k.startsWith('liaPersonaLinkerLivePersonaScopeV2::'));
      const binding = JSON.parse(f.values.get(key));
      const live = f.db.personas.find(p => p.id === binding.livePersonaId);
      return { ok: out.ok && binding.lastProcessedPairCount === 5, evidence: { lastProcessedPairCount: binding.lastProcessedPairCount, liveState: (binding.liveState || []).map(i => `${i.category}:${clip(i.value, 60)}`).slice(0, 5), ledgers: binding.ledgers?.length, livePromptChanged: live?.personaPrompt !== 'Base persona prompt', status: out.status.message }, error: out.ok ? '' : out.status.message };
    });

    await feature('afterRequest_emotion_asset', 'registered afterRequest replacer (no LLM) with stored visual set', async () => {
      if (typeof afterRequestReplacer !== 'function') throw new Error('afterRequest replacer not registered');
      const persona = f.db.personas[0];
      await lia.writePersonaVisualAssetStore({ sets: { [`persona:${persona.id}`]: { personaKey: `persona:${persona.id}`, personaId: persona.id, personaName: persona.name, assetPrefix: 'SourcePersona', images: {
        neutral: { emotion: 'neutral', assetPath: 'assets/sp_neutral.png', assetName: 'SourcePersona_neutral', mime: 'image/png' },
        angry: { emotion: 'angry', assetPath: 'assets/sp_angry.png', assetName: 'SourcePersona_angry', mime: 'image/png' },
      } } } });
      const content = [
        'Rain hammered the Undertide docks.',
        `${persona.name} glared at the smuggler, furious, and frowned with clenched teeth. "You sold tide-glass to children," ${persona.name} snapped, angry.`,
        'Mira only laughed and stepped back into the fog.',
        'The lantern flickered.',
      ].join('\n\n');
      const out = await afterRequestReplacer(content, 'model');
      const skipped = await afterRequestReplacer(content, 'submodel');
      const assets = f.db.characters[0].additionalAssets || [];
      const attached = /\{\{image::SourcePersona_angry\}\}/.test(out);
      return { ok: attached && skipped === content, evidence: { attachedAngry: attached, lia_inline_markup: out.includes('lia-inline-emotion-asset'), characterAssetWrites: characterWrites, characterAssets: JSON.stringify(assets).slice(0, 120), submodelUntouched: skipped === content } };
    });
  } finally {
    await f.dispose();
    dom.window.close();
  }
  const summary = { model: llmModel, liaProvider, thinking: thinkingOff ? 'off' : 'auto', endpoint: '(RAG_EVAL_LLM_URL)/chat/completions', providerTimeoutMs, mode: 'plugin_only', blockedServerCalls: blockedServer, totalLlmCalls: llmLog.length,
    imageGeneration: 'skipped (generatePersonaVisualEmotion uses an image provider)', results };
  const json = option('--json');
  if (json) fs.writeFileSync(json, JSON.stringify(summary, null, 2));
  process.stdout.write(`${redact(JSON.stringify(summary, null, 2))}\n`);
  process.exit(results.some(r => !r.ok) ? 1 : 0);
}

main().catch(error => { process.stderr.write(`lia_feature_llm_check: FATAL ${redact(error?.stack || error)}\n`); process.exit(2); });
