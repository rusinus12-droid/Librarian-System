'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage, waitFor } = require('./fixtures/hayaku_runtime_harness.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
const start = source.indexOf('  const viewerRenderManualRecapture =');
const end = source.indexOf('  const bindLedgerViewerUi =', start);
assert(start >= 0 && end > start, 'manual recapture GUI controller is part of the production viewer');
const sourceBlock = source.slice(start, end);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

class FakeNode {
  constructor() {
    this.listeners = new Map(); this._innerHTML = ''; this.clearChildrenOnInnerHTML = false; this.textContent = ''; this.hidden = true; this.disabled = false;
    this.dataset = {}; this.style = { setProperty() {} }; this.children = new Map(); this.attributes = new Map(); this.scrollTop = 0;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value ?? '');
    if (this.clearChildrenOnInnerHTML) this.children.clear();
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  async fire(type, event = {}) {
    const normalized = { ...event, currentTarget: event.currentTarget || this };
    return await this.listeners.get(type)?.(normalized);
  }
  querySelector(selector) {
    if (!this.children.has(selector)) {
      const child = new FakeNode();
      child.focus = () => { this.focusedSelector = selector; child.isFocused = true; };
      this.children.set(selector, child);
    }
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { this.lastChild = child; child.parentNode = this; }
  focus() { this.isFocused = true; }
  remove() { this.removed = true; }
}

class FakeTarget {
  constructor(attributes = {}, dataset = {}) { this.attributes = attributes; this.dataset = dataset; this.checked = false; this.disabled = false; }
  closest(selector) { return selector === '[data-hayaku-manual-recapture-action]' && this.getAttribute('data-hayaku-manual-recapture-action') ? this : null; }
  getAttribute(name) { return this.attributes[name] ?? (name === 'data-hayaku-manual-recapture-action' ? this.attributes.action : null) ?? null; }
}

const assistantTurn = (turn, visible, packets) => ({
  role: 'assistant',
  chatId: `assistant-${turn}`,
  data: `${visible}\n${packets.map(packet => hiddenPacketMessage('', packet)).join('\n')}`
});
const storageBytes = storage => Array.from(storage.values.entries(), ([key, value]) => [key, String(value)])
  .sort(([a], [b]) => a.localeCompare(b));
const action = (name, turn) => new FakeTarget({
  action: name,
  ...(turn == null ? {} : { 'data-hayaku-manual-recapture-turn': String(turn) })
});

async function createFixtureRuntime(chatId) {
  const visible1 = 'Alice found an amber compass in the archive.';
  const visible2 = 'Bob left a silver telescope beneath the red stair.';
  const visible3 = 'Carol found a green notebook beside the river.';
  const t1Current = createValidPacket({ turn: 1, packetType: 'current_snapshot', subject: 'Alice', scene: 'archive', summary: visible1 });
  const t1Recovery = createValidPacket({ turn: 1, packetType: 'recovery_snapshot', subject: 'Alice', scene: 'archive', summary: visible1 });
  const t2Current = createValidPacket({ turn: 2, packetType: 'current_snapshot', subject: 'Bob', scene: 'tower', summary: visible2 });
  const t2Recovery = createValidPacket({ turn: 2, packetType: 'recovery_snapshot', subject: 'Bob', scene: 'tower', summary: visible2 });
  const t3Current = createValidPacket({ turn: 3, packetType: 'current_snapshot', subject: 'Carol', scene: 'river', summary: visible3 });
  const messages = [
    { role: 'user', chatId: 'user-1', data: 'Alice searches the archive.' },
    assistantTurn(1, visible1, [t1Current, t1Recovery]),
    { role: 'user', chatId: 'user-2', data: 'Bob returns to the tower.' },
    assistantTurn(2, visible2, [t2Current, t2Recovery]),
    { role: 'user', chatId: 'user-3', data: 'Carol walks along the river.' },
    assistantTurn(3, visible3, [t3Current])
  ];
  const runtime = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false, messages, chatId });
  const settled=()=>[...runtime.pluginStorage.values].filter(([key])=>key.includes('__memory_suite_internal_scope_routes_v1__')).every(([,value])=>{const row=typeof value==='string'?JSON.parse(value):value;return row.modePublication?.phase!=='pending';});
  await waitFor(()=>runtime.replacers.has('afterRequest')&&settled(),'registered runtime and settled startup scope route');
  await new Promise(resolve=>setImmediate(resolve));
  await waitFor(settled,'scope route remains settled before manual-action baseline');
  const test = runtime.hayaku._test;
  const scope = await test.currentChatScope();
  const fullSnapshot = test.authoritativeChatSnapshot(scope.chatMessages, scope);
  await test.reconcileObservedChatTopology(scope, {
    ...fullSnapshot,
    conversationPairs: fullSnapshot.conversationPairs.filter(pair => pair.pairIndex === 1)
  }, 'manual_recapture_gui_protected_fixture', { prompt: false });
  const ledger = await test.loadStorageLedger(scope, { hydrateArchive: false });
  const suppressedCurrent = ledger.records.find(record => record.targetPairIndex === 1 && record.packetType === 'current_snapshot');
  assert.ok(suppressedCurrent, 'fixture stores the T1 current packet before suppressing it');
  const forgotten = await runtime.hayaku.ledger.forget({ hash: suppressedCurrent.hash });
  assert.equal(forgotten.forgotten, true, 'fixture suppresses one visible T1 variant');
  return { runtime, visible: { visible1, visible2, visible3 } };
}

