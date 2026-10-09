'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const sourceFile = name => path.join(process.env.COMPANION_GUI_PLUGIN_DIR || path.join(root, 'plugins'), name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label, ms = 10000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw Error('Timed out: ' + label); await sleep(10); }
}
function domHost() {
  const errors = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid/', pretendToBeVisual: true, virtualConsole: new VirtualConsole().on('jsdomError', error => errors.push(error.message)) });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const globals = { window: w, document: w.document, HTMLElement: w.HTMLElement, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MutationObserver: w.MutationObserver, requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w), getComputedStyle: w.getComputedStyle.bind(w) };
  return { dom, w, doc: w.document, globals, errors };
}
async function lia(options = {}) {
  const h = domHost(); let open;
  const fixture = await require('./lia_native_runtime_fixture.cjs').createFixture('official', {
    transformSource: () => fs.readFileSync(sourceFile('LIA_Persona_Linker.js'), 'utf8'),
    configureApi(api, state) {
      api.registerSetting = async (_name, callback) => { open = callback; return true; };
      api.showContainer = async () => {}; api.hideContainer = async () => {};
      if (options.configureApi) options.configureApi(api, state);
    }
  });
  Object.assign(fixture.context, h.globals);
  return { ...h, ...fixture, open: () => open(), close: async () => { await fixture.dispose(); h.w.close(); } };
}
async function retrace() {
  const h = domHost();
  const f = await require('./hayaku_runtime_harness.cjs').createHayakuRuntime({ autoRepair: false, pluginSourceFile: sourceFile('HAYAKU_Locator_Continuity.js') });
  Object.assign(f.context, h.globals);
  f.host.showContainer = async () => {}; f.host.hideContainer = async () => {};
  f.context = vm.createContext({ ...f.context });
  const previousUnloads = new Set(f.host.unloadHandlers);
  vm.runInContext(fs.readFileSync(sourceFile('RETRACE.js'), 'utf8'), f.context, { filename: 'RETRACE-gui-defects.js' });
  await wait(() => f.context.__RETRACE, 'RETRACE registration');
  await wait(() => f.host.unloadHandlers.some(callback => !previousUnloads.has(callback)), 'RETRACE unload registration');
  const retraceUnload = f.host.unloadHandlers.find(callback => !previousUnloads.has(callback));
  return { ...h, ...f, plugin: f.context.__RETRACE, retraceUnload, close: async () => { await f.dispose(); h.w.close(); } };
}
async function gradia(options = {}) {
  const h = domHost(), unloads = [];
  const f = await require('../gradia/host.cjs').load({ sourceFile: sourceFile('GRADIA.js'), storage: options.storage, transformSource: options.transformSource,
    api: { showContainer: async () => {}, hideContainer: async () => {}, onUnload: async callback => unloads.push(callback) },
    testGlobals: { ...h.globals, crypto: require('node:crypto').webcrypto, Response }
  });
  return { ...h, ...f, close: async () => { await f.plugin.closeSettingsGui(); for (const callback of unloads) await callback(); h.w.close(); } };
}
module.exports = { root, sourceFile, sleep, wait, lia, retrace, gradia };
