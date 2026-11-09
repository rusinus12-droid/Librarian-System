'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {JSDOM} = require('jsdom');
const {load} = require('./gradia/host.cjs');
const createBus = require('./fixtures/libra_gradia_read_bus.cjs'), startOwnerSelections = require('./fixtures/gradia_owner_selection_stub.cjs');

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
  // Every owner answers GRADIA over plugin IPC with its own selection, whatever its storage mode.
  const bus = createBus();
  const stopOwners = await startOwnerSelections(bus, Object.fromEntries(owners.map(o => [o, {scope: scopes[o], content: o + ' memory'}])));
  const transport = async target => { requests.push({path: new URL(target).pathname}); throw Error('NETWORK FORBIDDEN: GRADIA reads over plugin IPC'); };
  const host = await load({
    api: {
      ...bus.api('serial_gradation_agents_for_rp'),
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
    await stopOwners();
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
  return {...host, dom, bus, values, local, requests, status, connect};
}

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

test('toggling draft owners connects and persists that set', async t => {
  const f = await fixture(t);
  const doc = f.dom.window.document;
  
  // Uncheck HAYAKU for draft
  const draftHayaku = doc.querySelector('[data-lib-draft-owner="hayaku"]');
  draftHayaku.checked = false;
  draftHayaku.dispatchEvent(new f.dom.window.Event('change', {bubbles: true}));

  // Click connect
  const status = await f.connect();
  assert.equal(status.connection.state, 'connected');

  // Verify connection status reflects independent sets
  assert.deepEqual(Array.from(status.connection.draftReadOwners), ['libra', 'flashback']);
  assert.equal(status.connection.inputWriterReadOwners, undefined);

  // Verify persistence includes both sets
  const saved = JSON.parse(f.local.get(PREF));
  assert.equal(saved.schema, 'gradia.lib-read-connection.v2');
  assert.deepEqual(saved.draftReadOwners, ['libra', 'flashback']);
  assert.equal(saved.inputWriterReadOwners, undefined);
});

test('UI supports disabling / turning off LIB memory read and persists off state', async t => {
  const f = await fixture(t);
  const doc = f.dom.window.document;

  // First connect to ensure connected state
  await f.connect();
  assert.equal(f.status().connection.state, 'connected');

  // Now select 'off' in #lib-read-source
  const select = doc.querySelector('#lib-read-source');
  assert.ok(select, '#lib-read-source exists');
  const offOption = Array.from(select.options).find(opt => opt.value === 'off');
  assert.ok(offOption, 'off option exists in select');

  select.value = 'off';
  select.dispatchEvent(new f.dom.window.Event('change', {bubbles: true}));

  // Click connect to apply off setting
  doc.querySelector('#lib-connect').click();
  await wait(() => {
    const s = f.local.get(PREF) ? JSON.parse(f.local.get(PREF)) : null;
    return f.status().connection.state === 'disconnected' && s?.explicit === false && s?.readSource === 'off';
  });

  const conn = f.status().connection;
  assert.equal(conn.state, 'disconnected');
  assert.equal(conn.readSource, 'off');
  assert.equal(conn.explicit, false);
  assert.equal(conn.reason, 'LIB_READ_DISABLED');

  // Verify persistence
  const saved = JSON.parse(f.local.get(PREF));
  assert.equal(saved.schema, 'gradia.lib-read-connection.v2');
  assert.equal(saved.explicit, false);
  assert.equal(saved.readSource, 'off');
});

test('saved off preference restores cleanly without network requests or reconnection attempts', async t => {
  const f = await fixture(t, {
    saved: {
      schema: 'gradia.lib-read-connection.v2',
      url,
      explicit: false,
      readSource: 'off',
      readOwners: ['libra'],
      draftReadOwners: ['libra'],
      inputWriterReadOwners: ['libra']
    }
  });

  const conn = f.status().connection;
  assert.equal(conn.state, 'disconnected');
  assert.equal(conn.readSource, 'off');
  assert.equal(conn.explicit, false);
  assert.equal(conn.reason, 'LIB_READ_DISABLED');
  assert.equal(f.requests.length, 0, 'No network requests on startup when memory read is off');
  assert.equal(f.bus.messages.filter(m => m.sender === 'serial_gradation_agents_for_rp').length, 0, 'No owner reads on startup when memory read is off');
});

test('clicking #lib-disconnect disables memory reading, updates UI and persists off state', async t => {
  const f = await fixture(t);
  const doc = f.dom.window.document;

  await f.connect();
  assert.equal(f.status().connection.state, 'connected');

  // Click disconnect button
  const disconnectBtn = doc.querySelector('#lib-disconnect');
  assert.ok(disconnectBtn, '#lib-disconnect exists');
  disconnectBtn.click();

  await wait(() => {
    const s = f.local.get(PREF) ? JSON.parse(f.local.get(PREF)) : null;
    return f.status().connection.state === 'disconnected' && s?.explicit === false && s?.readSource === 'off';
  });

  const conn = f.status().connection;
  assert.equal(conn.state, 'disconnected');
  assert.equal(conn.readSource, 'off');
  assert.equal(conn.explicit, false);

  const chip = doc.querySelector('#lib-chip');
  assert.ok(chip.textContent.includes('기억 읽기 끔') || chip.textContent.includes('사용 안 함'));
});
