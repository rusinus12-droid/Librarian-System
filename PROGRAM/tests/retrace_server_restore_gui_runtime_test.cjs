'use strict';

// Actual RETRACE registration/click/render/bridge/backup/restore code, real
// loopback HTTP server and SQLite files. The host and DOM are test fixtures.
// The seam only observes runtime state; it never replaces a producer/action.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { DatabaseSync } = require('node:sqlite');
const source = fs.readFileSync(process.env.RETRACE_SOURCE_FILE || path.join(__dirname, '../plugins/RETRACE.js'), 'utf8');
const marker = '  const RetraceApi = Object.freeze({';
assert.equal(source.split(marker).length, 2, 'unique read-only audit boundary');
let audited = source.replace(marker,
  '  globalThis.__retraceRestoreAudit = { state: () => clone({control:Runtime.serverControl,visible:Runtime.visible,busy:Runtime.busy,activeTab:Runtime.activeTab,scopeLoading:Runtime.serverScopeManagerLoading}), bridge:MemorySuiteStorageBridge };\n' + marker);
audited = audited.replace('if(readset!==latest){state.plan=null;', 'if(readset!==latest){globalThis.__recordReadset?.({readset:JSON.parse(readset),latest:JSON.parse(latest)});state.plan=null;');
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const trace = value => { if (process.env.RETRACE_TRACE_FILE) fs.appendFileSync(process.env.RETRACE_TRACE_FILE, value + '\n'); };
const waitFor = async (read, label, timeout = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timeout: ' + label);
};
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
function store(entries = []) {
  const rows = new Map(entries);
  return { rows, async getItem(key) { return rows.get(String(key)) ?? null; },
    async setItem(key, value) { rows.set(String(key), value); return true; },
    async removeItem(key) { rows.delete(String(key)); return true; }, async keys() { return [...rows.keys()]; } };
}
async function controlFaultProxy(serverUrl) {
  let refuseStatus = false, heldHistory = null;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=Buffer.concat(chunks),headers={...req.headers},route=new URL(req.url,serverUrl).pathname;
      delete headers.host;delete headers['transfer-encoding'];
      if(refuseStatus&&route==='/v1/manager/control/status'){
        refuseStatus=false;requests.push({route,status:400,error:'fixture_status_refused'});
        res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture_status_refused'}));return;
      }
      const response=await fetch(serverUrl+req.url,{method:req.method,headers,...(body.length?{body}:{}),redirect:'manual'});
      const text=await response.text();requests.push({route,status:response.status});
      if(heldHistory&&route==='/v1/manager/control/history'){
        const gate=heldHistory;heldHistory=null;gate.captured=JSON.parse(text);gate.entered.resolve();await gate.release.promise;
      }
      res.writeHead(response.status,{'Content-Type':'application/json'});res.end(text);
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+server.address().port,requests,refuseStatusOnce(){refuseStatus=true;},
    holdHistory(){heldHistory={entered:deferred(),release:deferred(),captured:null};return heldHistory;},
    async close(){heldHistory?.release.resolve();await new Promise(resolve=>server.close(resolve));}};
}
async function realm(baseUrl, sourceHost) {
  const callbacks = new Map(), unloads = [], timers = new Set(), intervals = new Set();
  const pluginStorage = store([['fixture_original_bytes', JSON.stringify(sourceHost)]]), safeLocalStorage = store();
  const args = { memory_suite_server_mode: 'plugin_only', memory_suite_server_url: baseUrl };
  const requests = [];
  let held = null, modelCalls = 0, selection = 'present';
  const readsetDrifts = [];
  const host = {
    pluginStorage, safeLocalStorage,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) { return args[name] ?? ''; },
    async setArgument(name, value) { args[name] = String(value); return true; },
    async nativeFetch(url, init) {
      assert.equal(new URL(String(url)).origin, baseUrl, 'transport is confined to the isolated server');
      const response = await fetch(url, init);
      requests.push({ route: new URL(String(url)).pathname, status: response.status });
      if (held && !held.captured && new URL(String(url)).pathname === '/v1/manager/control/status' && ++held.statusSeen === held.ordinal) {
        const item = held;
        item.captured = await response.clone().json();
        item.entered.resolve();
        await item.release.promise;
        item.delivered = true;
      }
      return response;
    },
    async getDatabase(fields) { return Array.isArray(fields) ? Object.fromEntries(fields.map(key => [key, sourceHost[key] ?? null])) : sourceHost; },
    async getCurrentCharacterIndex() { if(selection==='read-failure')throw new Error('fixture_native_selection_read_failure');return selection==='absent'?null:0; },
    async getCurrentChatIndex() { return selection==='no-chat'?-1:0; },
    async getCharacterFromIndex() { return selection==='malformed'?{}:sourceHost.characters[0]; },
    async getChatFromIndex() { return sourceHost.characters[0].chats[0]; },
    async getCharacter() { if(selection==='read-failure')throw new Error('fixture_native_selection_read_failure');return selection==='absent'?null:sourceHost.characters[0]; },
    async getChat() { return selection==='no-chat'?null:sourceHost.characters[0].chats[0]; },
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'web', saveMethod: 'local' }; },
    async registerSetting(_name, callback, _icon, _type, id) { callbacks.set(id, callback); return { id }; },
    async registerButton(options, callback) { callbacks.set(options.id, callback); return { id: options.id }; },
    async unregisterUIPart(id) { callbacks.delete(id); return true; },
    async onUnload(callback) { unloads.push(callback); return true; },
    async addPluginChannelListener() { return true; }, async removePluginChannelListener() { return true; },
    async postPluginChannelMessage() { return false; },
    async showContainer() { return true; }, async hideContainer() { return true; },
    async runLLMModel() { modelCalls++; throw new Error('model calls are forbidden'); }
  };
  const virtualConsole = new VirtualConsole();
  const domErrors = [];
  virtualConsole.on('jsdomError', error => { if (error.type !== 'css-parsing') domErrors.push(error.message); });
  const dom = new JSDOM('<!doctype html><body></body>', { url: baseUrl, virtualConsole });
  const context = vm.createContext({ __recordReadset: value => readsetDrifts.push(value), risuai: host, Risuai: host, document: dom.window.document,
    window: dom.window, navigator: { language: 'en-US' }, console: { log() {}, info() {}, warn() {}, debug() {}, error: console.error },
    setTimeout(fn, delay, ...values) { const timer = setTimeout(() => { timers.delete(timer); fn(...values); }, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    setInterval(fn, delay, ...values) { const timer = setInterval(fn, delay, ...values); intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); clearInterval(timer); },
    // Risu supplies nativeFetch. Browser-global fetch is absent in this host,
    // so the optional release notice cannot make an external request.
    fetch: undefined, queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, AbortSignal, DOMException, Headers, Request, Response, Blob, FormData,
    crypto: globalThis.crypto, structuredClone, atob, btoa, performance,
    Event: dom.window.Event, confirm: () => false, alert() {} });
  vm.runInContext(audited, context, { filename: 'RETRACE.js' });
  await waitFor(() => context.__RETRACE && unloads.length && callbacks.size === 2, 'full plugin startup and registration');
  const audit = context.__retraceRestoreAudit;
  const document = dom.window.document;
  const open = async () => { await callbacks.get('retrace-main-hamburger')(); return document.querySelector('#flashback-hayaku-bridge-root'); };
  return { context, document, window: dom.window, audit, callbacks, requests, domErrors, readsetDrifts, pluginStorage, open,
    selection(value) { selection = value; },
    holdStatus(ordinal = 1) { held = { entered: deferred(), release: deferred(), captured: null, delivered: false, ordinal, statusSeen: 0 }; return held; },
    async close() {
      held?.release.resolve();
      for (const unload of unloads.slice().reverse()) await unload();
      for (const timer of timers) clearTimeout(timer);
      for (const timer of intervals) clearInterval(timer);
      dom.window.close();
    }, modelCalls: () => modelCalls };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrace-registered-restore-'));
  let app, env, url, faultProxy, partialHeld;
  const start = async () => {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeEnabled: false });
    const address = await app.listen(); url = `http://127.0.0.1:${address.port}`;
  };
  const sourceHost = { characters: [{ id: 'restore-source-character', chaId: 'restore-source-character', name: 'Original', chatPage: 0,
    chats: [{ id: 'restore-source-chat', chatId: 'restore-source-chat', name: 'Original', message: [{ role: 'user', data: 'unchanged original raw text' }] }] }],
    personas: [], selectedPersona: '', plugins: [] };
  const originalHash = sha(sourceHost);
  const payload = { id: 'record-001', scopeKey: 'restore-source-chat', text: 'archive original text', hash: 'stable-fixture-hash', sessionEpoch: 0,
    inheritedSessionHistory: false, turnStart: 1, turnEnd: 1, schema: 'fixture-namespace-record.v1' };
  const key = 'hayaku.v2.ledger.restore-source-chat', untouchedKey = 'libra:v1:restore-unselected';
  const boot = async plugin => (await (await fetch(url + '/bootstrap', { headers: { 'X-Memory-Suite-Plugin': plugin } })).json());
  const ownerRead = async (connection, method = 'GET') => {
    const response = await fetch(url + (method === 'GET' ? '/v1/kv/get?namespace=hayaku&space=plugin&key=' + encodeURIComponent(key) : '/v1/kv/set'), {
      method, headers: { Authorization: 'Bearer ' + connection.token, 'X-Memory-Suite-Plugin': 'hayaku_locator_continuity',
        'X-Memory-Suite-Reset-Epochs': JSON.stringify(connection.resetEpochs), 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ namespace: 'hayaku', space: 'plugin', key, value: { text: 'stale overwrite' },
        expectedRevision: 1, operationId: 'retrace_old_epoch_write_001' }) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await start();
    trace('server started');
    app.repositories.hayaku.mutate({ kind: 'set', space: 'plugin', key, value: payload, expectedRevision: 0, operationId: 'retrace_restore_seed_001' });
    app.repositories.libra.mutate({ kind: 'set', space: 'plugin', key: untouchedKey, value: { original: true, text: 'unselected namespace' }, expectedRevision: 0, operationId: 'retrace_restore_unselected_001' });
    const untouched = app.repositories.libra.get('plugin', untouchedKey);
    const oldOwner = await boot('hayaku_locator_continuity');
    env = await realm(url, sourceHost);
    trace('plugin started');
    let root = await env.open();
    root.querySelector('[data-tab="serverdata"]').click();
    await waitFor(() => env.audit.state().control?.status && !env.audit.state().scopeLoading, 'registered server tab refresh').catch(error => {
      console.error(JSON.stringify({boundary:'initial-readset',drifts:env.readsetDrifts,state:env.audit.state()})); throw error;
    });
    trace('server tab refreshed');
    root.querySelector('[data-server-page="backups"]').click();
    const click = action => {
      const button = root.querySelector('[data-server-control="' + action + '"]');
      assert.ok(button && !button.disabled, action + ' is an enabled bound control'); button.click();
    };
    click('backup-create');
    await waitFor(() => !env.audit.state().busy && env.audit.state().control?.backups?.length === 1, 'GUI backup result');
    assert.equal(root.querySelector('#job-backup').hidden,false,'manager backup opens its named job dialog');
    assert.match(root.querySelector('#job-backup [data-job-result]').textContent,/백업 생성 완료:/,'job result is the real manager response');
    root.querySelector('#job-backup [data-job-hide]').click();
    const backupId = root.querySelector('#serverControlBackups').value;
    assert.ok(backupId, 'GUI selects its created backup');
    root.querySelector('[data-control-namespace][value="hayaku"]').checked = true;
    app.repositories.hayaku.mutate({ kind: 'set', space: 'plugin', key, value: { ...payload, text: 'later server value', sessionEpoch: 1 }, expectedRevision: 1, operationId: 'retrace_restore_later_001' });
    click('restore-plan');
    await waitFor(() => !env.audit.state().busy && env.audit.state().control?.plan, 'GUI restore preview');
    assert.equal(app.repositories.hayaku.get('plugin', key).value.text, 'later server value', 'preview leaves durable data unchanged');
    click('restore-execute');
    await waitFor(() => !root.querySelector('#dlg-restore').hidden, 'real confirmation dialog');
    root.querySelector('#dlg-restore [data-dialog-cancel]').click();
    assert.equal(app.repositories.hayaku.get('plugin', key).value.text, 'later server value', 'cancel leaves durable data unchanged');
    const firstPlanId = env.audit.state().control.plan.planId;

    const held = env.holdStatus();
    root.querySelector('#refreshActiveTab').click();
    await waitFor(() => held.captured, 'held pre-restore status received');
    trace('held pre-restore status');
    assert.equal(held.captured.result.resetEpochs.hayaku, oldOwner.resetEpochs.hayaku, 'held reply physically predates restore');
    // This unit owns the server-control result fence. Finish the independent
    // namespace scanner before restoring; its concurrent reset-refusal/SDK
    // availability classification defect has a separate preserved HTTP probe.
    await waitFor(() => !env.audit.state().scopeLoading, 'pre-restore namespace scan settled');
    // The real server invalidates previews when that scanner changes its scope
    // index. Obtain a new preview instead of bypassing the server's stale-plan gate.
    click('restore-plan');
    await waitFor(() => !env.audit.state().busy && env.audit.state().control?.plan?.planId !== firstPlanId && env.audit.state().control?.plan, 'fresh preview after namespace scan');
    click('restore-execute');
    await waitFor(() => !root.querySelector('#dlg-restore').hidden, 'restore confirmation reopened');
    root.querySelector('#dlg-restore [data-dialog-typed-input]').value='복원';root.querySelector('#dlg-restore [data-dialog-typed-input]').dispatchEvent(new env.window.Event('input',{bubbles:true}));root.querySelector('#dlg-restore [data-dialog-confirm]').click();
    await waitFor(() => !env.audit.state().busy && env.audit.state().control?.history?.some(row => row.action === 'restore-execute' && row.status === 'complete'), 'GUI restore and current history').catch(error => {
      console.error(JSON.stringify({boundary:'post-restore-readset',drifts:env.readsetDrifts,state:env.audit.state(),requests:env.requests.slice(-12)})); throw error;
    });
    assert.equal(root.querySelector('#job-restore').hidden,false,'confirmed manager restore opens its named job dialog');
    assert.equal(root.querySelectorAll('#job-restore [data-job-steps] .step').length,3,'canonical restore steps retained');
    assert.equal(root.querySelectorAll('#job-restore [data-job-result] .res').length,2,'canonical restored/kept owner rows retained');
    assert.match(root.querySelector('#job-restore [data-job-result]').textContent,/hayaku/,'canonical job target row reflects actual restored owner');
    assert.match(root.querySelector('#job-restore [data-job-response]').textContent,/복원 완료:/,'collapsed actual manager response retained');
    root.querySelector('#job-restore [data-job-hide]').click();
    trace('restore completed');
    assert.deepEqual(app.repositories.hayaku.get('plugin', key).value, payload, 'exact server physical readback after registered restore');
    assert.deepEqual(app.repositories.libra.get('plugin', untouchedKey), untouched, 'unselected namespace remains byte-equivalent');
    const current = env.audit.state().control;
    assert.equal(current.status.resetEpochs.hayaku, Number(oldOwner.resetEpochs.hayaku || 0) + 1, 'GUI post-restore status is on the new epoch');
    assert.deepEqual([...current.reconnect], ['hayaku']);
    assert.equal(root.querySelector('#serverControlReconnect').hidden, false, 'GUI visibly requires owner reconnection');
    const renderedHistory = root.querySelector('#serverControlHistory').textContent;
    assert.match(root.querySelector('#serverControlResult').textContent, /\uBCF5\uC6D0 \uC644\uB8CC/, 'GUI renders restore completion only after server reply');
    held.release.resolve();
    await waitFor(() => held.delivered, 'held real HTTP reply delivered');
    // The promise continuation settles before this event-loop observation.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.audit.state().control.status.resetEpochs.hayaku, current.status.resetEpochs.hayaku,
      'late pre-restore HTTP status cannot overwrite current GUI epoch');
    assert.equal(root.querySelector('#serverControlHistory').textContent, renderedHistory, 'late refresh preserves current rendered restore history');
    trace('late status checked');
    const fencedRead = await ownerRead(oldOwner), fencedWrite = await ownerRead(oldOwner, 'POST');
    assert.equal(fencedRead.status, 409, 'old owner read is fenced after GUI restore');
    assert.equal(fencedWrite.status, 409, 'old owner cannot overwrite the restored record');
    const currentOwner = await boot('hayaku_locator_continuity');
    assert.deepEqual((await ownerRead(currentOwner)).body.result.value, payload, 'fresh owner HTTP readback matches every restored field');
    assert.equal(sha(sourceHost), originalHash, 'mock host original source is immutable');
    assert.equal(env.pluginStorage.rows.get('fixture_original_bytes'), JSON.stringify(sourceHost), 'plugin-only original marker bytes are unchanged');

    assert.equal(env.modelCalls(), 0);
    assert.deepEqual(env.domErrors, [], 'no DOM runtime errors');
    await env.close(); env = null;
    trace('plugin closed');
    await app.close(); app = null;
    trace('server closed');
    await start();
    assert.deepEqual(app.repositories.hayaku.get('plugin', key).value, payload, 'SQLite restart preserves exact restored fields');
    assert.deepEqual(app.repositories.libra.get('plugin', untouchedKey), untouched, 'restart preserves unselected namespace');
    const restartedOwner = await boot('hayaku_locator_continuity');
    assert.equal(restartedOwner.resetEpochs.hayaku, currentOwner.resetEpochs.hayaku);
    assert.deepEqual((await ownerRead(restartedOwner)).body.result.value, payload, 'restart fresh owner readback');
    env = await realm(url, sourceHost); root = await env.open();
    root.querySelector('[data-tab="serverdata"]').click();
    await waitFor(() => env.audit.state().control?.history?.some(row => row.action === 'restore-execute' && row.status === 'complete'), 'fresh plugin registered GUI reads durable restore history');
    assert.equal(env.audit.state().control.status.resetEpochs.hayaku, currentOwner.resetEpochs.hayaku);
    assert.equal(sha(sourceHost), originalHash);
    assert.equal(env.modelCalls(), 0);
    await waitFor(() => !env.audit.state().scopeLoading, 'fresh runtime namespace scan settled');
    const profileHeld = env.holdStatus(2);
    root.querySelector('#refreshActiveTab').click();
    await waitFor(() => profileHeld.captured, 'final HTTP authority reply held before publication');
    await waitFor(() => !env.audit.state().scopeLoading, 'profile test namespace scan settled');
    sourceHost.characters[0].chats[0].bindedPersona = 'replacement-profile';
    profileHeld.release.resolve();
    await waitFor(() => env.audit.state().control?.errors?.some(error => error.includes('\uC870\uD68C \uB300\uC0C1\uC774 \uBCC0\uACBD')), 'actual host profile drift rejects the old readset');
    assert.equal(env.audit.state().control.status, undefined, 'old HTTP status is not published in the replacement profile');
    assert.equal(env.audit.state().control.backups, undefined);
    assert.equal(env.audit.state().control.history, undefined);
    delete sourceHost.characters[0].chats[0].bindedPersona;
    root.querySelector('#refreshActiveTab').click();
    await waitFor(() => env.audit.state().control?.status && !env.audit.state().scopeLoading, 'original profile fresh readset');
    assert.equal(sha(sourceHost), originalHash, 'profile control restores the exact original host bytes');
    for(const selection of ['absent','no-chat']){
      env.selection(selection);
      const globalHeld=env.holdStatus(2);
      root.querySelector('#refreshActiveTab').click();
      await waitFor(()=>globalHeld.captured,'native '+selection+' global status reaches the real HTTP authority');
      assert.equal(globalHeld.captured.result.resetEpochs.hayaku,currentOwner.resetEpochs.hayaku);
      globalHeld.release.resolve();
      await waitFor(()=>!env.audit.state().control.loading&&!env.audit.state().scopeLoading,'native '+selection+' global control completes');
      assert.equal(env.audit.state().control.status.resetEpochs.hayaku,currentOwner.resetEpochs.hayaku);
      assert.equal(env.audit.state().control.errors.length,0,'explicit native absence is a valid global readset');
      assert.ok(env.audit.state().control.history.some(row=>row.action==='restore-execute'&&row.status==='complete'));
    }
    const absenceHeld=env.holdStatus(2);
    root.querySelector('#refreshActiveTab').click();
    await waitFor(()=>absenceHeld.captured,'no-chat final authority held');
    await waitFor(()=>!env.audit.state().scopeLoading,'absence transition scanner settled');
    env.selection('present');absenceHeld.release.resolve();
    await waitFor(()=>env.audit.state().control.errors?.some(error=>error.includes('\uC870\uD68C \uB300\uC0C1\uC774 \uBCC0\uACBD')),'actual no-chat to selected transition rejects pending HTTP readset');
    assert.equal(env.audit.state().control.status,undefined);
    for(const selection of ['read-failure','malformed']){
      env.selection(selection);root.querySelector('#refreshActiveTab').click();
      await waitFor(()=>!env.audit.state().control.loading&&env.audit.state().control.errors?.length,'native '+selection+' control rejection');
      assert.equal(env.audit.state().control.status,undefined,'native failure never publishes an absent-selection result');
      assert.match(env.audit.state().control.errors.join('\n'),selection==='read-failure'?/fixture_native_selection_read_failure/:/\uC120\uD0DD \uC815\uBCF4/);
      await waitFor(()=>!env.audit.state().scopeLoading,'native '+selection+' scanner settles');
    }
    env.selection('present');root.querySelector('#refreshActiveTab').click();
    await waitFor(()=>env.audit.state().control.status&&!env.audit.state().scopeLoading,'fresh native selection after failure controls');
    assert.equal(sha(sourceHost),originalHash,'native selection controls never mutate original host bytes');
    const closeHeld = env.holdStatus();
    root.querySelector('#refreshActiveTab').click();
    await waitFor(() => closeHeld.captured, 'fresh runtime close status received');
    root.querySelector('#closeBridge').click();
    await waitFor(() => !env.audit.state().visible, 'actual close callback');
    const beforeCloseReply = JSON.stringify(env.audit.state().control);
    closeHeld.release.resolve();
    await waitFor(() => closeHeld.delivered, 'hidden reply delivered');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(env.audit.state().control), beforeCloseReply, 'closed GUI cannot publish a held refresh');
    await waitFor(() => !env.audit.state().scopeLoading, 'hidden scope scan settled');
    const unloadHeld = env.holdStatus();
    root = await env.open();
    await waitFor(() => unloadHeld.captured, 'remounted GUI pending status received');
    const beforeUnload = env.audit.state().control.status;
    const oldEnv = env;
    await env.close(); env = null;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(oldEnv.audit.state().control.status, beforeUnload, 'unloaded runtime does not accept its late response');
    assert.equal(oldEnv.callbacks.size, 0, 'real unload unregisters both GUI entries');
    faultProxy=await controlFaultProxy(url);env=await realm(faultProxy.url,sourceHost);root=await env.open();
    root.querySelector('[data-tab="serverdata"]').click();
    await waitFor(()=>env.audit.state().control?.status&&!env.audit.state().scopeLoading,'partial-batch fresh registered runtime');
    faultProxy.refuseStatusOnce();root.querySelector('#refreshActiveTab').click();
    await waitFor(()=>!env.audit.state().control.loading&&env.audit.state().control.errors?.some(error=>error.includes('fixture_status_refused'))&&!env.audit.state().scopeLoading,'stable initial-status refusal');
    assert.equal(env.audit.state().control.backups,undefined,'initial HTTP status refusal cannot certify even stable dependent backup observations');
    assert.equal(env.audit.state().control.history,undefined);assert.equal(env.audit.state().control.plan,null);
    root.querySelector('#refreshActiveTab').click();
    await waitFor(()=>env.audit.state().control?.status&&!env.audit.state().scopeLoading,'complete positive refresh after stable refusal');
    const beforePartialEpoch=env.audit.state().control.status.resetEpochs.hayaku;
    faultProxy.refuseStatusOnce();partialHeld=faultProxy.holdHistory();root.querySelector('#refreshActiveTab').click();
    await waitFor(()=>partialHeld.captured,'old real HTTP history held after initial status refusal');
    await waitFor(()=>!env.audit.state().scopeLoading,'partial-batch namespace scan settled');
    const partialPlan=await env.audit.bridge.managerControl('restore-plan',{backupId,namespaces:['hayaku']});
    await env.audit.bridge.managerControl('restore-execute',{operationId:'retrace_partial_restore_002',planId:partialPlan.planId,confirmation:'RESTORE '+partialPlan.planId});
    const currentAuthority=await env.audit.bridge.managerControl('status');
    const durableHistory=await env.audit.bridge.managerControl('history');
    assert.equal(currentAuthority.resetEpochs.hayaku,beforePartialEpoch+1,'actual restore increments the epoch while the old history response is held');
    assert.ok(durableHistory.some(row=>row.id==='retrace_partial_restore_002'&&row.status==='complete'));
    assert.ok(!partialHeld.captured.result.some(row=>row.id==='retrace_partial_restore_002'),'the held history physically predates this restore');
    const db=new DatabaseSync(path.join(dataDir,'stores','hayaku','hayaku.sqlite'),{readOnly:true});
    try{assert.deepEqual(JSON.parse(db.prepare('SELECT value_json FROM kv WHERE key=?').get(key).value_json),payload,'exact raw SQLite readback after partial-batch restore');}finally{db.close();}
    assert.deepEqual(app.repositories.libra.get('plugin',untouchedKey),untouched,'partial-batch restore preserves the unselected namespace');
    partialHeld.release.resolve();
    await waitFor(()=>!env.audit.state().control.loading&&env.audit.state().control.errors?.some(error=>error.includes('fixture_status_refused')),'uncertified partial batch refuses publication');
    assert.equal(env.audit.state().control.status,undefined);assert.equal(env.audit.state().control.backups,undefined);assert.equal(env.audit.state().control.history,undefined);assert.equal(env.audit.state().control.plan,null);
    assert.equal(faultProxy.requests.filter(row=>row.status===400).length,2,'both faults are actual loopback HTTP status refusals');
    root.querySelector('[data-server-page="data"]').click();
    root.querySelector('#serverResetTarget').value='hayaku';
    root.querySelector('#serverResetBegin').click();
    await waitFor(()=>!root.querySelector('#dlg-reset').hidden,'named reset confirmation');
    assert.equal(root.querySelector('#dlg-reset [data-dialog-summary-value]').textContent,'hayaku','reset dialog shows the captured namespace target');
    root.querySelector('#dlg-reset [data-dialog-typed-input]').value='초기화';
    root.querySelector('#dlg-reset [data-dialog-typed-input]').dispatchEvent(new env.window.Event('input',{bubbles:true}));
    assert.equal(root.querySelector('#dlg-reset [data-dialog-confirm]').disabled,false,'destructive confirmation requires the exact typed word');
    root.querySelector('#dlg-reset [data-dialog-confirm]').click();
    await waitFor(()=>root.querySelector('#serverResetStatus').textContent.includes('초기화 및 빈 상태 확인 완료'),'actual manager reset readback');
    assert.equal(root.querySelector('#job-reset').hidden,false,'reset operation displays its named result dialog');
    assert.equal(root.querySelectorAll('#job-reset [data-job-steps] .step').length,4,'canonical reset steps retained');
    assert.equal(root.querySelectorAll('#job-reset [data-job-result] .res').length,2,'canonical reset target/backup result rows retained');
    assert.match(root.querySelector('#job-reset [data-job-result]').textContent,/hayaku/,'reset target row retains captured owner');
    assert.match(root.querySelector('#job-reset [data-job-response]').textContent,/backupId/,'collapsed reset receipt retains actual backup id');
    const resetOwner=await boot('hayaku_locator_continuity');
    assert.equal(resetOwner.resetEpochs.hayaku,Number(currentAuthority.resetEpochs.hayaku||0)+1,'reset advances the owner reset epoch');
    const afterReset=await ownerRead(resetOwner);
    assert.equal(afterReset.body.result.exists,false,'fresh owner read confirms reset data is empty');
    root.querySelector('#job-reset [data-job-hide]').click();
    assert.equal(env.modelCalls(),0);assert.equal(sha(sourceHost),originalHash);assert.deepEqual(env.domErrors,[]);
    console.log(JSON.stringify({ test: 'retrace_server_restore_gui_runtime', result: 'PASS',
      registeredEntry: 'retrace-main-hamburger', namespace: 'hayaku', backupId,
      oldEpoch: Number(oldOwner.resetEpochs.hayaku || 0), restoredEpoch: currentOwner.resetEpochs.hayaku,
      partialBatchRestoredEpoch:currentAuthority.resetEpochs.hayaku,
      originalHostSha256: originalHash, restoredRecordSha256: sha(payload), modelCalls: 0,
      evidence: ['preview/cancel no mutation', 'confirmed physical restore', 'late HTTP status fenced in UI', 'closed UI response discarded',
        'old owner read/write 409', 'fresh HTTP field readback', 'unselected namespace invariant', 'SQLite/server/plugin restart', 'actual profile drift rejected after final HTTP await',
        'native null/no-chat global controls', 'native absence transition rejected', 'native throw/malformed rejected', 'unload response discarded',
        'stable initial HTTP status refusal rejects dependent batch', 'restore epoch increment rejects uncertified old history', 'raw SQLite partial-batch readback', 'named typed reset confirmation', 'manager reset epoch and fresh owner empty readback', 'job backup/restore/reset result dialogs'] }));
  } finally {
    partialHeld?.release.resolve();
    if (env) await env.close();
    await faultProxy?.close();
    if (app) await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
