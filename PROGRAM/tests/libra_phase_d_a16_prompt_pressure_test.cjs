'use strict';

// A16: candidate reference budget exhaustion. Five long exact U+A turns plus real existing
// candidates are driven through the shipped prompt pressure path so the optional blocks are
// genuinely dropped in order (reference -> previous_state -> thread_candidates). The
// controlled provider receives the REAL composed user message; the test then checks the ten
// original rows survive byte-for-byte, that omission/coverage is recorded, and that an alias
// the request never presented is not accepted as a canonical link.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { branch } = require('./fixtures/native_branch_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const acceptance = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A16');
assert.ok(acceptance, 'the A16 acceptance scenario is present');

const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => {
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) { hash ^= body.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  hash ^= 31; hash = Math.imul(hash, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${body.length + 1}`;
};

// Verbose source so the prompt window can be squeezed below the exact-source block alone.
const LONG = '지호는 민아와 함께 오래된 서재의 기록을 다시 확인하면서 그날의 약속과 준비 과정과 남은 절차를 차분하게 정리했다. ';
const turns = [
  { turn: 1, user: `${LONG}지호는 민아에게 10월 1일 푸른 편지 전달 약속을 했다.`,
    assistant: `${LONG}민아는 그 약속을 기억하기로 했고 두 사람은 다음 절차를 확인했다.` },
  { turn: 2, user: `${LONG}두 사람은 편지를 준비하기로 했고 봉투와 종이와 잉크를 함께 골랐다.`,
    assistant: `${LONG}민아는 준비된 물건을 서재 선반에 정리해 두었다.` },
  { turn: 3, user: `${LONG}지호는 봉투를 준비했고 민아는 전달 날짜를 다시 확인했다.`,
    assistant: `${LONG}두 사람은 약속한 날이 10월 1일임을 다시 확인했다.` },
  { turn: 4, user: `${LONG}두 사람은 약속을 바꾸지 않았고 편지는 아직 전달되지 않았다.`,
    assistant: `${LONG}그날의 대화는 그 상태로 끝났다.` },
  { turn: 5, user: `${LONG}약속은 계속 열려 있었고 두 사람은 다음 날 다시 만나기로 했다.`,
    assistant: `${LONG}민아는 서재를 정리하고 지호는 도서관으로 돌아갔다.` }
];
// The canonical thread name must appear literally in the source rows of the batch being
// analyzed (the validator binds names to the source: UNIFIED_ENTITY_NAME_UNBOUND otherwise).
// Every batch shares this opening phrase, so it is a name each one can actually bind.
const TITLE = '오래된 서재의 기록을 다시 확인하면서';
// Later turns give the follow-up request its own source batch (and real candidates).
const pressureTurns = [
  { turn: 11, user: `${LONG}두 사람은 다시 서재에서 만나 남은 절차를 확인했다.`,
    assistant: `${LONG}민아는 장부를 펼쳤고 지호는 날짜를 확인했다.` },
  { turn: 12, user: `${LONG}두 사람은 준비 상태를 다시 정리했다.`,
    assistant: `${LONG}그날의 기록이 장부에 남았다.` },
  { turn: 13, user: `${LONG}민아는 서재에 남았고 지호는 도서관으로 갔다.`,
    assistant: `${LONG}주변은 조용했다.` },
  { turn: 14, user: `${LONG}두 사람은 다음 절차만 확인했다.`,
    assistant: `${LONG}약속은 여전히 열려 있었다.` },
  { turn: 15, user: `${LONG}그날의 기록이 마무리되었다.`,
    assistant: `${LONG}대화가 끝났다.` }
];
const laterTurns = [
  { turn: 6, user: `${LONG}두 사람은 다음 날 서재에서 다시 만나 남은 절차를 확인했다.`,
    assistant: `${LONG}민아는 봉투를 다시 살펴보고 지호는 날짜를 확인했다.` },
  { turn: 7, user: `${LONG}두 사람은 준비 상태를 차분하게 정리했다.`,
    assistant: `${LONG}그날의 기록은 서재 장부에 남았다.` },
  { turn: 8, user: `${LONG}민아는 서재로 이동했고 지호는 도서관에 남았다.`,
    assistant: `${LONG}주변은 조용했고 새로운 약속은 없었다.` },
  { turn: 9, user: `${LONG}두 사람은 다음 절차만 확인했다.`,
    assistant: `${LONG}약속은 여전히 열려 있었다.` },
  { turn: 10, user: `${LONG}그날 기록이 마무리되었다.`,
    assistant: `${LONG}대화가 끝났다.` }
];
const rowsForTurns = selected => selected.flatMap(row => [
  { role: 'user', chatId: `t${row.turn}-u`, data: row.user },
  { role: 'assistant', chatId: `t${row.turn}-a`, data: row.assistant }
]);
const makeChat = selected => {
  const chat = { id: 'unified-chat', chatId: 'unified-chat', name: 'A16 prompt pressure', message: rowsForTurns(selected) };
  chat.messages = chat.message;
  return chat;
};
const sourceBatch = selected => selected.map(row => ({ turn: row.turn, user: { text: row.user }, assistant: { text: row.assistant } }));
const rowsText = selected => selected.map(row =>
  `[t${row.turn}-u]\n${row.user}\n\n[t${row.turn}-a]\n${row.assistant}`).join('\n\n');
const quote = (turn, role = 'user', source = null) => {
  const row = source || turns.find(item => item.turn === turn);
  return { ref: `t${turn}-${role === 'assistant' ? 'a' : 'u'}`, quote: row[role] };
};
const userMessage = args => {
  const messages = Array.isArray(args?.[0]?.messages) ? args[0].messages : [];
  return String((messages.find(row => row.role === 'user') || {}).content || '');
};
const candidateRowsFromPrompt = message => {
  const match = String(message || '').match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  if (!match) return [];
  try { return JSON.parse(match[1]); } catch { return []; }
};

// The artifact must quote the batch being analyzed, so it is built from the batch's own rows.
const artifactForBatch = (batch, idPrefix, alias) => {
  const first = batch[0];
  const q = { ref: `t${first.turn}-u`, quote: first.user };
  return {
    schema: 'libra.canonical_artifact.v5',
    entities: [
      { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [q] },
      { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [q] },
      { tempId: `${idPrefix}_thread`, name: TITLE, type: 'world', kind: 'thread', evidenceSpans: [q] }
    ],
    facts: [{
      tempFactId: `${idPrefix}_fact`, domain: 'narrative', subjectTempRef: `${idPrefix}_thread`, claimKind: 'thread',
      values: { thread: { summary: TITLE, status: 'open', kind: 'promise', participants: [
        { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }
      ], ...(alias ? { link: 'resolve', linkCandidateAlias: alias } : {}) } },
      text: first.user, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [q]
    }]
  };
};
const attackArtifact = (alias, present) => ({
  schema: 'libra.canonical_artifact.v5',
  entities: [
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(5)] },
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(5)] },
    { tempId: 'promise_attack', name: TITLE, type: 'world', kind: 'thread', evidenceSpans: [quote(5)] }
  ],
  facts: [{
    tempFactId: 'promise_attack', domain: 'narrative', subjectTempRef: 'promise_attack', claimKind: 'thread',
    values: { thread: { summary: TITLE, status: 'resolved', kind: 'promise', resolution: 'fulfilled', participants: [
      { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }
    ], ...(present ? { link: 'resolve', linkCandidateAlias: alias } : { link: 'resolve', linkCandidateAlias: 'ca_00000000_99' }) } },
    text: turns[4].user, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(5)]
  }]
});

const makeHost = state => ({
  getCurrentCharacterIndex: async () => 0,
  getCurrentChatIndex: async () => state.chats.indexOf(state.current),
  getCharacter: async () => state.character,
  getChar: async () => state.character,
  getCharacterFromIndex: async () => state.character,
  getChat: async () => state.current,
  getCurrentChat: async () => state.current,
  getChatFromIndex: async (_characterIndex, index) => state.chats[index],
  getDatabase: async fields => {
    const db = { personas: [], selectedPersona: '', characters: [state.character], plugins: [] };
    return Array.isArray(fields) ? Object.fromEntries(fields.map(key => [key, db[key] ?? null])) : db;
  }
});

// The shipped runtime exposes the last analysis diagnostic (with promptBudget) at
// f.r.context.__memoryRuntime — the same surface the existing preflight test reads.
// Expose the shipped runtime object (the same transform the preflight test uses) so the
// test can read the real promptBudget diagnostic the product records during the run.
const expose = source => source
  .replace('const callLLMWithPreset = async', 'const callLLMWithPreset = globalThis.__memoryGateway = async')
  .replace('const Runtime = {', 'const Runtime = globalThis.__memoryRuntime = {');
const readPromptBudget = f => f?.r?.context?.__memoryRuntime?.lastMemoryAnalysisDiagnostic?.promptBudget || null;
const manifestForChat = (server, chatId) => {
  const row = [...server.storedRows(), ...[...server.local.entries()].map(([key, raw]) => {
    let value = raw; if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = null; } }
    return { key, value };
  })].find(candidate => /:manifest$/.test(candidate.key) && candidate.value?.chatId === chatId);
  return row?.value || null;
};
const recordFor = (server, chatId, start) => {
  const manifest = manifestForChat(server, chatId);
  const ref = manifest?.memories?.[String(start)];
  assert.ok(ref?.key, `canonical ref for ${chatId} T${start}`);
  const all = [...server.storedRows(), ...[...server.local.entries()].map(([key, raw]) => {
    let value = raw; if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = null; } }
    return { key, value };
  })];
  const row = all.find(candidate => candidate.key === ref.key);
  assert.ok(row, `raw record ${ref.key}`);
  return { ref, memory: row.value };
};
const persistRecord = async (server, mode, key, value) => {
  let stored = false;
  if (server.local.has(key) || mode === 'plugin_only') { server.local.set(key, JSON.stringify(value)); stored = true; }
  if (mode !== 'plugin_only' && server.storedRows().some(row => row.key === key)) { await server.mutate(key, value); stored = true; }
  assert.equal(stored, true, `${mode}: persisted canonical key exists in the real active storage`);
};

(async () => {
  const summaryRows = [];
  for (const mode of MODES) {
    const parentChat = makeChat(turns);
    const server = await serverFixture({ mode, snapshot: { chat: parentChat }, transformSource: expose });
    // The fixture's provider boundary is host.runLLMModel (control.calls / control.onCall),
    // which catches every provider -- including the direct custom preset. The recorded call
    // args are exactly what the plugin handed the host, so the composed prompt is read there.
    let f = server.f;
    const providerReplies = [];
    const providerExchanges = [];
    // A direct (custom) preset makes the plugin issue a real HTTP request instead of calling
    // the host model. The fixture routes every non-server URL through hooks.externalFetch, so
    // that hook is the provider boundary for this configuration.
    const httpRequests = [];
    server.hooks.externalFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      httpRequests.push(body);
      const queuedReply = providerReplies.length ? providerReplies.shift() : '{}';
      const reply = typeof queuedReply === 'function' ? queuedReply(body) : queuedReply;
      const requestMessage = String((body?.messages || []).find(row => row.role === 'user')?.content || '');
      providerExchanges.push({ request: body, requestMessage, reply });

      return new Response(JSON.stringify({ model: 'a16-test-model',
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    // control.calls is the fixture's provider-call record; read it through the live handle so
    // a restart cannot leave the test holding a stale array.
    const calls = () => f.control.calls;
    const promptCount = () => calls().length + httpRequests.length;
    const lastPrompt = () => (httpRequests.length ? messageOfHttp(httpRequests.at(-1)) : messageOf(calls().at(-1)));
    const lastBaselineOrPressure = () => lastPrompt();
    const messageOfHttp = body => String((body?.messages || []).find(row => row.role === 'user')?.content || '');
    const messageOf = args => String((args?.[0]?.messages || []).find(row => row.role === 'user')?.content || '');
    const lastUserMessage = () => lastPrompt();
    try {
      // The opening batch runs on the shipped risuai_aux binding, which calls the host model.
      f.control.onCall = () => ({ type: 'success', result: JSON.stringify(artifactForBatch(turns, 'opening')) });
      const opening = await f.r.api.runManualColdStart();

      assert.equal(opening.completed, 1, `${mode}: opening batch commits`);

      // ── configure a measurable window: the shipped binding cannot produce pressure
      // The shipped librarian binding is `risuai_aux`, for which the product sets
      // promptWindow = 0 (the host owns that budget), so pressure can never trigger there.
      // A direct provider with a real context_window is what a user configures to get a
      // measurable window, and it is the only configuration where this path is reachable.
      // The preset itself goes through saveLibraProviderConfig; the librarian BINDING goes
      // through acceptLibrarianConfiguration, which is the shipped path for that slot
      // (stagePresetNames.librarian is derived from agents.librarian.preset).
      const config = await f.r.api.getLibraProviderConfig();
      const presetName = 'a16-narrow';
      const base = config.providerPresets[config.stagePresetNames?.librarian || config.defaultPresetName] || {};
      const narrow = { ...base, provider: 'custom', url: 'https://test.invalid/v1/chat/completions',
        model: 'a16-test-model', context_window: 1, catalog_context_window: 1,
        metadata_model_id: '', max_tokens: 16384 };
      await f.r.api.saveLibraProviderConfig({
        ...config,
        providerPresets: { ...config.providerPresets, [presetName]: narrow }
      });
      const preview = await f.r.api.getLibrarianConfigurationPreview();
      await f.r.api.acceptLibrarianConfiguration({ sourceDigest: preview.sourceDigest, selectedIds: [], preset: presetName });
      assert.equal(f.r.context.__memoryRuntime?.settings?.stagePresetNames?.librarian, presetName,
        `${mode}: the librarian stage resolves the direct preset`);

      // ── control: run one ordinary later batch first. THAT request is the one that presents
      // the real existing candidates (the opening request legitimately has none).
      f.chat.message.push(...rowsForTurns(laterTurns));
      f.chat.messages = f.chat.message;
      // From here the librarian binding is the narrow direct preset, so requests go to
      // externalFetch and the recorded bodies are the product's real composed prompts.
      // Stage 1: a window generous enough that the optional blocks are PRESENTED, so the
      // candidate rows exist as a control before anything is dropped.
      const setWindow = async value => {
        const live = f.r.context.__memoryRuntime.settings;
        await f.r.api.saveLibraProviderConfig({
          ...(await f.r.api.getLibraProviderConfig()),
          providerPresets: { ...live.presets, [presetName]: { ...live.presets[presetName], context_window: value, catalog_context_window: value } }
        });
      };
      await setWindow(131072);
      providerReplies.push(body => {
        const requestMessage = String((body?.messages || []).find(row => row.role === 'user')?.content || '');
        const presented = candidateRowsFromPrompt(requestMessage);
        assert.ok(presented[0]?.alias, `${mode}: the baseline provider receives a real request-local alias`);
        const baselineProviderArtifact = artifactForBatch(laterTurns, 'baseline', presented[0].alias);
        baselineProviderArtifact.facts[0].values.thread.link = 'reaffirm';
        return JSON.stringify(baselineProviderArtifact);
      });
      const baselineRequestCount = promptCount();
      const baselineRun = await f.r.api.runManualColdStart();

      assert.ok(promptCount() > baselineRequestCount, `${mode}: the baseline request reached the provider`);
      const baselineMessage = lastUserMessage();
      const baselineCandidates = candidateRowsFromPrompt(baselineMessage);
      const baselineSource = rowsText(laterTurns);
      const baselineExchange = providerExchanges.at(-1);
      assert.equal(providerExchanges.length, 1, `${mode}: the baseline request crossed the controlled HTTP provider boundary`);

      assert.ok(baselineCandidates.length > 0, `${mode}: the request presents real existing candidates before pressure`);
      assert.ok(baselineExchange, `${mode}: the actual baseline provider exchange is captured`);
      assert.equal(baselineExchange.requestMessage, baselineMessage,
        `${mode}: the baseline exchange prompt is the request inspected by this test`);
      const baselineReplyArtifact = JSON.parse(baselineExchange.reply);
      assert.equal(baselineReplyArtifact.facts[0].values.thread.linkCandidateAlias, baselineCandidates[0].alias,
        `${mode}: the provider uses an alias actually presented in the baseline prompt`);

      assert.ok(baselineMessage.includes(baselineSource), `${mode}: the ten exact rows are present in the baseline request`);
      assert.equal(baselineRun.completed, 1, `${mode}: the presented-alias control commits`);
      const openingFact = recordFor(server, 'unified-chat', 1).memory.canonicalArtifact.facts[0];
      const baselineRecord = recordFor(server, 'unified-chat', 6);
      const baselineFact = baselineRecord.memory.canonicalArtifact.facts.find(row => row.tempFactId === 'baseline_fact');
      assert.equal(baselineFact?.values?.thread?.linkStatus, 'accepted',
        `${mode}: the alias is valid when it is presented in the provider prompt`);
      assert.equal(baselineFact.values.thread.linkTarget?.lifecycleId, openingFact.values.thread.lifecycleId,
        `${mode}: the presented alias resolves to the existing promise lifecycle`);
      const baselineHead = await f.r.api.getCurrentStateHead();
      const baselinePromise = baselineHead.narrative.threads.find(row => row.lifecycleId === openingFact.values.thread.lifecycleId);
      assert.equal(baselineHead.throughTurn, 10, `${mode}: the baseline Head reaches turn 10 before pressure`);
      assert.equal(baselinePromise?.status, 'open', `${mode}: the existing promise is open before pressure`);
      const baselineBudget = await readPromptBudget(f);

      // Stage 2: squeeze the window below the exact-source block so the optional blocks are
      // dropped in the product's own order.
      await setWindow(1);
      f.chat.message.push(...rowsForTurns(pressureTurns));
      f.chat.messages = f.chat.message;
      // Reuse an alias that WAS presented in the previous request. It must be
      // rejected once prompt pressure removes this request's candidate table.
      const staleAlias = baselineCandidates[0].alias;
      assert.ok(staleAlias, `${mode}: a real previous request alias is available`);
      const pressureArtifact = artifactForBatch(pressureTurns, 'pressure', staleAlias);
      assert.equal(pressureArtifact.facts[0].values.thread.linkCandidateAlias, staleAlias,
        `${mode}: the provider actually sends the unprovided alias`);
      const pressureRequestCount = promptCount();
      const providerExchangeCount = providerExchanges.length;
      providerReplies.push(JSON.stringify(pressureArtifact));
      const pressed = await f.r.api.runManualColdStart();

      assert.equal(promptCount() > pressureRequestCount, true,
        `${mode}: the pressure request reached the provider`);
      assert.equal(providerExchanges.length, providerExchangeCount + 1,
        `${mode}: the pressure request produced a new controlled HTTP provider exchange`);
      const pressureMessage = lastUserMessage();
      const pressureCandidates = candidateRowsFromPrompt(pressureMessage);
      const pressureExchange = providerExchanges.at(-1);
      assert.ok(pressureExchange, `${mode}: the actual HTTP provider exchange is captured`);
      assert.equal(pressureExchange.requestMessage, pressureMessage,
        `${mode}: the pressure exchange prompt is the request inspected by this test`);
      assert.equal(baselineExchange.requestMessage.includes(staleAlias), true,
        `${mode}: the stale alias was in the earlier provider prompt`);
      assert.equal(pressureExchange.requestMessage.includes(staleAlias), false,
        `${mode}: the earlier alias is absent from the actual pressure provider prompt`);
      assert.equal(pressureMessage.includes(staleAlias), false,
        `${mode}: the earlier alias is absent from the inspected pressure prompt`);
      const pressureReplyArtifact = JSON.parse(pressureExchange.reply);
      assert.equal(pressureReplyArtifact.facts[0].values.thread.linkCandidateAlias, staleAlias,
        `${mode}: the actual provider response sends the prior request alias`);
      assert.equal(pressureReplyArtifact.facts[0].tempFactId, 'pressure_fact',
        `${mode}: the captured provider response is the pressure artifact stored below`);

      const budget = await readPromptBudget(f);

      // 1. pressure must have been reached and recorded
      assert.ok(Array.isArray(budget?.optionalOmitted) && budget.optionalOmitted.length > 0,
        `${mode}: prompt pressure recorded an omission (optionalOmitted)`);
      // 2. the exact ten rows survive byte-for-byte
      const exactSource = rowsText(pressureTurns);

      assert.equal(pressureMessage.includes(exactSource), true,
        `${mode}: all ten original rows survive pressure byte-for-byte`);
      for (const row of pressureTurns) {
        assert.equal(pressureMessage.includes(row.user), true, `${mode}/T${row.turn}-u survives`);
        assert.equal(pressureMessage.includes(row.assistant), true, `${mode}/T${row.turn}-a survives`);
      }
      // The forbidden outcome is trading source text for room: the exact block must be the
      // full ten rows, never truncated, and the source must not have been shortened to make
      // room for the candidate block.
      const exactBlock = pressureMessage.slice(pressureMessage.indexOf('[EXACT FIVE U+A]'));
      assert.equal((exactBlock.match(/\[t\d+-[ua]\]/g) || []).length, 10,
        `${mode}: the exact block still carries all ten row markers`);
      // 3. omission order / coverage: thread_candidates dropped => no candidate block presented
      assert.equal(budget.optionalOmitted.includes('thread_candidates'), true,
        `${mode}: thread_candidates is among the omitted blocks under this window`);
      assert.equal(pressureCandidates.length, 0, `${mode}: no candidate block is presented once it is omitted`);
      assert.equal(/\[V5 THREAD CANDIDATES/.test(pressureMessage), false, `${mode}: the candidate block is absent from the real request`);

      // 4. an alias the request never presented must not become a canonical link
      const stored = recordFor(server, 'unified-chat', 11);

      const fact = stored.memory.canonicalArtifact.facts.find(row => row.tempFactId === 'pressure_fact');
      assert.ok(fact, `${mode}: the attack fact was stored`);
      assert.equal(fact.values.thread.linkStatus, 'pending',
        `${mode}: an alias this request never presented remains pending`);
      assert.equal(fact.values.thread.linkPendingReason, 'unknown_or_stale_candidate_alias');
      assert.equal(fact.values.thread.linkTarget, undefined, `${mode}: no canonical target is manufactured`);
      assert.equal(String(fact.values.thread.linkCandidateAlias ?? ''), '',
        `${mode}: the request-local alias is not persisted into the canonical artifact`);
      // 5. candidate absence must not be sealed as "no existing promise"
      assert.notEqual(String(fact.values.thread.lifecycleId || ''), '',
        `${mode}: the stored fact still carries a real canonical lifecycle, not an absence conclusion`);

      // storage readback per mode
      const manifest = manifestForChat(server, 'unified-chat');
      const ref = manifest.memories['11'];
      const localRaw = server.local.get(ref.key) || null;
      const serverRow = server.storedRows().find(row => row.key === ref.key) || null;
      assert.ok(ref.sourceDigest && ref.artifactDigest, `${mode}: manifest ref carries digests`);
      if (mode === 'plugin_only') assert.equal(serverRow, null, 'plugin_only: no server rows');
      if (mode === 'mirror') assert.equal(digest(JSON.parse(localRaw)), digest(serverRow.value), 'mirror: both copies agree');
      if (mode === 'server_only') assert.ok(serverRow, 'server_only: the record lives on the server');

      const storedBytesBeforeRestart = JSON.stringify(stored.memory);
      const refBytesBeforeRestart = JSON.stringify(stored.ref);
      f = await server.restart();
      const durableReadback = recordFor(server, 'unified-chat', 11);
      assert.equal(JSON.stringify(durableReadback.memory), storedBytesBeforeRestart,
        `${mode}: fresh runtime reads the exact pressure record from persistent storage`);
      assert.equal(JSON.stringify(durableReadback.ref), refBytesBeforeRestart,
        `${mode}: fresh runtime reads the active manifest reference from persistent storage`);
      const durableFact = durableReadback.memory.canonicalArtifact.facts.find(row => row.tempFactId === 'pressure_fact');
      assert.equal(durableFact.values.thread.linkStatus, 'pending',
        `${mode}: the fresh runtime still reads the pending unprovided-alias result`);
      assert.equal(durableFact.values.thread.linkPendingReason, 'unknown_or_stale_candidate_alias',
        `${mode}: fresh readback retains the stale-alias rejection reason`);
      assert.equal(durableFact.values.thread.linkTarget, undefined,
        `${mode}: fresh readback has no fabricated canonical target`);
      assert.equal(String(durableFact.values.thread.linkCandidateAlias ?? ''), '',
        `${mode}: fresh readback does not persist the request-local alias`);
      const durableManifest = manifestForChat(server, 'unified-chat');
      const durableRef = durableManifest.memories['11'];
      const durableLocalRaw = server.local.get(durableRef.key) || null;
      const durableServerRow = server.storedRows().find(row => row.key === durableRef.key) || null;
      if (mode === 'plugin_only') assert.equal(durableServerRow, null, 'plugin_only: restart still reads no server memory');
      if (mode === 'mirror') assert.equal(digest(JSON.parse(durableLocalRaw)), digest(durableServerRow.value),
        'mirror: both durable copies still agree after restart');
      if (mode === 'server_only') assert.ok(durableServerRow, 'server_only: restart still reads the server memory');
      const head = await f.r.api.getCurrentStateHead();
      assert.equal(head.throughTurn, 15, `${mode}: the fresh runtime public Head reaches the pressure batch`);
      const promiseAfterPressure = head.narrative.threads.find(row => row.lifecycleId === openingFact.values.thread.lifecycleId);
      assert.equal(promiseAfterPressure?.status, baselinePromise.status,
        `${mode}: fresh Head readback preserves the existing promise status across pressure`);
      summaryRows.push({
        mode, optionalOmitted: budget.optionalOmitted, exactSourceChars: budget.exactSourceChars,
        contextWindow: budget.contextWindow, baselineCandidateCount: baselineCandidates.length,
        pressureCandidateCount: pressureCandidates.length, baselineBudget: baselineBudget?.optionalOmitted || null,
        linkStatus: fact.values.thread.linkStatus, aliasPersisted: String(fact.values.thread.linkCandidateAlias ?? ''),
        memoryId: stored.ref.memoryId, revision: Number(stored.ref.revision || 0),
        hasLifecycle: String(fact.values.thread.lifecycleId || '') !== '',
        presentedAliasAccepted: baselineFact.values.thread.linkStatus === 'accepted',
        staleAliasSent: pressureReplyArtifact.facts[0].values.thread.linkCandidateAlias === staleAlias,
        staleAliasAbsentFromPressurePrompt: !pressureExchange.requestMessage.includes(staleAlias),
        durableReadback: JSON.stringify(durableReadback.memory) === storedBytesBeforeRestart,
        existingPromiseStatus: promiseAfterPressure?.status || null,
        headThroughTurn: Number(head?.throughTurn || 0) || null
      });
      console.log(JSON.stringify({ marker: 'A16-mode', ...summaryRows.at(-1) }));
      console.log(JSON.stringify({ marker: 'A16-unprovided-alias-sent', mode,
        priorPromptPresented: baselineExchange.requestMessage.includes(staleAlias),
        pressurePromptPresented: pressureExchange.requestMessage.includes(staleAlias),
        providerReplyAlias: pressureReplyArtifact.facts[0].values.thread.linkCandidateAlias }));
      console.log(JSON.stringify({ marker: 'A16-three-mode-pending-no-target', mode,
        linkStatus: durableFact.values.thread.linkStatus, linkTarget: durableFact.values.thread.linkTarget || null,
        aliasPersisted: String(durableFact.values.thread.linkCandidateAlias ?? '') }));
      console.log(JSON.stringify({ marker: 'A16-unchanged-existing-promise', mode,
        lifecycleId: openingFact.values.thread.lifecycleId,
        statusBeforePressure: baselinePromise.status, statusAfterPressure: promiseAfterPressure?.status || null,
        throughTurn: head.throughTurn }));
      console.log(JSON.stringify({ marker: 'A16-physical-readback', mode,
        refMemoryId: durableReadback.ref.memoryId,
        rawRecordMatches: JSON.stringify(durableReadback.memory) === storedBytesBeforeRestart,
        activeStorePresent: mode === 'plugin_only' ? Boolean(durableLocalRaw) : Boolean(durableServerRow),
        mirrorCopiesAgree: mode === 'mirror' ? digest(JSON.parse(durableLocalRaw)) === digest(durableServerRow.value) : null }));
      // Per-mode acceptance marker read by the repository acceptance reporter.
      console.log(JSON.stringify({ schema: 'acceptance.action_result.v1', case_id: 'A16', mode,
        action: acceptance.action, assertion_result: true,
        optionalOmitted: budget.optionalOmitted, exactSourceChars: budget.exactSourceChars,
        contextWindow: budget.contextWindow, baselineCandidateCount: baselineCandidates.length,
        pressureCandidateCount: pressureCandidates.length,
        linkStatus: fact.values.thread.linkStatus, aliasPersisted: String(fact.values.thread.linkCandidateAlias ?? '') }));
    } finally {
      await server.cleanup();
    }
  }
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'))).digest('hex');
  const testHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  console.log(JSON.stringify({ marker: 'A16-three-mode-prompt-pressure', modes: MODES, rows: summaryRows,
    sourceSha256: sourceHash, testSha256: testHash, result: 'PASS' }));
})().catch(error => {
  console.log(JSON.stringify({ marker: 'A16-failed', message: String(error && error.message || error) }));
  console.error(error);
  process.exit(1);
});
