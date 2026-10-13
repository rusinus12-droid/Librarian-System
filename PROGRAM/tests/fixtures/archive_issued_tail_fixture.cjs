'use strict';

// Root 85 owns startup producers only at its source-fixture baseline boundary.
// Shared modules, artifact evaluations and artifact restart waits stay intact.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const sourcePlans = require('./archive_issued_tail_plans.json');
// A distinct reviewed plan admits GUI-adopted source bytes. Historical inputs
// and their independent output pins stay untouched. The scheduler callback
// fingerprints must remain identical to those historical plans.
const guiSourcePlans = require('./archive_issued_tail_gui_plans.json');
assert.equal(sourcePlans.schema, 'root085.source-observer-plans.v1');
assert.equal(sourcePlans.offsetUnit, 'javascript-utf16-code-unit');
assert.equal(sourcePlans.plans.length, 3);
assert.equal(guiSourcePlans.schema, 'gui-adoption.source-observer-plans.v1');
assert.equal(guiSourcePlans.offsetUnit, sourcePlans.offsetUnit);
assert.equal(guiSourcePlans.plans.length, 3);
for (const plan of guiSourcePlans.plans) {
  const historical = sourcePlans.plans.find(row => row.name === plan.name);
  assert(historical, 'GUI plan has a reviewed historical variant');
  const fingerprints = row => row.callsites.map(site => site.family + ':' + site.callbackSha256).sort();
  assert.deepEqual(fingerprints(plan), fingerprints(historical), 'all reviewed scheduler callbacks unchanged');
  assert.equal(plan.expressionCount, historical.expressionCount);
  assert.deepEqual(plan.anchors.map(anchor => anchor.before), historical.anchors.map(anchor => anchor.before));
}
const crypto = require('node:crypto');
const key = '__root085IssuedStartupObserver';
const origin = new AsyncLocalStorage();
const ownedFiles = new Set(['archive_reporting_fixture.cjs', 'archive_owner_fixture.cjs', 'embedding_contract_harness.cjs']);
const contexts = new WeakMap(), localModules = new Map(), sourceCache = new Map();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clock = () => Number(process.hrtime.bigint()) / 1e6;
const events = [];
let nextContext = 0, nextPromise = 0, dropped = 0, configuredControl = null;
let defaultControls = null;
const emit = (kind, data = {}) => {
  if (!configuredControl || configuredControl.finished || (data.context && configuredControl.context && data.context !== configuredControl.context)) return;
  if (events.length === 512) { dropped++; return; }
  events.push({ kind, atMs: clock(), ...data });
};
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length - 1, 1, 'unique source observer seam');
  return source.replace(before, after);
};

function observeProduct(source) {
  const hash = digest(source);
  if (sourceCache.has(hash)) return sourceCache.get(hash);
  const plan = [...sourcePlans.plans, ...guiSourcePlans.plans].find(row => row.sourceSha256 === hash);
  assert(plan, 'source observer requires an exact statically verified input');
  assert.equal(Buffer.byteLength(source), plan.sourceBytes);
  assert.equal(source.length, plan.sourceCodeUnits, 'source offsets are JavaScript UTF-16 code units');
  assert.equal(plan.callsites.length, 32);
  assert.equal(plan.expressionCount, 52);
  assert.equal(plan.anchors.length, 8);
  for (const anchor of plan.anchors) {
    const region = source.slice(0, anchor.regionEnd);
    assert.equal(region.indexOf(anchor.before), anchor.start, 'complete fixed source anchor');
    assert.equal(region.indexOf(anchor.before, anchor.start + 1), -1, 'unambiguous fixed source anchor');
  }
  const chunks = [];
  let cursor = 0;
  for (const patch of plan.patches) {
    assert(Number.isInteger(patch.start) && Number.isInteger(patch.end));
    assert(patch.start >= cursor && patch.end >= patch.start && patch.end <= source.length, 'ordered nonoverlapping source patches');
    assert.equal(source.slice(patch.start, patch.end), patch.before, 'exact complete patch input');
    chunks.push(source.slice(cursor, patch.start), patch.after);
    cursor = patch.end;
  }
  chunks.push(source.slice(cursor));
  const result = chunks.join('');
  assert.equal(digest(result), plan.observedSha256, 'byte-exact reviewed AST observer output');
  const transformed = { source: result, sourceSha256: hash, observedSha256: plan.observedSha256,
    callsites: plan.callsites, expressionCount: plan.expressionCount };
  assert(sourceCache.size < 8, 'bounded fixture source variants');
  sourceCache.set(hash, transformed);
  return transformed;
}

