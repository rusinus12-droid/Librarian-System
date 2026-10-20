'use strict';
// LIBRA memory lens live evaluation: every lens feature against a real chat model and real
// embeddings, scored against a hand-annotated Korean roleplay corpus.
//
// Runs the shipped LIBRA on the test VM host (tests/fixtures/libra_lens_handoff_fixture.cjs). Lens
// analysis and the lens design assistant go to a real OpenAI-compatible chat model; lens note and
// query vectors go to a real embedding provider through the plugin's own embedding adapter.
//   RAG_EVAL_LLM_URL / RAG_EVAL_LLM_KEY / RAG_EVAL_LLM_MODEL       chat model (…/v1)
//   RAG_EVAL_EMBED_URL / RAG_EVAL_EMBED_KEY / RAG_EVAL_EMBED_MODEL embeddings (…/v1, optional)
// Node's built-in fetch ignores HTTPS_PROXY; run with NODE_USE_ENV_PROXY=1 behind a proxy.
// Sections (--only a,b,…): templates, modes, assistant, health, names, recall (on the health notes).
// Handoff and native copy are covered by the deterministic tests; this chat has no canonical memory.
// goldrecall stores the corpus's hand-written gold notes (no chat model) and measures lexical vs
// hybrid recall and the cosine distribution on them with the real embedding provider.
// --reps N repeats each model run (default 2). --json file writes the full report.
// RAG_EVAL_LLM_LOG=file appends every model request/response (JSON lines). Logs and reports can
// contain chat text; keep them outside the repository. Keys are read from the environment only.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { lensFixture } = require('../../tests/fixtures/libra_lens_handoff_fixture.cjs');
const corpus = require('./libra_lens_live_corpus.json');

const argv = process.argv.slice(2);
const arg = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; };
const only = new Set(String(arg('--only') || 'goldrecall,templates,modes,assistant,health,names,recall').split(',').map(value => value.trim()).filter(Boolean));
const reps = Math.max(1, Number(arg('--reps') || 2));
const jsonOut = arg('--json');
const llmUrl = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const embedUrl = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
if (!llmUrl || !process.env.RAG_EVAL_LLM_MODEL) throw new Error('RAG_EVAL_LLM_URL and RAG_EVAL_LLM_MODEL are required');
const repositoryRoot = path.resolve(__dirname, '../../..');
for (const file of [jsonOut, process.env.RAG_EVAL_LLM_LOG].filter(Boolean)) {
  const relative = path.relative(repositoryRoot, path.resolve(file));
  if (!relative.startsWith('..')) throw new Error('Reports and model logs must be written outside the repository');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const plain = value => JSON.parse(JSON.stringify(value));
const stats = { llmCalls: 0, llmFailures: 0, llmMs: 0, embedCalls: 0, embedFailures: 0, embedMs: 0 };
const callModel = async args => {
  const request = args[0] || {};
  const messages = (request.messages || request.prompt || []).map(m => ({ role: m.role === 'char' ? 'assistant' : m.role, content: String(m.content ?? '') }));
  const started = performance.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(llmUrl + '/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_LLM_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.RAG_EVAL_LLM_MODEL, messages, temperature: 0, stream: false }),
        signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
      const body = await response.json();
      const content = String(body.choices?.[0]?.message?.content || '');
      stats.llmCalls += 1; stats.llmMs += performance.now() - started;
      if (process.env.RAG_EVAL_LLM_LOG) fs.appendFileSync(process.env.RAG_EVAL_LLM_LOG, JSON.stringify({ messages, response: content, usage: body.usage || null }) + '\n', { mode: 0o600 });
      return { type: 'success', result: content };
    } catch (error) {
      if (attempt === 2) { stats.llmFailures += 1; return { type: 'error', result: String(error.message || error) }; }
      await sleep(2000 * (attempt + 1));
    }
  }
};
const embedFetch = async (url, init) => {
  const started = performance.now();
  try { const response = await fetch(url, init); if (!response.ok) stats.embedFailures += 1; return response; }
  catch (error) { stats.embedFailures += 1; throw error; }
  finally { stats.embedCalls += 1; stats.embedMs += performance.now() - started; }
};