function makeController(runtime, { preview, adopt, state, launch, overlay }) {
  const root = {
    querySelector(selector) {
      return selector === '#openHayakuManualRecapture' ? launch
        : selector === '#hayakuManualRecaptureOverlay' ? overlay
          : null;
    }
  };
  const viewerState = state || { root, scope: { key: 'synthetic-scope' }, activeTab: 'packets', visible: true };
  viewerState.root = root;
  const context = vm.createContext({
    Memory: { ledgerViewer: viewerState },
    manualRecapturePreview: preview || (() => runtime.hayaku.ledger.manualRecapture.preview()),
    manualRecaptureAdopt: adopt || (options => runtime.hayaku.ledger.manualRecapture.adopt(options)),
    viewerEscapeHtml: escapeHtml,
    viewerSetStatusMessage: (message, error) => { viewerState.status = { message, error }; },
    compact: (value, max = 160) => String(value ?? '').slice(0, max),
    text: value => String(value ?? ''),
    ensureArray: value => Array.isArray(value) ? value : []
  });
  vm.runInContext(`${sourceBlock}\nglobalThis.__manualRecaptureGui = { viewerBindManualRecaptureUi };`, context);
  context.__manualRecaptureGui.viewerBindManualRecaptureUi(root);
  return { root, state: viewerState, context };
}

