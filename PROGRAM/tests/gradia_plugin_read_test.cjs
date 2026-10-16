'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const create = require('../tools/gradia_plugin_read.cjs'), createBus = require('./fixtures/libra_gradia_read_bus.cjs');
const primitives = { fingerprint: value => crypto.createHash('sha256').update(value).digest('hex'), byteLength: value => Buffer.byteLength(value) };
const scope = { scopeKey: 's', characterId: 'c', chatId: 'h' };
async function setup(t, options = {}) {
  const bus = createBus(), state = { mode: 'plugin_only', current: true, close: 0, captures: 0, gate: null };
  const owner = create({ role: 'owner', owner: 'hayaku', api: bus.api('hayaku_locator_continuity'), primitives,
    boundary: async () => ({ scope, mode: state.mode }), capture: async request => {
      state.captures++; await state.gate;
      return { items: [{ id: 'i', key: 'k', content: 'IPC_OWNER_EVIDENCE', source: { namespace: 'hayaku' } }],
        assertCurrent: async () => state.current, close: () => state.close++ };
    } });
  const reader = create({ role: 'reader', api: bus.api('serial_gradation_agents_for_rp'), primitives, timeoutMs: 70, ...options });
  await owner.start(); t.after(async () => { await reader.dispose(); await owner.dispose(); });
  return { bus, state, owner, reader, client: reader.createClient({ hayaku: scope }) };
}
test('plugin IPC reads independently of request hooks and releases an owner receipt', async t => {
  const f = await setup(t), found = await f.reader.describe(scope, ['hayaku']);
  assert.deepEqual(found.scopes, { hayaku: scope });
  const read = await f.client.openReadSession(scope, { maxCorpusBytes: 10000, source: 'plugin_ipc', queryText: 'query' });
  assert.equal(read.snapshot.items[0].content, 'IPC_OWNER_EVIDENCE');
  assert.equal(read.source, 'plugin_ipc'); assert.equal(await read.assertCurrent(), true);
  read.close(); assert.equal(f.state.close, 1); assert.throws(read.assertCurrentSync, /STALE/);
});
test('mode and source changes invalidate plugin evidence before delivery', async t => {
  for (const change of ['mode', 'source']) {
    const f = await setup(t), read = await f.client.openReadSession(scope, { maxCorpusBytes: 10000 });
    if (change === 'mode') f.state.mode = 'server_only'; else f.state.current = false;
    await assert.rejects(read.assertCurrent, /LIB_READ_/); assert.equal(f.state.close, 1);
  }
});
test('authenticated metadata rejects spoofed owner requests and responses', async t => {
  const f = await setup(t), evil = f.bus.api('untrusted');
  await evil.postPluginChannelMessage('hayaku_locator_continuity', 'gradia_memory_read_request_v1', {
    schema: 'memory-suite.gradia-plugin-read.v1', kind: 'request', id: 'spoof', action: 'capture', scope, maxCorpusBytes: 10000, queryText: 'x', sender: 'serial_gradation_agents_for_rp' });
  assert.equal(f.state.captures, 0);
  let resolve; f.state.gate = new Promise(r => { resolve = r; });
  const pending = f.client.openReadSession(scope, { maxCorpusBytes: 10000 });
  while (!f.state.captures) await new Promise(r => setTimeout(r, 1));
  const request = f.bus.messages.find(m => m.body.action === 'capture');
  await evil.postPluginChannelMessage('serial_gradation_agents_for_rp', 'gradia_memory_read_response_v1', {
    schema: request.body.schema, kind: 'response', action: 'capture', id: request.body.id, result: { forged: true } });
  resolve(); const read = await pending; assert.equal(read.snapshot.items.length, 1); read.close();
});
test('abort while owner is capturing releases its late result', async t => {
  const f = await setup(t), signal = new AbortController(); let resolve;
  f.state.gate = new Promise(r => { resolve = r; });
  const pending = f.client.openReadSession(scope, { maxCorpusBytes: 10000, signal: signal.signal });
  while (!f.state.captures) await new Promise(r => setTimeout(r, 1));
  signal.abort(); await assert.rejects(pending, /CANCELED/); resolve();
  await new Promise(r => setTimeout(r, 10)); assert.equal(f.state.close, 1);
});
test('missing owners are explicit and proposal inputs do not become facts', async t => {
  const f = await setup(t), found = await f.reader.describe(scope);
  assert.deepEqual(Object.keys(found.scopes), ['hayaku']); assert.equal(found.unavailable.libra, 'LIB_READ_TIMEOUT');
  await assert.rejects(f.client.openReadSession(scope, { maxCorpusBytes: 10000, proposal: { factAdopted: true } }), /PROPOSAL_INVALID/);
});
test('a receipt from a different operation is rejected and the real pending capture is released', async t => {
  const f=await setup(t);let resolve;
  f.state.gate=new Promise(r=>{resolve=r;});
  const pending=f.client.openReadSession(scope,{maxCorpusBytes:10000});
  while(!f.state.captures)await new Promise(r=>setTimeout(r,1));
  const request=f.bus.messages.find(m=>m.body.action==='capture').body;
  await f.bus.api('hayaku_locator_continuity').postPluginChannelMessage('serial_gradation_agents_for_rp','gradia_memory_read_response_v1',{
    schema:request.schema,kind:'response',id:request.id,action:'capture',result:{receipt:'unrelated-operation'} });
  await assert.rejects(pending,/RESPONSE_INVALID/);resolve();
  await new Promise(r=>setTimeout(r,10));assert.equal(f.state.close,1);
});
