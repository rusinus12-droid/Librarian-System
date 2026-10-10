'use strict';
// Offline VM host shared by recall protection and multilingual tests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.LIBRA_RECALL_TEST_DIST || path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));

async function load(options = {}) {
  const replacers={}, timers=new Set(), intervals=new Set(), unload=[];
  const store=options.store || new Map();
  const chat = { id: 'anchor-memo', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'anchor-memo-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
  const args = new Map(Object.entries({ debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off' }));
  const risuai = {
    async getArgument(n){ return args.get(n); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(){ return true; }, async setCharacter(){ return true; }, async getDatabase(){ return { personas: [] }; },
    async addRisuReplacer(type,fn){ replacers[type]=fn; }, async removeRisuReplacer(){}, async addRisuScriptHandler(){}, async removeRisuScriptHandler(){},
    async registerBodyIntercepter(){ return 'x'; }, async unregisterBodyIntercepter(){}, async onUnload(callback){ unload.push(callback); },
    async registerSetting(){}, async registerButton(){}, async showContainer(){}, async hideContainer(){},
    pluginStorage: {
      async getItem(key){ return store.get(key) ?? null; },
      async setItem(key,value){ store.set(key,value); return true; },
      async removeItem(key){ store.delete(key); return true; }
    },
    async nativeFetch(){ throw new Error('no fetch'); }
  };
  const selectedDist = options.dist || DIST;
  let code = fs.readFileSync(selectedDist, 'utf8');
  // Test-only access at the closure boundary; the shipped public API is untouched.
  code = code.replace('            inspectRecallEligibility,', '            __testExactBackfill: applyExactAnchorBackfill,\n            inspectRecallEligibility,');
  if (options.transformCode) code = options.transformCode(code);
  const close = code.lastIndexOf('})();');
  code = code.slice(0, close)
    + '\n;globalThis.__ANCHOR_MEMO_TEST__={MemoryEngine,MemoryState,CompactMemoryCodec,TokenizerEngine,KoreanTextCore,StrengthenedJaccardCore,LibraTurnWorldline,LibraDataStorage,IntegrityMetaManager,RecallScoringCore:typeof RecallScoringCore!=="undefined"?RecallScoringCore:null};\n'
    + code.slice(close);
  const context = {
    console: { log(){}, warn(){}, error(){}, debug(){} },
    setTimeout(fn,ms,...args){let t;t=setTimeout(()=>{timers.delete(t);fn(...args);},ms);timers.add(t);return t;},
    clearTimeout(t){timers.delete(t);clearTimeout(t);},
    setInterval(fn,ms,...args){const t=setInterval(fn,ms,...args);intervals.add(t);return t;},
    clearInterval(t){intervals.delete(t);clearInterval(t);}, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('no fetch'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: t => Buffer.from(String(t), 'base64').toString('binary'), btoa: t => Buffer.from(String(t), 'binary').toString('base64')
  };
  context.globalThis = context;
  Object.assign(context, options.globals || {});
  vm.createContext(context);
  await vm.runInContext(code, context, { filename: selectedDist, timeout: 15000 });
  await new Promise(r => setTimeout(r, 40));
  context.__ANCHOR_MEMO_TEST__.libraBeforeRequestReplacer=replacers.beforeRequest;
  const closeFixture=async()=>{try{for(const callback of unload.splice(0))await callback();}finally{for(const t of timers)clearTimeout(t);for(const t of intervals)clearInterval(t);timers.clear();intervals.clear();}};
  return { api: context.__ANCHOR_MEMO_TEST__, char, chat, context, store, close:closeFixture, fixtureTimers:()=>({timeouts:timers.size,intervals:intervals.size}) };
}

function memoryEntry(i, text, imp = 5) {
  const meta = { t: i, ttl: -1, imp, cat: 'event', ent: [], summary: text.slice(0, 50), s_id: 'anchor-memo' };
  return { key: `lmai_memory::${i}`, comment: 'lmai_memory', content: `[META:${JSON.stringify(meta)}] ${text}` };
}

module.exports = { load, memoryEntry };
