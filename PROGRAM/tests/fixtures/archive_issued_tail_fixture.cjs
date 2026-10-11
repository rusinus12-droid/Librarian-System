'use strict';

// Root 85 source-fixture observer. Shared modules and artifact evaluations stay
// untouched. This first revision deliberately retains every original 200ms wait.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const acorn = require('acorn');
const crypto = require('node:crypto');
const key = '__root085IssuedStartupObserver';
const origin = new AsyncLocalStorage();
const ownedFiles = new Set(['archive_reporting_fixture.cjs', 'archive_owner_fixture.cjs', 'embedding_contract_harness.cjs']);
const contexts = new WeakMap(), localModules = new Map(), sourceCache = new Map();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clock = () => Number(process.hrtime.bigint()) / 1e6;
const events = [];
let nextContext = 0, nextPromise = 0, dropped = 0, configuredControl = null;
const emit = (kind, data = {}) => {
  if (!configuredControl || (data.context && configuredControl.context && data.context !== configuredControl.context)) return;
  if (events.length === 512) { dropped++; return; }
  events.push({ kind, atMs: clock(), ...data });
};
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [name, value] of Object.entries(node)) {
    if (name === 'loc') continue;
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length - 1, 1, 'unique source observer seam');
  return source.replace(before, after);
};

function observeProduct(source) {
  const hash = digest(source);
  if (sourceCache.has(hash)) return sourceCache.get(hash);
  const tree = acorn.parse(source, { ecmaVersion: 'latest', locations: true });
  const edits = [], expressions = new Map(), callsites = [];
  const searchBoundary = source.indexOf('// BEGIN MEMORY SUITE SEARCH');
  const wrap = (node, prefix) => edits.push({ start: node.start, end: node.end, prefix, suffix: ')' });
  walk(tree, node => {
    if (node.type !== 'CallExpression') return;
    const family = node.callee.name;
    if (family !== 'scheduleTimer' && !(family === 'scheduleLifecycleTimeout' && node.start < searchBoundary)) return;
    const callback = node.arguments[0];
    const label = `${family}:${node.loc.start.line}`;
    callsites.push({ family, label, callbackSha256: digest(source.slice(callback.start, callback.end)) });
    wrap(callback, `globalThis.${key}.label(${JSON.stringify(label)},`);
    if (callback.type === 'Identifier') return; // Actual return observed by invoke.
    walk(callback.body, child => {
      if (child.type !== 'ExpressionStatement') return;
      let expression = child.expression;
      if (expression.type === 'UnaryExpression' && expression.operator === 'void') expression = expression.argument;
      if (expression.type !== 'CallExpression' && !(expression.type === 'AssignmentExpression' && expression.right.type === 'CallExpression')) return;
      expressions.set(expression.start, expression);
    });
  });
  assert.equal(callsites.filter(row => row.family === 'scheduleTimer').length, 18);
  assert.equal(callsites.filter(row => row.family === 'scheduleLifecycleTimeout').length, 14);
  for (const node of expressions.values()) wrap(node, `globalThis.${key}.promise('scheduled.chain',`);
  // Balanced insertions preserve all original source text, including nested
  // callback registrations and detached child chains.
  const insertions = new Map();
  const add = (at, text, order) => { const rows = insertions.get(at) || []; rows.push({ text, order }); insertions.set(at, rows); };
  for (const edit of edits) { add(edit.start, edit.prefix, -edit.end); add(edit.end, edit.suffix, -edit.start); }
  let result = source;
  for (const [at, rows] of [...insertions].sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, at) + rows.sort((a, b) => a.order - b.order).map(row => row.text).join('') + result.slice(at);
  }
  result = replaceOnce(result, "try { fn(); } catch (error) { warn('scheduled timer callback failed', error); }",
    `try { globalThis.${key}.invoke(fn); } catch (error) { warn('scheduled timer callback failed', error); }`);
  result = replaceOnce(result, '      callback();\n    }, Math.max(0, Number(delayMs || 0) || 0));',
    `      globalThis.${key}.invoke(callback);\n    }, Math.max(0, Number(delayMs || 0) || 0));`);
  result = replaceOnce(result, '  globalThis.__FlashbackMemory = publicApi;',
    `  globalThis.${key}.captureRuntime({ Runtime, sharedScopeWriteLocks, clearScheduledTimers });\n  globalThis.__FlashbackMemory = publicApi;`);
  result = replaceOnce(result, '  const autoMigratePlugin = !localOnlyOwner',
    `  globalThis.${key}.captureSdk({ timers: lifecycle.timers, clear: clearLifecycleTimeout });\n  const autoMigratePlugin = !localOnlyOwner`);
  result = replaceOnce(result, 'void refreshHostRuntimeInfo();', `void globalThis.${key}.promise('startup.runtime_info',refreshHostRuntimeInfo());`);
  result = replaceOnce(result, "registerUi(Runtime.settings).catch(error => warn('registerUi async failed', error));",
    `globalThis.${key}.promise('startup.ui',registerUi(Runtime.settings).catch(error => warn('registerUi async failed', error)));`);
  acorn.parse(result, { ecmaVersion: 'latest' });
  const transformed = { source: result, sourceSha256: hash, observedSha256: digest(result), callsites, expressionCount: expressions.size };
  assert(sourceCache.size < 8, 'bounded fixture source variants');
  sourceCache.set(hash, transformed);
  return transformed;
}

