'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {JSDOM} = require('jsdom');
const {load} = require('./gradia/host.cjs');

const PREF = 'serial_gradation_agents_for_rp:lib_read_connection:v1', url = 'http://127.0.0.1:47630';
const owners = ['libra', 'hayaku', 'flashback'];
const scopes = Object.fromEntries(owners.map(o => [o, {scopeKey: o + '-scope', characterId: 'c', chatId: 'h'}]));

const wait = async fn => {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error('NOT_SETTLED');
};

async function fixture(t, {saved} = {}) {
  const values = new Map(), local = new Map(), requests = [], writes = [], unloads = [];
  if (saved) local.set(PREF, JSON.stringify(saved));
  values.set('libra:v1:scope-registry:v1', JSON.stringify({'c::h': scopes.libra}));
  for (const owner of owners) {
    values.set('__memory_suite_internal_scope_routes_v1__:' + owner, JSON.stringify({
      schema: 'memory-suite.scope-routing.v1',
      namespace: owner,
      version: 1,
      legacyGlobalModeImported: true,
      entries: {
        [scopes[owner].scopeKey]: {
          scopeId: scopes[owner].scopeKey,
          ...scopes[owner],
          mode: 'server_only',
          origin: 'user_explicit',
          updatedAt: 1
        }
      }
    }));
  }
  const store = {
    getItem: async k => values.get(k) ?? null,
    setItem: async (k, v) => { writes.push(k); values.set(k, v); },
    removeItem: async k => { writes.push(k); values.delete(k); }
  };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {pretendToBeVisual: true, url: 'https://offline.invalid/'});
  const id = 'A'.repeat(32);
  const transport = async (target, init) => {
    const path = new URL(target).pathname;
    requests.push({path, headers: init.headers, body: init.body && JSON.parse(init.body)});
    if (path === '/bootstrap') {
      const readNamespaces = init.headers['X-Memory-Suite-Read-Owners']
        ? JSON.parse(init.headers['X-Memory-Suite-Read-Owners'])
        : ['libra'];
      return new Response(JSON.stringify({
        ok: true,
        schema: 'memory-suite.storage.bootstrap.v1',
        url,
        token: 'offline-only',
        dataInstanceId: id,
        dataIdentityContract: 'memory-suite.physical-data-identity.v1',
        resetEpochs: {},
        protocol: {major: 1, minor: 0},
        namespaces: owners,
        authorization: {
          schema: 'memory-suite.bootstrap-authorization.v1',
          pluginId: 'serial_gradation_agents_for_rp',
          namespace: 'libra',
          roles: ['readonly'],
          readNamespaces,
          writeNamespaces: []
        },
        capabilities: Object.fromEntries([
          'kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1',
          'tombstone.v1','readback.v1','namespace-integrity.v1',
          'data-instance-binding.v1','libra-read-session.v1','gradia-memory-read-session.v1'
        ].map(k => [k, true]))
      }));
    }
    const match = /^\/v1\/(libra|hayaku|flashback)\/read-session\/(capture|current)$/.exec(path);
    assert(match, path);
    const owner = match[1], body = JSON.parse(init.body), scope = scopes[owner];
    const evidenceRevision = crypto.createHash('sha256').update(owner).digest('hex');
    const result = match[2] === 'capture' ? {
      schema: `memory-suite.${owner}-read-session.v1`,
      scope,
      readOnly: true,
      complete: true,
      items: [{id: 'm', key: 'k', content: owner, source: {namespace: owner, scopeKey: scope.scopeKey}}],
      dependencies: [],
      evidenceRevision,
      corpusBytes: owner.length,
      maxCorpusBytes: body.maxCorpusBytes,
      maxRawBytes: body.maxRawBytes,
      metadataBytes: 10,
      rawBytes: 10,
      dataInstanceId: id,
      resetEpoch: 0,
      readIdentity: {scope, dataInstanceId: id, resetEpoch: 0}
    } : {
      schema: `memory-suite.${owner}-read-session-current.v1`,
      scope,
      current: true,
      evidenceRevision,
      dataInstanceId: id,
      resetEpoch: 0
    };
    return new Response(JSON.stringify({ok: true, dataInstanceId: id, result}));
  };
  const channel = new Map();
  const host = await load({
    api: {
      addPluginChannelListener: async (name, fn) => { channel.set(name, fn); return true; },
      removePluginChannelListener: async name => { channel.delete(name); },
      postPluginChannelMessage: async (target, name, message) => {
        if (target !== 'libra' || name !== 'libra_gradia_unified_read_request_v1' || message.kind !== 'request') return;
        const reply = message.action === 'describe'
          ? {ok: true, result: {schema: 'libra.gradia-unified-read.v1', source: 'unified_engine', readOnly: true, purposes: ['response_evidence', 'input_writer_proposal']}}
          : {ok: false, errorCode: 'LIB_READ_UNIFIED_UNAVAILABLE'};
        setTimeout(() => channel.get('libra_gradia_unified_read_response_v1')?.({schema: 'libra.gradia-unified-read.v1', kind: 'response', requestId: message.requestId, ...reply}, {sender: 'libra'}), 0);
      },
      pluginStorage: store,
      getLocalPluginStorage: async () => ({getItem: async k => local.get(k) ?? null, setItem: async (k, v) => local.set(k, v)}),
      nativeFetch: transport,
      fetch: transport,
      onUnload: async fn => unloads.push(fn),
      showContainer: async () => {},
      hideContainer: async () => {},
      getCurrentCharacterIndex: async () => 0,
      getCurrentChatIndex: async () => 0,
      getCharacterFromIndex: async () => ({chaId: 'c', chats: [{id: 'h'}]}),
      getChatFromIndex: async () => ({id: 'h', message: []})
    },
    testGlobals: {
      crypto: crypto.webcrypto,
      Response,
      window: dom.window,
      Element: dom.window.Element,
      document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      MutationObserver: dom.window.MutationObserver,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
    }
  });
  t.after(async () => {
    await host.plugin.closeSettingsGui();
    for (const f of unloads) await f();
    dom.window.close();
  });
  await host.plugin.openSettingsGui();
  dom.window.document.querySelector('.sidebar [data-go="sources"]').click();
  const status = () => host.plugin.getLibReadOnlyStatus();
  const connect = async () => {
    dom.window.document.querySelector('#lib-connect').click();
    await wait(() => ['connected', 'error'].includes(status().connection.state));
    return status();
  };
  return {...host, dom, values, local, requests, status, connect};
}

