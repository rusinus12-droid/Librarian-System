'use strict';
// 플러그인 IPC 연결 픽스처. 실제 RisuAI 채널 함수 자리에 응답자를 두고, 세 owner(LIBRA/HAYAKU/
// Flashback)가 describe/select/release 에 답한다. 읽기 경로가 plugin_ipc 하나뿐이므로 서버 전송은
// 호출되면 즉시 실패시켜, 테스트가 실수로 HTTP 로 새는 것을 막는다.
const crypto = require('node:crypto');
const {JSDOM} = require('jsdom');
const {load} = require('./host.cjs');

const PREF = 'serial_gradation_agents_for_rp:lib_read_connection:v1';
const OWNER_IDS = {libra: 'libra', hayaku: 'hayaku_locator_continuity', flashback: 'flashback_memory'};
const REQUEST = 'gradia_memory_read_request_v1', RESPONSE = 'gradia_memory_read_response_v1';
const wait = async (fn, ms = 6000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
  throw Error('Connection action did not settle');
};

function ipcHost(t, {saved, delayPreference = false} = {}) {
  const local = new Map(), values = new Map(), unloads = [], locals = [], requests = [], channel = new Map(), asked = [];
  if (saved) local.set(PREF, JSON.stringify(saved));
  let releasePreference = null, current = {id: 'h', message: []};
  const chatRows = {0: current, 1: {id: 'other', message: []}};
  let currentIndex = 0;
  const scopes = {
    libra: {scopeKey: 'ipc-libra', characterId: 'c', chatId: 'h'},
    hayaku: {scopeKey: 'ipc-hayaku', characterId: 'c', chatId: 'h'},
    flashback: {scopeKey: 'ipc-flashback', characterId: 'c', chatId: 'h'}
  };
  const reply = (sender, message, result, error) => setTimeout(() => channel.get(RESPONSE)?.(
    {schema: 'memory-suite.gradia-plugin-read.v1', kind: 'response', id: message.id, action: message.action, ...(error ? {error} : {result})},
    {sender}), 0);
  const api = {
    addPluginChannelListener: async (name, fn) => { channel.set(name, fn); return true; },
    removePluginChannelListener: async name => { channel.delete(name); },
    postPluginChannelMessage: async (target, name, message) => {
      if (name !== REQUEST || message?.kind !== 'request') return;
      const owner = Object.keys(OWNER_IDS).find(key => OWNER_IDS[key] === target);
      if (!owner) return;
      asked.push(owner);
      const activeChat = chatRows[currentIndex];
      if (message.native && (message.native.characterId !== 'c' || message.native.chatId !== activeChat.id)) {
        return reply(target, message, null, 'LIB_READ_NATIVE_SCOPE_CHANGED');
      }
      if (message.action === 'describe') return reply(target, message, {owner, source: 'plugin_ipc', readOnly: true, scope: {...scopes[owner], chatId: activeChat.id}});
      if (message.action === 'select') return reply(target, message, {owner, source: 'plugin_ipc', readOnly: true, scope: {...scopes[owner], chatId: activeChat.id}, content: owner + ' memory:' + String(message.queryText || '').slice(0, 20)});
      if (message.action === 'release') return reply(target, message, {released: true});
      return reply(target, message, null, 'LIB_READ_REQUEST_INVALID');
    },
    pluginStorage: {getItem: async k => values.get(k) ?? null, setItem: async (k, v) => { values.set(k, v); }, removeItem: async k => { values.delete(k); }},
    getLocalPluginStorage: async () => ({
      getItem: async k => local.get(k) ?? null,
      setItem: async (k, v) => {
        locals.push(k);
        if (delayPreference && JSON.parse(v).explicit === true) await new Promise(r => releasePreference = r);
        local.set(k, v);
      },
      removeItem: async k => { locals.push(k); local.delete(k); }
    }),
    nativeFetch: async (target, init) => { requests.push({url: String(target), headers: init?.headers}); throw Error('IPC path must not use the server transport'); },
    fetch: async () => { throw Error('IPC path must not use the server transport'); },
    onUnload: async fn => unloads.push(fn), showContainer: async () => {}, hideContainer: async () => {},
    getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => currentIndex,
    getCharacterFromIndex: async () => ({chaId: 'c', chats: Object.values(chatRows)}),
    getCharacter: async () => ({chaId: 'c', chats: [current]}),
    getChatFromIndex: async (_c, index) => chatRows[index],
    getChat: async () => current, getCurrentChat: async () => current
  };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {pretendToBeVisual: true, url: 'https://offline.invalid/'});
  return (async () => {
    const host = await load({api, testGlobals: {
      crypto: crypto.webcrypto, Response, window: dom.window, Element: dom.window.Element, document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window), MutationObserver: dom.window.MutationObserver,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
    }});
    t.after(async () => { await host.plugin.closeSettingsGui(); for (const fn of unloads) await fn(); dom.window.close(); });
    await host.plugin.openSettingsGui();
    dom.window.document.querySelector('.sidebar [data-go="sources"]').click();
    const doc = dom.window.document, status = () => host.plugin.getLibReadOnlyStatus();
    const node = selector => { const found = doc.querySelector(selector); if (!found) throw Error('missing ' + selector); return found; };
    const click = action => node(action === 'inspect' ? '#lib-check' : `#lib-${action}`).click();
    const connect = async () => { click('connect'); await wait(() => ['connected', 'error'].includes(status().connection?.state)); return status(); };
    const fire = (element, type) => element.dispatchEvent(new dom.window.Event(type, {bubbles: true}));
    const savedPreference = () => { const raw = local.get(PREF); return raw ? JSON.parse(raw) : null; };
    return {
      host, doc, status, click, connect, local, locals, requests, values, asked, savedPreference, node, wait,
      setChat: id => { current = chatRows[currentIndex] = {id, message: []}; },
      switchIndex: () => { currentIndex = 1; current = chatRows[1]; },
      toggleDraftOwner: (owner, checked) => { const box = node(`[data-lib-draft-owner="${owner}"]`); box.checked = checked; fire(box, 'change'); },
      selectSource: value => { const select = node('#lib-read-source'); select.value = value; fire(select, 'change'); },
      preferenceWaiting: () => !!releasePreference, releasePreference: () => releasePreference?.(),
      unload: async () => { for (const fn of unloads) await fn(); }
    };
  })();
}

module.exports = {ipcHost, PREF, wait};
