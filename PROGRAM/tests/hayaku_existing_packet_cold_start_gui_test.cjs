'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

const CONFIRM_TEXT = '기존 패킷이 있습니다. 그래도 콜드스타트 하시겠습니까?';

const transcript = () => {
  const packet = createValidPacket({
    turn: 1,
    subject: 'Alice',
    summary: 'Alice kept the brass key on the table. GUI_EXISTING_INLINE_PACKET'
  });
  return [
    { role: 'user', chatId: 'gui-u1', id: 'gui-u1', data: 'What happened to the brass key?' },
    { role: 'assistant', chatId: 'gui-a1', id: 'gui-a1', data: hiddenPacketMessage('Alice kept the brass key on the table.', packet) },
    { role: 'user', chatId: 'gui-u2', id: 'gui-u2', data: 'What appeared over the river?' },
    { role: 'assistant', chatId: 'gui-a2', id: 'gui-a2', data: 'Bob saw a green comet above the river.' }
  ];
};

const responder = async call => {
  const prompt = Array.isArray(call?.messages) ? call.messages.map(message => String(message?.content || '')).join('\n') : '';
  const units = Array.from(prompt.matchAll(/\[UNIT ORDINAL (\d+) · TURN (\d+) · ([^\]]+)\]/g), match => ({
    unitOrdinal: Number(match[1]), turn: Number(match[2])
  }));
  const output = turn => ({
    packet: createValidPacket({ turn, summary: turn === 1 ? 'Alice kept the brass key on the table.' : 'Bob saw a green comet above the river.' }),
    grounding: [{ path: 'world.active_events[0]', source: 'target', evidence: [turn === 1 ? 'Alice kept the brass key on the table.' : 'Bob saw a green comet above the river.'] }]
  });
  const schema = prompt.includes('[COLD START BATCH ENVELOPE')
    ? 'hayaku.native_cold_start_batch_output.v1'
    : 'hayaku.native_repair_output.v1';
  if (schema === 'hayaku.native_cold_start_batch_output.v1') {
    return { type: 'success', result: JSON.stringify({ schema, packets: units.map(unit => ({ unitOrdinal: unit.unitOrdinal, ...output(unit.turn) })) }) };
  }
  const turn = Number(prompt.match(/\[Turn (\d+)\]/)?.[1] || 1);
  return { type: 'success', result: JSON.stringify({ schema, ...output(turn) }) };
};

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.id = '';
    this._className = '';
    this._textContent = '';
    this._innerHTML = '';
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.checked = false;
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value || ''); }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._textContent = String(value ?? ''); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(markup) {
    this._innerHTML = String(markup || '');
    this._textContent = '';
    this.children = [];
    const tags = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
    let match;
    while ((match = tags.exec(this._innerHTML))) {
      const child = this.ownerDocument.createElement(match[1]);
      const attrs = match[2];
      const attrPattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let attr;
      while ((attr = attrPattern.exec(attrs))) {
        if (attr[0].startsWith('/')) continue;
        const name = attr[1];
        const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
        child.setAttribute(name, value);
      }
      this.appendChild(child);
    }
  }

  get classList() {
    const element = this;
    return {
      contains(name) { return element.className.split(/\s+/).includes(String(name)); },
      add(name) { if (!this.contains(name)) element.className = [...element.className.split(/\s+/).filter(Boolean), String(name)].join(' '); },
      remove(name) { element.className = element.className.split(/\s+/).filter(value => value && value !== String(name)).join(' '); },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !this.contains(name) : force === true;
        if (shouldAdd) this.add(name); else this.remove(name);
        return shouldAdd;
      }
    };
  }

  setAttribute(name, value) {
    const key = String(name);
    const normalized = String(value);
    this.attributes.set(key, normalized);
    if (key === 'id') this.id = normalized;
    if (key === 'class') this.className = normalized;
    if (key === 'type') this.type = normalized;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = normalized;
  }

  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }
  focus() {}
  addEventListener(type, handler) {
    const listeners = this.listeners.get(String(type)) || [];
    listeners.push(handler);
    this.listeners.set(String(type), listeners);
  }
  async fire(type, event = {}) {
    if (type === 'click' && this.disabled) return undefined;
    let result;
    for (const handler of this.listeners.get(String(type)) || []) {
      result = handler({ target: this, currentTarget: this, preventDefault() {}, ...event });
    }
    return await result;
  }
  matches(selector) {
    if (selector === '*') return true;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.classList.contains(name));
    if (selector === 'button') return this.tagName === 'BUTTON';
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attribute) return this.attributes.has(attribute[1]) && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
    const inputType = selector.match(/^input\[type=([^\]]+)\]$/);
    if (inputType) return this.tagName === 'INPUT' && this.type === inputType[1].replace(/["']/g, '');
    return this.tagName.toLowerCase() === selector.toLowerCase();
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
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tagName) { return new FakeElement(tagName, this); }
  getElementById(id) { return this.body.querySelector(`#${id}`); }
  querySelector(selector) { return this.body.querySelector(selector); }
  addEventListener() {}
  removeEventListener() {}
}

