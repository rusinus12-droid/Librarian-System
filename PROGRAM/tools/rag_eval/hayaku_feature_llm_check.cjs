'use strict';
// HAYAKU feature check against a REAL OpenAI-compatible chat model.
//
// Drives the real plugin (plugins/HAYAKU_Locator_Continuity.js) through the runtime harness and its
// REAL registered hooks (beforeRequest / afterRequest / chat 'output' listener / 'display' script
// handler). Every runLLMModel call the plugin makes is answered by the real model, and every claim is
// read back from HAYAKU's own ledger API, never from a returned string alone.
//
// Features:
//   normal     5 consecutive normal turns: beforeRequest -> real main model -> afterRequest -> chat output
//              -> ledger readback; display handler hides the packet; next request carries no packet.
//   repair     afterRequest repair: a reply WITHOUT a packet -> exactly one runLLMModel call -> packet admitted.
//   recall     recall question in beforeRequest: injected HAYAKU context carries content from earlier turns.
//   autoprobe  scheduleHayakuAutoProbe (fires 30 s after the first observed chat output).
//   testcall   recovery.auxiliaryModel.testCall.
//   coldstart  recovery.coldStart over packet-less history (batched), then
//   regen      recovery.regenerateTurns(+replacementRecordIds) + resolveRegenerationChoice('adopt_regenerated').
//   missing    recovery.repairSelected on transcript gaps; recovery.repairNow on afterRequest-failure debt;
//              recovery.failedAnalysis surface.
//
// Env: RAG_EVAL_LLM_URL (…/v1), OLLAMA_KEY or RAG_EVAL_LLM_KEY, RAG_EVAL_LLM_MODEL (default
//      deepseek-v4.1-flash:cloud), HAYAKU_LLM_CHECK_MAX_CALLS (default 60), HAYAKU_LLM_CHECK_OUT (json path).
// Usage: node tools/rag_eval/hayaku_feature_llm_check.cjs [--only normal,repair,recall,autoprobe,testcall,coldstart,regen,missing]
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage, waitFor } = require(path.join(ROOT, 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rag_eval_ko_v1.json'), 'utf8'));

const LLM_URL = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const LLM_KEY = process.env.OLLAMA_KEY || process.env.RAG_EVAL_LLM_KEY || '';
const MODEL = process.env.RAG_EVAL_LLM_MODEL || 'deepseek-v4.1-flash:cloud';
const MAX_CALLS = Number(process.env.HAYAKU_LLM_CHECK_MAX_CALLS || 60);
const OUT = process.env.HAYAKU_LLM_CHECK_OUT || '';
const onlyArg = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7) || (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '');
const ONLY = new Set(String(onlyArg || '').split(',').map(s => s.trim()).filter(Boolean));
const want = name => !ONLY.size || ONLY.has(name);
if (!LLM_URL || !LLM_KEY) { console.error('RAG_EVAL_LLM_URL and OLLAMA_KEY (or RAG_EVAL_LLM_KEY) are required'); process.exit(2); }

// ---------------------------------------------------------------- real model client
const calls = [];
let currentFeature = 'setup';
const redact = s => String(s || '').split(LLM_KEY).join('[key]');
const classify = msgs => {
  const t = msgs.map(m => String(m?.content || '')).join('\n');
  if (/connectivity probe/i.test(t)) return 'connection_probe';
  if (/COLD START BATCH ENVELOPE/.test(t)) return 'cold_start_batch';
  if (/hayaku\.native_repair_output\.v1/.test(t)) return 'native_repair_envelope';
  if (/HAYAKU_STATE_PACKET_START/.test(t)) return 'main_turn';
  return 'other';
};
const callModel = async (messages, source) => {
  if (calls.length >= MAX_CALLS) throw new Error(`llm_call_budget_exhausted(${MAX_CALLS})`);
  const body = JSON.stringify({
    model: MODEL, temperature: 0, stream: false,
    messages: messages.map(m => ({ role: /^(system|user|assistant)$/.test(String(m.role)) ? m.role : (/^(char|bot|model)$/i.test(String(m.role)) ? 'assistant' : 'user'), content: String(m.content ?? '') }))
  });
  const row = { n: calls.length + 1, feature: currentFeature, source, kind: classify(messages), promptChars: body.length, ms: 0, ok: false, attempts: 0, chars: 0, error: '' };
  calls.push(row);
  const started = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    row.attempts = attempt;
    try {
      const response = await fetch(`${LLM_URL}/chat/completions`, {
        method: 'POST', body, signal: AbortSignal.timeout(240000),
        headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' }
      });
      const raw = await response.text();
      if (!response.ok) {
        lastError = new Error(`http_${response.status}:${redact(raw).slice(0, 200)}`);
        if (response.status >= 500 || response.status === 429) { await new Promise(r => setTimeout(r, 3000 * attempt)); continue; }
        break;
      }
      const json = JSON.parse(raw);
      const content = String(json?.choices?.[0]?.message?.content ?? '');
      row.ms = Date.now() - started; row.ok = true; row.chars = content.length;
      row.finish = json?.choices?.[0]?.finish_reason || '';
      return content;
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  row.ms = Date.now() - started;
  row.error = redact(lastError?.cause?.message || lastError?.message || lastError).slice(0, 240);
  throw new Error(row.error);
};
// The host runLLMModel responder: the plugin's own calls go to the real model.
const realResponder = async callOptions => {
  try { return { type: 'success', result: await callModel(callOptions?.messages || [], `runLLMModel:${callOptions?.mode}`) }; }
  catch (error) { return { type: 'fail', result: String(error?.message || error) }; }
};

// ---------------------------------------------------------------- helpers
const results = [];
const record = (feature, trigger, ok, evidence, extra = {}) => {
  const featureCalls = calls.filter(c => c.feature === feature);
  const row = { feature, trigger, ok: !!ok, llmCalls: featureCalls.length,
    latencyMs: featureCalls.map(c => c.ms), kinds: featureCalls.map(c => c.kind), evidence, ...extra };
  results.push(row);
  console.log(`[${ok ? 'OK  ' : 'FAIL'}] ${feature} calls=${row.llmCalls} ${JSON.stringify(evidence).slice(0, 600)}`);
  return row;
};
const user = (n, data) => ({ role: 'user', chatId: `u${n}`, id: `u${n}`, data, time: Date.now() });
const assistant = (n, data) => ({ role: 'assistant', chatId: `a${n}`, id: `a${n}`, data, time: Date.now() });
const SYSTEM = { role: 'system', content: '당신은 한국어 판타지 롤플레이의 내레이터입니다. 항구 마을을 배경으로, 사용자의 행동에 2~4문장의 한국어 서술로 답하세요.' };
const requestFor = (chat, windowTurns = Infinity) => {
  // RisuAI hands beforeRequest OpenAI-style rows; chat-history rows carry memo = chatId.
  const rows = chat.message.map(m => ({ role: m.role, content: String(m.data), memo: m.chatId }));
  const userIdx = rows.map((r, i) => r.role === 'user' ? i : -1).filter(i => i >= 0);
  const start = Number.isFinite(windowTurns) && userIdx.length > windowTurns ? userIdx[userIdx.length - windowTurns] : 0;
  return [SYSTEM, ...rows.slice(start)];
};
const ownedText = msgs => msgs.filter(m => /^hayaku-/.test(String(m.memo || ''))).map(m => String(m.content || '')).join('\n');
const ledgerRecords = async h => {
  const l = await h.hayaku.ledger.inspect({ includeRecords: true });
  return Array.from(l.records || []);
};
const activeFor = (records, turn) => records.filter(r => Number(r.targetPairIndex || 0) === turn && ['active', 'historical'].includes(r.recordState));
const coverage = async h => (await h.hayaku.recovery.status({ includeDebts: true, refreshDebts: true }))?.debt?.coverage || {};
const short = (v, n = 300) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return String(s ?? '').slice(0, n); };
const summaryOf = record => { try { return JSON.parse(record.raw)?.meta?.summary_memory?.summary || ''; } catch { return ''; } };
const makeRuntime = async (opts = {}) => {
  const scripts = {};
  const h = await createHayakuRuntime({
    llmResponder: realResponder,
    afterRequestAutoRepair: true, backgroundAutoRepair: false, autoRepair: false,
    ...opts,
    hostOverrides: { async addRisuScriptHandler(mode, fn) { scripts[mode] = fn; return true; }, ...(opts.hostOverrides || {}) }
  });
  h.scripts = scripts;
  return h;
};

// One complete normal turn through the real hooks.
const normalTurn = async (h, n, userText, opts = {}) => {
  const callsBefore = h.llmCalls.length;
  const logMark = Math.max(0, ...(h.hayaku.activityLog.list() || []).map(e => Number(e.id) || 0));
  h.chat.message.push(user(n, userText)); h.chat.messages = h.chat.message;
  const outgoing = await h.callBeforeRequest(requestFor(h.chat, opts.windowTurns), 'model');
  const outgoingText = outgoing.map(m => String(m.content || '')).join('\n');
  const historyHasPacket = outgoing.filter(m => !/^hayaku-/.test(String(m.memo || ''))).some(m => /HAYAKU_STATE_PACKET_START\s*\{/.test(String(m.content || '')));
  const t0 = Date.now();
  const reply = opts.replyOverride != null ? opts.replyOverride : await callModel(outgoing, 'main_model');
  const mainMs = Date.now() - t0;
  const replyHasPacket = /HAYAKU_STATE_PACKET_START/.test(reply) && /HAYAKU_STATE_PACKET_END/.test(reply);
  const afterRepairCallsBefore = h.llmCalls.length;
  const after = await h.callAfterRequest(reply, 'model');
  const afterRepairCalls = h.llmCalls.length - afterRepairCallsBefore;
  h.chat.message.push(assistant(n, after)); h.chat.messages = h.chat.message;
  await h.callChatOutput({ char: h.character, chat: h.chat, characterIndex: 0, chatIndex: 0, messageIndex: h.chat.message.length - 1 });
  let records = [];
  try {
    const started = Date.now();
    while (Date.now() - started < 30000) {
      records = await ledgerRecords(h);
      if (activeFor(records, n).length) break;
      await new Promise(r => setTimeout(r, 250));
    }
  } catch (_) {}
  const admitted = activeFor(records, n);
  const display = typeof h.scripts.display === 'function' ? await h.scripts.display(after) : null;
  const visible = typeof display === 'string' ? display : '';
  const logRow = [...(h.hayaku.activityLog.list() || [])].reverse().find(e => /after_request_packet_(candidate_returned|failed|suspended)/.test(e.event) && e.id > logMark);
  const lastRepair = logRow ? { outcome: logRow.event.replace('native_recovery:after_request_packet_', ''), errorCode: logRow.detail?.errorCode || '', error: short(logRow.detail?.error || logRow.detail?.reason || '', 200), validationErrors: short(logRow.detail?.validationErrors || '', 300) } : null;
  return {
    turn: n, mainMs, replyChars: reply.length, replyHasPacket, afterRequestReturnedPacket: /HAYAKU_STATE_PACKET_START/.test(after),
    afterRepairCalls, pluginCallsThisTurn: h.llmCalls.length - callsBefore, historyHasPacket,
    injectedChars: ownedText(outgoing).length, outgoingText,
    admitted: admitted.map(r => ({ packetType: r.packetType, captureSource: r.captureSource, state: r.recordState, summary: short(summaryOf(r), 140) })),
    displayHidesPacket: visible ? !/HAYAKU_STATE_PACKET|"meta"\s*:/.test(visible) && visible.trim().length > 0 : null,
    visiblePreview: short(visible, 120), replyTail: replyHasPacket ? '' : short(reply.slice(-200), 200), lastRepair
  };
};

// ---------------------------------------------------------------- features
const runNormalRepairRecall = async () => {
  const h = await makeRuntime({ chatId: 'ko-normal' });
  const turns = [];
  try {
    currentFeature = 'normal';
    for (let n = 1; n <= 5; n++) {
      try { turns.push(await normalTurn(h, n, fixture.turns[n - 1][0])); }
      catch (error) { turns.push({ turn: n, error: String(error?.message || error).slice(0, 300) }); }
      console.log('  turn', n, short({ ...turns.at(-1), outgoingText: undefined }, 500));
    }
    const ok = turns.every(t => !t.error && t.admitted?.length > 0 && t.displayHidesPacket !== false && !t.historyHasPacket);
    record('normal', 'beforeRequest -> main model -> afterRequest -> chat output (x5)', ok, {
      admittedTurns: turns.filter(t => t.admitted?.length).map(t => t.turn),
      modelWrotePacket: turns.filter(t => t.replyHasPacket).map(t => t.turn),
      afterRequestRepairedTurns: turns.filter(t => t.afterRepairCalls > 0).map(t => t.turn),
      captureSources: turns.map(t => t.admitted?.[0]?.captureSource || t.error || 'none'),
      displayHidesPacket: turns.map(t => t.displayHidesPacket),
      historyPacketLeaked: turns.filter(t => t.historyHasPacket).map(t => t.turn),
      summaries: turns.map(t => t.admitted?.[0]?.summary || ''),
      lastRepair: turns.map(t => t.lastRepair?.outcome || '')
    }, { turns: turns.map(t => ({ ...t, outgoingText: undefined })) });

    if (want('repair')) {
      currentFeature = 'repair';
      // A reply WITHOUT a packet: the fixture's own narrator line for turn 6.
      const t6 = await normalTurn(h, 6, fixture.turns[5][0], { replyOverride: fixture.turns[5][1] });
      const repairCalls = calls.filter(c => c.feature === 'repair');
      record('repair', 'afterRequest on a packet-less reply', t6.afterRepairCalls === 1 && t6.afterRequestReturnedPacket && t6.admitted.length > 0, {
        pluginRunLLMModelCalls: t6.afterRepairCalls, kinds: repairCalls.map(c => c.kind), returnedPacket: t6.afterRequestReturnedPacket,
        admitted: t6.admitted, displayHidesPacket: t6.displayHidesPacket, lastRepair: t6.lastRepair
      });
    }

    if (want('recall')) {
      currentFeature = 'recall';
      // The main model writes its own story, so the recall target is whatever turn 2 actually
      // established (read from the admitted turn-2 packet), not the fixture's planted line.
      const records = await ledgerRecords(h);
      const turn2 = summaryOf(activeFor(records, 2)[0] || {});
      const probeTerms = (turn2.match(/[가-힣A-Za-z]{2,}/g) || []).filter(w => !/^(여행자가|여행자|사용자|당신|당신의|했다|있었다|물었고|물었다)$/.test(w));
      h.chat.message.push(user(7, '유나가 처음에 묵을 곳으로 어디 어디를 알려줬었지? 다시 말해줘.')); h.chat.messages = h.chat.message;
      // Only the last 2 turns are in the outgoing window, so turn 2 must come from HAYAKU memory.
      const outgoing = await h.callBeforeRequest(requestFor(h.chat, 2), 'model');
      const injected = ownedText(outgoing);
      const windowText = outgoing.filter(m => !/^hayaku-/.test(String(m.memo || ''))).map(m => String(m.content || '')).join('\n');
      const turn2Message = String(h.chat.message.find(m => m.chatId === 'a2')?.data || '');
      const turn2InWindow = turn2Message && windowText.includes(turn2Message.slice(0, 40));
      // A turn-2 fact counts as recalled when its distinctive terms appear in HAYAKU's injected context
      // (it may be rendered as a summary, consequence or entity row rather than the verbatim summary).
      const injectedTerms = probeTerms.filter(w => injected.includes(w));
      const hit = !!turn2 && (injected.includes(turn2) || (probeTerms.length > 0 && injectedTerms.length / probeTerms.length >= 0.5));
      let answer = '';
      try { answer = await callModel(outgoing, 'main_model'); } catch (e) { answer = 'ERROR ' + e.message; }
      const visibleAnswer = typeof h.scripts.display === 'function' ? String(await h.scripts.display(answer) || '') : answer;
      const sm = injected.indexOf('[SOURCE MEMORY RECORDS');
      const answerTerms = probeTerms.filter(w => visibleAnswer.includes(w));
      record('recall', 'beforeRequest with recall question about turn 2 (window = last 2 turns)', hit && !turn2InWindow, {
        injectedChars: injected.length, turn2FactInjected: hit, injectedTermCoverage: `${injectedTerms.length}/${probeTerms.length}`, turn2RawInVisibleWindow: !!turn2InWindow,
        turn2PacketSummary: short(turn2, 160), sourceMemoryExcerpt: sm >= 0 ? short(injected.slice(sm, sm + 400), 400) : 'no [SOURCE MEMORY RECORDS] block',
        answerUsesRecalledTerms: answerTerms.slice(0, 8), answer: short(visibleAnswer, 220)
      });
    }

    if (want('autoprobe')) {
      currentFeature = 'autoprobe';
      const probeCallsBefore = calls.filter(c => c.kind === 'connection_probe');
      if (!probeCallsBefore.length) {
        try { await waitFor(() => calls.some(c => c.kind === 'connection_probe' && c.ok), 'auto probe', 45000); } catch (_) {}
      }
      const probeCalls = calls.filter(c => c.kind === 'connection_probe');
      const status = h.hayaku.recovery.auxiliaryModel.status();
      // Probe calls fired during earlier features are attributed to them; re-attribute here.
      probeCalls.forEach(c => { c.feature = 'autoprobe'; });
      record('autoprobe', 'scheduleHayakuAutoProbe (30 s after first chat output)', probeCalls.length >= 1 && probeCalls.some(c => c.ok) && status?.last?.ok === true, {
        probeCalls: probeCalls.length, firedDuring: probeCalls.map(c => c.source), status: { readiness: status?.readiness, lastOk: status?.last?.ok, lastStatus: status?.last?.status, preview: short(status?.last?.responsePreview, 80), error: status?.last?.error }
      });
    }
  } finally { await h.dispose(); }
};

const runTestCall = async () => {
  currentFeature = 'testcall';
  const h = await makeRuntime({ chatId: 'ko-testcall', messages: [user(1, fixture.turns[0][0])] });
  try {
    const r = await h.hayaku.recovery.auxiliaryModel.testCall();
    record('testcall', 'recovery.auxiliaryModel.testCall()', r.ok === true && r.status === 'complete', {
      status: r.status, submitted: r.submitted, elapsedMs: r.elapsedMs, preview: short(r.responsePreview, 80), error: r.error,
      writesLedger: r.writesPacketLedger, ledgerRecords: (await ledgerRecords(h)).length
    });
  } finally { await h.dispose(); }
};

const runColdStartAndRegen = async () => {
  const N = 5;
  const messages = fixture.turns.slice(0, N).flatMap(([u, a], i) => [user(i + 1, u), assistant(i + 1, a)]);
  const h = await makeRuntime({ chatId: 'ko-cold', messages, arguments: { hayaku_cold_start_batch_turns: '5' } });
  try {
    if (want('coldstart')) {
      currentFeature = 'coldstart';
      const before = await coverage(h);
      let r; try { r = await h.hayaku.recovery.coldStart({ resume: true }); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
      const records = (await ledgerRecords(h)).filter(x => x.captureSource === 'bridge_cold_start' && x.recordState === 'historical');
      const turnsCovered = records.map(x => { try { return Number(JSON.parse(x.raw).meta?.source_turn_range?.start); } catch { return 0; } }).sort((a, b) => a - b);
      const status = await h.hayaku.recovery.status().catch(() => null);
      const failed = await h.hayaku.recovery.failedAnalysis.list().catch(e => ({ error: String(e?.message || e) }));
      const failedDetail = [];
      for (const entry of (Array.isArray(failed?.entries) ? failed.entries : []).slice(0, 3)) {
        const read = await h.hayaku.recovery.failedAnalysis.read(entry.failureId).catch(e => ({ error: String(e?.message || e) }));
        const art = read?.artifact || read?.entry || read || {};
        failedDetail.push({ turns: entry.targetTurns || entry.turns || entry.targetPairIndex || entry.turn, code: entry.errorCode || entry.code || art?.error?.code || '',
          message: short(entry.errorMessage || entry.message || art?.error?.message || '', 240),
          reason: entry.reason, diag: (() => { const j = JSON.stringify(read || {}); const i = j.indexOf('originalValidation'); const k = j.indexOf('rejected'); return short(j.slice(Math.max(0, (i >= 0 ? i : k >= 0 ? k : 0))), 900); })() });
      }
      let resumed = null;
      if (r.ok === true && r.completed !== true) {
        currentFeature = 'coldstart_resume';
        try { resumed = await h.hayaku.recovery.coldStart({ resume: true }); } catch (e) { resumed = { ok: false, error: String(e?.message || e) }; }
        const after = (await ledgerRecords(h)).filter(x => x.captureSource === 'bridge_cold_start' && x.recordState === 'historical');
        record('coldstart_resume', 'recovery.coldStart({resume:true}) again after a partial run', resumed.ok === true && resumed.completed === true && after.length === N, {
          result: { ok: resumed.ok, completed: resumed.completed, packets: resumed.packets, llmCalls: resumed.llmCalls, reusedChunks: resumed.reusedChunks, reason: resumed.reason, error: resumed.error },
          packetsAdmitted: after.length
        }, { raw: short(resumed, 1200) });
        currentFeature = 'coldstart';
      }
      record('coldstart', `recovery.coldStart({resume:true}) over ${N} packet-less turns, batch=5`, r.ok === true && r.completed === true && records.length === N, {
        failedDetail,
        coverageBefore: { mode: before.mode, completedTurns: before.completedTurns, missing: before.missingTurns },
        result: { ok: r.ok, completed: r.completed, packets: r.packets, llmCalls: r.llmCalls, batchTurns: r.analysisBatchTurns, reason: r.reason, error: r.error || r.lastError },
        packetsAdmitted: records.length, turnsCovered, summaries: records.slice(0, N).map(x => short(summaryOf(x), 90)),
        chunks: status?.coldStartRun?.run?.chunks?.map(c => c.status), failedAnalysisEntries: Array.isArray(failed?.entries) ? failed.entries.length : failed
      }, { raw: short(r, 1500) });
    }
    if (want('regen')) {
      currentFeature = 'regen';
      const records = await ledgerRecords(h);
      const coldRecs = records.filter(x => x.captureSource === 'bridge_cold_start' && x.recordState === 'historical');
      const target = coldRecs.find(x => Number(h.hayaku._test.storageRecordTurnRange(x).turnStart) === 2) || coldRecs[0];
      const regenTurn = target ? Number(h.hayaku._test.storageRecordTurnRange(target).turnStart) : 0;
      if (!target) { record('regen', 'regenerateTurns', false, { error: 'no cold-start record for turn 2 (coldstart did not run or failed)' }); return; }
      let r; try { r = await h.hayaku.recovery.regenerateTurns({ targetTurns: [regenTurn], replacementRecordIds: [target.recordId], replaceExisting: true }); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
      let adopt = null;
      if (r.awaitingChoice) adopt = await h.hayaku.recovery.resolveRegenerationChoice('adopt_regenerated', { runId: r.runId });
      const after = await ledgerRecords(h);
      const old = after.find(x => x.recordId === target.recordId);
      const replacement = after.find(x => x.packetType === 'recovery_snapshot' && x.recordState === 'active' && Number(x.targetPairIndex || 0) === regenTurn);
      record('regen', `regenerateTurns({targetTurns:[${regenTurn}],replacementRecordIds}) + resolveRegenerationChoice(adopt_regenerated)`,
        r.ok === true && r.awaitingChoice === true && adopt?.ok === true && old?.recordState === 'tombstoned' && !!replacement, {
          regen: { ok: r.ok, awaitingChoice: r.awaitingChoice, reason: r.reason, error: r.error }, adopt: adopt && { ok: adopt.ok, outcome: adopt.outcome, reason: adopt.reason },
          oldRecordState: old?.recordState, replacementSummary: short(summaryOf(replacement || {}), 140)
        }, { raw: short(r, 1500) });
    }
  } finally { await h.dispose(); }
};

const koPacket = (turn, summary) => createValidPacket({ turn, subject: '유나', scene: '항구 마을', summary });
const runMissing = async () => {
  currentFeature = 'missing';
  // Turns 1,3 carry packets; 2 and 4 are transcript gaps.
  const messages = [1, 2, 3, 4].flatMap(n => {
    const [u, a] = fixture.turns[n - 1];
    return [user(n, u), assistant(n, [1, 3].includes(n) ? hiddenPacketMessage(a, koPacket(n, a)) : a)];
  });
  const h = await makeRuntime({ chatId: 'ko-missing', messages });
  try {
    const before = await coverage(h);
    let r; try { r = await h.hayaku.recovery.repairSelected({ scopeKey: (await h.hayaku._test.currentChatScope()).key, targetTurns: [2, 4], rows: before.rows }); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    const after = await coverage(h);
    const recs = (await ledgerRecords(h)).filter(x => x.recordState === 'active' && x.captureSource === 'bridge_incremental_recovery');
    record('missing', 'recovery.repairSelected({targetTurns:[2,4]})', r.ok === true && (after.missingTurns || []).length === 0, {
      missingBefore: before.missingTurns, missingAfter: after.missingTurns, completed: r.completed, physicalCalls: r.physicalCalls,
      reason: r.reason, code: r.code, error: short(r.error, 200), recoveredTurns: recs.map(x => x.targetPairIndex),
      summaries: recs.map(x => short(summaryOf(x), 100)), failureIds: (r.results || []).map(x => x.failureId).filter(Boolean)
    }, { raw: short(r, 1500) });

    // repairNow: create real packet debt the way production does — a turn whose afterRequest repair failed.
    currentFeature = 'repairnow';
    h.setLlmResponder(async () => ({ type: 'success', result: 'not-a-packet (simulated failed afterRequest repair)' }));
    const t5 = await normalTurn(h, 5, fixture.turns[4][0], { replyOverride: fixture.turns[4][1] });
    h.setLlmResponder(realResponder);
    const debts = await h.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: false, limit: 8 }).catch(e => ({ error: String(e?.message || e) }));
    let rn; try { rn = await h.hayaku.recovery.repairNow({ reason: 'real_llm_check' }); } catch (e) { rn = { ok: false, error: String(e?.message || e) }; }
    const recs2 = (await ledgerRecords(h)).filter(x => x.recordState === 'active' && Number(x.targetPairIndex || 0) === 5);
    const debtsAfter = await h.hayaku._test.inspectRecoveryDebtsForNativeRepair({ limit: 8 }).catch(() => null);
    record('repairnow', 'afterRequest repair fails (stub) -> recovery.repairNow()', rn.ok === true && rn.repaired === true && recs2.length > 0, {
      afterRequestOutcome: t5.lastRepair, debtReason: debts.reason, debtTurns: (debts.debts || []).map(d => d.pairIndex),
      repairNow: { ok: rn.ok, repaired: rn.repaired, reason: rn.reason, error: short(rn.error || rn.lastError, 200) },
      admittedTurn5: recs2.map(x => ({ packetType: x.packetType, captureSource: x.captureSource, summary: short(summaryOf(x), 100) })),
      debtsAfter: debtsAfter?.totalActiveDebts
    }, { raw: short(rn, 1500) });

    currentFeature = 'failedanalysis';
    const list = await h.hayaku.recovery.failedAnalysis.list().catch(e => ({ error: String(e?.message || e) }));
    const resolve = await h.hayaku.recovery.failedAnalysis.resolve('any', 'llm', {}).catch(e => ({ error: String(e?.message || e) }));
    record('failedanalysis', 'recovery.failedAnalysis.list / resolve(llm)', resolve?.reason === 'failed_recovery_retired_use_missing_turn_generation', {
      entries: Array.isArray(list?.entries) ? list.entries.length : short(list, 200), resolveReason: resolve?.reason,
      note: 'retry of failed analysis is retired in this plugin version; the replacement path is repairSelected (missing-turn generation), checked above'
    });
  } finally { await h.dispose(); }
};

(async () => {
  const started = Date.now();
  console.log(`HAYAKU real-LLM feature check · model=${MODEL} · maxCalls=${MAX_CALLS}`);
  const guard = async (name, fn) => { try { await fn(); } catch (error) { record(name, 'uncaught', false, { error: String(error?.stack || error).slice(0, 600) }); } };
  if (want('normal') || want('repair') || want('recall') || want('autoprobe')) await guard(currentFeature = 'normal', runNormalRepairRecall);
  if (want('testcall')) await guard('testcall', runTestCall);
  if (want('coldstart') || want('regen')) await guard('coldstart', runColdStartAndRegen);
  if (want('missing')) await guard('missing', runMissing);
  const report = {
    schema: 'memory-suite.hayaku-feature-llm-check.v1', model: MODEL, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started,
    totalLlmCalls: calls.length, results, calls
  };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('\nSUMMARY');
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.feature.padEnd(15)} calls=${r.llmCalls} ms=[${r.latencyMs.join(',')}]`);
  console.log(`total real LLM calls: ${calls.length}${OUT ? ` · report: ${OUT}` : ''}`);
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
  process.exit(process.exitCode);
})();