// A fresh runtime whose current chat is the evaluation corpus.
const session = async ({ embeddings = Boolean(embedUrl) } = {}) => {
  const f = await lensFixture();
  f.control.onCall = callModel;
  f.r.context.risuai.nativeFetch = embedFetch;
  await f.api.saveEmbeddingSettings(embeddings
    ? { enabled: true, provider: 'openai', url: embedUrl + '/embeddings', model: process.env.RAG_EVAL_EMBED_MODEL, key: process.env.RAG_EVAL_EMBED_KEY, maxRetries: 2 }
    : { enabled: false, provider: 'openai', url: 'https://disabled.invalid/v1/embeddings', model: 'none', key: '' });
  f.r.context.risuai.getDatabase = async () => ({ selectedPersona: 0, personas: [{ id: 'eval-persona', name: corpus.personaName }] });
  const chat = f.target('lens live eval');
  corpus.turns.forEach(([user, assistant], index) => chat.message.push({ role: 'user', chatId: `t${index + 1}-u`, data: user }, { role: 'char', chatId: `t${index + 1}-a`, data: assistant }));
  chat.messages = chat.message;
  f.character.name = corpus.characterName;
  return f;
};
const spans = () => { const out = []; for (let start = 1; start <= corpus.turns.length; start += 5) out.push([start, Math.min(corpus.turns.length, start + 4)]); return out; };
const runAll = async (f, lensId) => {
  const runs = [];
  for (const [startTurn, endTurn] of spans()) {
    const started = performance.now();
    const result = plain(await f.api.runLensForRange(lensId, { startTurn, endTurn }));
    runs.push({ span: `T${startTurn}-T${endTurn}`, status: result.status, ms: Math.round(performance.now() - started), counts: result.run?.counts || {},
      rejected: (result.rejectedItems || []).map(row => row.reasonCode), items: result.items || [] });
  }
  return runs;
};
const rawResponses = async (f, lensId) => {
  const inspect = plain(await f.api.inspectScopeLenses());
  const out = [];
  for (const run of inspect.lenses[lensId]?.runs || []) {
    const raw = plain(await f.api.getLensRawResponse({ lensId, runId: run.runId }));
    if (raw.ok) out.push(raw.rawResponse);
  }
  return out;
};
const parseItems = raw => { try { const match = String(raw).match(/\{[\s\S]*\}/); return JSON.parse(match ? match[0] : raw).items || []; } catch (_) { return null; } };
const norm = value => String(value || '').replace(/\s+/g, '');
const report = { model: process.env.RAG_EVAL_LLM_MODEL, embedModel: embedUrl ? process.env.RAG_EVAL_EMBED_MODEL : null, reps, startedAt: new Date().toISOString(), sections: {} };
const log = (...parts) => console.log(...parts);

// ---- templates and evidence modes ------------------------------------------------------------
const evalTemplates = async () => {
  const rows = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const f = await session({ embeddings: false });
    try {
      for (const template of f.api.getLensStarterTemplates()) {
        const lens = plain(await f.api.createLens({ ...template, lensId: template.templateId, cadence: { mode: 'manual' } }));
        const runs = await runAll(f, lens.lensId);
        const raws = await rawResponses(f, lens.lensId);
        const accepted = runs.reduce((sum, run) => sum + Number(run.counts.quoted || 0) + Number(run.counts.interpreted || 0), 0);
        const rejected = runs.flatMap(run => run.rejected);
        rows.push({ rep, template: template.templateId, evidenceMode: lens.evidenceMode, statuses: runs.map(run => run.status), accepted,
          quoted: runs.reduce((sum, run) => sum + Number(run.counts.quoted || 0), 0), rejected: rejected.length,
          rejectReasons: rejected.reduce((map, code) => ({ ...map, [code]: (map[code] || 0) + 1 }), {}),
          parseOk: raws.every(raw => parseItems(raw) !== null), msPerRun: Math.round(runs.reduce((sum, run) => sum + run.ms, 0) / runs.length),
          sample: runs.flatMap(run => run.items).slice(0, 3).map(item => `[${item.label}] ${item.text}`) });
        log(`template ${template.templateId} rep${rep}: accepted ${rows.at(-1).accepted} rejected ${rows.at(-1).rejected} ${JSON.stringify(rows.at(-1).rejectReasons)}`);
      }
    } finally { await f.close(); }
  }
  report.sections.templates = rows;
};

