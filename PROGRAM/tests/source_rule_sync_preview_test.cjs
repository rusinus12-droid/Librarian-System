'use strict';
// 원문 태그 설정: (C) LIBRA, HAYAKU and Flashback compare and copy their source rules over plugin
// IPC; (D) the preview lists recent messages with the parts the rules remove struck through,
// and never shows a result the analysis would not get.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const SDK = fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInput.libra.source.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInputControls.source.js'), 'utf8');
const IDS = { libra: 'libra', hayaku: 'hayaku_locator_continuity', flashback: 'flashback_memory' };
const RULES = { version: 1, ignoredTags: ['img', 'lb-xnai', 'status-window', 'thoughts'], unwrapTags: ['wrap'], sourceTags: [], controls: ['html-comment', 'lbdata'] };

// One window holds all three owners' policies (their stored rules are keyed by owner) and a
// host channel bus that, like RisuAI, stamps the sender on every message.
const world = ({ saved = {}, present = ['libra', 'hayaku', 'flashback'], busy = {} } = {}) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(SDK);
  const listeners = {}, store = {}, sent = [];
  const api = id => ({
    addPluginChannelListener: async (channel, fn) => { (listeners[id + '|' + channel] ||= []).push(fn); return true; },
    removePluginChannelListener: async (channel, fn) => { listeners[id + '|' + channel] = (listeners[id + '|' + channel] || []).filter(x => x !== fn); },
    postPluginChannelMessage: async (target, channel, message) => {
      sent.push({ from: id, target, message: JSON.parse(JSON.stringify(message)) });
      for (const fn of listeners[target + '|' + channel] || []) setTimeout(() => fn(JSON.parse(JSON.stringify(message)), { sender: id }), 1);
    }
  });
  const policies = {}, syncs = {};
  for (const owner of present) {
    if (saved[owner]) store[owner] = { ignoredTags: saved[owner].ignoredTags.filter(x => typeof x === 'string'), sourceRules: saved[owner] };
    policies[owner] = w.createMemorySuiteSourceInputPolicy({ owner, busy: () => busy[owner] === true,
      read: async () => owner in store ? JSON.stringify(store[owner]) : null,
      write: async body => { store[owner] = JSON.parse(body); return true; } });
    syncs[owner] = w.createMemorySuiteSourceRuleSync({ owner, policy: policies[owner], api: () => api(IDS[owner]) });
  }
  return { w, dom, store, sent, api, policies, syncs, async start() { for (const s of Object.values(syncs)) await s.start(); } };
};

test('compare reports same, different and absent peers by the rules each one runs', async () => {
  const f = world({ saved: { libra: RULES, hayaku: { ...RULES, ignoredTags: ['lb-xnai'] } }, present: ['libra', 'hayaku'] });
  await f.start();
  const states = await f.syncs.libra.compare();
  assert.equal(states.hayaku.state, 'different');
  assert.equal(states.flashback.state, 'absent', 'a plugin that does not answer is absent, after a short wait');
  const g = world({ saved: { libra: RULES, hayaku: RULES } });
  await g.start();
  const fromLibra = await g.syncs.libra.compare();
  assert.equal(fromLibra.hayaku.state, 'same');
  assert.equal(fromLibra.flashback.state, 'different', 'no saved rules there: it runs the shared defaults, not these rules');
  assert.equal(fromLibra.flashback.builtIn, true);
  // 공통 기준: a plugin that saved the shared defaults matches one that never saved rules.
  const h = world({ saved: {} });
  const defaults = JSON.parse(JSON.stringify(h.w.memorySuiteDefaultSourceRules('libra')));
  const k = world({ saved: { libra: defaults } });
  await k.start();
  const fromDefaults = await k.syncs.libra.compare();
  assert.deepEqual([fromDefaults.hayaku.state, fromDefaults.flashback.state], ['same', 'same']);
  assert.deepEqual([fromDefaults.hayaku.builtIn, fromDefaults.flashback.builtIn], [true, true]);
  f.dom.window.close(); g.dom.window.close(); h.dom.window.close(); k.dom.window.close();
});

test('apply copies normalized rules into each peer through its own policy', async () => {
  const f = world({ saved: { libra: RULES } });
  await f.start();
  const results = await f.syncs.libra.applyToPeers(RULES);
  assert.deepEqual(JSON.parse(JSON.stringify(results)), { hayaku: { ok: true }, flashback: { ok: true } });
  for (const owner of ['hayaku', 'flashback']) assert.deepEqual(f.store[owner].sourceRules.ignoredTags, RULES.ignoredTags, owner);
  const states = await f.syncs.hayaku.compare();
  assert.deepEqual([states.libra.state, states.flashback.state], ['same', 'same']);
  f.dom.window.close();
});

