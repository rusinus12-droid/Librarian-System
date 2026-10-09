'use strict';
// The old stacking-context contract depended on a manual consent overlay and
// floating dock. Automatic beforeRequest reconciliation must leave the host GUI
// intact; this CJS DOM harness exercises the actual history renderer directly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toLowerCase(); this.ownerDocument = ownerDocument; this.children = [];
    this.attributes = new Map(); this.dataset = {}; this.style = {}; this.value = ''; this.textContent = '';
    this.disabled = false; this.isConnected = true; this.parent = null;
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; node.isConnected = this.isConnected; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes.reverse()) { node.parent = this; node.isConnected = this.isConnected; this.children.unshift(node); } }
  insertBefore(node, reference) { const index = this.children.indexOf(reference); node.parent = this; node.isConnected = this.isConnected; this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.isConnected = false; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  walk() { return this.children.flatMap(child => [child, ...child.walk()]); }
  matches(selector) {
    if (selector === '[data-source-tracking-controls]') return !!this.dataset.sourceTrackingControls;
    return selector.split(',').map(value => value.trim()).some(value => {
      if (value.startsWith('.')) return String(this.className || '').split(/\s+/).includes(value.slice(1));
      if (value.startsWith('[') && value.endsWith(']')) return this.getAttribute(value.slice(1, -1)) !== null;
      return value === this.tagName;
    });
  }
  querySelector(selector) { return this.walk().find(node => node.matches(selector)) || null; }
  querySelectorAll(selector) { return this.walk().filter(node => node.matches(selector)); }
  focus() {}
}

const program = path.resolve(__dirname, '..');
const context = vm.createContext({ setTimeout, clearTimeout, Date, console });
vm.runInContext(fs.readFileSync(path.join(program, 'sdk/MemorySuiteSourceEditConsent.source.js'), 'utf8'), context);

(async () => {
  let assertions = 0;
  for (const owner of ['libra', 'hayaku', 'flashback']) {
    const doc = { createElement: tag => new Element(tag, doc) };
    const root = new Element('main', doc), storage = new Map();
    let units = [
      { key: '1', start: 1, end: 1, label: 'T1', identity: owner + '-pair-1', digest: 'new-1', sourceDigest: 'new-1', originalDigest: 'old-1', basis: 'basis-1', changed: true, current: false },
      { key: '2', start: 2, end: 2, label: 'T2', identity: owner + '-pair-2', digest: 'new-2', sourceDigest: 'new-2', originalDigest: 'old-2', basis: 'basis-2', changed: true, current: false }
    ];
    let promptCalls = 0, rootDocumentCalls = 0, executions = 0;
    const host = { activeElement: { id: 'send' }, visible: true, overlays: [] };
    const controller = context.createMemorySuiteSourceEditConsent({
      owner, requestBoundary: true, externalObserver: true,
      read: async key => storage.get(key) ?? null,
      write: async (key, value) => { storage.set(key, value); return true; },
      collect: async () => ({ scopeKey: owner + '-chat', units: units.map(unit => ({ ...unit })), completedTurnIds: ['u1'] }),
      api: () => ({ getRootDocument: async () => { rootDocumentCalls += 1; return host; } }),
      prompt: async () => { promptCalls += 1; throw new Error('automatic work must not prompt'); },
      loadReview: async tasks => ({ rows: tasks.map(task => task.key === '1'
        ? { key: '1', previousUnavailable: false, beforeText: 'old '+owner+' <img src=x onerror="window.xss=1">', afterText: 'new '+owner+' <img src=x onerror="window.xss=2">' }
        : { key: '2', previousUnavailable: true, afterText: 'current '+owner+' <script>window.xss=3</script>' }) }),
      execute: async (task, permit) => { await permit.assertCurrent(); executions += 1; units = units.map(unit => unit.key === task.key ? { ...unit, changed: false, current: true } : unit); return { ok: true }; }
    });

    try {
      await controller.beforeRequest();
      controller.mountControls(root);
      await Promise.resolve(); await Promise.resolve();
      const controls = root.querySelector('[data-source-tracking-controls]');
      assert.ok(controls, owner + ' gets inline history in its own settings surface');
      assert.equal(controls.dataset.sourceTrackingControls, owner);
      assert.equal(root.querySelectorAll('.ms-source-event').length, 2);
      assert.equal(root.querySelector('[data-source-edit-dialog]'), null);
      assert.equal(promptCalls, 0); assert.equal(rootDocumentCalls, 0); assert.equal(executions, 2);
      assert.equal(host.activeElement.id, 'send'); assert.deepEqual(host.overlays, []);
      assertions += 9;

      const buttons = () => controls.querySelectorAll('button');
      assert.equal(controls.querySelectorAll('pre').length, 0, 'source material is fetched only after a compare click');
      const compare = buttons().find(button => button.textContent === '원문 비교');
      await compare.onclick();
      const output = controls.querySelector('pre');
      assert.ok(output.textContent.includes('old '+owner+' <img src=x onerror="window.xss=1">'));
      assert.ok(output.textContent.includes('new '+owner+' <img src=x onerror="window.xss=2">'));
      assert.equal(output.querySelectorAll('img,script').length, 0, 'raw evidence is literal text, not executable markup');
      assertions += 4;

      const missing = root.querySelectorAll('.ms-source-event').find(item => item.querySelector('strong').textContent.startsWith('T2'));
      await missing.querySelectorAll('button').find(button => button.textContent === '원문 비교').onclick();
      const missingText = missing.querySelector('pre').textContent;
      assert.ok(missingText.includes('이전 전체 원문 없음'));
      assert.ok(missingText.includes('current '+owner+' <script>window.xss=3</script>'));
      assert.equal(missingText.includes('old '+owner), false, 'missing historical text is never reconstructed');
      assert.equal(missing.querySelector('pre').querySelectorAll('script,img').length, 0);
      assertions += 5;

      const exception = buttons().find(button => button.textContent === '예외 지정');
      await exception.onclick();
      assert.equal(controller.status().tasks[0].excluded, true, 'exception applies to this owner task revision');
      const missingAfterRerender = root.querySelectorAll('.ms-source-event').find(item => item.querySelector('strong').textContent.startsWith('T2'));
      const remove = missingAfterRerender.querySelectorAll('button').find(button => button.textContent === '내역 삭제');
      await remove.onclick();
      assert.equal(controller.status().events.length, 1, 'deleting history removes only the selected visible event');
      assert.equal(controller.status().tasks.length, 2, 'the applied receipt remains after history deletion');
      assert.equal(controller.status().tasks[0].excluded, true, 'history deletion preserves its exception');
      assert.equal(controller.status().tasks.find(task => task.key === '2').state, 'applied');
      assertions += 4;

      const manual = await controller.review();
      assert.equal(manual.reason, 'automatic_before_request_only');
      assert.equal(promptCalls, 0); assert.equal(rootDocumentCalls, 0);
      assertions += 3;
    } finally { controller.dispose(); }
  }
  console.log(JSON.stringify({ test: 'source_review_manual_stacking_context', result: 'pass', owners: ['libra', 'hayaku', 'flashback'], assertions,
    contract: 'request-boundary work and inline history do not create a blocking overlay or floating dock' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
