'use strict';
// Release-artifact verification for the MINIFIED deployment bundle.
//
// The whole regression suite reads `LIBRA World Manager Full.js` (the readable build).
// The file users actually download is `LIBRA World Manager.js`, so without this gate a
// broken minification (or the silent unminified fallback) ships unverified.
//
// Asserts:
//   1. The minified artifact is genuinely minified (not the unminified fallback).
//   2. The plugin header RisuAI parses survives minification (every //@arg + metadata).
//   3. Both artifacts retain matching plugin identity/version and readable provenance.
//   4. The minified bundle evaluates, registers handlers, and answers a recall.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const MIN_PATH = path.join(ROOT, 'dist', 'LIBRA World Manager.js');
const FULL_PATH = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
const assertions = [];
const check = (name, ok, detail = null) => {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

(async () => {
  const minCode = fs.readFileSync(MIN_PATH, 'utf8');
  const fullCode = fs.readFileSync(FULL_PATH, 'utf8');
  const minBytes = Buffer.byteLength(minCode, 'utf8');
  const fullBytes = Buffer.byteLength(fullCode, 'utf8');

  // ── 1. Genuinely minified, not the silent fallback ─────────────────────────
  // The fallback path writes the readable bundle verbatim (+ a trailing newline), so
  // "minified == full" is the exact signature of the fallback.
  const isFallback = minCode === fullCode || minCode === fullCode + '\n';
  check('minified_artifact_is_not_the_unminified_fallback', !isFallback,
    { minBytes, fullBytes, identical: minCode === fullCode });

  const ratio = minBytes / fullBytes;
  assertions.push({ name: 'minified_compression_ratio_recorded', ok: true,
    detail: { minBytes, fullBytes, ratio: Number(ratio.toFixed(4)), informational: true } });

  // Compression and comment counts depend on source mix; record rather than gate them.
  const fullCommentLines = (fullCode.match(/^\s*\/\/\s*[^\n]*$/gm) || []).length;
  const minCommentLines = (minCode.match(/^\s*\/\/\s*[^\n]*$/gm) || []).length;
  assertions.push({ name: 'minified_comment_counts_recorded', ok: true,
    detail: { fullCommentLines, minCommentLines, informational: true } });

  // ── 2. RisuAI-parsed header survives ───────────────────────────────────────
  const fullArgs = (fullCode.match(/^\/\/@arg\s+\S+/gm) || []).length;
  const minArgs = (minCode.match(/^\/\/@arg\s+\S+/gm) || []).length;
  check('all_arg_declarations_survive_minification', minArgs === fullArgs && minArgs > 0,
    { fullArgs, minArgs });

  for (const key of ['name', 'display-name', 'author', 'api', 'version', 'update-url']) {
    const re = new RegExp(`^//@${key}\\s+\\S`, 'm');
    check(`header_${key.replace(/-/g, '_')}_survives`, re.test(minCode),
      { key, found: (minCode.match(re) || [])[0] || null });
  }

  // The first line must remain the plugin name (RisuAI reads the header from the top).
  check('plugin_name_is_first_line', minCode.startsWith('//@name '),
    { firstLine: minCode.split('\n')[0] });

  // ── 3. Provenance: the vendored CBS source hashes live in a comment block ──
  // They are documentation, not runtime data, so minification legitimately drops them;
  // what matters is that the READABLE bundle still carries them (the audit trail) and
  // that the minified bundle is not silently missing runtime BEHAVIOUR.
  const fullHashes = (fullCode.match(/[0-9a-f]{64}/g) || []).length;
  check('readable_bundle_keeps_provenance_hashes', fullHashes > 0, { fullHashes });

  // Behavioural equivalent of a hash check: the minified bundle must contain the same
  // public plugin identifier the readable one declares (so the two artifacts are the
  // same plugin, not a stale pairing).
  const fullName = (fullCode.match(/^\/\/@name\s+(\S+)/m) || [])[1];
  const minName = (minCode.match(/^\/\/@name\s+(\S+)/m) || [])[1];
  const fullVersion = (fullCode.match(/^\/\/@version\s+(\S+)/m) || [])[1];
  const minVersion = (minCode.match(/^\/\/@version\s+(\S+)/m) || [])[1];
  check('artifacts_declare_the_same_plugin', fullName === minName && Boolean(minName), { fullName, minName });
  check('artifacts_declare_the_same_version', fullVersion === minVersion && Boolean(minVersion), { fullVersion, minVersion });

  // Provenance metadata that must NOT be lost: the vendored CBS reference hashes.
  // The minifier strips them, so assert they survive in the readable build and record
  // the minified count so a future config change that strips more is visible.
  const minHashes = (minCode.match(/[0-9a-f]{64}/g) || []).length;
  assertions.push({
    name: 'minified_provenance_hash_count_recorded',
    ok: true,
    detail: { fullHashes, minHashes, note: 'informational: terser drops the vendored-hash comment block' }
  });

  // ── 4. The minified bundle must actually RUN ───────────────────────────────
  const chat = { id: 'min-artifact', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'min-artifact-c', name: 'M', chats: [chat], globalLore: [], lorebook: [] };
  const args = new Map(Object.entries({ debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off' }));
  const replacers = { beforeRequest: [], afterRequest: [] };
  let handlerRegistrations = 0;
  const risuai = {
    async getArgument(n){ return args.get(n); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(){ return true; }, async setCharacter(){ return true; }, async getDatabase(){ return { personas: [] }; },
    async addRisuReplacer(type, handler){ (replacers[type] || (replacers[type] = [])).push(handler); handlerRegistrations += 1; return true; },
    async removeRisuReplacer(){ return true; },
    async addRisuScriptHandler(mode, handler){ handlerRegistrations += 1; return true; },
    async removeRisuScriptHandler(){ return true; },
    async registerBodyIntercepter(){ handlerRegistrations += 1; return 'x'; }, async unregisterBodyIntercepter(){ return true; },
    async onUnload(){ return true; }, async registerSetting(){ return true; }, async registerButton(){ return true; },
    async showContainer(){ return true; }, async hideContainer(){ return true; },
    pluginStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async nativeFetch(){ throw new Error('no fetch'); }
  };
  // Minified output has no newline before the final terminator, so match it directly.
  const close = minCode.lastIndexOf('})();');
  if (close < 0) throw new Error('minified bundle: closing IIFE not found');
  const instrumented = minCode.slice(0, close)
    + '\n;globalThis.__MIN_ARTIFACT_TEST__={MemoryEngine:typeof MemoryEngine!=="undefined"?MemoryEngine:null};\n'
    + minCode.slice(close);
  const context = {
    console: { log(){}, warn(){}, error(){}, debug(){} }, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('no fetch'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: t => Buffer.from(String(t), 'base64').toString('binary'), btoa: t => Buffer.from(String(t), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  const evalStart = performance.now();
  await vm.runInContext(instrumented, context, { filename: MIN_PATH, timeout: 20000 });
  await new Promise(r => setTimeout(r, 60));
  const evalMs = performance.now() - evalStart;

  const ME = context.__MIN_ARTIFACT_TEST__?.MemoryEngine;
  check('minified_bundle_exposes_runtime', Boolean(ME && typeof ME.retrieveMemories === 'function'),
    { hasEngine: Boolean(ME) });
  check('minified_bundle_registers_handlers', handlerRegistrations > 0, { handlerRegistrations });
  check('minified_bundle_registers_before_request', Array.isArray(replacers.beforeRequest) && replacers.beforeRequest.length > 0,
    { beforeRequest: replacers.beforeRequest.length });

  // Functional smoke on the minified artifact: store a memory and recall it.
  ME.setTurn(7);
  const lore = [];
  const now = Date.now();
  const mkEntry = (id, text, imp) => ({
    key: `lmai_memory::${id}`, comment: 'lmai_memory',
    content: `[META:${JSON.stringify({ t: 7, ttl: -1, imp, cat: 'event', ent: [], summary: text.slice(0, 40), s_id: 'min' })}] ${text}`
  });
  lore.push(mkEntry('a', '아리엘은 별핵 파편의 공명을 확인했다.', 8));
  lore.push(mkEntry('b', '도현은 관측 기록을 대조했다.', 3));
  ME.setLorebook(char, chat, lore);
  const entries = ME.getManagedEntries(lore);
  const out = await ME.retrieveMemories('별핵 파편 공명', 7, entries, { scopeKey: 'min' }, 5);
  check('minified_bundle_recall_returns_results', Array.isArray(out) && out.length > 0,
    { returned: Array.isArray(out) ? out.length : -1 });
  check('minified_bundle_recall_finds_the_matching_memory',
    (Array.isArray(out) ? out : []).some(item => String(item?.content || '').includes('아리엘은 별핵 파편')),
    { previews: (Array.isArray(out) ? out : []).map(i => String(i?.content || '').slice(-40)) });

  const failed = assertions.filter(item => !item.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    minBytes, fullBytes,
    savedBytes: fullBytes - minBytes,
    savedPercent: Number(((1 - ratio) * 100).toFixed(2)),
    minHeaderArgs: minArgs,
    evalMs: Number(evalMs.toFixed(1)),
    assertions
  }, null, 2));
  if (failed.length) process.exit(1);
})().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error), stack: error?.stack || '', assertions }, null, 2));
  process.exit(1);
});