const assertActionButtons = (html, selector, expected) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<div class="${escaped}"[^>]*>([\\s\\S]*?)<\\/div>`));
  assert.ok(match, `${selector} is rendered`);
  const buttons = [...match[1].matchAll(/<button\b[^>]*data-hayaku-manual-recapture-action="([^"]+)"/g)].map(row => row[1]);
  assert.deepEqual(buttons, expected, `${selector} contains only its requested controls`);
  return match[1];
};

function makeFocusableDialog(count = 2) {
  const dialog = new FakeNode();
  const stops = Array.from({ length: count }, () => new FakeNode());
  for (const [index, stop] of stops.entries()) {
    stop.focusCount = 0;
    stop.getClientRects = () => [{}];
    stop.focus = () => { stop.focusCount += 1; dialog.lastFocused = index; };
  }
  dialog.querySelectorAll = () => stops;
  dialog.contains = target => stops.includes(target);
  return { dialog, stops };
}

async function exerciseKeyboardFocusContainment() {
  const launch = new FakeNode();
  const overlay = new FakeNode();
  overlay.clearChildrenOnInnerHTML = true;
  const list = makeFocusableDialog(3);
  const details = makeFocusableDialog(3);
  const { state } = makeController(null, {
    launch,
    overlay,
    state: { scope: { key: 'keyboard-scope' }, activeTab: 'packets', visible: true },
    preview: async () => ({
      ok: true,
      previewId: 'keyboard-preview',
      scopeKey: 'keyboard-scope',
      turns: [{ turn: 2, eligible: true, packets: [{ packetType: 'current_snapshot', eligible: true, raw: '{}' }] }],
      eligibleTurns: [2]
    }),
    adopt: async () => ({ ok: true, durable: true, adopted: true })
  });
  const registerDialogs = () => {
    overlay.children.set('.dialog[role="dialog"]', list.dialog);
    overlay.children.set('.detail-view[role="dialog"]', details.dialog);
  };
  const key = async (keyName, target, shiftKey = false) => {
    let prevented = false;
    let stopped = false;
    await overlay.fire('keydown', {
      key: keyName,
      target,
      shiftKey,
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; }
    });
    return { prevented, stopped };
  };

  await launch.fire('click', { currentTarget: launch });
  await waitFor(() => state.manualRecapture?.preview?.previewId === 'keyboard-preview', 'keyboard recapture preview');
  registerDialogs();

  let result = await key('Tab', list.stops[2]);
  assert.deepEqual(result, { prevented: true, stopped: false }, 'Tab at the last list control is trapped');
  assert.equal(list.dialog.lastFocused, 0, 'Tab from the last list control wraps to the first');
  list.dialog.lastFocused = null;
  result = await key('Tab', list.stops[0], true);
  assert.deepEqual(result, { prevented: true, stopped: false }, 'Shift+Tab at the first list control is trapped');
  assert.equal(list.dialog.lastFocused, 2, 'Shift+Tab from the first list control wraps to the last');
  list.dialog.lastFocused = null;
  result = await key('Tab', list.stops[0]);
  assert.equal(result.prevented, false, 'Tab between controls follows normal browser order');
  assert.equal(list.dialog.lastFocused, null, 'an interior Tab does not force focus');
  const outside = new FakeNode();
  await key('Tab', outside);
  assert.equal(list.dialog.lastFocused, 0, 'Tab from outside returns focus to the first active-dialog control');

  await overlay.fire('click', { target: action('view-turn', 2) });
  assert.equal(state.manualRecapture.detailTurn, 2, 'packet detail dialog is active');
  registerDialogs();
  details.dialog.lastFocused = null;
  result = await key('Tab', details.stops[2]);
  assert.equal(result.prevented, true, 'Tab is trapped in the packet detail dialog');
  assert.equal(details.dialog.lastFocused, 0, 'detail Tab wraps to a detail control, not the background list');
  details.dialog.lastFocused = null;
  result = await key('Tab', details.stops[0], true);
  assert.equal(result.prevented, true, 'Shift+Tab is trapped in the packet detail dialog');
  assert.equal(details.dialog.lastFocused, 2, 'detail Shift+Tab wraps to its last control');

  result = await key('Escape', details.stops[0]);
  assert.equal(result.prevented, true, 'Escape at the first detail edge closes only the detail dialog');
  assert.equal(state.manualRecapture.detailTurn, 0);
  assert.equal(state.manualRecapture.preview.previewId, 'keyboard-preview');
  assert.equal(overlay.focusedSelector, '[data-hayaku-manual-recapture-action="view-turn"][data-hayaku-manual-recapture-turn="2"]');
  registerDialogs();
  result = await key('Escape', list.stops[2]);
  assert.equal(result.prevented, true, 'Escape at the last list edge cancels the preview');
  assert.equal(state.manualRecapture.preview, null);
  assert.equal(launch.isFocused, true, 'cancelling restores focus to the launch button');
}

async function exerciseChoice(choice) {
  const { runtime, visible } = await createFixtureRuntime(`manual-recapture-gui-${choice}`);
  try {
    const launch = new FakeNode();
    const overlay = new FakeNode();
    overlay.clearChildrenOnInnerHTML = true;
    const apiCalls = [];
    const scope = await runtime.hayaku._test.currentChatScope();
    const { state } = makeController(runtime, {
      launch,
      overlay,
      state: { scope, activeTab: 'packets', visible: true },
      adopt: async options => {
        apiCalls.push(JSON.parse(JSON.stringify(options)));
        return await runtime.hayaku.ledger.manualRecapture.adopt(options);
      }
    });
    let writes = 0;
    const setItem = runtime.pluginStorage.setItem.bind(runtime.pluginStorage);
    runtime.pluginStorage.setItem = async (...args) => { writes += 1; return await setItem(...args); };
    const before = storageBytes(runtime.pluginStorage);

    await launch.fire('click', { currentTarget: launch });
    await waitFor(() => overlay.innerHTML.includes('T1'), 'manual recapture card list');
    assert.equal(overlay.hidden, false, 'clicking the packet-page button opens the dialog');
    const toolbar = assertActionButtons(overlay.innerHTML, 'cluster', ['select-all', 'select-none']);
    const footer = assertActionButtons(overlay.innerHTML, 'dialog__actions', ['selected', 'cancel']);
    assert.match(toolbar, />모두 선택</);
    assert.match(toolbar, />선택 해제</);
    assert.match(footer, />채택 \(0\)</);
    assert.match(footer, />취소</);
    const firstCard = overlay.innerHTML.match(/<article class="[^"]*\brow\b[^"]*"[\s\S]*?<\/article>/)?.[0] || '';
    assert.equal((firstCard.match(/<button\b/g) || []).length, 2, 'selection and packet-view buttons are siblings inside each card');
    assert.doesNotMatch(overlay.innerHTML, /amber compass|silver telescope|packet_type/,
      'the compact list does not eagerly display packet JSON');
    assert.match(overlay.innerHTML, /data-hayaku-manual-recapture-action="select-turn" data-hayaku-manual-recapture-turn="1"[^>]*aria-pressed="false"[^>]*disabled/,
      'a protected turn stays visible with a disabled pressed-state selection button');
    assert.match(overlay.innerHTML, /data-hayaku-manual-recapture-action="view-turn" data-hayaku-manual-recapture-turn="1"[^>]*aria-label="T1 패킷 보기"/,
      'a protected turn keeps its separate, accessible packet-view button');
    assert.match(overlay.innerHTML, /T1.*전체 턴 보호/s, 'the blocked turn includes a visible protection reason');
    const previewId = state.manualRecapture.preview.previewId;

    if (choice === 'cancel') {
      await overlay.fire('click', { target: action('cancel') });
      assert.equal(apiCalls.length, 0, 'cancel closes without calling the adoption API');
      assert.equal(overlay.hidden, true);
      assert.deepEqual(storageBytes(runtime.pluginStorage), before, 'preview and cancel do not change storage');
      assert.equal(writes, 0, 'preview and cancel make no plugin storage writes');
    } else {
      if (choice === 'selected') {
        await overlay.fire('click', { target: action('select-turn', 1) });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [], 'a blocked turn cannot be selected even if its disabled control is targeted');
        await overlay.fire('click', { target: action('select-turn', 2) });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [2]);
        await overlay.fire('click', { target: action('view-turn', 2) });
        assert.match(overlay.innerHTML, /role="dialog"[^>]*aria-labelledby="hayakuManualRecaptureTitle"/,
          'packet details open a separately labelled dialog');
        assert.equal((overlay.innerHTML.match(/role="dialog"/g) || []).length, 2, 'the list dialog remains in the DOM behind the detail popup');
        assert.match(overlay.innerHTML, /class="[^"]*overlay--bottom[^"]*"/);
        assert.match(overlay.innerHTML, /aria-hidden="true" inert>/, 'the background list is hidden from assistive navigation while details are open');
        assert.ok(overlay.innerHTML.includes('현재 패킷') || overlay.innerHTML.includes('current_snapshot'));
        assert.ok(overlay.innerHTML.includes('recovery_snapshot'), 'detail shows every packet type from T2');
        const previewT2Packets = state.manualRecapture.preview.turns.find(row => row.turn === 2).packets;
        assert.ok(overlay.innerHTML.includes(escapeHtml(previewT2Packets.find(packet => packet.packetType === 'current_snapshot').raw)),
          'detail shows the full current JSON supplied by the preview');
        assert.ok(overlay.innerHTML.includes(escapeHtml(previewT2Packets.find(packet => packet.packetType === 'recovery_snapshot').raw)),
          'detail shows the full recovery JSON supplied by the preview');
        assert.ok(overlay.innerHTML.includes(visible.visible2));
        assert.doesNotMatch(overlay.innerHTML, /amber compass|green notebook/, 'T2 detail contains no unrelated turn bodies');
        assert.match(overlay.innerHTML, /detail-view[\s\S]*data-hayaku-manual-recapture-action="back"/);
        await overlay.fire('click', { target: action('back') });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [2], 'returning from detail preserves selection');
        assert.match(overlay.innerHTML, /data-hayaku-manual-recapture-action="select-turn" data-hayaku-manual-recapture-turn="2"[^>]*aria-pressed="true"/,
          'the T2 card announces its selected state after returning');

        await overlay.fire('click', { target: action('view-turn', 1) });
        assert.equal((overlay.innerHTML.match(/role="dialog"/g) || []).length, 2, 'blocked-turn detail is also a separate popup');
        const previewT1Packets = state.manualRecapture.preview.turns.find(row => row.turn === 1).packets;
        assert.ok(overlay.innerHTML.includes(escapeHtml(previewT1Packets.find(packet => packet.packetType === 'current_snapshot').raw)),
          'blocked T1 current packet remains inspectable');
        assert.ok(overlay.innerHTML.includes(escapeHtml(previewT1Packets.find(packet => packet.packetType === 'recovery_snapshot').raw)),
          'blocked T1 recovery packet remains inspectable');
        assert.match(overlay.innerHTML, /보호됨|user_suppressed/, 'blocked detail explains the protection state');
        await overlay.fire('click', { target: action('back') });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [2], 'blocked detail navigation also preserves T2');
      } else {
        await overlay.fire('click', { target: action('select-all') });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [2, 3], 'select-all chooses only eligible turns');
        await overlay.fire('click', { target: action('select-none') });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [], 'clear removes all selected turns');
        await overlay.fire('click', { target: action('select-all') });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [2, 3]);
        await overlay.fire('click', { target: action('view-turn', 2) });
        await overlay.fire('click', { target: action('back') });
        assert.deepEqual(Array.from(state.manualRecapture.selectedTurns), [2, 3], 'select-all state survives detail navigation');
      }

      await overlay.fire('click', { target: action('selected') });
      assert.equal(apiCalls.length, 1, 'adopt calls the backend once');
      assert.equal(state.manualRecapture.result?.ok, true, JSON.stringify(state.manualRecapture.result));
      assert.equal(overlay.hidden, true, 'durable adoption closes the consumed preview');
      assert.equal(apiCalls[0].previewId, previewId);
      assert.equal(apiCalls[0].selection, 'selected');
      assert.deepEqual(Array.from(apiCalls[0].turns), choice === 'all' ? [2, 3] : [2], 'adoption receives the exact selected turn list');
      const ledgerKey = Array.from(runtime.pluginStorage.values.keys()).find(key => String(key).startsWith('hayaku.v2.ledger.'));
      const raw = runtime.pluginStorage.values.get(ledgerKey);
      const ledger = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const active = ledger.records.filter(row => row.recordState === 'active');
      const activeNewVariants = active.filter(row => Number(row.targetPairIndex) >= 2)
        .map(row => `${Number(row.targetPairIndex)}:${row.packetType}`).sort();
      assert.deepEqual(activeNewVariants, choice === 'all'
        ? ['2:current_snapshot', '2:recovery_snapshot', '3:current_snapshot']
        : ['2:current_snapshot', '2:recovery_snapshot'], 'the adopted T2 variants are durable and unselected T3 stays absent');
      assert.equal(active.some(row => Number(row.targetPairIndex) === 1 && row.packetType === 'current_snapshot'), false,
        'adoption cannot reactivate the suppressed T1 sibling');
    }
    assert.equal(runtime.llmCalls.length, 0, 'manual GUI flow does not call a model');
    assert.equal(runtime.fetchCalls.length, 0, 'manual GUI flow does not call a provider');
  } finally {
    await runtime.dispose();
  }
}

async function exerciseLargeList() {
  const turns = Array.from({ length: 600 }, (_, index) => {
    const turn = index + 1;
    return {
      turn,
      eligible: true,
      reason: '',
      packets: [{ packetType: 'current_snapshot', eligible: true, raw: `SYNTHETIC_FULL_BODY_T${turn}`, sourceRaw: `SOURCE_BODY_T${turn}`, normalizationChanged: false }]
    };
  });
  const launch = new FakeNode();
  const overlay = new FakeNode();
  overlay.clearChildrenOnInnerHTML = true;
  const state = { scope: { key: 'synthetic-scope' }, activeTab: 'packets', visible: true };
  const { state: boundState } = makeController(null, {
    launch,
    overlay,
    state,
    preview: async () => ({ ok: true, previewId: 'large-preview', scopeKey: 'synthetic-scope', turns, eligibleTurns: turns.map(row => row.turn) }),
    adopt: async () => ({ ok: true, durable: true, adopted: true })
  });
  await launch.fire('click');
  await waitFor(() => (overlay.innerHTML.match(/data-hayaku-manual-recapture-action="select-turn"/g) || []).length === 600, 'large manual recapture list');
  assert.equal((overlay.innerHTML.match(/data-hayaku-manual-recapture-action="select-turn"/g) || []).length, 600, 'all turns are reachable as compact cards');
  assert.ok(overlay.innerHTML.includes('data-hayaku-manual-recapture-turn="600"'), 'the last card is present and selectable');
  assert.doesNotMatch(overlay.innerHTML, /SYNTHETIC_FULL_BODY_T1|SYNTHETIC_FULL_BODY_T600|SOURCE_BODY_T600/,
    'the large list never embeds packet bodies');
  assertActionButtons(overlay.innerHTML, 'cluster', ['select-all', 'select-none']);
  assertActionButtons(overlay.innerHTML, 'dialog__actions', ['selected', 'cancel']);
  const suiteCss = fs.readFileSync(path.join(__dirname, '..', 'docs', 'gui-redesign', 'assets', 'suite.css'), 'utf8');
  assert.match(suiteCss, /\.overlay\{/);
  assert.match(suiteCss, /\.dialog\{/);
  assert.match(source, /id=\"hayakuManualRecaptureOverlay\" class=\"overlay\"/,
    'the recapture dialog uses the adopted suite overlay');
  assert.match(source, /class=\"dialog dialog--wide/,
    'packet details use the adopted suite dialog');

  overlay.querySelector('.list').scrollTop = 420;
  await overlay.fire('click', { target: action('select-all') });
  assert.equal(boundState.manualRecapture.selectedTurns.length, 600, 'select-all handles a large list');
  assert.equal(overlay.querySelector('.list').scrollTop, 420, 'selection rerender retains list scroll position');
  await overlay.fire('click', { target: action('select-none') });
  assert.deepEqual(Array.from(boundState.manualRecapture.selectedTurns), []);
  await overlay.fire('click', { target: action('select-turn', 600) });
  await overlay.fire('click', { target: action('view-turn', 600) });
  assert.equal((overlay.innerHTML.match(/role="dialog"/g) || []).length, 2, 'large-list detail is a separate dialog over the list');
  assert.ok(overlay.innerHTML.includes('SYNTHETIC_FULL_BODY_T600'), 'opening the last detail reveals its full body');
  assert.doesNotMatch(overlay.innerHTML, /SYNTHETIC_FULL_BODY_T599/, 'detail view contains only its requested turn');
  await overlay.fire('click', { target: action('back') });
  assert.deepEqual(Array.from(boundState.manualRecapture.selectedTurns), [600], 'last-turn selection survives detail and back');
  assert.equal(overlay.querySelector('.list').scrollTop, 420, 'returning from detail restores the list scroll position');
  assert.equal(overlay.focusedSelector, '[data-hayaku-manual-recapture-action="view-turn"][data-hayaku-manual-recapture-turn="600"]',
    'returning from detail restores keyboard focus to that turn');

  let prevented = false;
  await overlay.fire('click', { target: action('view-turn', 600) });
  await overlay.fire('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Escape is handled by the dialog');
  assert.equal(overlay.hidden, false, 'Escape inside packet details returns to the list without cancelling');
  assert.equal(boundState.manualRecapture.preview.previewId, 'large-preview', 'detail Escape leaves the preview open');
  assert.equal(boundState.manualRecapture.detailTurn, 0, 'detail Escape closes only the packet popup');
  assert.equal(overlay.focusedSelector, '[data-hayaku-manual-recapture-action="view-turn"][data-hayaku-manual-recapture-turn="600"]',
    'detail Escape restores focus to the matching card');
  await overlay.fire('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(overlay.hidden, true, 'Escape cancels the preview');
  assert.equal(launch.isFocused, true, 'cancel restores focus to the public launch button');
}

async function exercisePublicShowUiCancel() {
  const { runtime } = await createFixtureRuntime('manual-recapture-public-show-ui');
  try {
    const doc = {
      body: new FakeNode(),
      documentElement: new FakeNode(),
      root: null,
      createElement() { return new FakeNode(); },
      getElementById(id) { return this.root?.id === id ? this.root : null; }
    };
    doc.body.appendChild = node => { doc.root = node; node.ownerDocument = doc; };
    runtime.context.document = doc;
    assert.equal(await runtime.hayaku.showUi(), true, 'the public showUi entry point mounts the ledger viewer');
    const root = doc.root;
    assert.ok(root.innerHTML.includes('id="openHayakuManualRecapture"'), 'the actual packet-page template contains the launch button');
    await waitFor(() => root.querySelector('#hayakuViewerScopeTop').textContent.length > 0, 'public viewer scope refresh');
    const launch = root.querySelector('#openHayakuManualRecapture');
    const overlay = root.querySelector('#hayakuManualRecaptureOverlay');
    overlay.clearChildrenOnInnerHTML = true;
    assert.equal(typeof launch.listeners.get('click'), 'function', 'public showUi binds the launch button');
    let writes = 0;
    const setItem = runtime.pluginStorage.setItem.bind(runtime.pluginStorage);
    runtime.pluginStorage.setItem = async (...args) => { writes += 1; return await setItem(...args); };
    let quietChecks = 0;
    let lastWrites = writes;
    for (let attempt = 0; attempt < 50 && quietChecks < 5; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (writes === lastWrites) quietChecks += 1;
      else { lastWrites = writes; quietChecks = 0; }
    }
    assert.equal(quietChecks, 5, 'ordinary viewer mirroring settles before the manual action baseline');
    writes = 0;
    const beforeLaunch = storageBytes(runtime.pluginStorage);
    await launch.fire('click', { currentTarget: launch });
    await waitFor(() => overlay.innerHTML.includes('T1'), 'public manual recapture card list');
    assert.ok(overlay.innerHTML.includes('패킷 보기'), 'public list exposes its per-turn detail controls');
    assert.doesNotMatch(overlay.innerHTML, /amber compass|silver telescope/, 'public list starts compact without packet bodies');
    await overlay.fire('click', { target: action('cancel') });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(overlay.hidden, true, 'public cancel closes the preview');
    assert.deepEqual(storageBytes(runtime.pluginStorage), beforeLaunch, 'public preview and cancel leave durable bytes unchanged');
    assert.equal(writes, 0, 'public preview and cancel make no storage writes');
    assert.equal(runtime.llmCalls.length, 0);
    assert.equal(runtime.fetchCalls.length, 0);
  } finally {
    await runtime.dispose();
  }
}

(async () => {
  await exerciseKeyboardFocusContainment();
  for (const choice of ['cancel', 'selected', 'all']) await exerciseChoice(choice);
  await exerciseLargeList();
  await exercisePublicShowUiCancel();
  console.log('PASS compact manual recapture cards, per-turn details, keyboard focus containment, selection, cancel, durable adoption, and large-list behavior');
})().catch(error => { console.error(error); process.exitCode = 1; });