const startGuiRuntime = async ({ storedOnly = false } = {}) => {
  const originalTranscript = transcript();
  const runtime = await createHayakuRuntime({ autoRepair: false, messages: originalTranscript, llmResponder: responder });
  const storageWrites = [];
  const setItem = runtime.pluginStorage.setItem.bind(runtime.pluginStorage);
  runtime.pluginStorage.setItem = async (key, value) => {
    storageWrites.push({ key: String(key), value: String(value) });
    return setItem(key, value);
  };
  if (storedOnly) {
    const seeded = await runtime.hayaku.recovery.status({ includeDebts: true, refreshDebts: true });
    assert.ok(seeded.debt?.coverage?.coveredTurns?.includes(1), 'seed chat packet must become covered storage before its inline marker is removed');
    const withoutInlineCarrier = originalTranscript.map(message => ({ ...message }));
    withoutInlineCarrier[1].data = 'Alice kept the brass key on the table.';
    runtime.setMessages(withoutInlineCarrier);
  }
  const doc = new FakeDocument();
  runtime.context.document = doc;
  assert.equal(await runtime.hayaku.showUi(), true, 'the real public viewer entry point should mount in a fake host document');
  const root = doc.getElementById('hayaku-ledger-viewer-root');
  await waitFor(() => /조회·관리|조회 실패/.test(root?.querySelector('#hayakuViewerStatus')?.textContent || ''), 'initial viewer refresh');
  await root.querySelector('#refreshHayakuRecovery').fire('click');
  await waitFor(() => /완료 턴|기록 없음/.test(root.querySelector('#hayakuNativeCoverageSummary')?.textContent || ''), 'recovery coverage refresh');
  return { runtime, doc, root, storageWrites };
};

const textNodeWithExactText = (root, text) => root.querySelectorAll('*').find(node => node.textContent === text) || null;
const storageSnapshot = storage => JSON.stringify(Array.from(storage.values.entries()));

const openConfirmation = async ({ runtime, root }) => {
  const button = root.querySelector('#runHayakuNativeColdStart');
  const pendingRun = button.fire('click');
  const overlay = await waitFor(() => root.querySelector('#hayakuColdStartConfirmOverlay'), 'existing-packet confirmation dialog');
  assert.equal(textNodeWithExactText(overlay, CONFIRM_TEXT)?.textContent, CONFIRM_TEXT,
    'existing packets must show the exact Korean confirmation text');
  assert.match(overlay.textContent, /설정된 Provider.*비용이 발생할 수 있습니다/, 'the confirmation states that Other Ax uses the configured provider and may incur cost');
  return { overlay, pendingRun };
};