function createState(sandbox) {
  const id = ++nextContext, pending = new Map(), labels = new WeakMap();
  const state = { id, sandbox, pending, runtime: null, sdk: null, startup: null, control: null, boundary: null };
  const promise = (kind, value) => {
    if (!value || typeof value.then !== 'function') return value;
    if ([...pending.values()].some(row => row.value === value)) return value;
    const token = ++nextPromise, label = origin.getStore()?.label || kind;
    pending.set(token, { value, kind, label });
    emit('promise.started', { context: id, token, kind, label });
    value.then(() => { pending.delete(token); emit('promise.fulfilled', { context: id, token, kind, label }); },
      error => { pending.delete(token); emit('promise.rejected', { context: id, token, kind, label, code: String(error?.code || error?.name || 'Error').slice(0, 80) }); });
    return value;
  };
  state.observer = {
    promise,
    label(label, callback) { labels.set(callback, label); return callback; },
    invoke(callback) {
      const label = labels.get(callback);
      assert(label, 'registered actual scheduled callback');
      emit('callback.entered', { context: id, label });
      return origin.run({ state, label }, () => promise('scheduled.return', Reflect.apply(callback, undefined, [])));
    },
    captureRuntime(value) {
      assert(!state.runtime);
      assert.equal(typeof value.clearScheduledTimers, 'function');
      assert.equal(typeof value.sharedScopeWriteLocks.values, 'function');
      state.runtime = value;
    },
    captureSdk(value) {
      assert(!state.sdk);
      assert.equal(typeof value.clear, 'function');
      assert.equal(typeof value.timers.values, 'function');
      state.sdk = value;
    }
  };
  return state;
}

const facade = Object.create(vm);
facade.createContext = function (sandbox, ...args) {
  const state = createState(sandbox);
  const context = vm.createContext(sandbox, ...args);
  contexts.set(context, state);
  return context;
};
facade.runInContext = function (source, context, options) {
  const state = contexts.get(context);
  assert(state, 'fixture owns its fresh VM context');
  if (options?.filename !== 'Flashback_Memory.js') {
    emit('consumer.unmodified', { context: state.id, sourceSha256: digest(source), filename: path.basename(options?.filename || '') });
    return vm.runInContext(source, context, options);
  }
  assert.equal(typeof source, 'string');
  assert.deepEqual(Object.keys(options), ['filename'], 'reviewed source fixture evaluation options');
  assert(source.includes('  globalThis.__FlashbackMemory = publicApi;'));
  state.sandbox[key] = state.observer;
  const transformed = observeProduct(source);
  state.source = transformed;
  emit('source.observed', { context: state.id, sourceSha256: transformed.sourceSha256, observedSha256: transformed.observedSha256 });
  if (configuredControl && !configuredControl.assigned) installControl(state, configuredControl);
  const result = vm.runInContext(transformed.source, context, options);
  state.startup = result;
  return state.observer.promise('native.iife', result);
};

function pendingSnapshot(state) {
  const runtime = state.runtime?.Runtime;
  const rows = [...state.pending.values()].map(row => ({ kind: row.kind, label: row.label }));
  return { context: state.id, pending: rows, nativeInFlight: runtime?.nativeCopyObserver?.inFlight ?? null,
    scopeLocks: state.runtime?.sharedScopeWriteLocks.size ?? null,
    retirementPromises: runtime?.externalRetirementInFlight.size ?? null,
    nativeChecks: runtime?.nativeCopyObserver?.checks ?? null };
}

function issuedPromises(state) {
  assert(state?.runtime, 'source runtime private capture exists');
  const collected = new Set(), counts = {}, runtime = state.runtime.Runtime;
  const add = (name, value) => {
    assert(value && typeof value.then === 'function', `${name} must contain an actual thenable`);
    collected.add(value);
    counts[name] = (counts[name] || 0) + 1;
  };
  const collection = (name, value) => {
    assert(value && typeof value.values === 'function' && Number.isInteger(value.size), `${name} must be an actual promise collection`);
    counts[name] = 0;
    for (const item of value.values()) add(name, item);
  };
  for (const row of state.pending.values()) add('observed.callback_or_startup', row.value);
  for (const name of ['externalRetirementInFlight', 'legacyRestoreFinalizeInFlight', 'deferredScopeStorageTasks', 'scopeRegistryRetryTasks']) {
    collection(name, runtime[name]);
  }
  for (const name of ['legacyMigrationInFlight', 'operationLogWrite']) {
    counts[name] = 0;
    if (runtime[name] != null) add(name, runtime[name]);
  }
  collection('sharedScopeWriteLocks', state.runtime.sharedScopeWriteLocks);
  const coordinator = state.sandbox[Symbol.for('rusinus12.flashback.storage-mutation-coordinator.v1')];
  assert(coordinator, 'actual physical storage mutation coordinator exists');
  collection('physicalStorageMutationTails', coordinator.tails);
  // Timer sets deliberately are not promise collections and are never counted
  // as settled work. A future drain must apply their distinct ownership rules.
  return { promises: collected, counts };
}

