'use strict';
// RisuAI rebuilds a plugin's arguments from its header on every update or re-import, so a value kept
// there is lost. Settings belong in pluginStorage, which also travels with a RisuAI backup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

// Only settings with no screen of their own may stay declared as plugin arguments.
const allowedArguments = {
  'Flashback_Memory.js': [],
  'GRADIA.js': [],
  'RETRACE.js': [],
  'LIA_Persona_Linker.js': ['max_lore_entries'],
  'LIBRA.js': ['evidence_link_index_enabled', 'lore_link_index_enabled'],
  'HAYAKU_Locator_Continuity.js': ['hayaku_recall_short_max_age', 'hayaku_recall_medium_max_age', 'hayaku_recall_short_turn_quota', 'hayaku_recall_medium_turn_quota', 'hayaku_recall_long_turn_quota'],
};
for (const [file, allowed] of Object.entries(allowedArguments)) {
  const text = fs.readFileSync(path.join(root, 'plugins', file), 'utf8');
  const declared = [...text.matchAll(/^\/\/@arg\s+(\S+)/gm)].map(match => match[1]);
  assert.deepEqual(declared.sort(), [...allowed].sort(), `${file} declares only settings with no screen of their own`);
}

const memoryStore = () => {
  const map = new Map();
  return { map,
    async getItem(key) { return map.has(key) ? map.get(key) : null; },
    async setItem(key, value) { map.set(key, value); return true; },
    async removeItem(key) { map.delete(key); return true; },
    async keys() { return [...map.keys()]; } };
};

(async () => {
  const previous = globalThis.risuai;
  try {
    for (const source of ['MemorySuiteStorageClient.source.js', 'MemorySuiteStorageClient.libra.source.js', 'MemorySuiteStorageClient.flashback.source.js']) {
      const args = {};
      globalThis.risuai = {
        async getArgument(name) { return args[name] || ''; },
        async setArgument(name, value) { args[name] = String(value); return true; },
        async nativeFetch() { throw new Error('no network in this test'); },
      };
      const create = new Function(`${fs.readFileSync(path.join(root, 'sdk', source), 'utf8')}\nreturn createMemorySuiteStorageBridge;`)();
      const legacy = memoryStore();
      const bridge = create({ namespace: 'hayaku', pluginId: 'hayaku', pluginVersion: '1.0.0', pluginPrefixes: ['t:'], managementButton: false, migrationDelayMs: 100000,
        currentScopeProvider: async () => ({ scopeId: 'a', scopeKey: 'a', label: 'A' }) });
      bridge.createPluginStorageProxy(legacy);
      const url = 'http://127.0.0.1:47699';
      await bridge.setServerUrl(url);
      assert.equal(legacy.map.get('__memory_suite_internal_server_url_v1__:hayaku'), url, `${source}: the address is saved in pluginStorage`);
      assert.equal(args.memory_suite_server_url, undefined, `${source}: the address is not written to a plugin argument`);
      for (const key of Object.keys(args)) delete args[key];
      assert.equal((await bridge.getConnectionSettings({ force: true })).url, url, `${source}: the address survives a plugin update`);
      await bridge.dispose?.();
    }
  } finally {
    globalThis.risuai = previous;
  }
  console.log('settings_survive_plugin_update_test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