test('a peer that is busy refuses, and internal suite rules are never accepted', async () => {
  const f = world({ saved: { libra: RULES }, busy: { flashback: true } });
  await f.start();
  const results = await f.syncs.libra.applyToPeers(RULES);
  assert.equal(results.hayaku.ok, true);
  assert.equal(results.flashback.ok, false);
  assert.match(results.flashback.error, /BUSY/);
  assert.equal(f.store.flashback, undefined, 'nothing written while busy');
  const internal = await f.syncs.libra.applyToPeers({ ...RULES, ignoredTags: [...RULES.ignoredTags, 'hayaku_packet_contract'] }).catch(error => ({ thrown: error.message }));
  assert.ok(internal.thrown || Object.values(internal).every(row => row.ok === false), 'a suite-owned rule is refused');
  f.dom.window.close();
});

test('only the three suite plugins may ask, and responses must come from the asked peer', async () => {
  const f = world({ saved: { hayaku: RULES } });
  await f.start();
  const stranger = f.api('some_other_plugin');
  await stranger.postPluginChannelMessage(IDS.hayaku, 'memory_suite_source_rules_v1', { schema: 'memory-suite.source-rules-sync.v1', kind: 'request', id: 'x1', action: 'apply', rules: { ...RULES, ignoredTags: ['evil'] } });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(f.store.hayaku.sourceRules.ignoredTags, RULES.ignoredTags, 'an unknown sender changes nothing');
  assert.equal(f.sent.filter(row => row.from === IDS.hayaku && row.target === 'some_other_plugin').length, 0, 'and gets no answer');
  f.dom.window.close();
});

test('the preview marks exactly what the rules remove, or shows the plain result', () => {
  const f = world();
  const rules = f.w.memorySuiteNormalizeSourceRules({ version: 1, ignoredTags: ['img', 'lb-xnai', 'status-window'], unwrapTags: ['wrap'], sourceTags: [], controls: ['html-comment', 'lbdata'] });
  const samples = [
    '민아가 웃었다.\n<img src="a.png">\n<status-window>HP 10</status-window>\n<!-- memo -->\n<wrap>감싼 문장</wrap>\n[LBDATA START]x[LBDATA END]\n끝.',
    '<lb-xnai scene="1">{{inlay::a}}</lb-xnai> 삽화만 <lb-xnai scene="2">창가의 하연</lb-xnai> 서술 남음',
    '닫히지 않은 <status-window>HP 9',
    '태그 없음'
  ];
  for (const text of samples) {
    const marked = f.w.memorySuiteMarkSourceProjection(text, rules);
    const expected = f.w.memorySuiteProjectSourceRules(f.w.memorySuiteStripInternalSource(text), rules).text;
    assert.equal(marked.exact, true, text);
    assert.equal(marked.segments.filter(s => !s.removed).map(s => s.text).join(''), expected, 'kept parts are the analysis input: ' + text);
    assert.equal(marked.segments.map(s => s.text).join(''), f.w.memorySuiteStripInternalSource(text), 'every character appears once');
  }
  const first = f.w.memorySuiteMarkSourceProjection(samples[0], rules);
  assert.deepEqual(Array.from(first.segments).filter(s => s.removed).map(s => s.text.trim()).filter(Boolean),
    ['<img src="a.png">', '<status-window>HP 10</status-window>', '<!-- memo -->', '<wrap>', '</wrap>', '[LBDATA START]x[LBDATA END]']);
  // A broken 이 안만 분석 area falls back to the whole message, as the analysis does.
  const only = f.w.memorySuiteNormalizeSourceRules({ version: 1, ignoredTags: [], unwrapTags: [], sourceTags: ['main'], controls: [] });
  const broken = f.w.memorySuiteMarkSourceProjection('앞 <main>안</main> <main>둘째</main>', only);
  assert.equal(broken.fallback, true);
  assert.equal(broken.segments.some(s => s.removed), false);
  f.dom.window.close();
});

test('the shared editor applies to the other plugins when asked, and the preview explains the built-in cleanup', async () => {
  const f = world({ saved: { libra: RULES } });
  await f.start();
  const host = f.w.document.querySelector('main');
  const messages = [{ text: '하연은 웃었다.\n<img src="x.png">\n<choice>1. 간다</choice>', role: 'assistant' }, { text: '문을 연다.', role: 'user' }];
  f.w.mountMemorySuiteSourceInputControls(host, { owner: 'hayaku', policy: f.policies.hayaku, ruleSync: f.syncs.hayaku,
    readSample: async () => messages.at(-1), readSamples: async () => messages, projectLegacySample: item => 'LEGACY:' + item.text });
  const find = s => host.querySelector(s);
  const wait = async fn => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 5)); } throw Error('WAIT_TIMEOUT'); };
  await wait(() => !find('[data-source-input-add]').disabled);
  await wait(() => find('[data-source-rule-sync-peer="libra"]')?.dataset.state === 'different');
  assert.equal(find('[data-source-rule-sync-peer="flashback"]').dataset.state, 'same', 'neither has saved rules');
  // Before any saved rule the preview shows the plugin's own cleanup, and says so once.
  find('[data-source-input-preview]').click();
  await wait(() => host.querySelectorAll('[data-source-preview-item]').length === 2);
  assert.match(find('[data-source-preview-list] small').textContent, /자체 정리 결과/);
  assert.match(host.querySelector('[data-source-preview-item] pre').textContent, /^LEGACY:/);
  // A changed draft is previewed with strikes, then applied here and in both peers.
  const last = [...host.querySelectorAll('[data-rule-value]')].at(-1);
  last.value = 'choice'; last.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  await wait(() => host.querySelector('[data-source-preview-item] del'));
  assert.match(find('[data-source-preview-list] small').textContent, /취소선/);
  assert.equal(find('[data-source-rule-sync-together]').checked, true);
  await find('[data-source-input-apply]').onclick();
  await wait(() => /LIBRA 적용됨/.test(find('[data-source-rule-sync-status]').textContent) && /Flashback 적용됨/.test(find('[data-source-rule-sync-status]').textContent));
  for (const owner of ['hayaku', 'libra', 'flashback']) assert.ok(f.store[owner].sourceRules.ignoredTags.includes('choice'), owner);
  await wait(() => ['libra', 'flashback'].every(peer => find(`[data-source-rule-sync-peer="${peer}"]`).dataset.state === 'same'));
  f.dom.window.close();
});

