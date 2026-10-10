'use strict';
// LIBRA review-#1 forced-concurrency test: the GLOBAL scope registry
// (`libra:v1:scope-registry:v1`) was written from two UNLOCKED read-modify-writes
// (resolveStableScopeKey, markNativeCopySuppressed).
//
// Unlike the per-scope manifest, this registry is ONE global document holding an
// entry per chat. Two concurrent scope resolutions therefore both read the whole
// document, each add their own entry, and the second setJson drops the first — the
// lost chat then mints a NEW scope key on its next pass, splitting its canonical
// memories across two scopes (canonical memories appear to vanish).
//
// Method: evaluate the plugin's own source slice and expose `resolveStableScopeKey`
// — the same technique tests/fixtures/libra_state_race_fixture.cjs uses for the
// state pipeline. Two resolutions for DIFFERENT chats run together with the
// plugin's registry read held open, so the interleaving window is real.
//
//   both entries survive -> the write was serialized
//   both resolutions ran -> non-vacuous (cannot pass by doing nothing)
//
// RED: LIBRA_REGISTRY_RACE_PLUGIN_SOURCE=<pre-fix LIBRA.js> makes this FAIL.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const targetPath = process.env.LIBRA_REGISTRY_RACE_PLUGIN_SOURCE
  ? path.resolve(process.env.LIBRA_REGISTRY_RACE_PLUGIN_SOURCE)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(targetPath, 'utf8');

const READ_DELAY_MS = Number(process.env.LIBRA_REGISTRY_RACE_READ_DELAY_MS || 60);

const REGISTRY_KEY = 'libra:v1:scope-registry:v1';
const startMarker = 'const scopeRegistryIdentity =';
// End marker just past markNativeCopySuppressed (the second registry writer), so
// both unlocked read-modify-write sites are inside the evaluated slice.
const endMarker = 'const nativeCopyChatListSnapshot = async context =>';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'scope registry slice markers must exist');
const slice = source.slice(start, end);

const values = new Map();
let registryReads = 0;
// Barrier: hold concurrent registry reads until either two have arrived (the
// pre-fix interleaving) or a bounded wait expires (the serialized post-fix case,
// where the second reader never arrives because it is queued behind the tail).
// Each read returns the document as it existed when THAT read started, which is
// what makes a lost update detectable: two readers that both started from the same
// empty document will each write only their own entry.
const pendingReads = [];
const READ_BARRIER = 2;
const BARRIER_WAIT_MS = Number(process.env.LIBRA_REGISTRY_RACE_BARRIER_MS || 150);
let barrierArmed = true;
const rawStore = {
  async getItem(key) {
    const k = String(key);
    if (k === REGISTRY_KEY) {
      registryReads += 1;
      const snapshot = values.has(k) ? values.get(k) : null;
      if (barrierArmed) {
        let satisfied = false;
        await new Promise(resolve => {
          pendingReads.push(() => { satisfied = true; resolve(); });
          if (pendingReads.length >= READ_BARRIER) {
            for (const release of pendingReads.splice(0)) release();
          } else {
            setTimeout(() => {
              const index = pendingReads.indexOf(resolve);
              if (!satisfied) {
                const waiting = pendingReads.splice(0);
                for (const release of waiting) release();
              }
            }, BARRIER_WAIT_MS);
          }
        });
        // Disarm after the first wave so later re-reads never block.
        if (pendingReads.length === 0) barrierArmed = false;
      }
      return snapshot;
    }
    return values.has(k) ? values.get(k) : null;
  },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return Array.from(values.keys()); }
};
// The plugin's `storage` object wraps the raw store with JSON handling.
const storage = {
  async getJson(key, fallback = null) {
    const raw = await rawStore.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    try { return JSON.parse(String(raw)); } catch (_) { return fallback; }
  },
  async setJson(key, value) { return await rawStore.setItem(key, JSON.stringify(value)); },
  async keys() { return await rawStore.keys(); },
  async remove(key) { return await rawStore.removeItem(key); }
};

const nowIso = () => new Date().toISOString();
const string = value => String(value ?? '').trim();
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
class LIBRAError extends Error { constructor(message, code) { super(message); this.code = code; } }
const PREFIX = 'libra:v1';
const key = { scopeRegistry: () => REGISTRY_KEY };
const state = { disposed: false };

const context = vm.createContext({
  storage, nowIso, string, asObject, LIBRAError, PREFIX, key, state,
  stableDraftHash: value => `h${String(value).length}`,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, Promise, Set, Map, JSON, Object, Array, Number, Math, Error
});

vm.runInContext(
  `${slice}\nthis.resolveStableScopeKey = resolveStableScopeKey;\nthis.markNativeCopySuppressed = markNativeCopySuppressed;`,
  context,
  { filename: 'LIBRA-scope-registry-slice.js' }
);

(async () => {
  const resolveStableScopeKey = context.resolveStableScopeKey;
  const markNativeCopySuppressed = context.markNativeCopySuppressed;
  assert.equal(typeof resolveStableScopeKey, 'function', 'resolveStableScopeKey exposed from the slice');
  assert.equal(typeof markNativeCopySuppressed, 'function', 'markNativeCopySuppressed exposed from the slice');

  // Two DIFFERENT chats resolved concurrently.
  registryReads = 0;
  const settled = await Promise.allSettled([
    resolveStableScopeKey('character-1', 'chat-A', 'character-1:chat-A'),
    resolveStableScopeKey('character-1', 'chat-B', 'character-1:chat-B')
  ]);
  const failures = settled.filter(r => r.status === 'rejected')
    .map(r => String(r.reason && (r.reason.message || r.reason)));

  const registry = JSON.parse(values.get(REGISTRY_KEY) || '{}');
  const entries = Object.values(registry).filter(row => row && row.scopeKey);
  const byChat = new Map(entries.map(row => [String(row.chatId || ''), String(row.scopeKey || '')]));

  console.log(JSON.stringify({
    test: 'libra_global_scope_registry_serialization',
    registryReads,
    totalEntries: entries.length,
    chatAPresent: byChat.has('chat-A'),
    chatBPresent: byChat.has('chat-B'),
    failures
  }, null, 1));

  // Non-vacuity: both resolutions must really have read the shared registry.
  assert.ok(registryReads >= 2, 'both scope resolutions really read the shared registry');
  assert.deepEqual(failures, [], `no resolution may fail: ${failures.join(' | ')}`);
  // The fix: neither write may drop the other's entry.
  assert.equal(byChat.has('chat-A'), true,
    'chat A entry must survive a concurrent resolution for chat B (no lost update)');
  assert.equal(byChat.has('chat-B'), true,
    'chat B entry must survive a concurrent resolution for chat A (no lost update)');

  // Second site: a suppression write must not drop an unrelated chat entry either.
  await markNativeCopySuppressed({ scopeKey: byChat.get('chat-B'), characterId: 'character-1', chatId: 'chat-B' }, 'regression_probe');
  const afterSuppress = JSON.parse(values.get(REGISTRY_KEY) || '{}');
  assert.equal(afterSuppress['character-1::chat-B']?.nativeCopySuppressed, true,
    'the suppression marker is persisted');
  assert.ok(Object.values(afterSuppress).some(row => row && String(row.chatId || '') === 'chat-A'),
    'a suppression write must not drop an unrelated chat entry');

  process.stdout.write('libra_global_scope_registry_serialization_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
