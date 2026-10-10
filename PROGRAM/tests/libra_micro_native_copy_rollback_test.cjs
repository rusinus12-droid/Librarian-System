'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {clone, parent, branch, character} = require('./fixtures/native_branch_fixture.cjs');

(async () => {
 for (const mode of ['plugin_only','server_only']) {
  const root = parent('micro-rollback-parent', 1);
  root.message[1].data = 'Alice placed the key on the table.';
  const char = character([root]);
  let current = root, listener;
  const host = {
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => char.chats.indexOf(current),
    getCharacter: async () => clone(char),
    getCharacterFromIndex: async () => clone(char),
    getChat: async () => clone(current),
    getCurrentChat: async () => clone(current),
    getChatFromIndex: async (_ci, index) => clone(char.chats[index]),
    getDatabase: async fields => {
      const db = {personas: [], selectedPersona: '', characters: [clone(char)], plugins: []};
      return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
    },
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; },
    runLLMModel: async () => ({type: 'error', result: 'controlled provider unavailable'})
  };
  const fx = await serverFixture({mode, host});
  try {
    const api = fx.f.r.api;
    listener({char, chat: root, characterIndex: 0, chatIndex: 0, messageIndex: 1});
    let source;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      source = await api.debugReadActiveMicroMemory(1);
      if (source.status === 'verified') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(source.status, 'verified');
    const sourceRaw = mode === 'plugin_only' ? fx.local.get(source.recordKey) : fx.storedRows().find(row=>row.key===source.recordKey)?.raw;
    const child = branch(root, 1, 'micro-rollback-child');
    char.chats.unshift(child);
    current = child;
    const setItem = fx.backend.setItem;
    let injected = false;
    const isTargetHead = key => String(key).includes(':micro-memory-head:') && !String(key).includes(source.record.scopeKey);
    fx.backend.setItem = async (storageKey, value) => {
      if (mode === 'plugin_only' && !injected && isTargetHead(storageKey)) {
        injected = true;
        throw new Error('injected target Micro head write failure');
      }
      return setItem(storageKey, value);
    };
    fx.hooks.beforeServerRequest = (url, init) => {
      if (mode !== 'server_only' || injected || !/\/v1\/kv\/(set|batch)$/.test(url)) return;
      const body=JSON.parse(init.body);
      if (isTargetHead(body.key) || body.mutations?.some(row=>isTargetHead(row.key))) {
        injected=true;
        throw new Error('injected target Micro head write failure');
      }
    };
    await assert.rejects(() => api.debugNativeChatCopy({force: true}),
      mode === 'plugin_only' ? /pluginStorage 쓰기 실패:.*:micro-memory-head:/
        : /(?:injected target Micro head write failure|LIBRA_VERIFIED_STORAGE_COPY_MISMATCH)/);
    fx.backend.setItem = setItem;
    fx.hooks.beforeServerRequest = null;
    assert.equal(injected, true);
    const targetKey = storageKey => String(storageKey).startsWith('libra:v1:scope:')
      && !String(storageKey).includes(`:scope:${source.record.scopeKey}:`)
      && /:(?:micro-memory|micro-memory-head|micro-work|source-receipt|source-receipt-head):/.test(storageKey);
    assert.equal([...fx.local.keys()].filter(targetKey).length, 0,
      'rollback removes every newly written target owner key from local storage');
    assert.equal(fx.storedRows().filter(row => targetKey(row.key)).length, 0,
      'rollback removes every newly written target owner key from server storage');
    assert.equal(mode === 'plugin_only' ? fx.local.get(source.recordKey) : fx.storedRows().find(row=>row.key===source.recordKey)?.raw, sourceRaw,
      'rollback does not modify the source immutable Micro');
    const restarted = await fx.restart();
    assert.equal((await restarted.r.api.debugReadActiveMicroMemory(1)).status, 'verified',
      'a fresh bridge may retry the fully rolled-back copy and then read the completed target');
    current = root;
    assert.equal((await restarted.r.api.debugReadActiveMicroMemory(1)).status, 'verified',
      'the original source Micro is still readable');
    console.log('PASS native Micro copy failure rolls back target and preserves source in '+mode);
  } finally { await fx.cleanup(); }
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
