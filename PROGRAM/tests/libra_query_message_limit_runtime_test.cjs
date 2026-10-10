'use strict';
// Product mutation caught: historyRows.slice(-0) admits every receipt at N=1.
// Real source/Full/Min and registered beforeRequest; no source transform/private export.
// Synthetic provider output only creates the persisted fixture. Query replay forbids calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { generated, fixture } = require('./fixtures/libra_q04_thread_fixture.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const evidence = { kind: 'offline synthetic replay; not live model quality', cases: [], networkAttempts: [] };
const blockNetwork = (...args) => { evidence.networkAttempts.push(String(args[0] || '')); throw Error('query-limit replay forbids network'); };
global.fetch = blockNetwork;
for (const [name, methods] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:dns', ['lookup', 'resolve']]]) {
  for (const method of methods) require(name)[method] = blockNetwork;
}
const current = '오늘 열쇠를 돌려주겠다는 약속';
async function checkCase(snapshot, name, setting, expectedLimit, input = current, expectedHistory = null) {
  const f = await fixture({ snapshot, host: { nativeFetch: blockNetwork } });
  try {
    f.control.onCall = () => { throw Error('query composition must not invoke a model'); };
    const settings = await f.r.api.getLibraMemorySettings();
    assert.equal(settings.recallQueryMessages, 5, 'fresh fixture preserves default five');
    if (setting !== 'default') await f.r.api.saveLibraMemorySettings({ ...settings, recallQueryMessages: setting });
    const request = [{ role: 'user', content: input }];
    const messages = await f.control.hooks.beforeRequest(request, 'model');
    const runtime = f.r.api.getRuntime();
    const query = runtime.lastMemoryRecall?.query;
    const available = snapshot.chat.message.map(row => ({ role: row.role, body: row.data }));
    const limit = Math.min(available.length, expectedLimit - 1);
    const history = expectedHistory || (limit > 0 ? available.slice(-limit) : []);
    const scene = history.map(row => `${row.role.toUpperCase()}: ${row.body}`).join('\n\n');
    const checks = {
      requested: query?.queryMessagesRequested === expectedLimit,
      used: query?.queryMessagesUsed === history.length + 1,
      historyCount: query?.queryHistoryRows.length === history.length,
      chronologicalScene: query?.sceneText === scene,
      currentQuery: query?.currentText === input,
      currentRendered: messages.filter(row => row.role === 'user').length === 1 && messages.find(row => row.role === 'user').content === input,
      noQueryModel: f.control.calls.length === 0,
      ...(expectedLimit === 1 && input === current ? { noSceneWeight: query?.sceneWeight === 0 } : {})
    };
    const row = { name, setting, expectedLimit, expectedHistory: history.length, checks, pass: Object.values(checks).every(Boolean), query: clone(query), messages: clone(messages), viewer: clone(runtime.lastMemoryRecallViewer), injection: clone(runtime.lastMemoryInjectionMeta) };
    evidence.cases.push(row);
    console.log(JSON.stringify({ name, requested: query?.queryMessagesRequested, used: query?.queryMessagesUsed, history: query?.queryHistoryRows.length, pass: row.pass, failed: Object.keys(checks).filter(key => !checks[key]) }));
  } finally { await f.r.cleanup(); }
}
(async () => {
  try {
    const prepared = await generated();
    let snapshot;
    try {
      snapshot = { chat: clone(prepared.chat), values: [...prepared.r.values] };
      assert.equal(snapshot.chat.message.length, 20, 'ten completed turns supply twenty history rows');
      assert.equal(prepared.getRecords('libra.completed_turn_receipt.v1').length, 10, 'all history is receipt-backed');
      evidence.fixtureModelCalls = prepared.control.calls.length;
    } finally { await prepared.r.cleanup(); }
    for (const [name, setting, expected] of [
      ['one-current-only', 1, 1], ['two-keeps-last-history', 2, 2], ['default-five', 'default', 5],
      ['upper-bound', 20, 20], ['above-upper-clamped', 99, 20], ['zero-clamped', 0, 1],
      ['negative-clamped', -7, 1], ['fraction-floored', 1.9, 1], ['numeric-string', '2', 2], ['invalid-default', 'invalid', 5]
    ]) await checkCase(snapshot, name, setting, expected);
    await checkCase(snapshot, 'one-continuation-current-only', 1, 1, '계속');
    const empty = { chat: { id: 'query-empty', chatId: 'query-empty', name: 'No history', message: [] } };
    for (const [name, setting, expected] of [['empty-one', 1, 1], ['empty-two', 2, 2], ['empty-default', 'default', 5]]) {
      await checkCase(empty, name, setting, expected);
    }
    const f = await fixture({ snapshot: empty, host: { nativeFetch: blockNetwork } });
    try {
      f.control.onCall = () => { throw Error('empty current input must not invoke a model'); };
      const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: '' }], 'model');
      assert.equal(f.r.api.getRuntime().lastMemoryRecall, null, 'no current input does not become a history-only query');
      assert.equal(f.control.calls.length, 0);
      assert.equal(messages.find(row => row.role === 'user').content, '');
      evidence.emptyCurrent = { pass: true, messages: clone(messages) };
      console.log('PASS empty current input skips recall');
    } finally { await f.r.cleanup(); }
    assert.equal(evidence.networkAttempts.length, 0);
    assert.deepEqual(evidence.cases.filter(row => !row.pass).map(row => row.name), [], 'query window contract failures');
    evidence.status = 'PASS';
  } catch (error) { evidence.status = 'FAIL'; evidence.error = error.stack; console.error(error); process.exitCode = 1; }
  finally { if (process.env.LIBRA_QUERY_LIMIT_EVIDENCE) fs.writeFileSync(process.env.LIBRA_QUERY_LIMIT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n'); }
})();
