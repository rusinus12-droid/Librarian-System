'use strict';
/**
 * RisuAI Contract-Backed Host Adapter
 *
 * Implements the observable host primitives extracted from the pinned RisuAI upstream
 * commit (`ea61945f9038e0189807d075f55f4e66ab7e98bf`) and reviewed in `PROGRAM/contracts/risuai/`:
 * - Enforces `api-surface.json`: any call to an unmapped RisuAI API fails with `UNMAPPED_RISUAI_API_CALL`
 * - Enforces `storage-contract.json`:
 *   - `pluginStorage`: async JSON-serializable storage (`JSON.stringify` / `JSON.parse`), null on missing key,
 *     reserved keys (`_coldpluginIndex`, `_coldplugin`) protected
 *   - `safeLocalStorage`: async string-only storage under `safe_plugin_` prefix
 *   - `getLocalPluginStorage()`: returns a fresh remote proxy (`__classType: 'REMOTE_REQUIRED'`) per call
 * - Enforces `ipc-contract.json`:
 *   - `addPluginChannelListener`: registers listener under `plugin.name + channelName` and unregisters on `onUnload`
 *   - `postPluginChannelMessage`: requires receiver exists, receiver `allowedIPC` includes sender, and sender `allowedIPC`
 *     includes receiver; delivers `(message, { sender, channel })`
 * - Enforces `plugin-loader-contract.json`:
 *   - Parses `//@name`, `//@api 3.0`, `//@version` (<= 500 bytes), `//@arg`, `//@allowed-ipc`
 * - Does NOT own storage authority (`plugin_only` vs `server_only`): provides only raw host primitives
 *   while Librarian Storage SDK owns storage routing and authority.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadCompatibilityPack, parsePluginHeader } = require('./risu_contract_verifier.cjs');

const URL_BLACKLIST = Object.freeze(['risuai.xyz', 'risuai.net', 'sionyw.com']);
const ALLOWED_DB_KEYS = Object.freeze([
  'characters', 'modules', 'enabledModules', 'moduleIntergration', 'pluginV2', 'personas',
  'plugins', 'pluginCustomStorage', 'temperature', 'askRemoval', 'maxContext', 'maxResponse',
  'frequencyPenalty', 'PresensePenalty', 'theme', 'textTheme', 'lineHeight',
  'seperateModelsForAxModels', 'seperateModels', 'customCSS', 'guiHTML', 'colorSchemeName',
  'selectedPersona', 'characterOrder'
]);
const RESERVED_STORAGE_KEYS = new Set(['_coldpluginIndex', '_coldplugin']);

const SAFE_INSPECTION_PROPS = new Set([
  'then', 'catch', 'finally', 'toString', 'valueOf', 'toJSON', 'constructor',
  '__esModule', 'Symbol(Symbol.toStringTag)', 'Symbol(Symbol.iterator)',
  'Symbol(nodejs.util.inspect.custom)'
]);

function cloneSnapshot(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function createContractPluginStorage(options = {}) {
  const entries = new Map();
  const operations = {
    reads: [],
    writes: [],
    removes: [],
    clears: 0
  };

  for (const [k, v] of Object.entries(options.initialEntries || {})) {
    entries.set(String(k), JSON.stringify(v) ?? 'null');
  }

  const store = {
    __entries: entries,
    __operations: operations,
    get map() {
      const m = new Map();
      for (const [k, raw] of entries.entries()) {
        try { m.set(k, JSON.parse(raw)); } catch (_) { m.set(k, raw); }
      }
      return m;
    },
    async getItem(key) {
      const k = String(key);
      operations.reads.push(k);
      if (RESERVED_STORAGE_KEYS.has(k) || !entries.has(k)) return null;
      return JSON.parse(entries.get(k));
    },
    async setItem(key, value) {
      const k = String(key);
      if (typeof options.onBeforeWrite === 'function') {
        await options.onBeforeWrite(k, value);
      }
      // Match PluginStorageStore.setItem: JSON.stringify(value) ?? 'null' (throws on BigInt/circular)
      const json = JSON.stringify(value) ?? 'null';
      entries.set(k, json);
      operations.writes.push({ key: k, bytes: Buffer.byteLength(json, 'utf8'), at: Date.now() });
      return true;
    },
    async removeItem(key) {
      const k = String(key);
      entries.delete(k);
      operations.removes.push(k);
      return true;
    },
    async clear() {
      entries.clear();
      operations.clears += 1;
      return true;
    },
    async keys() {
      return [...entries.keys()].filter(k => !RESERVED_STORAGE_KEYS.has(k));
    },
    async key(index) {
      const allKeys = await store.keys();
      return allKeys[index] ?? null;
    },
    async length() {
      const allKeys = await store.keys();
      return allKeys.length;
    }
  };

  return store;
}

function createContractSafeLocalStorage() {
  const rawStorage = new Map();
  const PREFIX = 'safe_plugin_';
  const api = {
    __raw: rawStorage,
    async getItem(key) {
      const fullKey = `${PREFIX}${String(key)}`;
      return rawStorage.has(fullKey) ? rawStorage.get(fullKey) : null;
    },
    async setItem(key, value) {
      const fullKey = `${PREFIX}${String(key)}`;
      rawStorage.set(fullKey, String(value));
    },
    async removeItem(key) {
      const fullKey = `${PREFIX}${String(key)}`;
      rawStorage.delete(fullKey);
    },
    async keys() {
      const out = [];
      for (const k of rawStorage.keys()) {
        if (k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
      }
      return out;
    },
    async key(index) {
      const all = await api.keys();
      return all[index] || null;
    },
    async clear() {
      const all = await api.keys();
      for (const k of all) await api.removeItem(k);
    },
    async length() {
      const all = await api.keys();
      return all.length;
    }
  };
  return api;
}

function createContractLocalPluginStorageFactory() {
  const backingForage = new Map();
  const PREFIX = 'safe_plugin_';
  return {
    __backingForage: backingForage,
    createProxyInstance() {
      // Every getLocalPluginStorage() call in RisuAI v3 returns a fresh SafeLocalPluginStorage instance
      return {
        __classType: 'REMOTE_REQUIRED',
        async getItem(key) {
          const fullKey = `${PREFIX}${String(key)}`;
          if (!backingForage.has(fullKey)) return null;
          return cloneSnapshot(backingForage.get(fullKey));
        },
        async setItem(key, value) {
          const fullKey = `${PREFIX}${String(key)}`;
          const json = JSON.stringify(value) ?? 'null';
          backingForage.set(fullKey, JSON.parse(json));
        },
        async removeItem(key) {
          const fullKey = `${PREFIX}${String(key)}`;
          backingForage.delete(fullKey);
        },
        async keys() {
          const out = [];
          for (const k of backingForage.keys()) {
            if (k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
          }
          return out;
        },
        async clear() {
          for (const k of [...backingForage.keys()]) {
            if (k.startsWith(PREFIX)) backingForage.delete(k);
          }
        }
      };
    }
  };
}

function parseDefaultArgValuesFromSource(src, parsedHeader) {
  const realArg = {};
  for (const [k, type] of Object.entries(parsedHeader.arguments || {})) {
    const desc = parsedHeader.argMeta?.[k]?.description || '';
    const blankMatch = /blank uses ([^;.\n]+)/i.exec(desc);
    if (blankMatch) {
      const rawVal = blankMatch[1].trim();
      realArg[k] = type === 'int' ? Number(rawVal) : rawVal;
    } else {
      realArg[k] = type === 'int' ? 0 : '';
    }
  }
  return realArg;
}

function createContractBackedHostCluster(options = {}) {
  const pack = options.compatibilityPack || loadCompatibilityPack(options.contractsDir);
  const contractedApiNames = new Set(Object.keys(pack.apiSurface.apis || {}));
  const fullHostSurfaceNames = new Set(Object.keys(pack.apiSurface.hostSurface || pack.apiSurface.apis || {}));
  const allowlistedProbeNames = new Set(Object.keys(pack.apiSurface.allowlistedOptionalProbes || {}));
  const strictContractedOnly = options.strictContractedOnly !== false;

  const pluginStorage = options.pluginStorage || createContractPluginStorage(options.storageOptions);
  const safeLocalStorage = options.safeLocalStorage || createContractSafeLocalStorage();
  const localPluginStorageFactory = createContractLocalPluginStorageFactory();

  const pluginChannel = new Map();
  const pluginUnloadCallbacks = new Map();
  const registeredPlugins = new Map();
  const ipcMessages = [];
  const ipcWarnings = [];
  const unmappedApiCalls = [];

  const defaultChat = options.initialChat || {
    id: 'contract-host-chat-0',
    chatId: 'contract-host-chat-0',
    name: 'chat-0',
    message: [
      { role: 'user', chatId: 'u-1', data: 'Synthetic user message 1' },
      { role: 'assistant', chatId: 'a-1', data: 'Synthetic assistant message 1' }
    ]
  };
  if (!defaultChat.messages) defaultChat.messages = defaultChat.message;

  const defaultCharacter = options.initialCharacter || {
    id: 'contract-host-char-0',
    chaId: 'contract-host-char-0',
    name: 'Contract Host Character',
    description: 'Synthetic character for contract-backed host',
    chatPage: 0,
    chats: [defaultChat],
    chat: defaultChat,
    globalLore: []
  };

  const dbState = {
    characters: options.characters || [defaultCharacter],
    modules: [],
    enabledModules: [],
    personas: options.personas || [{ id: 'persona-0', name: 'Synthetic User', personaPrompt: 'Synthetic persona', icon: '' }],
    selectedPersona: 0,
    plugins: [],
    pluginCustomStorage: {},
    colorSchemeName: 'dark',
    colorScheme: { bgcolor: '#111', darkbg: '#000', borderc: '#333', selected: '#444', draculared: '#f00', textcolor: '#eee', textcolor2: '#ccc', darkBorderc: '#222', darkbutton: '#222', type: 'dark' },
    textTheme: 'standard',
    customTextTheme: {}
  };

  let selectedCharID = 0;
  let uiCounter = 0;
  const nextUiId = () => `uipart_${++uiCounter}`;

  const menuStores = {
    settings: [],
    action: [],
    hamburger: [],
    chat: [],
    panels: [],
    bodyIntercepters: []
  };

  const hooks = {
    chatOutput: new Set(),
    replacerbeforeRequest: new Set(),
    replacerafterRequest: new Set(),
    editdisplay: new Set(),
    editoutput: new Set(),
    editprocess: new Set(),
    editinput: new Set(),
    ttsPre: new Set(),
    ttsPost: new Set()
  };

  function addPluginUnloadCallback(pluginName, fn) {
    if (!pluginUnloadCallbacks.has(pluginName)) {
      pluginUnloadCallbacks.set(pluginName, []);
    }
    pluginUnloadCallbacks.get(pluginName).push(fn);
  }

  function registerPluginMeta(pluginMeta) {
    const entry = {
      name: pluginMeta.name,
      displayName: pluginMeta.displayName,
      version: '3.0',
      versionOfPlugin: pluginMeta.versionOfPlugin || '1.0.0',
      arguments: pluginMeta.arguments || {},
      realArg: { ...(pluginMeta.realArg || {}) },
      argMeta: pluginMeta.argMeta || {},
      customLink: pluginMeta.customLink || [],
      updateURL: pluginMeta.updateURL || '',
      allowedIPC: [...(pluginMeta.allowedIPC || [])],
      enabled: true
    };
    registeredPlugins.set(entry.name, entry);
    const existingIdx = dbState.plugins.findIndex(p => p.name === entry.name);
    if (existingIdx >= 0) dbState.plugins[existingIdx] = entry;
    else dbState.plugins.push(entry);
    return entry;
  }

  function createHostForPlugin(pluginInput = {}) {
    let header = pluginInput.header || null;
    if (!header && pluginInput.sourceText) {
      header = parsePluginHeader(pluginInput.sourceText, pluginInput.filename || 'plugin.js');
    }
    if (!header) {
      header = {
        name: pluginInput.name || 'anonymous_plugin',
        apiVersion: '3.0',
        versionOfPlugin: pluginInput.version || '1.0.0',
        arguments: {},
        argMeta: {},
        customLink: [],
        allowedIPC: pluginInput.allowedIPC || []
      };
    }

    const defaultRealArg = pluginInput.sourceText
      ? parseDefaultArgValuesFromSource(pluginInput.sourceText, header)
      : {};
    const pluginEntry = registerPluginMeta({
      ...header,
      realArg: { ...defaultRealArg, ...(pluginInput.argumentOverrides || {}) }
    });

    const record = {
      pluginName: pluginEntry.name,
      hooks: { chatListeners: [], replacers: [], scriptHandlers: [], ttsPre: 0, ttsPost: 0 },
      ui: { settings: [], buttons: [], unregistered: [] },
      ipc: { channels: [], sent: [] },
      network: { nativeFetch: 0, risuFetch: 0, urls: [] },
      llm: { calls: 0, requests: [], lastMessages: null },
      providers: [],
      mcps: [],
      consoleErrors: [],
      unmappedCalls: []
    };

    const checkUrlBlacklist = (url) => {
      const lower = String(url || '').toLowerCase();
      for (const blocked of URL_BLACKLIST) {
        if (lower.includes(blocked)) {
          throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
        }
      }
    };

    const defaultFetchImpl = async (url, opts) => {
      if (typeof options.fetchImpl === 'function') {
        return await options.fetchImpl(url, opts, pluginEntry.name);
      }
      const err = new Error('network blocked by contract host');
      err.code = 'HARNESS_NET_BLOCKED';
      throw err;
    };

    const rawApi = {
      apiVersion: '3.0',
      apiVersionCompatibleWith: ['3.0'],

      getArgument: async (key) => {
        const k = String(key);
        return Object.prototype.hasOwnProperty.call(pluginEntry.realArg, k) ? pluginEntry.realArg[k] : undefined;
      },
      setArgument: async (key, value) => {
        pluginEntry.realArg[String(key)] = value;
      },
      getArg: async (arg) => {
        const str = String(arg);
        const key = str.includes('::') ? str.split('::')[1] : str;
        return Object.prototype.hasOwnProperty.call(pluginEntry.realArg, key) ? pluginEntry.realArg[key] : undefined;
      },
      setArg: async (arg, value) => {
        const str = String(arg);
        const key = str.includes('::') ? str.split('::')[1] : str;
        pluginEntry.realArg[key] = value;
      },

      pluginStorage,
      safeLocalStorage,
      getLocalPluginStorage: async () => localPluginStorageFactory.createProxyInstance(),

      addRisuChatListener: async (mode, func) => {
        if (mode !== 'output') throw new Error(`chat listener mode ${mode} not found`);
        if (options.denyPermissions?.includes('replacer')) return;
        hooks.chatOutput.add(func);
        record.hooks.chatListeners.push(String(mode));
        addPluginUnloadCallback(pluginEntry.name, () => hooks.chatOutput.delete(func));
      },
      removeRisuChatListener: async (mode, func) => {
        if (mode !== 'output') throw new Error(`chat listener mode ${mode} not found`);
        hooks.chatOutput.delete(func);
      },

      addRisuReplacer: async (name, func) => {
        if (!hooks['replacer' + name]) throw new Error(`replacer handler named ${name} not found`);
        if (options.denyPermissions?.includes('replacer')) return;
        hooks['replacer' + name].add(func);
        record.hooks.replacers.push(String(name));
        addPluginUnloadCallback(pluginEntry.name, () => hooks['replacer' + name].delete(func));
      },
      removeRisuReplacer: async (name, func) => {
        if (!hooks['replacer' + name]) throw new Error(`replacer handler named ${name} not found`);
        hooks['replacer' + name].delete(func);
      },

      addRisuScriptHandler: async (mode, func) => {
        if (!hooks['edit' + mode]) throw new Error(`script handler named ${mode} not found`);
        hooks['edit' + mode].add(func);
        record.hooks.scriptHandlers.push(String(mode));
      },
      removeRisuScriptHandler: async (mode, func) => {
        if (!hooks['edit' + mode]) throw new Error(`script handler named ${mode} not found`);
        hooks['edit' + mode].delete(func);
      },

      addTTSPreprocessor: async (func) => {
        hooks.ttsPre.add(func);
        record.hooks.ttsPre += 1;
        addPluginUnloadCallback(pluginEntry.name, () => hooks.ttsPre.delete(func));
      },
      addTTSPostprocessor: async (func) => {
        hooks.ttsPost.add(func);
        record.hooks.ttsPost += 1;
        addPluginUnloadCallback(pluginEntry.name, () => hooks.ttsPost.delete(func));
      },

      registerSetting: async (name, callback, icon = '', iconType = 'none', providedId) => {
        const effectiveIconType = iconType || 'none';
        if (!['html', 'img', 'none'].includes(effectiveIconType)) {
          throw new Error("iconType must be 'html', 'img' or 'none'");
        }
        const id = providedId || nextUiId();
        const def = { id, name: String(name || ''), icon: String(icon || ''), iconType: effectiveIconType, callback };
        const existingIdx = menuStores.settings.findIndex(item => item.id === id);
        if (existingIdx !== -1) menuStores.settings[existingIdx] = def;
        else menuStores.settings.push(def);
        record.ui.settings.push({ name: def.name, id });
        addPluginUnloadCallback(pluginEntry.name, () => {
          const idx = menuStores.settings.findIndex(item => item.id === id);
          if (idx !== -1) menuStores.settings.splice(idx, 1);
        });
        return { id };
      },

      registerButton: async (arg, callback) => {
        const opts = arg || {};
        const name = opts.name;
        const icon = opts.icon ?? '';
        const iconType = opts.iconType || 'none';
        const location = opts.location || 'action';
        if (!['html', 'img', 'none'].includes(iconType)) {
          throw new Error("iconType must be 'html', 'img' or 'none'");
        }
        if (typeof name !== 'string' || name.trim() === '') {
          throw new Error('name must be a non-empty string');
        }
        if (!['action', 'hamburger', 'chat'].includes(location)) {
          throw new Error('Invalid location for button');
        }
        const id = opts.id || nextUiId();
        const def = { id, name, icon: String(icon), iconType, callback };
        let replaced = false;
        for (const storeName of ['action', 'hamburger', 'chat']) {
          const idx = menuStores[storeName].findIndex(item => item.id === id);
          if (idx !== -1) {
            menuStores[storeName][idx] = def;
            replaced = true;
            break;
          }
        }
        if (!replaced) {
          menuStores[location].push(def);
        }
        record.ui.buttons.push({ name, id, location });
        addPluginUnloadCallback(pluginEntry.name, () => {
          for (const storeName of ['action', 'hamburger', 'chat']) {
            const idx = menuStores[storeName].findIndex(item => item.id === id);
            if (idx !== -1) menuStores[storeName].splice(idx, 1);
          }
        });
        return { id };
      },

      unregisterUIPart: async (id) => {
        const targetId = String(id);
        record.ui.unregistered.push(targetId);
        for (const storeName of ['settings', 'action', 'hamburger', 'chat', 'panels']) {
          const idx = menuStores[storeName].findIndex(item => item.id === targetId);
          if (idx !== -1) menuStores[storeName].splice(idx, 1);
        }
      },

      showContainer: async () => {},
      hideContainer: async () => {},

      onUnload: async (callback) => {
        if (typeof callback === 'function') {
          addPluginUnloadCallback(pluginEntry.name, callback);
        }
      },

      loadPlugins: async () => {},

      addPluginChannelListener: async (channelName, callback) => {
        const key = `${pluginEntry.name}${String(channelName)}`;
        pluginChannel.set(key, callback);
        record.ipc.channels.push(String(channelName));
        addPluginUnloadCallback(pluginEntry.name, () => {
          pluginChannel.delete(key);
        });
      },

      postPluginChannelMessage: async (targetPluginName, channelName, message) => {
        const currentPluginName = pluginEntry.name;
        const receiverPlugin = dbState.plugins.find(p => p.name === targetPluginName);
        if (!receiverPlugin) {
          ipcWarnings.push({
            code: 'IPC_RECEIVER_NOT_FOUND',
            sender: currentPluginName,
            receiver: targetPluginName,
            channel: channelName
          });
          return;
        }
        if (!receiverPlugin.allowedIPC?.includes(currentPluginName)) {
          ipcWarnings.push({
            code: 'IPC_ALLOWED_IPC_MISMATCH',
            reason: 'receiver_does_not_allow_sender',
            sender: currentPluginName,
            receiver: targetPluginName,
            channel: channelName
          });
          return;
        }
        if (!pluginEntry.allowedIPC?.includes(receiverPlugin.name)) {
          ipcWarnings.push({
            code: 'IPC_ALLOWED_IPC_MISMATCH',
            reason: 'sender_does_not_allow_receiver',
            sender: currentPluginName,
            receiver: targetPluginName,
            channel: channelName
          });
          return;
        }

        const clonedMsg = cloneSnapshot(message);
        ipcMessages.push({
          sender: currentPluginName,
          receiver: targetPluginName,
          channel: channelName,
          message: clonedMsg
        });
        record.ipc.sent.push({ target: targetPluginName, channel: channelName });

        const callback = pluginChannel.get(`${targetPluginName}${channelName}`);
        if (callback) {
          await callback(clonedMsg, {
            sender: currentPluginName,
            channel: channelName
          });
        }
      },

      nativeFetch: async (url, opts) => {
        checkUrlBlacklist(url);
        record.network.nativeFetch += 1;
        record.network.urls.push(String(url));
        return await defaultFetchImpl(url, opts);
      },

      risuFetch: async (url, opts) => {
        checkUrlBlacklist(url);
        record.network.risuFetch += 1;
        record.network.urls.push(String(url));
        return await defaultFetchImpl(url, opts);
      },

      runLLMModel: async (req) => {
        record.llm.calls += 1;
        record.llm.requests.push(cloneSnapshot(req));
        record.llm.lastMessages = Array.isArray(req?.messages) ? req.messages.length : null;
        if (typeof options.llmHandler === 'function') {
          return await options.llmHandler(req, pluginEntry.name);
        }
        return {
          type: 'success',
          result: '[[HARNESS_FAKE_LLM_OUTPUT]]',
          content: '[[HARNESS_FAKE_LLM_OUTPUT]]',
          model: 'contract-host-model',
          usage: null,
          finishReason: 'stop'
        };
      },

      getRuntimeInfo: async () => ({
        apiVersion: '3.0',
        platform: options.platform || 'node',
        saveMethod: options.saveMethod || 'local'
      }),

      getCharacter: async () => {
        const char = dbState.characters[selectedCharID];
        return char ? cloneSnapshot(char) : null;
      },
      getChar: async () => {
        const char = dbState.characters[selectedCharID];
        return char ? cloneSnapshot(char) : null;
      },
      setCharacter: async (char) => {
        dbState.characters[selectedCharID] = cloneSnapshot(char);
      },
      setChar: async (char) => {
        dbState.characters[selectedCharID] = cloneSnapshot(char);
      },
      getCharacterFromIndex: async (index) => {
        const char = dbState.characters[index];
        return char ? cloneSnapshot(char) : null;
      },
      setCharacterToIndex: async (index, char) => {
        if (dbState.characters[index]) {
          dbState.characters[index] = cloneSnapshot(char);
        }
      },
      getCurrentCharacterIndex: async () => selectedCharID,
      getCurrentChatIndex: async () => {
        const char = dbState.characters[selectedCharID];
        return char ? (char.chatPage ?? 0) : 0;
      },
      getChatFromIndex: async (characterIndex, chatIndex) => {
        const char = dbState.characters[characterIndex];
        const chat = char?.chats?.[chatIndex];
        return chat ? cloneSnapshot(chat) : null;
      },
      setChatToIndex: async (characterIndex, chatIndex, chat) => {
        const char = dbState.characters[characterIndex];
        if (char?.chats?.[chatIndex]) {
          char.chats[chatIndex] = cloneSnapshot(chat);
        }
      },
      getDatabase: async (includeOnly = 'all') => {
        if (options.databaseConsent === false || options.denyPermissions?.includes('db')) {
          return null;
        }
        const liteDB = {};
        for (const key of ALLOWED_DB_KEYS) {
          if (includeOnly !== 'all' && Array.isArray(includeOnly) && !includeOnly.includes(key)) {
            continue;
          }
          if (dbState[key] !== undefined) {
            liteDB[key] = cloneSnapshot(dbState[key]);
          }
        }
        return liteDB;
      },
      setDatabase: async (newDb) => {
        if (!newDb || typeof newDb !== 'object') return;
        for (const key of Object.keys(newDb)) {
          if (key === 'plugins') continue;
          if (ALLOWED_DB_KEYS.includes(key)) {
            dbState[key] = cloneSnapshot(newDb[key]);
          }
        }
      },
      setDatabaseLite: async (newDb) => {
        if (!newDb || typeof newDb !== 'object') return;
        for (const key of Object.keys(newDb)) {
          if (key === 'plugins') continue;
          if (ALLOWED_DB_KEYS.includes(key)) {
            dbState[key] = cloneSnapshot(newDb[key]);
          }
        }
      },
      getRootDocument: async () => {
        if (options.mainDomConsent !== true) return null;
        return options.safeDocument || null;
      },
      createMutationObserver: async () => ({
        observe: async () => {},
        disconnect: async () => {}
      }),
      addProvider: async (name) => {
        record.providers.push(String(name));
      },
      registerMCP: async (meta) => {
        record.mcps.push(meta?.identifier || '');
      },
      unregisterMCP: async () => {},
      registerBodyIntercepter: async (callback) => {
        if (options.denyPermissions?.includes('replacer')) return null;
        const id = nextUiId();
        menuStores.bodyIntercepters.push({ id, callback });
        addPluginUnloadCallback(pluginEntry.name, () => {
          const idx = menuStores.bodyIntercepters.findIndex(item => item.id === id);
          if (idx !== -1) menuStores.bodyIntercepters.splice(idx, 1);
        });
        return { id };
      },
      unregisterBodyIntercepter: async (id) => {
        const idx = menuStores.bodyIntercepters.findIndex(item => item.id === id);
        if (idx !== -1) menuStores.bodyIntercepters.splice(idx, 1);
      },
      requestPluginPermission: async (permission) => {
        if (options.denyPermissions?.includes(permission)) return false;
        return true;
      },
      getFetchLogs: async () => [],
      readImage: async () => null,
      readInlay: async () => null,
      saveAsset: async () => 'assets/synthetic.bin',
      unwarpSafeArray: async (arr) => (Array.isArray(arr) ? arr : []),
      searchTranslationCache: async () => [],
      getTranslationCache: async () => null,
      changeColorScheme: async () => {},
      getColorScheme: async () => ({ name: dbState.colorSchemeName, scheme: cloneSnapshot(dbState.colorScheme) }),
      setColorScheme: async (scheme) => { dbState.colorScheme = cloneSnapshot(scheme); },
      changeTextTheme: async () => {},
      getTextTheme: async () => ({ name: dbState.textTheme, customTheme: cloneSnapshot(dbState.customTextTheme) }),
      setCustomTextTheme: async (theme) => { dbState.customTextTheme = cloneSnapshot(theme); },
      alertError: async () => {},
      alert: async () => {},
      alertConfirm: async () => true,
      log: async () => {},
      checkCharOrder: async () => {},
      getCurrentLorebookEntries: async () => [],
      parseRisuChat: async (text) => String(text ?? ''),
      sendChat: async () => true,
      saveSecretHeader: async () => {},
      setChatPanel: async (content, opts = {}) => ({ id: opts.id || `${pluginEntry.name}:default` })
    };

    const proxyApi = new Proxy(rawApi, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') {
          return Reflect.get(target, prop, receiver);
        }
        const propName = String(prop);
        if (SAFE_INSPECTION_PROPS.has(propName)) {
          return Reflect.get(target, prop, receiver);
        }
        // Allow optional probes to return undefined cleanly when probed via `typeof api?.X === 'function'`
        if (allowlistedProbeNames.has(propName)) {
          return undefined;
        }
        const isMapped = strictContractedOnly
          ? contractedApiNames.has(propName)
          : fullHostSurfaceNames.has(propName);

        if (!isMapped) {
          const err = new Error(`UNMAPPED_RISUAI_API_CALL: Plugin '${pluginEntry.name}' accessed unmapped RisuAI API '${propName}'`);
          err.code = 'UNMAPPED_RISUAI_API_CALL';
          err.pluginName = pluginEntry.name;
          err.apiName = propName;
          record.unmappedCalls.push(propName);
          unmappedApiCalls.push({ pluginName: pluginEntry.name, apiName: propName });
          throw err;
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    return {
      api: proxyApi,
      pluginEntry,
      record,
      async unload() {
        const callbacks = pluginUnloadCallbacks.get(pluginEntry.name) || [];
        pluginUnloadCallbacks.delete(pluginEntry.name);
        for (const cb of callbacks) {
          await cb();
        }
      }
    };
  }

  async function dispatchChatOutputEvent({ characterIndex = 0, chatIndex = 0, messageIndex = -1 } = {}) {
    const charSnapshot = cloneSnapshot(dbState.characters[characterIndex]);
    const chatSnapshot = cloneSnapshot(charSnapshot?.chats?.[chatIndex]);
    for (const listener of [...hooks.chatOutput]) {
      // Every listener receives an isolated snapshot copy per RisuAI v3 contract
      await listener({
        char: cloneSnapshot(charSnapshot),
        chat: cloneSnapshot(chatSnapshot),
        characterIndex,
        chatIndex,
        messageIndex
      });
    }
  }

  return {
    pack,
    dbState,
    pluginStorage,
    safeLocalStorage,
    localPluginStorageFactory,
    pluginChannel,
    registeredPlugins,
    ipcMessages,
    ipcWarnings,
    unmappedApiCalls,
    hooks,
    menuStores,
    registerPluginMeta,
    createHostForPlugin,
    dispatchChatOutputEvent,
    setSelectedCharacterIndex(idx) { selectedCharID = idx; }
  };
}

module.exports = {
  URL_BLACKLIST,
  ALLOWED_DB_KEYS,
  RESERVED_STORAGE_KEYS,
  cloneSnapshot,
  createContractPluginStorage,
  createContractSafeLocalStorage,
  createContractLocalPluginStorageFactory,
  createContractBackedHostCluster
};
