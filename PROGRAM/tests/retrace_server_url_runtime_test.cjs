'use strict';
// Actual RETRACE GUI, actual manager-only SDK bridge and a real loopback server on a non-default port.
// Saving the address from the connection page reaches RE:TRACE and its LIA peer, leaves the other
// plugins' saved addresses (shared pluginStorage) untouched, and connects to the moved server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { sourceFile, wait } = require('./fixtures/companion_gui_fixture.cjs');
const key = namespace => '__memory_suite_internal_server_url_v1__:' + namespace;

// The companion RETRACE loader, with a host nativeFetch that reaches the real loopback server.
async function retrace() {
  const errors = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid/', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole().on('jsdomError', error => errors.push(error.message)) });
  const w = dom.window; w.HTMLElement.prototype.scrollIntoView = function () {};
  const globals = { window: w, document: w.document, HTMLElement: w.HTMLElement, Event: w.Event, KeyboardEvent: w.KeyboardEvent,
    MutationObserver: w.MutationObserver, requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    getComputedStyle: w.getComputedStyle.bind(w), Node: w.Node, Element: w.Element, CustomEvent: w.CustomEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent };
  const f = await require('./fixtures/hayaku_runtime_harness.cjs').createHayakuRuntime({ autoRepair: false,
    pluginSourceFile: sourceFile('HAYAKU_Locator_Continuity.js'), nativeFetch: (url, init) => fetch(url, init) });
  Object.assign(f.context, globals);
  f.host.showContainer = async () => {}; f.host.hideContainer = async () => {};
  f.context = vm.createContext({ ...f.context });
  vm.runInContext(fs.readFileSync(sourceFile('RETRACE.js'), 'utf8'), f.context, { filename: 'RETRACE-server-url.js' });
  await wait(() => f.context.__RETRACE, 'RETRACE registration');
  return { ...f, dom, w, doc: w.document, errors, plugin: f.context.__RETRACE, close: async () => { await f.dispose(); w.close(); } };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrace-server-url-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeEnabled: false });
  const { port } = await app.listen();
  assert.notEqual(port, 47630, 'the server runs on a moved port');
  const moved = `http://127.0.0.1:${port}`;
  const f = await retrace();
  try {
    const store = f.host.pluginStorage;
    await store.setItem(key('hayaku'), 'http://127.0.0.1:47630');
    await f.plugin.showUi();
    await wait(() => f.doc.getElementById('retraceServerUrl')?.value, 'saved address shown', 15000);
    const input = f.doc.getElementById('retraceServerUrl');
    assert.equal(input.value, 'http://127.0.0.1:47630', 'the default address is shown before any change');
    assert.match(f.doc.getElementById('retraceServerUrlPeers').textContent, /HAYAKU\s*http:\/\/127\.0\.0\.1:47630/);

    input.value = moved;
    f.doc.querySelector('[data-server-control="url-save"]').click();
    await wait(() => [...f.doc.querySelectorAll('[data-dialog-confirm]')].some(button => !button.closest('[hidden]')), 'confirmation', 15000);
    const dialog = [...f.doc.querySelectorAll('[data-dialog-confirm]')].find(button => !button.closest('[hidden]'));
    assert.match(dialog.closest('[role="dialog"],dialog,.dialog')?.textContent || f.doc.body.textContent, /새 주소: http:\/\/127\.0\.0\.1:\d+/);
    dialog.click();
    await wait(() => /서버 주소 저장 완료|저장했지만 연결하지 못했습니다|작업 확인 필요/.test(f.doc.getElementById('serverControlResult')?.textContent || ''), 'save result', 30000);
    const result = f.doc.getElementById('serverControlResult').textContent;
    assert.match(result, new RegExp('서버 주소 저장 완료: ' + moved.replace(/[.:/]/g, '\\$&') + ' · 연결 확인됨'), result);

    assert.equal(await store.getItem(key('retrace')), moved, 'RE:TRACE manager address saved');
    assert.equal(await store.getItem(key('lia')), moved, 'LIA peer address saved (LIA keeps none of its own)');
    assert.equal(await store.getItem(key('hayaku')), 'http://127.0.0.1:47630', "HAYAKU's own saved address is not written");
    assert.equal(await store.getItem(key('libra')), null, "LIBRA's own saved address is not written");
    assert.equal(await store.getItem(key('flashback')), null, "Flashback's own saved address is not written");
    assert.match(f.doc.getElementById('retraceServerUrlPeers').textContent, /RE:TRACE와 다른 주소/, 'a plugin left on the old port is pointed out');
    assert.deepEqual(f.errors, []);
    console.log('retrace_server_url_runtime_test: PASS (moved port connected; RE:TRACE and LIA saved; other plugins untouched)');
  } finally {
    await f.close();
    await app.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