const evalModes = async () => {
  const rows = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const f = await session({ embeddings: false });
    try {
      for (const evidenceMode of ['strict', 'interpretive']) {
        const lens = plain(await f.api.createLens({ name: `약속 ${evidenceMode}`, evidenceMode, cadence: { mode: 'manual' },
          instruction: { goal: '인물 사이의 약속, 계획, 다음 일정과 그 이행 여부를 기록하라.' } }));
        const runs = await runAll(f, lens.lensId);
        const items = runs.flatMap(run => run.items);
        rows.push({ rep, evidenceMode, accepted: items.length, quoted: items.filter(item => item.evidenceLevel === 'quoted').length,
          rejected: runs.flatMap(run => run.rejected).reduce((map, code) => ({ ...map, [code]: (map[code] || 0) + 1 }), {}),
          foundMondayVisit: items.some(item => /월요일/.test(item.text + item.quote)) });
        log(`mode ${evidenceMode} rep${rep}: ${JSON.stringify(rows.at(-1))}`);
      }
      // A trial run stores nothing.
      const before = [...f.r.values.keys()].filter(key => key.includes(':lens:')).length;
      const trial = plain(await f.api.trialRunLens({ draftLens: { name: '시험', instruction: { goal: '몸 상태 변화를 기록하라.' } }, startTurn: 1, endTurn: 5 }));
      rows.push({ rep, trial: true, status: trial.status, accepted: trial.acceptedCount, storedNothing: [...f.r.values.keys()].filter(key => key.includes(':lens:')).length === before });
    } finally { await f.close(); }
  }
  report.sections.modes = rows;
};

// ---- the lens design assistant ----------------------------------------------------------------
const evalAssistant = async () => {
  const rows = [];
  const f = await session({ embeddings: false });
  try {
    for (const request of corpus.assistantRequests) {
      for (let rep = 0; rep < reps; rep += 1) {
        const result = plain(await f.api.draftLensWithAssistant({ messages: [{ role: 'user', text: request.text }] }));
        const draft = result.draft;
        const check = key => request.expect[key] === undefined || (draft && draft[key] === request.expect[key]);
        rows.push({ request: request.text, rep, drafted: Boolean(draft), name: draft?.name || '', trackTime: draft?.trackTime, trackSubject: draft?.trackSubject,
          evidenceMode: draft?.evidenceMode, matches: Boolean(draft) && Object.keys(request.expect).every(check), reply: String(result.reply || '').slice(0, 160) });
        log(`assistant "${request.text}" rep${rep}: ${JSON.stringify({ name: draft?.name, trackTime: draft?.trackTime, trackSubject: draft?.trackSubject, ok: rows.at(-1).matches })}`);
      }
    }
  } finally { await f.close(); }
  report.sections.assistant = rows;
};

