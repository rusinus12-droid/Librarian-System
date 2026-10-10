'use strict';
// Real RETRACE registered UI + actual server. Only the host/DOM and synthetic DATA are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { NAMESPACES, assertCompleted, oracleControls } = require('../namespace_reset_all5_composition_test.cjs');
const { createDocument } = require('./retrace_gui_dom_fixture.cjs');
const program = path.resolve(__dirname, '..', '..');
const pins = {
  'plugins/RETRACE.js': '366fcfab5c9f1406e67ee4f815414decac57fcaee63383eb217975d62faaf6ad',
  'server/server.cjs': '330d7d2e274a72dce47fce6af7ae7cfb0208c0be674d6fe0202cdd5472a5f852',
  'server/core/namespace-reset.cjs': 'b1ea65c195f35fc541d955b95b26a6b64f10cae70573c259ffe318e73d08ce68'
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeout = 10000) => {
  const until = Date.now() + timeout;
  do { const result = await predicate(); if (result) return result; await delay(10); } while (Date.now() < until);
  throw new Error('fixture_deadline:' + label);
};
const plain = value => JSON.parse(JSON.stringify(value));
let executionBase = '38946c7afa0b7db79d864e37f90762035dd776be';
let sourcePhase = 'immutable-baseline';
const receipt = value => JSON.parse(JSON.stringify(value, (key, entry) => /^(authorization|token)$/i.test(key) ? '<synthetic credential omitted>' : entry));
async function bounded(promise, label, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('fixture_deadline:' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function verifySources() {
  let selected = pins;
  if (process.env.RESET_COMPOSITION_SOURCE_PINS) {
    const artifacts = [
      ['reset-resume-fix', 'physical-reset-admission-v2'],
      ['reset-resume-history-check', 'physical-reset-admission-v2-history-check']
    ].map(([folder, phase]) => ({ file: path.resolve(program, '..', '..', 'work', folder, 'CANDIDATE_SOURCE_PINS.json'), phase }));
    const artifact = artifacts.find(row => row.file === path.resolve(process.env.RESET_COMPOSITION_SOURCE_PINS));
    assert.ok(artifact, 'only exact allowlisted candidate pin artifact accepted');
    const allowed = artifact.file;
    const manifest = JSON.parse(fs.readFileSync(allowed));
    assert.equal(manifest.phase, artifact.phase);
    assert.match(manifest.base, /^[0-9a-f]{40}$/, 'explicit immutable candidate base');
    executionBase = manifest.base;
    sourcePhase = manifest.phase;
    assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(pins).sort(), 'exact three executed source pins');
    selected = manifest.files;
  }
  return Object.fromEntries(Object.entries(selected).map(([file, expected]) => {
    const bytes = fs.readFileSync(path.join(program, file));
    const actual = hash(bytes);
    if (expected) assert.equal(actual, expected, 'immutable 389 source: ' + file);
    return [file, { bytes: bytes.length, sha256: actual }];
  }));
}
function store() {
  const values = new Map([['reset-composition-local-canary', 'LOCAL-OWNER-KEEP']]);
  return { values, async getItem(key) { return values.get(String(key)) ?? null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; }, async keys() { return [...values.keys()]; } };
}
async function bootRetrace(url) {
  const document = createDocument(), callbacks = new Map(), unload = [], listeners = new Map();
  const timers = new Set(), intervals = new Set(), trace = [], errors = [];
  const pluginStorage = store(), local = store();
  const character = { id: 'reset-fixture-char', chaId: 'reset-fixture-char', name: 'Synthetic', chats: [{ id: 'reset-fixture-chat', message: [], messages: [] }] };
  let providerCalls = 0;
  const transport = async (target, init = {}) => {
    const parsed = new URL(String(target));
    assert.equal(parsed.hostname, '127.0.0.1', 'fixture accepts only its loopback server');
    assert.equal(parsed.origin, url, 'fixture accepts only exact synthetic server origin');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const record = { method: init.method || 'GET', route: parsed.pathname, body, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    trace.push(record);
    const response = await fetch(target, { ...init, signal: init.signal || AbortSignal.timeout(10000) });
    record.status = response.status;
    try { record.response = await response.clone().json(); } catch (_) {}
    return response;
  };
  const host = {
    pluginStorage, safeLocalStorage: local,
    async getLocalPluginStorage() { return local; },
    async getArgument(name) { if (String(name).includes('memory_suite_server_url')) return url; if (String(name).includes('memory_suite_server_mode')) return 'plugin_only'; return ''; },
    async getArg(name) { return host.getArgument(name); }, async setArgument() { return true; },
    nativeFetch: transport,
    async addPluginChannelListener(channel, callback) { const rows = listeners.get(channel) || new Set(); rows.add(callback); listeners.set(channel, rows); return { channel, callback }; },
    async removePluginChannelListener(channel, callback) { listeners.get(channel)?.delete(callback); return true; },
    async removePluginChannelHandler(channel, callback) { return host.removePluginChannelListener(channel, callback); },
    async offPluginChannelMessage(channel, callback) { return host.removePluginChannelListener(channel, callback); },
    async postPluginChannelMessage() { return true; },
    async onUnload(callback) { unload.push(callback); return true; },
    async registerSetting(name, callback, icon, type, id) { callbacks.set(id, callback); return { id }; },
    async registerButton(options, callback) { callbacks.set(options.id, callback); return { id: options.id }; },
    async unregisterUIPart(id) { callbacks.delete(id); return true; },
    async getDatabase(fields) { const db = { personas: [], selectedPersona: '', characters: [character], plugins: [] }; return Array.isArray(fields) ? Object.fromEntries(fields.map(name => [name, db[name] ?? null])) : db; },
    async setDatabase() { return true; }, async getCharacter() { return character; }, async getCharacterFromIndex() { return character; },
    async getChat() { return character.chats[0]; }, async getCurrentChat() { return character.chats[0]; }, async getChatFromIndex() { return character.chats[0]; },
    async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
    async getRootContainer() { return null; }, async getPluginRoot() { return null; }, async showContainer() { return true; }, async hideContainer() { return true; },
    async runLLMModel() { providerCalls++; throw new Error('model_forbidden'); }, async runEmbedding() { providerCalls++; throw new Error('embedding_forbidden'); }
  };
  const cleanup = async () => {
    for (const callback of unload.slice().reverse()) await callback();
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
    timers.clear(); intervals.clear();
    assert.equal(callbacks.size, 0, 'registered UI disposed');
    assert.equal(pluginStorage.values.get('reset-composition-local-canary'), 'LOCAL-OWNER-KEEP', 'plugin-local owner data preserved');
    assert.equal(local.values.get('reset-composition-local-canary'), 'LOCAL-OWNER-KEEP', 'local owner data preserved');
    assert.equal(providerCalls, 0, 'provider calls zero');
  };
  const context = vm.createContext({ risuai: host, document,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) => { if (name === 'error') errors.push(args.map(String).join(' ')); }])),
    setTimeout(fn, ms, ...args) { const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    setInterval(fn, ms, ...args) { const timer = setInterval(fn, ms, ...args); intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); clearInterval(timer); },
    queueMicrotask, AbortController, AbortSignal, DOMException, URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, structuredClone, performance, fetch: transport, Headers, Request, Response, FormData, Blob, atob, btoa,
    confirm: () => true, alert() {}, prompt: () => null
  });
  try {
    vm.runInContext(fs.readFileSync(path.join(program, 'plugins', 'RETRACE.js'), 'utf8'), context, { filename: 'RETRACE.js' });
    const entry = await waitFor(() => callbacks.get('retrace-main-hamburger'), 'registered RETRACE entry');
    await entry();
    const root = document.querySelector('#flashback-hayaku-bridge-root');
    assert.ok(root?.isConnected, 'actual registered callback mounts production shell');
    const tab = root.querySelector('[data-tab="serverdata"]');
    await tab.emit('click');
    assert.equal(tab.getAttribute('aria-selected'), 'true', 'actual server data tab selected');
    return { root, trace, cleanup, errors, get providerCalls() { return providerCalls; } };
  } catch (error) { await cleanup(); throw error; }
}
async function publicReset(ui, { target = 'all', cancel = false, onConfirm, withoutBackup = false } = {}) {
  ui.root.querySelector('#serverResetTarget').value = target;
  ui.root.querySelector('#serverResetNoBackup').checked = withoutBackup;
  const action = ui.root.querySelector('#serverResetBegin');
  const completed = action.emit('click');
  await waitFor(() => !ui.root.querySelector('#retraceDialogLayer').hidden, 'actual reset confirmation');
  const plan = ui.trace.filter(row => row.route === '/v1/manager/reset/plan').at(-1)?.response?.result;
  assert.ok(plan?.id, 'actual plan response reaches public dialog');
  if (onConfirm) await onConfirm(plan);
  await ui.root.querySelector(cancel ? '#retraceDialogCancel' : '#retraceDialogConfirm').emit('click');
  await bounded(completed, 'reset action');
  assert.equal(action.disabled, false, 'public action lifetime releases busy button');
  return { plan, status: ui.root.querySelector('#serverResetStatus').textContent,
    requests: ui.trace.filter(row => row.route.startsWith('/v1/manager/reset/')) };
}
const canaryFiles = ['config/unrelated-runtime.json', 'runtime/other-owner/state.bin'];
function seed(app, dataDir) {
  for (const ns of NAMESPACES) {
    const repo = app.repositories[ns];
    let id = 0;
    for (const [space, key] of [['plugin', 'reset-fixture-live'], ['local', 'reset-fixture-local'], ['plugin', 'reset-fixture-deleted']]) {
      repo.mutate({ kind: 'set', space, key, value: { namespace: ns, space, content: 'KEEP-UNTIL-RESET' }, operationId: `${ns}_all5_seed_${++id}_000000`, expectedRevision: 0 });
    }
    repo.mutate({ kind: 'remove', space: 'plugin', key: 'reset-fixture-deleted', operationId: `${ns}_all5_remove_000000`, expectedRevision: 1 });
  }
  const catalog = { schema: 'memory-suite.scope-catalog.v1', namespaces: Object.fromEntries(NAMESPACES.map(ns => [ns, { 'fixture-scope': { scopeId: 'fixture-scope', namespace: ns, fixture: true } }])) };
  for (const name of ['scope-catalog.json', 'scope-catalog.previous.json']) fs.writeFileSync(path.join(dataDir, 'config', name), JSON.stringify(catalog) + '\n');
  for (const file of canaryFiles) { const target = path.join(dataDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'UNRELATED-RUNTIME-' + file); }
}
function snapshot(dataDir, app) {
  const stores = {};
  for (const ns of NAMESPACES) {
    const db = app?.repositories[ns].database || new DatabaseSync(path.join(dataDir, 'stores', ns, ns + '.sqlite'), { readOnly: true });
    try { stores[ns] = plain({ kv: db.prepare('SELECT * FROM kv ORDER BY space,key').all(), operations: db.prepare('SELECT * FROM operations ORDER BY operation_id').all() }); }
    finally { if (!app) db.close(); }
  }
  const journalFile = path.join(dataDir, 'config', 'namespace-reset.json');
  return { stores, journal: fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile)) : { epochs: {}, pending: null },
    catalogs: ['scope-catalog.json', 'scope-catalog.previous.json'].map(file => JSON.parse(fs.readFileSync(path.join(dataDir, 'config', file)))),
    canaries: Object.fromEntries(canaryFiles.map(file => [file, hash(fs.readFileSync(path.join(dataDir, file)))])) };
}
async function call(url, route, body, plugin = 'flashback_hayaku_bridge', token, epochs, dataInstanceId) {
  const response = await fetch(url + route, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Memory-Suite-Plugin': plugin,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(epochs ? { 'X-Memory-Suite-Reset-Epochs': JSON.stringify(epochs) } : {}),
      ...(dataInstanceId ? { 'X-Memory-Suite-Data-Instance': dataInstanceId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json() };
}
async function appAt(dataDir, port = 0) {
  const { createMemorySuiteServer } = require('../../server/server.cjs');
  const app = createMemorySuiteServer({ host: '127.0.0.1', port, dataDir, autoBackup: false });
  const address = await app.listen();
  return { app, url: 'http://127.0.0.1:' + address.port, port: address.port };
}
function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'LIB-all5-reset-composition-')); }
function removeRoot(root) {
  assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'cleanup exact Temp child');
  assert.ok(path.basename(root).startsWith('LIB-all5-reset-composition-'), 'cleanup task-owned root');
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false, 'synthetic DATA removed');
}
async function publicCase() {
  const root = tempRoot(), dataDir = path.join(root, 'DATA'); let active, ui;
  try {
    active = await appAt(dataDir); seed(active.app, dataDir);
    const before = snapshot(dataDir, active.app);
    ui = await bootRetrace(active.url);
    const cancel = await publicReset(ui, { cancel: true });
    assert.equal(cancel.requests.filter(row => row.route.endsWith('/execute')).length, 0, 'cancel sends no reset execute');
    assert.deepEqual(snapshot(dataDir, active.app), before, 'cancel leaves KV/operations/epochs/journal/catalog/canary exact');
    const manager = (await call(active.url, '/bootstrap')).data;
    const rejected = await call(active.url, '/v1/manager/reset/execute', { planId: cancel.plan.id, confirmation: 'WRONG' }, 'flashback_hayaku_bridge', manager.token);
    assert.notEqual(rejected.status, 200, 'wrong confirmation rejected');
    assert.deepEqual(snapshot(dataDir, active.app), before, 'wrong confirmation performs zero reset mutations');
    const result = await publicReset(ui, { target: process.env.RESET_COMPOSITION_RED_TARGET || 'all' });
    const after = snapshot(dataDir, active.app);
    try {
      assert.deepEqual(result.plan.namespaces, [...NAMESPACES].sort(), 'public target all plans exact five namespaces');
      assertCompleted(after, NAMESPACES, before);
    } catch (error) { error.fixtureEvidence = { case: 'controlled-different-public-target', selected: process.env.RESET_COMPOSITION_RED_TARGET, before, after, result }; throw error; }
    const execute = result.requests.filter(row => row.route.endsWith('/execute')).at(-1);
    assert.equal(execute.response.result.id, result.plan.id, 'public plan/execute/durable journal execution ID exact');
    assert.equal(execute.headers['x-memory-suite-data-instance'], manager.dataInstanceId, 'public execute bound to actual physical DATA');
    assert.equal(result.requests.filter(row => row.route.endsWith('/plan')).at(-1).headers['x-memory-suite-data-instance'], manager.dataInstanceId, 'public plan bound to same physical DATA');
    assert.equal(after.journal.last.id, result.plan.id, 'persisted history bound to same execution ID');
    if (process.env.RESET_COMPOSITION_SOURCE_PINS) {
      assert.equal(after.journal.last.schema, 'memory-suite.namespace-reset-job.v2', 'actual public producer versioned job');
      assert.equal(after.journal.last.dataInstanceId, manager.dataInstanceId, 'public execution and durable job bind same actual physical DATA');
      assert.equal(after.journal.last.dataIdentityContract, 'memory-suite.physical-data-identity.v1');
    }
    assert.ok(after.journal.last.backupId, 'actual pre-reset backup verified');
    assert.equal(execute.body.withoutBackup, false, 'public backup choice preserved');
    assert.match(result.status, /초기화 및 빈 상태 확인 완료/, 'actual public success status');
    await ui.cleanup(); ui = null;
    await active.app.close(); active = null;
    active = await appAt(dataDir);
    const restarted = snapshot(dataDir, active.app);
    assertCompleted(restarted, NAMESPACES, before);
    assert.deepEqual(restarted, after, 'actual server restart reads identical reset result');
    return { case: 'public-all5', cancel, wrongConfirmation: rejected, result, before, after, restarted };
  } finally { if (ui) await ui.cleanup(); if (active) await active.app.close(); removeRoot(root); }
}

