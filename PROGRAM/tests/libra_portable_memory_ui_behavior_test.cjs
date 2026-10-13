'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const source = fs.readFileSync(requestedPlugin ? path.resolve(requestedPlugin) : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.onclick = null;
    this.onchange = null;
    this.files = [];
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  contains(target) {
    if (target === this) return true;
    return this.children.some(child => child.contains(target));
  }

  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === 'input[type=file]') return this.tagName === 'INPUT' && this.getAttribute('type') === 'file';
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attribute) {
      if (!this.attributes.has(attribute[1])) return false;
      return attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2];
    }
    return false;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    let match = null;
    const visit = node => {
      if (match) return;
      if (node.id === id) match = node;
      for (const child of node.children) visit(child);
    };
    visit(this.body);
    return match;
  }

  querySelector() {
    return null;
  }
}

const syncSource = between('const syncPortableUiState = message => {', "const setUiBusy = (busy, message = '') => {");
const ensureSource = between('const ensureUi = hostOverride => {', 'const publicApi = Object.freeze({');
const syncFactory = new Function('runtime', 'document', 'config', 'LibraMemoryCore', 'Runtime', 'portableCanonicalJobBusy', `${syncSource}\nreturn syncPortableUiState;`);
const ensureFactory = new Function('runtime', 'document', 'config', 'Gui', 'bindUi', 'syncPortableUiState', `${ensureSource}\nreturn ensureUi;`);

const document = new FakeDocument();
const runtime = { unloaded: false, uiRoot: null, input: null, busy: false, statusMessage: '', operationId: '' };
const LibraMemoryCore = { state: { canonicalJob: null, canonicalJobPromise: null, portableMemoryActiveOperationId: '', queues: new Map(), receiptQueues: new Map(), microQueues: new Map() } };
const Runtime = { inFlight: false };
const portableCanonicalJobBusy = () => {
  const job = LibraMemoryCore.state.canonicalJob;
  const terminal = ['completed', 'completed_with_warnings', 'cancelled', 'failed', 'original_kept'].includes(String(job?.state || ''));
  return !!LibraMemoryCore.state.canonicalJobPromise || (!!job && !terminal);
};
const config = { uiId: 'libra-portable-memory-backup-controls', pluginId: 'libra' };
let bindCount = 0;
const bindUi = root => {
  assert.ok(root.querySelector('[data-portable-backup]'));
  assert.ok(root.querySelector('[data-portable-restore]'));
  assert.ok(root.querySelector('input[type=file]'));
  bindCount += 1;
};
const Gui = { app: null };
const syncPortableUiState = syncFactory(runtime, document, config, LibraMemoryCore, Runtime, portableCanonicalJobBusy);
const ensureUi = ensureFactory(runtime, document, config, Gui, bindUi, syncPortableUiState);

const foreignHost = document.createElement('div');
foreignHost.setAttribute('data-portable-backup-host', 'flashback_memory');
document.body.appendChild(foreignHost);
assert.equal(ensureUi(foreignHost), null, 'LIBRA ignores another owner portable-memory host');
assert.equal(document.getElementById(config.uiId), null, 'LIBRA never creates a floating fallback');

const mountRecovery = () => {
  const app = document.createElement('section');
  app.dataset.responseFamily = 'libra';
  const host = document.createElement('div');
  host.setAttribute('data-portable-backup-host', 'libra');
  app.appendChild(host);
  document.body.appendChild(app);
  Gui.app = app;
  return { app, host };
};

const first = mountRecovery();
const firstControls = ensureUi(first.host);
assert.ok(firstControls, 'LIBRA mounts controls in the Recovery card');
assert.equal(firstControls.parentNode, first.host);
assert.equal(firstControls.className, 'stack', 'portable controls use the adopted mockup stack instead of the retired recovery-only wrapper');
assert.equal(document.body.children.includes(firstControls), false, 'controls are never attached directly to the body');
assert.deepEqual(firstControls.querySelectorAll('button').map(button => button.textContent), ['↓ JSON 백업 다운로드', '↑ JSON 백업에서 복원']);
assert.ok(firstControls.querySelectorAll('button').every(button => button.disabled === false));
assert.equal(bindCount, 1);

runtime.statusMessage = 'JSON 기억 복원…';
runtime.operationId = 'portable_restore_test';
LibraMemoryCore.state.portableMemoryActiveOperationId = runtime.operationId;
first.app.remove();
const second = mountRecovery();
const secondControls = ensureUi(second.host);
assert.ok(secondControls, 'controls remount after the main region is rebuilt');
assert.notEqual(secondControls, firstControls);
assert.equal(secondControls.parentNode, second.host);
assert.equal(bindCount, 2);
assert.ok(secondControls.querySelectorAll('button').every(button => button.disabled === true), 'remounted controls inherit the active operation lock');
assert.equal(secondControls.querySelector('[data-portable-status]').textContent, 'JSON 기억 복원…');

runtime.operationId = '';
runtime.statusMessage = '';
LibraMemoryCore.state.portableMemoryActiveOperationId = '';
LibraMemoryCore.state.canonicalJob = { state: 'awaiting_choice' };
syncPortableUiState();
assert.ok(secondControls.querySelectorAll('button').every(button => button.disabled === true), 'an unresolved canonical choice blocks portable memory work');
assert.equal(secondControls.querySelector('[data-portable-status]').textContent, '정본 작업이 끝난 뒤 사용할 수 있습니다.');

LibraMemoryCore.state.canonicalJob = { state: 'completed' };
syncPortableUiState('');
assert.ok(secondControls.querySelectorAll('button').every(button => button.disabled === false));
assert.equal(secondControls.querySelector('[data-portable-status]').textContent, '');

console.log('libra_portable_memory_ui_behavior_test: PASS');
