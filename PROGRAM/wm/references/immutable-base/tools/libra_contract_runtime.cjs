'use strict';
// Test-only host for the two JS contracts. This is not browser/UI coverage.
// No fallback: only LIBRA_CONTRACT_RUNTIME=node selects the jsdom VM.
const mode = process.env.LIBRA_CONTRACT_RUNTIME || 'playwright';
if (!['node', 'playwright'].includes(mode)) {
  throw new Error('Unsupported LIBRA_CONTRACT_RUNTIME: ' + mode);
}
function contractArtifactName() {
  const artifact = process.env.LIBRA_CONTRACT_ARTIFACT || 'full';
  if (artifact === 'full') return 'LIBRA World Manager Full.js';
  if (artifact === 'min') return 'LIBRA World Manager.js';
  throw new Error('Unsupported LIBRA_CONTRACT_ARTIFACT: ' + artifact);
}
function loadNodeContractRuntime() {
  const vm = require('node:vm');
  const { JSDOM, VirtualConsole } = require('jsdom');
  return { chromium: { async launch() {
    const pages = new Set();
    let browserClosed = false;
    return {
      async newPage() {
        if (browserClosed) throw new Error('Contract browser is closed');
        let dom = null;
        let closed = false;
        const errors = [];
        const check = () => {
          if (closed || browserClosed) throw new Error('Contract page is closed');
          if (errors.length) throw errors[0];
          if (!dom) throw new Error('Call setContent before evaluating the contract');
        };
        const run = source => vm.runInContext(source, dom.getInternalVMContext(), { timeout: 30000 });
        const page = {
          async setContent(html) {
            if (closed || browserClosed) throw new Error('Contract page is closed');
            if (dom) dom.window.close();
            const virtualConsole = new VirtualConsole();
            virtualConsole.on('jsdomError', error => errors.push(error));
            // Outside-only prevents automatic HTML scripts or external resources.
            // An origin provides real Web Storage without fetching that origin.
            dom = new JSDOM(String(html), {
              url: 'https://libra-contract.invalid/', runScripts: 'outside-only', virtualConsole
            });
          },
          async evaluate(callback, arg) {
            check();
            if (typeof callback !== 'function') throw new TypeError('Only function callbacks are supported');
            const serialized = arg === undefined ? 'undefined' : JSON.stringify(arg);
            if (serialized === undefined) throw new TypeError('Contract arguments must be JSON data');
            // Recompile the exact callback in the page realm; Node closures cannot leak.
            const pending = run('(' + Function.prototype.toString.call(callback) + ')(' + serialized + ')');
            let watchdog;
            try {
              // A pending Promise alone does not keep Node alive. This referenced
              // watchdog prevents exit 0 before the original assertions can run.
              const result = await Promise.race([pending, new Promise((resolve, reject) => {
                watchdog = setTimeout(() => {
                  const error = new Error('CONTRACT_EVALUATE_TIMEOUT:30000ms');
                  errors.push(error); // A timed-out page cannot later report success.
                  reject(error);
                }, 30000);
              })]);
              check();
              return structuredClone(result);
            } finally {
              clearTimeout(watchdog);
            }
          },
          async addScriptTag(options) {
            check();
            if (!options || typeof options.content !== 'string' || Object.keys(options).some(key => key !== 'content')) {
              throw new TypeError('Only inline script content is supported');
            }
            // A browser script tag does not await a script's async IIFE. Capture its
            // rejection, however, so asynchronous host errors cannot produce a pass.
            const result = run(options.content);
            if (result && typeof result.then === 'function') result.catch(error => errors.push(error));
          },
          async waitForTimeout(ms) {
            check();
            if (!Number.isFinite(ms) || ms < 0) throw new TypeError('Invalid wait duration');
            await new Promise(resolve => setTimeout(resolve, ms));
            check();
          },
          async close() {
            if (dom) dom.window.close();
            closed = true;
            pages.delete(page);
            if (errors.length) throw errors[0];
          }
        };
        pages.add(page);
        return page;
      },
      async close() {
        const pending = [...pages].map(page => page.close());
        browserClosed = true;
        await Promise.all(pending);
      }
    };
  } } };
}
const original = require('./libra_playwright_loader.cjs');
module.exports = {
  ...original,
  // Default browser function identity and behavior are unchanged; jsdom loads lazily.
  loadPlaywright: mode === 'node' ? loadNodeContractRuntime : original.loadPlaywright,
  contractArtifactName
};
