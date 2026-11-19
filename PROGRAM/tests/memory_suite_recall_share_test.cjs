'use strict';
// 기억 주입 공통 예산과 중복 제거.
// (1) One total recall budget split by fixed shares, saved in each plugin's source-input
//     preferences and kept equal over the rule-sync channel (compare-and-set).
// (2) RisuAI runs the request hooks one after another, each receiving the previous result, so a
//     plugin that runs later sees the other memory plugins' blocks and leaves out text they
//     already carry verbatim.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const POLICY = fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInput.libra.source.js'), 'utf8');
const CONTROLS = fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInputControls.source.js'), 'utf8');
const IDS = { libra: 'libra', hayaku: 'hayaku_locator_continuity', flashback: 'flashback_memory' };
const BUDGET = { version: 1, enabled: true, totalChars: 12000, shares: { libra: 50, hayaku: 30, flashback: 20 } };

const sdk = () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(POLICY + '\n;globalThis.api={memorySuiteNormalizeRecallBudget,memorySuiteRecallBudget,memorySuiteRecallShareChars,memorySuitePeerRecallIndex,memorySuiteDefaultRecallBudget};', context);
  return context.api;
};

// One window, three owners' policies and syncs over a host channel bus that stamps the sender.
const world = ({ saved = {}, present = ['libra', 'hayaku', 'flashback'] } = {}) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(POLICY + '\n' + CONTROLS);
  const listeners = {}, store = {};
  const api = id => ({
    addPluginChannelListener: async (channel, fn) => { (listeners[id + '|' + channel] ||= []).push(fn); return true; },
    removePluginChannelListener: async () => {},
    postPluginChannelMessage: async (target, channel, message) => {
      for (const fn of listeners[target + '|' + channel] || []) setTimeout(() => fn(JSON.parse(JSON.stringify(message)), { sender: id }), 1);
    }
  });
  const policies = {}, syncs = {};
  for (const owner of present) {
    if (saved[owner]) store[owner] = saved[owner];
    policies[owner] = w.createMemorySuiteSourceInputPolicy({ owner,
      read: async () => owner in store ? JSON.stringify(store[owner]) : null,
      write: async body => { store[owner] = JSON.parse(body); return true; } });
    syncs[owner] = w.createMemorySuiteSourceRuleSync({ owner, policy: policies[owner], api: () => api(IDS[owner]) });
  }
  return { w, dom, store, policies, syncs, async start() { for (const s of Object.values(syncs)) await s.start(); } };
};
// Saving waits until the plugin's own request work is over (the same guard as saving rules).
const saveWhenIdle = (save, budget) => wait(async () => { try { await save(budget); return true; } catch (error) { if (/BUSY/.test(error.message)) return false; throw error; } });
const wait = async fn => { for (let i = 0; i < 400; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 5)); } throw Error('WAIT_TIMEOUT'); };

test('the shared budget is validated, off by default, and gives each plugin its share', () => {
  const api = sdk();
  assert.equal(api.memorySuiteDefaultRecallBudget().enabled, false);
  const normalized = api.memorySuiteNormalizeRecallBudget(BUDGET);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), BUDGET);
  assert.throws(() => api.memorySuiteNormalizeRecallBudget({ ...BUDGET, shares: { libra: 50, hayaku: 30, flashback: 30 } }), /합이 100/);
  assert.throws(() => api.memorySuiteNormalizeRecallBudget({ ...BUDGET, totalChars: 500 }), /전체 예산/);
  assert.throws(() => api.memorySuiteNormalizeRecallBudget({ ...BUDGET, shares: { ...BUDGET.shares, libra: 50.5 } }), /정수/);
  assert.equal(api.memorySuiteRecallShareChars('libra'), null, 'no saved budget: each plugin keeps its own setting');
  api.memorySuiteRecallBudget('libra', { ...normalized, enabled: false });
  assert.equal(api.memorySuiteRecallShareChars('libra'), null, 'saved but off');
  for (const owner of ['libra', 'hayaku', 'flashback']) api.memorySuiteRecallBudget(owner, normalized);
  assert.deepEqual(['libra', 'hayaku', 'flashback'].map(api.memorySuiteRecallShareChars), [6000, 3600, 2400]);
});