// 오너 토글·켜기/끄기·연결 해제 계약은 tests/gradia/owner-toggle-ipc.test.cjs 로 이관했다.
test('UI renders owner toggle checkboxes for the draft route only', async t => {
  const f = await fixture(t);
  const doc = f.dom.window.document;
  
  const draftCbs = doc.querySelectorAll('[data-lib-draft-owner]');
  assert.equal(draftCbs.length, 3, '초안 작성용 오너 체크박스 3개 렌더링');
  const draftIds = Array.from(draftCbs).map(cb => cb.dataset.libDraftOwner);
  assert.deepEqual(draftIds, ['libra', 'hayaku', 'flashback']);

  const scope = doc.querySelector('[data-existing-response-field="rpImpersonationScope"]');
  assert.deepEqual(Array.from(scope.options).map(o => o.value), ['persona', 'persona_cast', 'all'], 'RP 세부 모드 3종');
  assert.equal(scope.hidden, true, '소설 모드에서는 RP 세부 모드를 숨긴다');
  assert.deepEqual(Array.from(scope.options).map(o => o.textContent), ['페르소나만 사칭 금지', '장면 연출', '문장화']);
  assert.equal(doc.querySelector('[data-rp-scope-description]').hidden, true, '소설 모드에서는 세부 모드 설명도 숨긴다');
  assert.equal(doc.querySelectorAll('[data-lib-input-writer-owner]').length, 0, '입력 작성기는 LIB 기억을 읽지 않으므로 대상 선택이 없다');
});