(async () => {
  const initial = await startGuiRuntime();
  try {
    const button = initial.root.querySelector('#runHayakuNativeColdStart');
    assert.ok(button, 'Cold Start control must be present in the real viewer shell');
    assert.equal(button.disabled, false, 'Cold Start remains available with completed turns and an inline existing packet');
    assert.match(initial.root.querySelector('#hayakuNativeCoverageSummary')?.textContent || '', /커버 1개/,
      'the GUI status refresh must recognize validated inline coverage before asking for confirmation');
  } finally {
    await initial.runtime.dispose();
  }

  const cancelled = await startGuiRuntime();
  try {
    const beforeStorage = storageSnapshot(cancelled.runtime.pluginStorage);
    const beforeWriteCount = cancelled.storageWrites.length;
    const { overlay, pendingRun } = await openConfirmation(cancelled);
    const buttons = overlay.querySelectorAll('button');
    assert.equal(buttons.length, 2, 'confirmation presents cancel and affirmative actions');
    await buttons[0].fire('click');
    assert.equal(await pendingRun, null, 'cancellation exits the GUI path without starting Cold Start');
    assert.equal(cancelled.runtime.llmCalls.length, 0, 'cancel must not call Other Ax');
    assert.equal(storageSnapshot(cancelled.runtime.pluginStorage), beforeStorage, 'cancel must not write storage');
    assert.equal(cancelled.storageWrites.length, beforeWriteCount, 'cancel must perform no storage writes, even same-value writes');
  } finally {
    await cancelled.runtime.dispose();
  }

  const accepted = await startGuiRuntime();
  try {
    const originalPacketText = accepted.runtime.chat.message[1].data;
    const beforeLedger = await accepted.runtime.hayaku.ledger.inspect({ includeRecords: true });
    const activeBefore = beforeLedger.records.filter(record => record.recordState === 'active' && record.captureSource !== 'bridge_cold_start');
    assert.ok(activeBefore.length > 0, 'GUI recovery refresh mirrors the validated inline packet as active memory');
    const { overlay, pendingRun } = await openConfirmation(accepted);
    const buttons = overlay.querySelectorAll('button');
    await buttons[1].fire('click');
    const result = await pendingRun;
    assert.equal(result?.ok, true, JSON.stringify(result));
    assert.ok(accepted.runtime.llmCalls.length > 0, 'affirmative confirmation permits the Cold Start run');
    assert.equal(accepted.runtime.chat.message[1].data, originalPacketText, 'the original active inline packet remains intact');
    const afterLedger = await accepted.runtime.hayaku.ledger.inspect({ includeRecords: true });
    const afterIds = new Set(afterLedger.records.map(record => `${record.recordId}:${record.hash}`));
    assert.ok(activeBefore.every(record => afterIds.has(`${record.recordId}:${record.hash}`)), 'existing active packets remain in the ledger');
    const checkpoint = await accepted.runtime.hayaku.recovery.status();
    assert.ok(checkpoint.coldStartRun?.run?.chunks?.length > 0, 'the confirmed run leaves its per-turn checkpoint available');
  } finally {
    await accepted.runtime.dispose();
  }

  const changedScope = await startGuiRuntime();
  try {
    const beforeStorage = storageSnapshot(changedScope.runtime.pluginStorage);
    const beforeWriteCount = changedScope.storageWrites.length;
    const { overlay, pendingRun } = await openConfirmation(changedScope);
    changedScope.runtime.chat.id = 'changed-scope-chat';
    changedScope.runtime.chat.chatId = 'changed-scope-chat';
    await overlay.querySelectorAll('button')[1].fire('click');
    const result = await pendingRun;
    assert.equal(result?.reason, 'cold_start_confirmation_scope_changed');
    assert.equal(changedScope.runtime.llmCalls.length, 0, 'scope change after the confirmation text must block Other Ax');
    assert.equal(storageSnapshot(changedScope.runtime.pluginStorage), beforeStorage, 'scope change must not write storage');
    assert.equal(changedScope.storageWrites.length, beforeWriteCount);
  } finally {
    await changedScope.runtime.dispose();
  }

  const changedTranscript = await startGuiRuntime();
  try {
    const beforeStorage = storageSnapshot(changedTranscript.runtime.pluginStorage);
    const beforeWriteCount = changedTranscript.storageWrites.length;
    const { overlay, pendingRun } = await openConfirmation(changedTranscript);
    const revised = changedTranscript.runtime.chat.message.map(message => ({ ...message }));
    revised[3].data = 'Bob noticed a red comet over the river.';
    changedTranscript.runtime.setMessages(revised);
    await overlay.querySelectorAll('button')[1].fire('click');
    const result = await pendingRun;
    assert.equal(result?.reason, 'cold_start_confirmation_transcript_changed');
    assert.equal(changedTranscript.runtime.llmCalls.length, 0, 'transcript change after confirmation must block Other Ax');
    assert.equal(storageSnapshot(changedTranscript.runtime.pluginStorage), beforeStorage, 'transcript change must not write storage');
    assert.equal(changedTranscript.storageWrites.length, beforeWriteCount);
  } finally {
    await changedTranscript.runtime.dispose();
  }

  const storedOnly = await startGuiRuntime({ storedOnly: true });
  try {
    assert.equal(storedOnly.runtime.chat.message[1].data.includes('HAYAKU_STATE_PACKET_START'), false,
      'stored-only GUI case must not retain an inline packet carrier');
    const ledger = await storedOnly.runtime.hayaku.ledger.inspect({ includeRecords: true });
    assert.ok(ledger.records.some(record => record.recordState === 'active' && record.captureSource !== 'bridge_cold_start'),
      'stored-only GUI case retains the validated active packet in storage');
    assert.match(storedOnly.root.querySelector('#hayakuNativeCoverageSummary')?.textContent || '', /커버 1개/,
      'recovery status recognizes the stored active packet after inline marker removal');
    const beforeStorage = storageSnapshot(storedOnly.runtime.pluginStorage);
    const beforeWriteCount = storedOnly.storageWrites.length;
    const { overlay, pendingRun } = await openConfirmation(storedOnly);
    await overlay.querySelectorAll('button')[0].fire('click');
    await pendingRun;
    assert.equal(storedOnly.runtime.llmCalls.length, 0, 'stored-only confirmation cancel must not call Other Ax');
    assert.equal(storageSnapshot(storedOnly.runtime.pluginStorage), beforeStorage);
    assert.equal(storedOnly.storageWrites.length, beforeWriteCount);
  } finally {
    await storedOnly.runtime.dispose();
  }
  console.log('PASS hayaku_existing_packet_cold_start_gui_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