test('peer blocks are found in every plugin format, the plugin\'s own block is ignored, and only verbatim repeats count', () => {
  const api = sdk();
  const messages = [
    { role: 'system', content: '[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]\n<LIBRA_CLASSIC_RECALL>\n[CURRENT STATE — how things stand now]\n- 은빛 열쇠 — 소지자: 민아\n</LIBRA_CLASSIC_RECALL>' },
    { role: 'system', content: '[HAYAKU ACTIVE SCENE HEAD]\n- Scene identity: 서재\n앞서 확립된 정황:\n- summary: 지호는 상자를 서랍에 넣고 열쇠를 돌렸다.\n[HAYAKU RUNTIME PACKET SHAPE]\nEmit exactly one current_snapshot packet.\n[/HAYAKU RUNTIME PACKET SHAPE]' },
    { role: 'system', content: [{ type: 'text', text: '[ACTIVE CONTINUITY EVIDENCE]\n[E01] 하연은 창가에 앉아 오래된 편지를 다시 읽었다.\n[/ACTIVE CONTINUITY EVIDENCE]' }] },
    { role: 'user', content: '은빛 열쇠는 어디 있어?' }
  ];
  const fromLibra = api.memorySuitePeerRecallIndex(messages, 'libra');
  assert.deepEqual([...fromLibra.owners], ['flashback', 'hayaku']);
  assert.equal(fromLibra.covered('- 은빛 열쇠 — 소지자: 민아'), false, 'its own block is not a peer');
  assert.equal(fromLibra.covered('- [T2] 지호는 상자를 서랍에 넣고 열쇠를 돌렸다.'), true, 'labels and list marks do not hide a repeat');
  assert.equal(fromLibra.covered('하연은 창가에 앉아 오래된 편지를 다시 읽었다.'), true, 'text parts of an array message count');
  assert.equal(fromLibra.covered('Emit exactly one current_snapshot packet.'), false, 'HAYAKU packet-writing instructions are not memory');
  const fromFlashback = api.memorySuitePeerRecallIndex(messages, 'flashback');
  assert.equal(fromFlashback.covered('- 소지자: 은빛 열쇠 — 소지자: 민아'), true);
  assert.equal(fromFlashback.covered('하연은 창가에 앉아 오래된 편지를 다시 읽었다.'), false);
  // Mostly new text stays: half repeated is below the 80% line.
  const mixed = '지호는 상자를 서랍에 넣고 열쇠를 돌렸다. 그리고 아무 말 없이 서재를 나가 복도 끝으로 걸어갔다.';
  assert.ok(fromFlashback.ratio(mixed) > 0.3 && fromFlashback.ratio(mixed) < 0.8, String(fromFlashback.ratio(mixed)));
  assert.equal(fromFlashback.covered(mixed), false);
  assert.equal(fromFlashback.covered('지호는 상자를 서랍에 넣었다.'), false, 'similar wording is not a repeat');
  const none = api.memorySuitePeerRecallIndex([{ role: 'user', content: '안녕' }], 'libra');
  assert.equal(none.chars, 0);assert.equal(none.digest, '');assert.equal(none.covered('아무 문장이나 길게 적어 둔다.'), false);
});

