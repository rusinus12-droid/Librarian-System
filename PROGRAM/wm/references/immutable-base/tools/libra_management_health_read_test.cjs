'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../src/parts', name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `source seam exists: ${start}`);
  return source.slice(from, to);
}
const archive = read('09b-archive-integrity.js'), gui = read('15a-gui-session-data.js');
const source = section(archive, '    const QuarantineManager =', '\n    try {')
  + archive.slice(archive.indexOf('    const IntegrityScanner ='))
  + section(gui, '        const buildHealthBadge =', '\n        const buildGuiAcceptedExtractionPayload =')
  + section(gui, '        const renderHealthReview =', '\n        const refreshHealthReviewFromStorage =');
function load(lore = []) {
  const nodes = new Map(), reports = [];
  const context = vm.createContext({
    lore, effectiveGuiLore: lore, chat: { id: 'chat-a' }, char: { id: 'char-a' }, scope: 'scope-a', persona: 'persona-a',
    safeClone: clone, truncateForLLM: (text, limit) => String(text).slice(0, limit),
    normalizeLegacyMemoryTurnAnchor: value => Number(value) || 0,
    recordRuntimeDebug() {}, recordSuppressedRuntimeError() {},
    // This seam isolates canonical health. Real durable receipt rendering is
    // exercised by libra_pending_capture_health_test.cjs against emitted builds.
    renderPendingCaptureHealth() {},
    TokenizerEngine: { simpleHash: value => String(value).slice(0, 20) },
    LibraLoreConsolidator: { unpack: value => value, withRawManagementRead: callback => callback() },
    esc: value => String(value), escAttr: value => String(value),
    overlay: { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', dataset: {} }); return nodes.get(selector); } },
    ActivityDashboardCore: { updateHealthSummary: (_, summary) => reports.push(clone(summary)) }
  });
  context.healthReadSource = { status:'current', verified:true, get lore(){ return context.lore; } };
  context.LibraDataStorage = { scopeKeyFor: () => context.scope + '|' + context.persona };
  vm.runInContext(`const getChatRuntimeScopeKey = () => scope; const getActiveManagedRuntimeScopeKey = () => scope;\n${source}\n globalThis.api={QuarantineManager,IntegrityScanner,buildHealthSummaryFromLore,renderHealthReview,buildHealthBadge};`, context);
  return { context, api: context.api, nodes, reports };
}
const review = (kind, rows = []) => ({ comment: kind === 'quarantine' ? 'lmai_analysis_quarantine' : 'lmai_integrity_scan', content: JSON.stringify(kind === 'quarantine'
  ? { schema: 'libra.analysis_quarantine.v1', entries: rows }
  : { schema: 'libra.integrity_scan.v1', findings: rows }) });
const qrow = { id: 'q1', status: 'blocked', reason: 'fixture', summary: { counts: { conflicts: 1 } }, payload: { entities: [{ name: 'Fixture' }] } };
const irow = { id: 'i1', type: 'schema_mismatch', status: 'open', severity: 'warn' };
const checks = [];
async function check(name, run) {
  try { await run(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); process.exitCode = 1; }
}
(async () => {
  for (const kind of ['quarantine', 'integrity']) {
    for (const content of ['{bad-json', 'null', '[]', '{}', '{"entries":{}}', '{"findings":{}}']) {
      await check(`${kind} strict reader rejects malformed state ${content}`, () => {
        const { api } = load();
        const manager = kind === 'quarantine' ? api.QuarantineManager : api.IntegrityScanner;
        const list = kind === 'quarantine' ? 'list' : 'listFindings';
        const seed = [review(kind, [kind === 'quarantine' ? qrow : irow])];
        manager[list](seed, { strictRead: true });
        const before = clone(manager.getState());
        const broken = review(kind); broken.content = content;
        assert.throws(() => manager[list]([broken], { strictRead: true }), /state_(invalid|unreadable)/);
        assert.deepEqual(clone(manager.getState()), before, 'failed strict read must preserve prior state');
      });
    }
  }
  for (const kind of ['quarantine', 'integrity']) {
    await check(`${kind} strict reader rejects rows that normalization would discard`, () => {
      const { api } = load(); const manager = kind === 'quarantine' ? api.QuarantineManager : api.IntegrityScanner;
      const list = kind === 'quarantine' ? 'list' : 'listFindings';
      assert.throws(() => manager[list]([review(kind, [{}])], { strictRead: true }), /state_(invalid|unreadable)/);
    });
  }
  await check('verified empty canonical lore does not reuse older effective snapshot', () => {
    const { api, context } = load([review('quarantine', [qrow])]);
    api.renderHealthReview(); context.lore = [];
    const empty = api.renderHealthReview(); assert.equal(empty.total, 0); assert.equal(empty.quarantineRows.length, 0);
  });
  await check('actual missing review state reports current healthy empty', () => {
    const { api } = load(); const summary = api.buildHealthSummaryFromLore([]);
    assert.equal(summary.readState, 'current'); assert.equal(summary.total, 0); assert.equal(summary.severity, 'ok');
  });
  await check('reader exception produces unavailable and unknown counts without leaking error text', () => {
    const { api, reports, nodes } = load();
    api.QuarantineManager.list = () => { throw new Error('PRIVATE_RAW_PAYLOAD'); };
    const summary = api.renderHealthReview();
    assert.equal(summary.readState, 'unavailable'); assert.equal(summary.total, null); assert.equal(summary.quarantine, null);
    assert.notEqual(summary.severity, 'ok');
    assert(!JSON.stringify(summary).includes('PRIVATE_RAW_PAYLOAD'));
    assert(!nodes.get('#health-quarantine-list').innerHTML.includes('검역 항목 없음'));
    assert(!reports.at(-1).message.includes('정상'));
  });
  await check('malformed stored JSON is unavailable instead of healthy empty', () => {
    const broken = review('integrity'); broken.content = '{oops';
    const { api } = load([broken]); const summary = api.renderHealthReview();
    assert.equal(summary.readState, 'unavailable'); assert.equal(summary.integrity, null); assert.notEqual(summary.severity, 'ok');
  });
  await check('last successful rows remain visibly stale, actions disabled, recovery clears stale', () => {
    const { api, context, nodes } = load([review('quarantine', [qrow]), review('integrity', [irow])]);
    const first = api.renderHealthReview(); assert.equal(first.quarantineRows.length, 1);
    const readOriginal = api.QuarantineManager.list;
    api.QuarantineManager.list = () => { throw new Error('offline'); };
    const stale = api.renderHealthReview();
    assert.equal(stale.readState, 'stale'); assert.equal(stale.quarantineRows[0].id, 'q1'); assert.equal(stale.total, null);
    assert(nodes.get('#health-quarantine-list').innerHTML.includes('disabled'));
    api.QuarantineManager.list = readOriginal; context.lore = []; context.effectiveGuiLore = [];
    const refreshed = api.renderHealthReview();
    assert.equal(refreshed.readState, 'current'); assert.equal(refreshed.total, 0); assert.equal(refreshed.quarantineRows.length, 0);
    assert(nodes.get('#health-quarantine-list').innerHTML.includes('검역 항목 없음'));
  });
  await check('scope change cannot reuse a previous scope health snapshot', () => {
    const { api, context } = load([review('quarantine', [qrow])]); api.renderHealthReview();
    context.scope = 'scope-b'; api.QuarantineManager.list = () => { throw new Error('offline'); };
    const next = api.renderHealthReview();
    assert.equal(next.readState, 'unavailable'); assert.equal(next.quarantineRows.length, 0);
  });
  await check('canonical persona change invalidates prior health snapshot despite same runtime scope', () => {
    const { api, context } = load([review('quarantine', [qrow])]); api.renderHealthReview();
    context.persona = 'persona-b'; api.QuarantineManager.list = () => { throw new Error('offline'); };
    const next = api.renderHealthReview();
    assert.equal(next.readState, 'unavailable'); assert.equal(next.quarantineRows.length, 0);
  });
  await check('health counters remain numeric while conflict rows remain separate', () => {
    const { api, reports } = load([review('quarantine', [qrow]), review('integrity', [irow])]);
    const summary = api.renderHealthReview();
    assert.equal(summary.conflictCount, 2); assert.equal(summary.conflicts.length, 2);
    assert.equal(reports.at(-1).conflicts, 2);
  });
  await check('actual dashboard updater retains unknown counts and read state', () => {
    const updaterSource = section(read('02d-activity-dashboard-queues-metrics.js'), '        const updateHealthSummary =', '\n        const getState =');
    for (const visible of [false, true]) {
      const current = { visible, status: 'idle' };
      const ctx = vm.createContext({ safeClone: clone, state: () => current, makeDashboardMetrics: () => ({ healthSummary: { total: 0, severity: 'ok' } }), nowMs: () => 1,
        update: (_, patch) => { Object.assign(current, clone(patch)); return clone(current); } });
      vm.runInContext(updaterSource + '\nglobalThis.run = updateHealthSummary;', ctx);
      ctx.run({}, { total: null, conflicts: null, readState: 'unavailable', severity: 'warn', message: 'unavailable' });
      assert.equal(current.healthSummary.total, null); assert.equal(current.healthSummary.conflicts, null);
      assert.equal(current.healthSummary.readState, 'unavailable'); assert.equal(current.healthSummary.severity, 'warn');
    }
  });
  console.log(JSON.stringify({ ok: checks.every(row => row.ok), passed: checks.filter(row => row.ok).length, failed: checks.filter(row => !row.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