test('a peer whose rules changed since compare refuses the copy instead of overwriting them', async () => {
  const f = world({ saved: { libra: RULES } });
  await f.start();
  const states = await f.syncs.libra.compare();
  // Flashback is edited elsewhere after LIBRA looked.
  const elsewhere = { ...RULES, ignoredTags: ['flash-only'] };
  await f.policies.flashback.setSourceRules(elsewhere);
  const results = await f.syncs.libra.applyToPeers(RULES, ['hayaku', 'flashback'], { hayaku: states.hayaku.fingerprint, flashback: states.flashback.fingerprint });
  assert.equal(results.hayaku.ok, true);
  assert.equal(results.flashback.ok, false);
  assert.match(results.flashback.error, /CONFLICT/);
  assert.deepEqual(f.store.flashback.sourceRules.ignoredTags, ['flash-only'], 'the newer rules stay');
  f.dom.window.close();
});

test('an open editor shows rules applied from another plugin, and an edited draft asks before overwriting them', async () => {
  const f = world({ saved: { libra: RULES, hayaku: RULES } });
  await f.start();
  const host = f.w.document.querySelector('main');
  f.w.mountMemorySuiteSourceInputControls(host, { owner: 'hayaku', policy: f.policies.hayaku, ruleSync: f.syncs.hayaku });
  const find = q => host.querySelector(q);
  const values = () => [...host.querySelectorAll('[data-rule-value]')].map(node => node.value).filter(Boolean);
  const wait = async fn => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 5)); } throw Error('WAIT_TIMEOUT'); };
  await wait(() => !find('[data-source-input-add]').disabled);
  // Untouched editor: the new rules appear at once.
  const next = { ...RULES, ignoredTags: [...RULES.ignoredTags, 'from-libra'] };
  assert.equal((await f.syncs.libra.applyToPeers(next, ['hayaku'])).hayaku.ok, true);
  await wait(() => values().includes('from-libra'));
  assert.match(find('[data-source-input-status]').textContent, /바뀐 규칙을 불러왔습니다/);
  assert.equal(find('[data-source-remote-changed]').hidden, true);
  // Edited draft: kept, with a notice; the first 적용 only warns, the second overwrites.
  const last = [...host.querySelectorAll('[data-rule-value]')].at(-1);
  last.value = 'my-draft'; last.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  const third = { ...RULES, ignoredTags: [...RULES.ignoredTags, 'second-remote'] };
  await f.syncs.libra.applyToPeers(third, ['hayaku']);
  await wait(() => find('[data-source-remote-changed]').hidden === false);
  assert.ok(values().includes('my-draft') && !values().includes('second-remote'), 'the draft is not replaced');
  find('[data-source-rule-sync-together]').checked = false;
  await find('[data-source-input-apply]').onclick();
  assert.ok(f.store.hayaku.sourceRules.ignoredTags.includes('second-remote'), 'nothing saved on the first 적용');
  assert.match(find('[data-source-input-status]').textContent, /한 번 더/);
  await find('[data-source-input-apply]').onclick();
  await wait(() => f.store.hayaku.sourceRules.ignoredTags.includes('my-draft'));
  assert.equal(find('[data-source-remote-changed]').hidden, true);
  // 바뀐 규칙 불러오기 drops the draft for the rules saved elsewhere.
  last.value = ''; const again = [...host.querySelectorAll('[data-rule-value]')].at(-1);
  again.value = 'another-draft'; again.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  await f.syncs.libra.applyToPeers(next, ['hayaku']);
  await wait(() => find('[data-source-remote-changed]').hidden === false);
  find('[data-source-remote-load]').click();
  await wait(() => values().includes('from-libra') && !values().includes('another-draft'));
  f.dom.window.close();
});