// ---- health lens: people and time against the annotated gold ----------------------------------
const goldMatch = (gold, item) => {
  const body = norm(`${item.text} ${item.quote || ''} ${item.basis || ''}`);
  return gold.keywords.some(word => body.includes(norm(word)));
};
const personMatches = (gold, item) => {
  const names = (item.who || []).map(person => person.role === 'user' ? '@user' : person.role === 'char' ? '@char' : norm(person.name));
  return gold.who.some(name => names.includes(name.startsWith('@') ? name : norm(name)) || names.some(written => name.startsWith('@') ? false : written.includes(norm(name)) || norm(name).includes(written)));
};
const evalHealth = async () => {
  const rows = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const f = await session({ embeddings: false });
    try {
      const lens = plain(await f.api.createLens({ name: '생체 추적', evidenceMode: 'interpretive', trackTime: true, trackSubject: true, cadence: { mode: 'manual' },
        labels: ['증상', '수치', '주기', '회복'], instruction: { goal: '등장하는 모든 존재(사람과 동물)의 몸 상태, 증상, 생체 수치, 생리 주기, 회복을 기록하라.' } }));
      const runs = await runAll(f, lens.lensId);
      const items = runs.flatMap(run => run.items);
      const raws = (await rawResponses(f, lens.lensId)).flatMap(raw => parseItems(raw) || []);
      const goldRows = corpus.healthGold.map(gold => {
        const hits = items.filter(item => goldMatch(gold, item));
        const best = hits.find(item => personMatches(gold, item)) || hits[0] || null;
        const timeOk = !best ? null : gold.when === null ? true
          : best.when ? gold.when.some(option => norm(best.when.text).includes(norm(option)) || norm(option).includes(norm(best.when.text))) : false;
        return { id: gold.id, found: Boolean(best), personOk: best ? personMatches(gold, best) : null, who: best?.who || null,
          when: best?.when?.text || null, timeOk, whenIssue: best?.whenIssue || '', whoIssue: best?.whoIssue || '' };
      });
      const forbidden = items.filter(item => (item.who || []).some(person => corpus.notPeople.some(name => norm(person.name).includes(norm(name)))));
      const modelForbidden = raws.filter(item => [].concat(item.who || []).some(name => corpus.notPeople.some(word => norm(name).includes(norm(word)))));
      const counts = runs.reduce((sum, run) => { for (const [k, v] of Object.entries(run.counts)) if (typeof v === 'number') sum[k] = (sum[k] || 0) + v; return sum; }, {});
      rows.push({ rep, items: items.length, counts, gold: goldRows, rejected: runs.flatMap(run => run.rejected),
        recall: goldRows.filter(row => row.found).length / goldRows.length,
        personAccuracy: goldRows.filter(row => row.found && row.personOk).length / Math.max(1, goldRows.filter(row => row.found).length),
        timeAccuracy: goldRows.filter(row => row.found && row.timeOk).length / Math.max(1, goldRows.filter(row => row.found).length),
        forbiddenStored: forbidden.map(item => ({ text: item.text, who: item.who })), forbiddenByModel: modelForbidden.map(item => ({ text: item.text, who: item.who })),
        modelWho: raws.map(item => ({ who: item.who, whoRef: item.whoRef, when: item.when, text: String(item.text || '').slice(0, 60) })),
        stored: items.map(item => ({ text: item.text, who: item.who, when: item.when, whoIssue: item.whoIssue, whenIssue: item.whenIssue })) });
      const row = rows.at(-1);
      log(`health rep${rep}: rejected ${JSON.stringify(row.rejected)} people ${JSON.stringify([...new Set(items.flatMap(item => (item.who || []).map(person => person.name)))])}`);
      log(`health rep${rep}: items ${row.items} recall ${row.recall.toFixed(2)} person ${row.personAccuracy.toFixed(2)} time ${row.timeAccuracy.toFixed(2)} forbidden ${row.forbiddenStored.length}/${row.forbiddenByModel.length}`);
      if (rep === 0 && only.has('recall')) report.sections.recall = await evalRecall(f, lens.lensId);
    } finally { await f.close(); }
  }
  report.sections.health = rows;
};