function installControl(state, control) {
  control.assigned = true;
  control.context = state.id;
  state.control = control;
  const host = state.sandbox.risuai, original = host.getCharacter;
  assert.equal(typeof original, 'function');
  host.getCharacter = function (...args) {
    const value = Reflect.apply(original, this, args);
    const caller = origin.getStore();
    const native = caller?.state === state && caller.label.startsWith('scheduleTimer:') && caller.label === 'scheduleTimer:24453';
    const sdk = caller?.state === state && caller.label === 'scheduleLifecycleTimeout:9675';
    if (control.entered || !(control.kind === 'native' ? native : sdk)) return value;
    control.entered = true;
    control.label = caller.label;
    emit('control.actual_host_read_entered', { context: state.id, label: caller.label, method: 'getCharacter', promise: !!value?.then });
    const gate = new Promise(resolve => { control.release = () => { control.released = true; resolve(); }; });
    control.gate = gate;
    control.safetyTimer = setTimeout(() => {
      emit('control.safety_release', { context: state.id });
      control.release();
    }, 2000);
    return Promise.resolve(value).then(result => gate.then(() => result));
  };
}

function boundary(context, value) {
  const state = contexts.get(context);
  assert(state?.runtime, 'source readiness boundary has actual runtime capture');
  state.boundary = { enteredAtMs: clock() };
  emit('boundary.entered', pendingSnapshot(state));
  const control = state.control;
  if (control) {
    // Independent of readiness completion: a correct future barrier must be
    // able to await this same genuine callback without deadlocking the release.
    control.releaseTimer = setTimeout(() => {
      emit('control.independent_release', { context: state.id, entered: !!control.entered });
      control.release?.();
      if (control.safetyTimer) clearTimeout(control.safetyTimer);
    }, 350);
  }
  value.then(() => {
    state.boundary.returnedAtMs = clock();
    emit('boundary.original_wait_finished', pendingSnapshot(state));
  }, () => {});
  return value;
}

function fixtureSource(source, name) {
  if (name === 'archive_reporting_fixture.cjs') {
    source = replaceOnce(source, '  await new Promise(resolve=>setTimeout(resolve,200));\n  for(const t of activeTimeouts)',
      '  await __root085Boundary(context,new Promise(resolve=>setTimeout(resolve,200)));\n  for(const t of activeTimeouts)');
  } else if (name === 'archive_owner_fixture.cjs') {
    source = replaceOnce(source, '    await new Promise(resolve => setTimeout(resolve, 200));',
      '    await (h.audit ? __root085Boundary(h.context,new Promise(resolve => setTimeout(resolve, 200))) : new Promise(resolve => setTimeout(resolve, 200)));');
  }
  return source;
}

function loadLocal(filename) {
  filename = path.resolve(filename);
  const name = path.basename(filename);
  assert(ownedFiles.has(name) && path.dirname(filename) === __dirname, 'private three-file fixture graph');
  if (localModules.has(filename)) return localModules.get(filename).exports;
  const child = new Module(filename, module);
  child.filename = filename;
  child.paths = Module._nodeModulePaths(__dirname);
  const ordinaryRequire = Module.createRequire(filename);
  child.require = request => {
    if (request === 'node:vm') return facade;
    if (request === './root085-private-boundary') return boundary;
    if (request.startsWith('./') && ownedFiles.has(path.basename(request))) return loadLocal(path.resolve(__dirname, request));
    return ordinaryRequire(request);
  };
  localModules.set(filename, child);
  const original = fs.readFileSync(filename, 'utf8');
  const copied = fixtureSource(original, name);
  child._compile(replaceOnce(copied, "'use strict';",
    "'use strict';\nconst __root085Boundary=require('./root085-private-boundary');"), filename);
  return child.exports;
}

module.exports = {
  ...loadLocal(path.join(__dirname, 'archive_reporting_fixture.cjs')),
  ...loadLocal(path.join(__dirname, 'archive_owner_fixture.cjs')),
  observeProduct, fixtureSource,
  configureControl(kind) { assert(['native', 'sdk'].includes(kind)); assert(!configuredControl); configuredControl = { kind }; },
  stateFor: context => contexts.get(context),
  report: () => ({ events, dropped, contexts: nextContext }),
  pendingSnapshot,
  issuedPromises,
  waitControlRelease: () => configuredControl?.gate || Promise.resolve(),
  releaseControl() {
    configuredControl?.release?.();
    if (configuredControl?.releaseTimer) clearTimeout(configuredControl.releaseTimer);
    if (configuredControl?.safetyTimer) clearTimeout(configuredControl.safetyTimer);
  }
};