test('the budget is saved with the source preferences, keeps the rules, and survives a reload', async () => {
  const rules = { version: 1, ignoredTags: ['img', 'lb-xnai', 'status'], unwrapTags: [], sourceTags: [], controls: ['html-comment'] };
  const f = world({ saved: { libra: { ignoredTags: ['img', 'lb-xnai', 'status'], sourceRules: rules } }, present: ['libra'] });
  await f.policies.libra.ready();
  assert.equal(f.policies.libra.recallBudget().enabled, false);
  await f.policies.libra.setRecallBudget(BUDGET);
  assert.deepEqual(f.store.libra.recallBudget, BUDGET);
  assert.deepEqual(f.store.libra.sourceRules.ignoredTags, rules.ignoredTags, 'saving the budget keeps the rules');
  assert.equal(f.w.memorySuiteRecallShareChars('libra'), 6000);
  await f.policies.libra.setSourceRules({ ...rules, ignoredTags: [...rules.ignoredTags, 'choice'] });
  assert.deepEqual(f.store.libra.recallBudget, BUDGET, 'saving the rules keeps the budget');
  const g = world({ saved: { libra: f.store.libra }, present: ['libra'] });
  await g.policies.libra.ready();
  assert.equal(g.w.memorySuiteRecallShareChars('libra'), 6000);
  const torn = world({ saved: { libra: { ...f.store.libra, recallBudget: { version: 1, enabled: true, totalChars: 3, shares: {} } } }, present: ['libra'] });
  await torn.policies.libra.ready();
  assert.equal(torn.w.memorySuiteRecallShareChars('libra'), null, 'a malformed stored budget is ignored, not fatal');
  f.dom.window.close(); g.dom.window.close(); torn.dom.window.close();
});

test('peers compare budgets and refuse a copy when theirs changed since compare', async () => {
  const f = world({ saved: { libra: { recallBudget: BUDGET } } });
  await f.start();
  const states = await f.syncs.libra.compareBudget();
  assert.deepEqual([states.hayaku.state, states.flashback.state], ['different', 'different']);
  await f.policies.flashback.setRecallBudget({ ...BUDGET, totalChars: 9000 });
  const results = await f.syncs.libra.applyBudgetToPeers(BUDGET, ['hayaku', 'flashback'], { hayaku: states.hayaku.fingerprint, flashback: states.flashback.fingerprint });
  assert.equal(results.hayaku.ok, true);
  assert.match(results.flashback.error, /CONFLICT/);
  assert.equal(f.store.flashback.recallBudget.totalChars, 9000, 'the newer budget stays');
  assert.deepEqual(f.store.hayaku.recallBudget, BUDGET);
  f.dom.window.close();
});