function createState(sandbox) {
  const id = ++nextContext, pending = new Map(), labels = new WeakMap();
  const state = { id, sandbox, pending, runtime: null, sdk: null, startup: null, control: null, boundary: null, closed: new Set() };
  const promise = (kind, value) => {
    if (!value || typeof value.then !== 'function') return value;
    if ([...pending.values()].some(row => row.value === value)) return value;
    const token = ++nextPromise, label = origin.getStore()?.label || kind;
    pending.set(token, { value, kind, label });
    emit('promise.started', { context: id, token, promiseKind: kind, label });
    value.then(() => { pending.delete(token); emit('promise.fulfilled', { context: id, token, promiseKind: kind, label }); },
      error => { pending.delete(token); emit('promise.rejected', { context: id, token, promiseKind: kind, label, code: String(error?.code || error?.name || 'Error').slice(0, 80) }); });
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
    timerRegistered(family, handle, callback, delayMs) {
      emit('timer.registered', { context: id, family, label: labels.get(callback), delayMs });
      if (state.closed.has(family)) {
        clearOwnedHandle(state, family, handle);
        emit('timer.cancelled_during_drain', { context: id, family, label: labels.get(callback), delayMs });
      }
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
  // Resolve the reviewed callback by its stable family + fingerprint. Source
  // GUI edits can move a callback to another UTF-16 offset while preserving
  // its body; matching the old stack label would then wait forever for a
  // callsite that no longer exists.
  const baseline = sourcePlans.plans.find(plan =>
    plan.sourceSha256 === 'd9026d86f5310fcc2357b824735007fd515719d0b7ddfa515cc34e5ea08336be');
  assert(baseline, 'pinned historical source observer plan exists');
  const baselineLabel = control.kind === 'native' ? 'scheduleTimer:24453' : 'scheduleLifecycleTimeout:9675';
  const accepted = baseline.callsites.filter(site => site.label === baselineLabel);
  assert.equal(accepted.length, 1, 'mandatory callback is uniquely identified in the pinned historical plan');
  const reviewedCallback = accepted[0];
  const matches = state.source.callsites.filter(site => site.family === reviewedCallback.family &&
    site.callbackSha256 === reviewedCallback.callbackSha256);
  assert.equal(matches.length, 1, 'mandatory startup control resolves to one reviewed callback fingerprint');
  control.targetLabel = matches[0].label;
  const host = state.sandbox.risuai, original = host.getCharacter;
  assert.equal(typeof original, 'function');
  host.getCharacter = function (...args) {
    const value = Reflect.apply(original, this, args);
    const caller = origin.getStore();
    const native = caller?.state === state && control.kind === 'native' && caller.label === control.targetLabel;
    const sdk = caller?.state === state && control.kind === 'sdk' && caller.label === control.targetLabel;
    if (control.entered || !(control.kind === 'native' ? native : sdk)) return value;
    control.entered = true;
    control.enteredAtMs = clock();
    control.resolveEntered();
    control.label = caller.label;
    emit('control.actual_host_read_entered', { context: state.id, label: caller.label, method: 'getCharacter', promise: !!value?.then });
    const gate = new Promise(resolve => { control.release = () => { control.released = true; resolve(); }; });
    control.gate = gate;
    control.safetyTimer = setTimeout(() => {
      control.releaseReason = 'safety';
      emit('control.safety_release', { context: state.id });
      control.release();
    }, 2000);
    return Promise.resolve(value).then(result => gate.then(() => result));
  };
}

function clearOwnedHandle(state, family, handle) {
  if (family === 'sdk') state.sdk.clear(handle);
  else {
    state.sandbox.clearTimeout(handle);
    state.runtime.Runtime.scheduledTimers.delete(handle);
  }
}

function clearOwnedProducers(state) {
  state.runtime.clearScheduledTimers();
  if (state.closed.has('sdk')) for (const handle of [...state.sdk.timers]) state.sdk.clear(handle);
}

async function boundary(context, ownership, failureCleanup) {
  const state = contexts.get(context);
  assert(state?.runtime, 'source readiness boundary has actual runtime capture');
  assert(['reporting', 'owner'].includes(ownership));
  state.boundary = { enteredAtMs: clock() };
  emit('boundary.entered', pendingSnapshot(state));
  const control = state.control;
  if (control) {
    // Independent of readiness completion: a correct future barrier must be
    // able to await this same genuine callback without deadlocking the release.
    control.releaseTimer = setTimeout(() => {
      emit('control.independent_release', { context: state.id, entered: !!control.entered });
      control.releaseReason = 'boundary';
      control.releasedAtMs = clock();
      control.release?.();
      if (control.safetyTimer) clearTimeout(control.safetyTimer);
    }, 350);
  }
  let deadline;
  try {
    await Promise.race([(async () => {
      // A mandatory control observes the actual registered producer entering;
      // it never invokes a callback itself or accepts an unexercised seam.
      if (control) await control.enteredPromise;
      if (control) {
        assert.equal(control.released, undefined, 'real callback acknowledgement remains held when producer admission closes');
        assert.equal(control.releaseReason, undefined, 'independent release has not preceded actual callback admission');
        assert([...state.pending.values()].some(row => row.label === control.label), 'actual full selected callback is pending at the close boundary');
        control.closedAtMs = clock();
      }
      state.closed.add('runtime');
      if (ownership === 'reporting') state.closed.add('sdk');
      clearOwnedProducers(state);
      if (control?.default) {
        await assert.rejects(state.runtime.withDeadline(new Promise(() => {}), 5, 'root85 owned-drain deadline control'),
          error => error?.code === 'FLASHBACK_DEADLINE');
        control.directDeadlineFired = true;
        emit('control.direct_deadline_fired', { context: state.id });
      }
      const settled = new Set();
      if (state.startup) await state.startup;
      for (;;) {
        clearOwnedProducers(state);
        const next = [...issuedPromises(state).promises].filter(value => !settled.has(value));
        if (!next.length) break;
        await Promise.all(next);
        next.forEach(value => settled.add(value));
      }
      clearOwnedProducers(state);
    })(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Timed out waiting for owned startup writers to settle')), 15000); })]);
    state.boundary.returnedAtMs = clock();
    emit('boundary.issued_work_settled', pendingSnapshot(state));
  } catch (error) {
    releaseControl(control);
    clearOwnedProducers(state);
    await failureCleanup();
    throw error;
  } finally { clearTimeout(deadline); }
}

function reopen(context) {
  const state = contexts.get(context);
  assert(state?.closed.has('runtime'), 'owned producer admission closes before reopening');
  state.closed.clear();
  state.reopened = true;
  emit('boundary.producers_reopened', { context: state.id });
}

function fixtureSource(source, name) {
  if (name === 'archive_reporting_fixture.cjs') {
    source = replaceOnce(source, '  await new Promise(resolve=>setTimeout(resolve,200));\n  for(const t of activeTimeouts)',
      `  await __root085Boundary(context,'reporting',async()=>{for(const h of unloadHandlers.splice(0))await h().catch(()=>{});for(const t of activeTimeouts)clearTimeout(t);activeTimeouts.clear();for(const t of activeIntervals)clearInterval(t);activeIntervals.clear();});\n  for(const t of activeTimeouts)`);
    source = replaceOnce(source, '  let requests=0;', '  __root085Reopen(context);\n  let requests=0;');
  } else if (name === 'archive_owner_fixture.cjs') {
    source = replaceOnce(source, '    await new Promise(resolve => setTimeout(resolve, 200));',
      "    await (h.audit ? __root085Boundary(h.context,'owner',()=>h.cleanup()) : new Promise(resolve => setTimeout(resolve, 200)));");
    source = replaceOnce(source, '      h.audit.clearScheduledTimers();', '      h.audit.clearScheduledTimers();\n      __root085Reopen(h.context);');
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
    if (request === './root085-private-reopen') return reopen;
    if (request.startsWith('./') && ownedFiles.has(path.basename(request))) return loadLocal(path.resolve(__dirname, request));
    return ordinaryRequire(request);
  };
  localModules.set(filename, child);
  const original = fs.readFileSync(filename, 'utf8');
  const copied = fixtureSource(original, name);
  child._compile(replaceOnce(copied, "'use strict';",
    "'use strict';\nconst __root085Boundary=require('./root085-private-boundary');\nconst __root085Reopen=require('./root085-private-reopen');"), filename);
  return child.exports;
}

function configureControl(kind, isDefault = false) {
  assert(['native', 'sdk'].includes(kind));
  assert(!configuredControl || configuredControl.finished, 'prior mandatory control must finish');
  configuredControl = { kind, default: isDefault };
  configuredControl.enteredPromise = new Promise(resolve => { configuredControl.resolveEntered = resolve; });
}

function releaseControl(control) {
  control?.release?.();
  if (control?.releaseTimer) clearTimeout(control.releaseTimer);
  if (control?.safetyTimer) clearTimeout(control.safetyTimer);
}

const reporting = loadLocal(path.join(__dirname, 'archive_reporting_fixture.cjs'));
module.exports = {
  ...reporting,
  ...loadLocal(path.join(__dirname, 'archive_owner_fixture.cjs')),
  async createArchiveReportingFixture(...args) {
    if (defaultControls?.length) configureControl(defaultControls.shift(), true);
    const f = await reporting.createArchiveReportingFixture(...args);
    const state = contexts.get(f.context), control = state.control;
    if (control?.default) {
      try {
        assert(control.entered && control.released && state.reopened, 'mandatory real startup tail is delivered, released and drained before actions');
        assert.equal(control.releaseReason, 'boundary', 'mandatory control uses independent release, not safety timeout');
        assert.equal([...state.pending.values()].some(row => row.label === control.label), false, 'whole actual controlled callback has settled');
        await state.runtime.withDeadline(new Promise(resolve => {
          state.runtime.scheduleTimer(state.observer.label('fixture.reopened_admission', resolve), 0);
        }), 15000, 'root85 reopened producer admission');
        control.reopenedTimerDelivered = true;
        f.assertMapSubsetUnchanged(f.protectedArchive, f.pluginStorage.values, 'startup control preserves archived source bytes');
        f.assertMapSubsetUnchanged(f.archiveVectors, f.safeLocalStorage.values, 'startup control preserves archived vector bytes');
        console.log(`PASS root85 ${control.kind} actual issued-tail readiness, direct deadline and reopened producer admission`);
        console.log('ROOT085_DEFAULT_READINESS_CONTROL', JSON.stringify({ kind: control.kind, callback: control.label,
          sourceSha256: state.source.sourceSha256, enteredAtMs: control.enteredAtMs, closedAtMs: control.closedAtMs,
          releasedAtMs: control.releasedAtMs, readyAtMs: state.boundary.returnedAtMs,
          directDeadlineFired: control.directDeadlineFired, reopenedTimerDelivered: control.reopenedTimerDelivered,
          preservedArchiveBytes: true, preservedVectorBytes: true }));
      } catch (error) { await f.dispose(); throw error; }
      finally { control.finished = true; releaseControl(control); }
    }
    return f;
  },
  enableDefaultControls() { assert.equal(defaultControls, null); defaultControls = ['native', 'sdk']; },
  observeProduct, fixtureSource,
  configureControl,
  stateFor: context => contexts.get(context),
  report: () => ({ events, dropped, contexts: nextContext }),
  pendingSnapshot,
  issuedPromises,
  waitControlRelease: () => configuredControl?.gate || Promise.resolve(),
  releaseControl: () => releaseControl(configuredControl)
};
