'use strict';
// Regression guard: settings that used to be declared but never connected must
// actually change observable behavior.
//   1. emotion_enabled     -> memory importance is boosted from text emotion
//   2. weight_mode/w_*     -> recall scoring uses the configured weight vector
//   3. memory_preset       -> retention defaults come from the preset table
//   4. hme_graph_debug     -> graph recall emits a debug record
// Each case asserts the effect AND a control, so a passing suite cannot come
// from the setting being ignored.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const assertions = [];
const check = (name, ok, detail = null) => {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

async function load(argsOverride = {}) {
  const chat = { id: 'settings-wiring-chat', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'settings-wiring-char', name: 'Settings Wiring Test', chatPage: 0, chats: [chat], globalLore: [], lorebook: [] };
  const args = new Map(Object.entries({
    debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off', ...argsOverride
  }));
  const debugRecords = [];
  const risuai = {
    apiVersion: '3.0-test', async getRuntimeInfo(){ return { apiVersion: '3.0-test' }; },
    async getArgument(name){ return args.get(name); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(_a, _b, next){ Object.assign(chat, clone(next)); char.chats[0] = chat; return true; },
    async setCharacter(next){ Object.assign(char, clone(next)); return true; }, async getDatabase(){ return { personas: [] }; },
    async addRisuReplacer(){ return true; }, async removeRisuReplacer(){ return true; }, async addRisuScriptHandler(){ return true; },
    async removeRisuScriptHandler(){ return true; }, async registerBodyIntercepter(){ return 'settings-wiring-test'; },
    async unregisterBodyIntercepter(){ return true; }, async onUnload(){ return true; }, async registerSetting(){ return true; },
    async registerButton(){ return true; }, async showContainer(){ return true; }, async hideContainer(){ return true; },
    pluginStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    safeLocalStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async getLocalPluginStorage(){ return this.pluginStorage; }, async nativeFetch(){ throw new Error('unexpected fetch'); }
  };
  let code = fs.readFileSync(DIST, 'utf8');
  const close = code.lastIndexOf('\n})();');
  if (close < 0) throw new Error('IIFE close not found');
  code = code.slice(0, close)
    + '\n;globalThis.__LIBRA_SETTINGS_WIRING_TEST__={MemoryEngine,MemoryState,DebugExportManager,EntityProcessor:EntityAwareProcessor};\n'
    + code.slice(close);
  const context = {
    console: { log(...a){ debugRecords.push({ level: 'log', msg: a.map(String).join(' ') }); }, warn(){}, error(){}, debug(){} },
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('unexpected fetch'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: text => Buffer.from(String(text), 'base64').toString('binary'), btoa: text => Buffer.from(String(text), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  const result = vm.runInContext(code, context, { filename: DIST, timeout: 15000 });
  if (result && typeof result.then === 'function') await result;
  await new Promise(resolve => setTimeout(resolve, 40));
  return { api: context.__LIBRA_SETTINGS_WIRING_TEST__, debugRecords, context };
}

// A memory payload with strongly emotional text, as the write path receives it.
function emotionalMemoryText(marker, text) {
  return `[META:{"t":7,"cat":"event","imp":5,"src":"${marker}"}] ${text}`;
}

(async () => {
  // ── 1. emotion_enabled drives memory importance ─────────────────────────
  {
    const on = await load({ emotion_enabled: 'true' });
    const off = await load({ emotion_enabled: 'false' });
    const text = '아리엘은 도현의 손을 붙잡고 눈물을 흘리며 무서워하고 있다.';
    const onImp = on.api.MemoryEngine.emotionAdjustedImportance
      ? on.api.MemoryEngine.emotionAdjustedImportance(5, text)
      : null;
    const offImp = off.api.MemoryEngine.emotionAdjustedImportance
      ? off.api.MemoryEngine.emotionAdjustedImportance(5, text)
      : null;
    check('emotion_setting_exposes_adjusted_importance', typeof onImp === 'number' && typeof offImp === 'number',
      { onImp, offImp });
    check('emotion_enabled_raises_importance_for_emotional_text', onImp > 5, { onImp, text });
    check('emotion_disabled_keeps_base_importance', offImp === 5, { offImp });
    const neutralOn = on.api.MemoryEngine.emotionAdjustedImportance(5, '도현은 관측 기록을 대조했다.');
    check('emotion_boost_is_selective_not_constant', neutralOn === 5, { neutralOn });
  }

  // ── 2. weight_mode / custom weights reach recall scoring ────────────────
  {
    const custom = await load({ weight_mode: 'custom', w_sim: '0.8', w_imp: '0.1', w_rec: '0.1' });
    const auto = await load({});
    const customCfg = custom.api.MemoryEngine.CONFIG;
    const autoCfg = auto.api.MemoryEngine.CONFIG;
    check('weight_mode_arg_is_read', String(customCfg.weightMode).toLowerCase() === 'custom',
      { weightMode: customCfg.weightMode });
    check('custom_weights_are_applied', Number(customCfg.weights?.similarity || 0) > 0.7,
      { weights: customCfg.weights });
    check('default_weights_remain_auto', Number(autoCfg.weights?.similarity || 0) !== Number(customCfg.weights?.similarity || 0),
      { autoWeights: autoCfg.weights, customWeights: customCfg.weights });
    const resolved = typeof custom.api.MemoryEngine.resolveRecallWeights === 'function'
      ? custom.api.MemoryEngine.resolveRecallWeights('anything')
      : null;
    check('recall_weights_come_from_config', resolved && Number(resolved.similarity) > 0.7, { resolved });
  }

  // ── 3. memory_preset drives retention defaults ─────────────────────────
  {
    const small = await load({ memory_preset: 'sim_small' });
    const large = await load({ memory_preset: 'sim_large' });
    const sCfg = small.api.MemoryEngine.CONFIG;
    const lCfg = large.api.MemoryEngine.CONFIG;
    check('memory_preset_arg_is_read', String(sCfg.memoryPreset) === 'sim_small', { memoryPreset: sCfg.memoryPreset });
    check('small_preset_sets_its_own_max_limit', Number(sCfg.maxLimit) === 220, { maxLimit: sCfg.maxLimit });
    check('large_preset_sets_a_larger_limit', Number(lCfg.maxLimit) === 560 && Number(lCfg.maxLimit) > Number(sCfg.maxLimit),
      { small: sCfg.maxLimit, large: lCfg.maxLimit });
    check('preset_changes_similarity_threshold', Number(sCfg.simThreshold) > Number(lCfg.simThreshold),
      { smallSim: sCfg.simThreshold, largeSim: lCfg.simThreshold });
  }

  // ── 4. hme_graph_debug emits a debug record ────────────────────────────
  {
    const on = await load({ hme_graph_debug: 'full' });
    const off = await load({ hme_graph_debug: 'off' });
    const onCfg = on.api.MemoryEngine.CONFIG;
    const offCfg = off.api.MemoryEngine.CONFIG;
    check('hme_graph_debug_arg_is_read', String(onCfg.hmeGraphDebug) === 'full' && String(offCfg.hmeGraphDebug) === 'off',
      { on: onCfg.hmeGraphDebug, off: offCfg.hmeGraphDebug });
    const level = typeof on.api.MemoryEngine.hmeGraphDebugLevel === 'function'
      ? on.api.MemoryEngine.hmeGraphDebugLevel()
      : null;
    check('hme_graph_debug_level_is_resolvable', level === 'full', { level });
    const offLevel = typeof off.api.MemoryEngine.hmeGraphDebugLevel === 'function'
      ? off.api.MemoryEngine.hmeGraphDebugLevel()
      : null;
    check('hme_graph_debug_off_is_respected', offLevel === 'off', { offLevel });
  }

  // ── 5. End-to-end: the settings change STORED data, not just config ──────
  {
    const { api, char, chat } = await load({});
    const ME = api.MemoryEngine;
    ME.setTurn(7);
    const lore = [];
    const text = '아리엘은 도현의 손을 붙잡고 눈물을 흘리며 무서워하고 있다.';
    const created = await ME.prepareMemory({
      content: `[META:{"t":7,"cat":"event","imp":5}] ${text}`,
      importance: 5, entityRefs: []
    }, 7, lore, lore, char, chat, 'm-e2e', { source: 'settings-wiring-test' });
    // prepareMemory returns the entry; it is not pushed into the lore array.
    const entry = created || (lore || []).find(e => e && e.comment === 'lmai_memory');
    const metaMatch = entry ? String(entry.content || '').match(/\[META:(\{[\s\S]*?\})\]/) : null;
    let storedImp = null;
    try { storedImp = metaMatch ? JSON.parse(metaMatch[1]).imp : null; } catch (_) {}
    check('emotion_boost_reaches_stored_memory_importance', Number(storedImp) > 5,
      { storedImp, note: 'read back from the lmai_memory [META:] block' });
  }
  {
    // memory_preset must change the stored ttl (it derives from CONFIG.threshold).
    const { api: apiSmall, char: cS, chat: chS } = await load({ memory_preset: 'sim_small' });
    const { api: apiLarge, char: cL, chat: chL } = await load({ memory_preset: 'sim_large' });
    const store = async (api, char, chat) => {
      const ME = api.MemoryEngine;
      ME.setTurn(7);
      const lore = [];
      // importance 4: below sim_small threshold(5) but above sim_large threshold(3)
      const created = await ME.prepareMemory({
        content: `[META:{"t":7,"cat":"event","imp":4}] 별핵 파편 조사가 진행되었다.`,
        importance: 4, entityRefs: []
      }, 7, lore, lore, char, chat, 'm-ttl', { source: 'settings-wiring-test' });
      const entry = created || (lore || []).find(e => e && e.comment === 'lmai_memory');
      const m = entry ? String(entry.content || '').match(/\[META:(\{[\s\S]*?\})\]/) : null;
      try { return m ? JSON.parse(m[1]).ttl : null; } catch (_) { return null; }
    };
    const ttlSmall = await store(apiSmall, cS, chS);
    const ttlLarge = await store(apiLarge, cL, chL);
    check('memory_preset_changes_stored_ttl', ttlSmall !== null && ttlLarge !== null && ttlSmall !== ttlLarge,
      { ttlSmall, ttlLarge, note: 'ttl derives from the preset threshold' });
  }
  {
    // hme_graph_debug: 'full' must emit a record into the runtime trace; 'off' must not.
    // Observed via the product's own reader (getRuntimeRecords) rather than by patching
    // the frozen DebugExportManager.
    const countGraphRecords = (api, char, chat) => {
      const scopeKey = api.MemoryState?._activeScopeKey || api.MemoryState?._activeChatId || '';
      let records = [];
      try {
        records = api.DebugExportManager?.getRuntimeRecords
          ? api.DebugExportManager.getRuntimeRecords(scopeKey)
          : [];
      } catch (_) { records = []; }
      const blob = JSON.stringify(records || []);
      return (blob.match(/hme-graph-recall/g) || []).length;
    };
    const runRecall = async (level) => {
      const { api, char, chat } = await load({ hme_graph_debug: level, debug: 'true' });
      const ME = api.MemoryEngine;
      ME.setTurn(7);
      const lore = [];
      ME.setLorebook(char, chat, lore);
      try { await ME.retrieveMemories('별핵 조사 진행 상황', 7, [], { scopeKey: 'e2e' }, 2); } catch (_) {}
      try { await ME.retrieveMemories('별핵 조사 진행 상황', 7, [], { scopeKey: 'e2e' }, 2); } catch (_) {}
      return countGraphRecords(api, char, chat);
    };
    const onCount = await runRecall('full');
    const offCount = await runRecall('off');
    check('hme_graph_debug_emits_record_when_enabled', onCount > 0, { onCount });
    check('hme_graph_debug_stays_silent_when_off', offCount === 0, { offCount });
  }

  const failed = assertions.filter(item => !item.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, assertions }, null, 2));
  if (failed.length) process.exit(1);
})().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error), stack: error?.stack || '', assertions }, null, 2));
  process.exit(1);
});