// ---- name boundary probes ---------------------------------------------------------------------
const evalNames = async () => {
  const rows = [];
  for (const probe of corpus.nameProbes) {
    for (let rep = 0; rep < reps; rep += 1) {
      const f = await lensFixture();
      try {
        f.control.onCall = callModel;
        const chat = f.target('name probe');
        probe.turns.forEach(([user, assistant], index) => chat.message.push({ role: 'user', chatId: `t${index + 1}-u`, data: user }, { role: 'char', chatId: `t${index + 1}-a`, data: assistant }));
        chat.messages = chat.message;
        f.character.name = probe.characterName || corpus.characterName;
        const lens = plain(await f.api.createLens({ name: '인물별 상태', evidenceMode: 'interpretive', trackSubject: true, cadence: { mode: 'manual' },
          instruction: { goal: probe.goal || '등장인물 각각의 몸 상태와 감정 변화를 인물별로 기록하라.' } }));
        const result = plain(await f.api.runLensForRange(lens.lensId, { startTurn: 1, endTurn: probe.turns.length }));
        const raw = (await rawResponses(f, lens.lensId))[0] || '';
        const modelItems = parseItems(raw) || [];
        const modelNames = modelItems.flatMap(item => [].concat(item.who || []).map(String));
        const storedNames = (result.items || []).flatMap(item => (item.who || []).map(person => person.role === 'named' ? person.name : `@${person.role}`));
        rows.push({ probe: probe.id, rep, modelNames, storedNames,
          expectedPresent: probe.expect.map(name => ({ name, model: modelNames.some(value => norm(value).includes(norm(name)) || (name.startsWith('@') && value === name.slice(1))), stored: storedNames.some(value => norm(value).includes(norm(name)) || value === name) })),
          forbidden: probe.forbid.map(name => ({ name, model: modelNames.some(value => norm(value).includes(norm(name))), stored: storedNames.some(value => norm(value).includes(norm(name))) })),
          items: (result.items || []).map(item => ({ text: item.text, who: item.who, whoIssue: item.whoIssue })),
          modelItems: modelItems.map(item => ({ who: item.who, text: String(item.text || '').slice(0, 70) })) });
        log(`names ${probe.id} rep${rep}: model ${JSON.stringify(modelNames)} -> stored ${JSON.stringify(storedNames)}`);
      } finally { await f.close(); }
    }
  }
  report.sections.names = rows;
};