async function run() {
  const sources = verifySources(); oracleControls();
  const requested = process.env.RESET_COMPOSITION_CASE || 'public';
  const watchdog = setTimeout(() => { console.error('parent_fixture_deadline'); process.exit(124); }, 120000);
  try {
    const result = requested === 'public' ? await publicCase() : await require('./namespace_reset_process_fixture.cjs').runCase(requested, { seed, snapshot, call, appAt, tempRoot, removeRoot, NAMESPACES, assertCompleted, bootRetrace, publicReset, hash, waitFor });
    const evidence = { base: executionBase, historicalBaseline: '38946c7afa0b7db79d864e37f90762035dd776be', sourcePhase, sources, ...result,
      scope: { unchangedProducts: true, actualModelCalls: 0, actualEmbeddingCalls: 0, externalNetworkCalls: 0, installedNativeGui: 'UNRUN', fivePluginRefresh: 'UNRUN' } };
    if (process.env.RESET_COMPOSITION_EVIDENCE) fs.writeFileSync(process.env.RESET_COMPOSITION_EVIDENCE, JSON.stringify(receipt(evidence), null, 2) + '\n');
    if (result.blocked) throw new Error(result.blocked);
    console.log('reset_composition_' + requested + ': PASS');
  } catch (error) {
    if (error.fixtureEvidence && process.env.RESET_COMPOSITION_EVIDENCE) fs.writeFileSync(process.env.RESET_COMPOSITION_EVIDENCE, JSON.stringify(receipt({ base: '38946c7afa0b7db79d864e37f90762035dd776be', sources, error: String(error.message), ...error.fixtureEvidence }), null, 2) + '\n');
    throw error;
  } finally { clearTimeout(watchdog); }
}
module.exports = { run, bootRetrace, publicReset, seed, snapshot, call, appAt, tempRoot, removeRoot };