test('the budget panel applies here and in the other plugins, and shows a budget applied elsewhere', async () => {
  const f = world();
  await f.start();
  const host = f.w.document.querySelector('main');
  f.w.mountMemorySuiteSourceInputControls(host, { owner: 'hayaku', policy: f.policies.hayaku, ruleSync: f.syncs.hayaku });
  const find = q => host.querySelector(q);
  const set = (q, value) => { const node = find(q); if (node.type === 'checkbox') { node.checked = value; node.dispatchEvent(new f.w.Event('change')); } else { node.value = String(value); node.dispatchEvent(new f.w.Event('input')); } };
  await wait(() => !find('[data-recall-budget-enabled]').disabled);
  assert.equal(find('[data-recall-budget-enabled]').checked, false);
  assert.equal(find('[data-recall-budget-apply]').disabled, true, 'nothing to apply yet');
  set('[data-recall-budget-enabled]', true); set('[data-recall-budget-total]', 10000);
  set('[data-recall-budget-share="libra"]', 40); set('[data-recall-budget-share="hayaku"]', 40); set('[data-recall-budget-share="flashback"]', 20);
  assert.match(find('[data-recall-budget-summary]').textContent, /LIBRA 4,000자 · HAYAKU 4,000자 · Flashback 2,000자/);
  set('[data-recall-budget-share="flashback"]', 30);
  assert.match(find('[data-recall-budget-summary]').textContent, /합이 100/);
  assert.equal(find('[data-recall-budget-apply]').disabled, true, 'an invalid draft cannot be applied');
  set('[data-recall-budget-share="flashback"]', 5); set('[data-recall-budget-total]', 10000);
  set('[data-recall-budget-share="hayaku"]', 55);
  assert.match(find('[data-recall-budget-summary]').textContent, /800자 미만/, 'a Flashback share below its minimum is called out');
  set('[data-recall-budget-share="flashback"]', 20); set('[data-recall-budget-share="hayaku"]', 40);
  await find('[data-recall-budget-apply]').onclick();
  await wait(() => /LIBRA 적용됨/.test(find('[data-recall-budget-status]').textContent) && /Flashback 적용됨/.test(find('[data-recall-budget-status]').textContent));
  for (const owner of ['hayaku', 'libra', 'flashback']) assert.equal(f.w.memorySuiteRecallShareChars(owner), { libra: 4000, hayaku: 4000, flashback: 2000 }[owner], owner);
  await wait(() => ['libra', 'flashback'].every(peer => find(`[data-recall-budget-peer="${peer}"]`).dataset.state === 'same'));
  // Applied from LIBRA: the untouched panel shows it.
  const next = { version: 1, enabled: true, totalChars: 8000, shares: { libra: 50, hayaku: 25, flashback: 25 } };
  await f.policies.libra.setRecallBudget(next);
  await f.syncs.libra.applyBudgetToPeers(next, ['hayaku']);
  await wait(() => find('[data-recall-budget-total]').value === '8000');
  assert.match(find('[data-recall-budget-status]').textContent, /바뀐 예산을 불러왔습니다/);
  // Edited here meanwhile: the draft stays and 예산 적용 asks once more.
  set('[data-recall-budget-total]', 9000);
  await f.syncs.libra.applyBudgetToPeers({ ...next, totalChars: 7000 }, ['hayaku']);
  await wait(() => /덮어씁니다/.test(find('[data-recall-budget-status]').textContent));
  assert.equal(find('[data-recall-budget-total]').value, '9000');
  await find('[data-recall-budget-apply]').onclick();
  assert.equal(f.store.hayaku.recallBudget.totalChars, 7000, 'nothing saved on the first press');
  assert.match(find('[data-recall-budget-status]').textContent, /한 번 더/);
  await find('[data-recall-budget-apply]').onclick();
  await wait(() => f.store.hayaku.recallBudget.totalChars === 9000);
  f.dom.window.close();
});

test('LIBRA leaves out lines a peer block already carries, and uses its share while the budget is on', async t => {
  const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const f = await fixture(); t.after(() => f.r.cleanup());
  await f.run();
  const ask = async extra => {
    const out = await f.control.hooks.beforeRequest([...extra, { role: 'user', content: '은빛 열쇠는 누가 보관해?' }], 'model');
    const block = out.find(row => row.role === 'system' && String(row.content).includes('<LIBRA_CLASSIC_RECALL>'))?.content || '';
    return block.slice(block.indexOf('<LIBRA_CLASSIC_RECALL>'));
  };
  const plain = await ask([]);
  assert.match(plain, /- 은빛 열쇠 — 소지자: 민아/);
  const withPeer = await ask([{ role: 'system', content: '[ACTIVE CONTINUITY EVIDENCE]\n- 은빛 열쇠 — 소지자: 민아\n[/ACTIVE CONTINUITY EVIDENCE]' }]);
  assert.doesNotMatch(withPeer, /- 은빛 열쇠 — 소지자: 민아/, 'the repeated line is left out');
  assert.match(withPeer, /- 은빛 열쇠 — 소유자: 민아/, 'a similar but different line stays');
  assert.match(withPeer, /\[CURRENT STATE — how things stand now\]/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.r.api.getRuntime().lastPeerRecallDedup)), { owners: ['flashback'], droppedLines: 1 });
  await f.r.api.setMemorySuiteRecallBudget({ version: 1, enabled: true, totalChars: 1000, shares: { libra: 20, hayaku: 40, flashback: 40 } });
  const small = await ask([]);
  assert.ok(small.length < plain.length, small.length + ' < ' + plain.length);
  await f.r.api.setMemorySuiteRecallBudget({ version: 1, enabled: false, totalChars: 1000, shares: { libra: 20, hayaku: 40, flashback: 40 } });
  assert.equal((await ask([])).length, plain.length, 'turned off: LIBRA\'s own budget again');
});

