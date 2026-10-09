'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const exportSnippet = `
;globalThis.__LIBRA_RESOURCE_GOVERNOR_TEST__ = {
  ResourceGovernor: typeof ResourceGovernor !== 'undefined' ? ResourceGovernor : null,
  AsyncTaskQueue: typeof AsyncTaskQueue !== 'undefined' ? AsyncTaskQueue : null,
  LRUCache: typeof LRUCache !== 'undefined' ? LRUCache : null,
  MaintenanceLLMQueue: typeof MaintenanceLLMQueue !== 'undefined' ? MaintenanceLLMQueue : null,
  BackgroundMaintenanceQueue: typeof BackgroundMaintenanceQueue !== 'undefined' ? BackgroundMaintenanceQueue : null,
  runResourceBoundSettledPool: typeof runResourceBoundSettledPool !== 'undefined' ? runResourceBoundSettledPool : null,
  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null
};
`;
const exportIndex = code.lastIndexOf('\n})();');
if (exportIndex >= 0) code = code.slice(0, exportIndex) + exportSnippet + code.slice(exportIndex);
else code += exportSnippet;

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this._id = '';
    this.className = '';
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._innerHTML = '';
    this.textContent = '';
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._innerHTML = String(v || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id && this.ownerDocument) this.ownerDocument._register(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
class FakeDocument {
  constructor() { this._ids = Object.create(null); this.head = new FakeElement('head', this); this.body = new FakeElement('body', this); }
  _register(el) { if (el?.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(selector) { if (selector === 'head') return this.head; if (selector === 'body') return this.body; return null; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assertions = [];
const assertCase = (name, ok, detail = null) => assertions.push({ name, ok: !!ok, detail });

(async () => {
  const document = new FakeDocument();
  const storage = new Map();
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(key) { return key === 'activity_dashboard' ? 'off' : undefined; },
    pluginStorage: {
      async getItem(k) { return storage.has(k) ? storage.get(k) : null; },
      async setItem(k, v) { storage.set(k, String(v)); },
      async removeItem(k) { storage.delete(k); }
    },
    async getCharacter() { return null; },
    async registerSetting() {},
    async registerButton() {},
    async requestPluginPermission() { return false; },
    async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
    Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    Map, Set, WeakMap, WeakSet, ArrayBuffer, Uint8Array, Float32Array,
    globalThis: null, window: null, document, Risuai, risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController,
    performance: { now: () => Date.now() }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await sleep(80);

  const api = context.__LIBRA_RESOURCE_GOVERNOR_TEST__ || {};
  const governor = api.ResourceGovernor;
  const engine = api.MemoryEngine;
  const maintenanceQueue = api.MaintenanceLLMQueue;
  assertCase('resource_governor_exported_for_test', !!governor && typeof governor.sample === 'function');
  assertCase('queue_and_lru_available', typeof api.AsyncTaskQueue === 'function' && typeof api.LRUCache === 'function');
  assertCase('single_profile_default_enabled', engine?.CONFIG?.resourceGovernorEnabled === true, engine?.CONFIG?.resourceGovernorEnabled);
  assertCase('prompt_budget_not_reduced', Number(engine?.CONFIG?.injectionBudgetMaxTokens || 0) >= 12000, engine?.CONFIG?.injectionBudgetMaxTokens);
  assertCase('embedding_quality_path_preserved', engine?.CONFIG?.embed?.enabled === true && String(engine?.CONFIG?.hmeAssociativeGraphMode || '') !== 'off', {
    embed: engine?.CONFIG?.embed?.enabled,
    graphMode: engine?.CONFIG?.hmeAssociativeGraphMode
  });

  governor.stop();
  Object.assign(engine.CONFIG, {
    resourceGovernorEnabled: true,
    resourceWorkingSetSoftBytes: 32 * 1024 * 1024,
    resourceWorkingSetHardBytes: 48 * 1024 * 1024,
    resourcePendingQueueSoftBytes: 1 * 1024 * 1024,
    resourcePendingQueueHardBytes: 2 * 1024 * 1024,
    resourcePressureHoldMs: 500,
    resourceRecoveryHoldMs: 3000,
    resourceNormalMaintenanceConcurrency: 3,
    resourcePressureMaintenanceConcurrency: 2,
    resourceCriticalMaintenanceConcurrency: 1
  });

  const fakeCache = {
    label: 'unit-pressure-cache',
    maxBytes: 80 * 1024 * 1024,
    totalBytes: 60 * 1024 * 1024,
    cache: new Map([['x', true]]),
    trimToBytes(target) { const changed = this.totalBytes > target ? 1 : 0; this.totalBytes = Math.min(this.totalBytes, target); return changed; },
    trimToSize() { return 0; }
  };
  governor.registerCache(fakeCache);
  let snapshot = governor.sample('unit-critical', { force: true });
  assertCase('hard_pressure_enters_critical', snapshot.state === 'critical', snapshot);
  assertCase('critical_reduces_only_execution_concurrency', maintenanceQueue.maxConcurrent === 1, maintenanceQueue.maxConcurrent);
  assertCase('critical_defers_nonessential_background', governor.shouldDeferBackground({ essential: false, foreground: false }) === true);
  assertCase('critical_keeps_essential_foreground', governor.shouldDeferBackground({ essential: true, foreground: true }) === false);
  assertCase('critical_shrinks_adaptive_batch', governor.adaptiveBatchSize(100, { min: 1, max: 100, label: 'unit-batch' }) <= 25);
  assertCase('critical_compacts_maintenance_queue_without_zeroing', governor.getPendingMaintenanceLimit() === 3);
  assertCase('critical_trims_recomputable_cache', fakeCache.totalBytes < 60 * 1024 * 1024, fakeCache.totalBytes);

  let poolActive = 0;
  let poolMaxActive = 0;
  const poolResults = await api.runResourceBoundSettledPool([0, 1, 2, 3, 4, 5], async value => {
    poolActive += 1;
    poolMaxActive = Math.max(poolMaxActive, poolActive);
    await sleep(12);
    poolActive -= 1;
    return value * 2;
  }, { label: 'unit-resource-pool', maxConcurrency: 6 });
  assertCase('critical_pool_preserves_all_items', poolResults.length === 6 && poolResults.every((item, i) => item.status === 'fulfilled' && item.value === i * 2), poolResults);
  assertCase('critical_pool_reduces_producer_window', poolMaxActive === 1, poolMaxActive);

  const localQueue = new api.AsyncTaskQueue(1, 'UnitQueue');
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = localQueue.enqueue(async () => { await firstGate; return 1; }, 'first', { estimatedBytes: 2048 });
  const second = localQueue.enqueue(async () => 2, 'second', { estimatedBytes: 4096 });
  await sleep(20);
  assertCase('queue_tracks_pending_bytes', localQueue.pendingCount === 1 && localQueue.pendingByteCount >= 4096, { pending: localQueue.pendingCount, bytes: localQueue.pendingByteCount });
  releaseFirst();
  await Promise.all([first, second]);
  assertCase('queue_releases_pending_bytes', localQueue.pendingByteCount === 0 && localQueue.pendingCount === 0, { pending: localQueue.pendingCount, bytes: localQueue.pendingByteCount });

  const lru = new api.LRUCache(100, { label: 'unit-lru', maxBytes: 4096 });
  for (let i = 0; i < 30; i += 1) lru.set(`k${i}`, 'z'.repeat(512));
  assertCase('lru_enforces_byte_budget', lru.totalBytes <= governor.getCacheBudget('unit-lru', 4096) && lru.cache.size < 30, lru.stats);

  fakeCache.totalBytes = 0;
  governor.sample('unit-healthy-1', { force: true });
  await sleep(1100);
  snapshot = governor.sample('unit-healthy-2', { force: true });
  assertCase('critical_recovers_with_hysteresis', snapshot.state === 'recovery', snapshot.state);
  await sleep(3100);
  snapshot = governor.sample('unit-healthy-3', { force: true });
  assertCase('recovery_returns_to_normal', snapshot.state === 'normal', snapshot.state);
  assertCase('normal_concurrency_restored', maintenanceQueue.maxConcurrent === 3, maintenanceQueue.maxConcurrent);
  assertCase('normal_background_not_deferred', governor.shouldDeferBackground({ essential: false }) === false);
  assertCase('governor_has_no_device_profile', !('device' in snapshot) && !('mobile' in snapshot) && !('desktop' in snapshot), snapshot);

  // A long end-to-end task can include provider/network waits. It must not be
  // mistaken for main-thread lag and force a quality-damaging pressure cycle.
  governor.reportTask('unit-provider-wait', 5000, { networkWait: true });
  snapshot = governor.sample('unit-long-task-not-lag', { force: true });
  assertCase('long_task_latency_is_not_event_loop_lag', snapshot.state === 'normal' && snapshot.eventLoopLagEmaMs === 0, snapshot);

  const maintenanceSource = fs.readdirSync(path.join(ROOT, 'src', 'parts'))
    .filter(name => /^05(?:-|[a-z]).*\.js$/i.test(name))
    .sort()
    .map(name => fs.readFileSync(path.join(ROOT, 'src', 'parts', name), 'utf8'))
    .join('');
  const committedQueueBlock = maintenanceSource.slice(
    maintenanceSource.indexOf('const enqueueTurnMaintenanceEntry'),
    maintenanceSource.indexOf('const scheduleTurnMaintenanceRecord')
  );
  assertCase('committed_turn_maintenance_is_essential', /essential:\s*true/.test(committedQueueBlock), committedQueueBlock.slice(0, 800));
  assertCase('committed_turn_maintenance_not_indefinitely_deferred', !/shouldDeferBackground/.test(committedQueueBlock), committedQueueBlock.slice(0, 800));

  governor.stop();
  const failed = assertions.filter(item => !item.ok);
  const result = {
    generatedAt: new Date().toISOString(),
    assertions,
    passed: failed.length === 0,
    failed: failed.map(item => item.name),
    finalSnapshot: snapshot
  };
  const outDir = path.join(ROOT, 'test-output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'resource_governor_result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