// ---- recall: lexical vs hybrid on the stored notes, in the session that made them --------------
const embeddingOn = async f => f.api.saveEmbeddingSettings({ enabled: true, provider: 'openai', url: embedUrl + '/embeddings', model: process.env.RAG_EVAL_EMBED_MODEL, key: process.env.RAG_EVAL_EMBED_KEY, maxRetries: 2 });
const evalRecall = async (f, lensId) => {
  const rows = { lexical: [], hybrid: [], calibration: [] };
  if (embedUrl) { await embeddingOn(f); log(`vectors: ${JSON.stringify(plain(await f.api.refreshLensVectors({ lensId })))}`); }
  for (const mode of ['lexical', 'hybrid']) {
    if (mode === 'hybrid' && !embedUrl) continue;
    for (const query of corpus.recallQueries) {
      const started = performance.now();
      const result = plain(await f.api.recallLensMemories({ query: query.text, canonicalBudgetChars: 12000, includeScores: mode === 'hybrid', semantic: mode === 'hybrid', refreshVectors: false }));
      const lines = result.renderedBlock.split('\n').filter(line => line.startsWith('- '));
      const relevant = line => query.relevant.some(word => norm(line).includes(norm(word)));
      const hits = lines.filter(relevant).length;
      rows[mode].push({ query: query.text, kind: query.kind, delivered: lines.length, relevantDelivered: hits, irrelevantDelivered: lines.length - hits,
        success: query.relevant.length ? hits > 0 : lines.length === 0, ms: Math.round(performance.now() - started), semantic: result.semantic, lines });
      if (mode === 'hybrid') for (const score of result.scores || []) rows.calibration.push({ query: query.text, kind: query.kind, similarity: score.similarity, lexicalOverlap: score.lexicalOverlap,
        relevant: query.relevant.some(word => norm(`${score.text} ${(score.who || []).join(' ')}`).includes(norm(word))), text: score.text, who: score.who });
      log(`recall ${mode} "${query.text}": delivered ${lines.length} relevant ${hits} ${rows[mode].at(-1).success ? 'OK' : 'MISS'}`);
    }
  }
  const relevantSims = rows.calibration.filter(row => row.relevant && row.similarity !== null).map(row => row.similarity).sort((a, b) => a - b);
  const otherSims = rows.calibration.filter(row => !row.relevant && row.similarity !== null).map(row => row.similarity).sort((a, b) => a - b);
  const pct = (list, p) => list.length ? list[Math.min(list.length - 1, Math.floor(p * list.length))] : null;
  const sweep = [];
  for (let t = 0.2; t <= 0.8001; t += 0.02) {
    const tp = relevantSims.filter(value => value >= t).length, fp = otherSims.filter(value => value >= t).length;
    const precision = tp + fp ? tp / (tp + fp) : 1, recall = relevantSims.length ? tp / relevantSims.length : 0;
    sweep.push({ threshold: Math.round(t * 100) / 100, tp, fp, precision: Math.round(precision * 1000) / 1000, recall: Math.round(recall * 1000) / 1000, f1: precision + recall ? Math.round(2 * precision * recall / (precision + recall) * 1000) / 1000 : 0 });
  }
  rows.summary = { relevant: { n: relevantSims.length, p10: pct(relevantSims, 0.1), p50: pct(relevantSims, 0.5), p90: pct(relevantSims, 0.9) },
    other: { n: otherSims.length, p50: pct(otherSims, 0.5), p90: pct(otherSims, 0.9), p99: pct(otherSims, 0.99), max: otherSims.at(-1) ?? null }, sweep };
  for (const mode of ['lexical', 'hybrid']) rows.summary[mode] = { success: rows[mode].filter(row => row.success).length, of: rows[mode].length,
    irrelevantDelivered: rows[mode].reduce((sum, row) => sum + row.irrelevantDelivered, 0) };
  return rows;
};

const evalGoldRecall = async () => {
  const f = await session({ embeddings: false });
  try {
    f.control.onCall = async args => {
      const key = JSON.stringify(args).includes('[t6-u]') ? '6-10' : '1-5';
      return { type: 'success', result: JSON.stringify({ items: corpus.goldNotes[key] }) };
    };
    const lens = plain(await f.api.createLens({ name: '생체 추적', evidenceMode: 'interpretive', trackTime: true, trackSubject: true, cadence: { mode: 'manual' },
      labels: ['증상', '수치', '주기', '회복', '진료', '부상'], instruction: { goal: '등장하는 모든 존재의 몸 상태를 기록하라.' } }));
    const runs = await runAll(f, lens.lensId);
    log(`gold notes stored: ${runs.map(run => run.status + ':' + run.items.length).join(', ')}`);
    report.sections.goldrecall = await evalRecall(f, lens.lensId);
  } finally { await f.close(); }
};

(async () => {
  const order = [['goldrecall', evalGoldRecall], ['templates', evalTemplates], ['modes', evalModes], ['assistant', evalAssistant], ['health', evalHealth], ['names', evalNames]];
  for (const [name, fn] of order) {
    if (!only.has(name) && !(name === 'health' && only.has('recall'))) continue;
    const started = performance.now();
    try { await fn(); } catch (error) { report.sections[name] = { error: String(error?.stack || error) }; log(`${name} failed: ${error?.message || error}`); }
    log(`== ${name} ${Math.round((performance.now() - started) / 1000)}s`);
  }
  report.stats = stats; report.finishedAt = new Date().toISOString();
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), { mode: 0o600 });
  log(JSON.stringify({ stats }));
})().catch(error => { console.error(error); process.exitCode = 1; });