const summary = 'Alice placed the brass key inside the royal archive.';
// Flashback's turn: a longer reply, so a peer that carries the reply but not the user's line repeats
// most of it (Flashback already skipped a turn whose whole text is in the request).
const reply = summary + ' She locked the oak cabinet twice and hid the ledger beneath the loose floorboard. Then she walked back to the east gate without saying a single word to the guards.';
const base = [{ role: 'system', content: 'Continue the story.' }, { role: 'user', content: 'Where is the brass key Alice placed?' }];
const flashbackBlock = out => out.find(row => String(row.content).includes('[ACTIVE CONTINUITY EVIDENCE]'))?.content || '';
// A budget is saved before any request: between the request hooks Flashback is busy until its
// after-request hook runs, which these hook-level tests do not drive.
const flashbackRuntime = async (t, budget = null) => {
  const { createModelFixture, modelSettings } = require('./fixtures/recall_model_runtime_fixture.cjs');
  const f = await createModelFixture({ arguments: { hook_recall_timeout_ms: '10000' } });
  t.after(() => f.dispose());
  f.currentChat.message = [{ role: 'user', chatId: 'u1', data: 'Where does Alice put the key?' }, { role: 'assistant', chatId: 'a1', data: reply }];
  f.currentChat.messages = f.currentChat.message;
  await f.api.saveSettings({ ...await f.api.loadSettings(), ...modelSettings, embeddingEnabled: true, autoEpisodeIndex: false });
  if (budget) await saveWhenIdle(f.api.setMemorySuiteRecallBudget, budget);
  await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
  return f;
};

test('Flashback leaves out excerpts a peer block mostly repeats, and keeps the rest', async t => {
  const f = await flashbackRuntime(t);
  assert.match(flashbackBlock(await f.api._selectionTest.beforeRequest(base, 'model')), /royal archive/);
  // Only one of the reply's sentences in the peer block: the excerpt stays.
  const partialPeer = { role: 'system', content: 'What had already been established:\n- summary: Alice placed the brass key inside the royal archive.\n[HAYAKU RUNTIME PACKET SHAPE]\nEmit one packet.\n[/HAYAKU RUNTIME PACKET SHAPE]' };
  assert.match(flashbackBlock(await f.api._selectionTest.beforeRequest([partialPeer, ...base], 'model')), /oak cabinet/);
  // Every sentence of the reply already there: the excerpt is left out.
  const hayakuPeer = { role: 'system', content: 'What had already been established:\n- summary: Alice placed the brass key inside the royal archive.\n- summary: She locked the oak cabinet twice and hid the ledger beneath the loose floorboard.\n- summary: Then she walked back to the east gate without saying a single word to the guards.\n[HAYAKU RUNTIME PACKET SHAPE]\nEmit one packet.\n[/HAYAKU RUNTIME PACKET SHAPE]' };
  assert.doesNotMatch(flashbackBlock(await f.api._selectionTest.beforeRequest([hayakuPeer, ...base], 'model')), /royal archive/);
  const last = (await f.api.debugState()).lastRecall;
  assert.deepEqual([...last.peerRecallDedup.owners], ['hayaku']);
  assert.ok(last.peerRecallDedup.droppedVariants > 0, JSON.stringify(last.peerRecallDedup));
  assert.equal(last.recallBudgetSource, 'own_setting');
});

