'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHayakuRuntime, waitFor } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createDocument } = require('./fixtures/retrace_gui_dom_fixture.cjs');

const ids = ['retrace-main-setting', 'retrace-main-hamburger'];
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'RETRACE.js'), 'utf8');
const marker = '  const RetraceApi = Object.freeze({';
assert.equal(source.split(marker).length, 2, 'full plugin audit seam is unique');
// Observe registration state/retry only. Rendering, binding, refresh, and unload
// execute the deployed plugin body rather than copied source slices.
const auditedSource = source.replace(marker,
  '  globalThis.__retraceGuiAudit = { registerUi, state: () => clone(Runtime.registered), ui: () => ({ activeTab: Runtime.activeTab, visible: Runtime.visible, mounted: Runtime.mounted }) };\n' + marker);

async function runCase(label, responses, { delayed = false, reload = false, recoveryViaReload = false } = {}) {
  const runtime = await createHayakuRuntime({ autoRepair: false });
  const callbacks = new Map();
  const calls = [];
  const removed = [];
  const shown = [];
  const document = createDocument();
  let answers = responses;
  let boots = 0;
  let modelAttempts = 0;
  runtime.context.document = document;
  runtime.context.console = { log() {}, info() {}, warn() {}, debug() {}, error: console.error };
  runtime.host.runLLMModel = async () => { modelAttempts += 1; throw new Error('GUI test must never invoke a model'); };
  runtime.host.showContainer = async mode => { shown.push(mode); return true; };
  const register = async (kind, id, callback) => {
    calls.push({ kind, id });
    const answer = answers[kind];
    if (answer === false) return false;
    assert.equal(callbacks.has(id), false, `${label}: no duplicate accepted callback`);
    callbacks.set(id, callback);
    return answer === undefined ? undefined : { id };
  };
  const install = () => {
    runtime.host.registerSetting = async (name, callback, icon, type, id) => register('setting', id, callback);
    runtime.host.registerButton = async (options, callback) => register('button', options.id, callback);
  };
  runtime.host.unregisterUIPart = async id => { removed.push(id); callbacks.delete(id); return true; };
  if (delayed) {
    delete runtime.host.registerSetting;
    delete runtime.host.registerButton;
  } else install();
  const boot = async () => {
    const previous = new Set(runtime.host.unloadHandlers);
    // A host reload has a new script realm; embedded top-level const bindings
    // from a previous plugin script must not survive into that realm.
    if (boots++ > 0) runtime.context = vm.createContext({ ...runtime.context });
    vm.runInContext(auditedSource, runtime.context, { filename: 'RETRACE.js' });
    return await waitFor(() => runtime.host.unloadHandlers.find(handler =>
      !previous.has(handler) && handler.toString().includes('globalThis.__RETRACE === RetraceApi')),
    `${label}: actual RETRACE unload registration`);
  };
  try {
    let unload = await boot();
    let audit = runtime.context.__retraceGuiAudit;
    const rejected = audit.state();
    for (const [kind, key] of [['setting', 'setting'], ['button', 'hamburger']]) {
      if (delayed || responses[kind] === false) assert.equal(Boolean(rejected[key]), false, `${label}: ${kind} rejection stays unregistered`);
      else {
        assert.ok(rejected[key], `${label}: accepted ${kind} is tracked`);
        if (responses[kind] === undefined) {
          assert.equal(rejected[key].uncertain, true, `${label}: undefined return retains compatibility handle`);
          assert.equal(rejected[key].id, ids[key === 'setting' ? 0 : 1]);
        }
      }
    }
    if (delayed) { assert.equal(calls.length, 0); install(); }
    answers = { setting: true, button: true };
    if (recoveryViaReload) {
      // No private registration retry: a real unload followed by normal full
      // plugin startup is the existing host-facing recovery entrypoint.
      assert.equal(callbacks.size, 0, `${label}: rejected host registered no GUI entry`);
      await unload();
      assert.equal(runtime.context.__RETRACE, undefined, `${label}: rejected runtime actually unloads`);
      unload = await boot();
      audit = runtime.context.__retraceGuiAudit;
      assert.equal(calls.length, 4, `${label}: normal reload startup retries both registrations`);
    } else await audit.registerUi();
    assert.deepEqual([...callbacks.keys()].sort(), [...ids].sort(), `${label}: host recovery accepts both entrypoints`);
    const acceptedCalls = calls.length;
    await audit.registerUi();
    assert.equal(calls.length, acceptedCalls, `${label}: repeated registration preserves accepted callback`);
    for (const id of ids) {
      await callbacks.get(id)();
      const root = document.querySelector('#flashback-hayaku-bridge-root');
      assert.ok(root?.isConnected, `${label}: registered ${id} mounts the rendered shell`);
      assert.equal(audit.ui().mounted, true);
      const tab = root.querySelector('[data-tab="diagnostics"]');
      await tab.emit('click');
      assert.equal(audit.ui().activeTab, 'diagnostics', `${label}: actual bound tab callback changes state`);
      assert.equal(tab.getAttribute('aria-selected'), 'true');
      assert.equal(root.querySelector('#panel-diagnostics').hidden, false);
      assert.equal(root.querySelector('#panel-session').hidden, true);
      assert.ok(root.querySelector('#diagnosticsBody').textContent.includes('IPC'), `${label}: diagnostics renderer executed`);
      await root.querySelector('#closeBridge').emit('click');
      assert.equal(audit.ui().visible, false);
    }
    await unload();
    assert.equal(callbacks.size, 0, `${label}: real unload removes host callbacks`);
    assert.deepEqual(removed, recoveryViaReload ? [...ids, ...ids] : ids, `${label}: unload uses both stable IDs`);
    assert.equal(document.querySelector('#flashback-hayaku-bridge-root'), null);
    assert.equal(runtime.context.__RETRACE, undefined);
    if (reload) {
      unload = await boot();
      assert.equal(callbacks.size, 2, `${label}: reload registers two fresh callbacks`);
      await callbacks.get(ids[1])();
      assert.equal(runtime.context.__retraceGuiAudit.ui().mounted, true);
      await unload();
      assert.equal(callbacks.size, 0, `${label}: reloaded unload removes callbacks`);
    }
    assert.equal(runtime.llmCalls.length, 0);
    assert.equal(modelAttempts, 0);
    assert.equal(runtime.fetchCalls.length, 0);
    console.log(JSON.stringify({ case: label, registrationCalls: calls.length, shown: shown.length, removed, actualModelCalls: modelAttempts }));
  } finally { await runtime.dispose(); }
}

(async () => {
  await runCase('explicit false then host recovery', { setting: false, button: false }, { reload: true });
  await runCase('explicit false then real unload and normal plugin reload', { setting: false, button: false }, { recoveryViaReload: true });
  await runCase('known accepted handles', { setting: true, button: true });
  await runCase('undefined return with actually registered callbacks', { setting: undefined, button: undefined }, { reload: true });
  await runCase('setting rejected independently', { setting: false, button: true });
  await runCase('button rejected independently', { setting: true, button: false });
  await runCase('delayed registration API', { setting: true, button: true }, { delayed: true });
  console.log('retrace_gui_registration_runtime_test: PASS (7 full-VM cases, registered callbacks, tabs, explicit retry, rejected-runtime unload/reload, no model)');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