test('Flashback follows its share while the shared budget is on', async t => {
  // 20% of 2,000 is below Flashback's 800-character minimum: no evidence.
  const small = await flashbackRuntime(t, { version: 1, enabled: true, totalChars: 2000, shares: { libra: 50, hayaku: 30, flashback: 20 } });
  assert.equal(flashbackBlock(await small.api._selectionTest.beforeRequest(base, 'model')), '');
  assert.equal((await small.api.debugState()).lastRecall.recallBudgetSource, 'memory_suite_shared');
  const wide = await flashbackRuntime(t, { version: 1, enabled: true, totalChars: 20000, shares: { libra: 50, hayaku: 30, flashback: 20 } });
  assert.match(flashbackBlock(await wide.api._selectionTest.beforeRequest(base, 'model')), /royal archive/, 'a 4,000-character share delivers');
  assert.equal((await wide.api.debugState()).lastRecall.recallBudgetSource, 'memory_suite_shared');
});

test('HAYAKU leaves out recalled records a peer block already carries, and follows its share', async t => {
  const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
  const runtime = async () => {
    const h = await createHayakuRuntime({ autoRepair: false, arguments: { memory_suite_server_mode: 'plugin_only' }, messages: [
      { role: 'user', id: 'u1', chatId: 'u1', data: 'Where does Alice put the key?' },
      { role: 'assistant', id: 'a1', chatId: 'a1', data: hiddenPacketMessage(summary, createValidPacket({ turn: 1, subject: 'Alice', scene: 'royal archive', summary })) }] });
    t.after(() => h.dispose());
    const hs = await h.hayaku._test.currentChatScope();
    await h.hayaku._test.reconcileObservedChatTopology(hs, h.hayaku._test.authoritativeChatSnapshot(hs.chatMessages, hs), 'recall-share-fixture');
    return h;
  };
  const h = await runtime();
  await h.hayaku._test.handleBeforeRequest(base, 'model');
  const alone = h.hayaku.lastDebug().lastBeforeRequest.recallDelivery.selectedEntries;
  const flashbackPeer = { role: 'system', content: '[ACTIVE CONTINUITY EVIDENCE]\n[E01] Alice placed the brass key inside the royal archive.\n- Alice remains associated with royal archive.\n[/ACTIVE CONTINUITY EVIDENCE]' };
  const out = await h.hayaku._test.handleBeforeRequest([flashbackPeer, ...base], 'model');
  const debug = h.hayaku.lastDebug();
  assert.ok(debug.lastBeforeRequest.recallDelivery.selectedEntries < alone, `${debug.lastBeforeRequest.recallDelivery.selectedEntries} < ${alone}`);
  assert.deepEqual([...debug.peerRecallDedup.owners], ['flashback']);
  assert.ok(debug.peerRecallDedup.droppedEntries > 0);
  assert.equal(debug.peerRecallDedup.budgetSource, 'own_setting');
  assert.match(out.find(row => row.memo === 'hayaku-runtime-context-v3')?.content || '', /\[HAYAKU ACTIVE SCENE HEAD\][\s\S]*royal archive/, 'the scene head is not recall and stays');
  const narrow = await runtime();
  await saveWhenIdle(narrow.hayaku.setMemorySuiteRecallBudget, { version: 1, enabled: true, totalChars: 1000, shares: { libra: 90, hayaku: 5, flashback: 5 } });
  await narrow.hayaku._test.handleBeforeRequest(base, 'model');
  const shared = narrow.hayaku.lastDebug();
  assert.equal(shared.peerRecallDedup.budgetSource, 'memory_suite_shared');
  assert.equal(shared.lastBeforeRequest.recallDataBudget.targetChars, 50, 'the recall cap is HAYAKU\'s share');
  assert.ok(shared.lastBeforeRequest.recallDelivery.renderedEntries < alone, 'a 50-character share carries less recalled evidence');
  assert.equal(h.llmCalls.length + narrow.llmCalls.length, 0);
});
