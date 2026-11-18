'use strict';
// 원문 태그 설정을 쉽게: (A) the default rules carry the presentation tags the built-in cleanup
// already removes, and a saved rule set missing them is told so with a one-click draft fix;
// (B) 채팅에서 태그 찾기 lists the tags and markers in recent messages with how the draft
// rules treat each, and adds a rule in one click. Nothing is saved until 적용.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const root = path.join(__dirname, '..');
const POLICY = fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInput.libra.source.js'), 'utf8');
const CONTROLS = fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInputControls.source.js'), 'utf8');
const sdk = () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(POLICY + '\n' + CONTROLS + ';globalThis.api={memorySuiteDefaultSourceRules,memorySuiteMissingDefaultSourceTags,memorySuiteSourceTagInventory,memorySuiteNormalizeSourceRules,memorySuiteProjectSourceRules,memorySuiteStripInternalSource};', context);
  return context.api;
};
// A rule set saved before the defaults carried the presentation tags, plus one custom tag.
const OLD_SAVED = { version: 1, ignoredTags: ['lb-xnai', 'status-window', 'thoughts'], unwrapTags: [], sourceTags: [], controls: ['html-comment', 'lbdata'] };
const MESSAGES = [
  '민아가 도서관 문을 열었다.\n<img src="door.png">\n<status-window>HP 10 · 위치: 도서관</status-window>',
  '열쇠를 보여 줘.',
  '민아는 열쇠를 내밀었다.\n<lb-xnai scene="2">{{inlay::abc}}</lb-xnai>\n<lb-stage id="1">무대</lb-stage>\n<status-window>HP 9</status-window>\n<!-- 작가 메모 -->\n<choice>1. 받는다 2. 거절한다</choice>'
];

test('default rules leave out what the built-in cleanup leaves out, and a saved set missing them is detected', () => {
  const api = sdk();
  const defaults = api.memorySuiteNormalizeSourceRules(api.memorySuiteDefaultSourceRules('libra'));
  for (const name of ['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker', 'lb-xnai', 'thoughts']) assert.ok(defaults.ignoredTags.includes(name), 'libra: ' + name);
  const text = api.memorySuiteProjectSourceRules('하연이 웃었다.\n<img src="a.png">\n<lb-stage id="1">무대</lb-stage>\n<lb-lazy id="x" />\n그녀는 창밖을 보았다.', defaults).text;
  assert.doesNotMatch(text, /<img|lb-stage|lb-lazy/, 'images and LightBoard markers do not reach the analysis');
  assert.match(text, /하연이 웃었다[\s\S]*창밖을 보았다/);
  assert.deepEqual(Array.from(api.memorySuiteMissingDefaultSourceTags(OLD_SAVED, 'libra')), ['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker']);
  assert.deepEqual(Array.from(api.memorySuiteMissingDefaultSourceTags({ ...OLD_SAVED, unwrapTags: ['img'], ignoredTags: [...OLD_SAVED.ignoredTags, 'lb-lazy', 'lb-stage', 'lb-stage-marker'] }, 'libra')), [], 'any action counts as handled');
  assert.deepEqual(Array.from(api.memorySuiteMissingDefaultSourceTags(null, 'libra')), []);
  // Each owner's defaults match its own built-in cleanup (measured on the real GUI preview):
  // Flashback drops images and lazy markers, HAYAKU keeps all four.
  const flashback = api.memorySuiteNormalizeSourceRules(api.memorySuiteDefaultSourceRules('flashback')).ignoredTags;
  assert.deepEqual(['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker'].filter(name => flashback.includes(name)), ['img', 'lb-lazy']);
  const hayaku = api.memorySuiteNormalizeSourceRules(api.memorySuiteDefaultSourceRules('hayaku')).ignoredTags;
  assert.deepEqual(['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker'].filter(name => hayaku.includes(name)), []);
  assert.deepEqual(Array.from(api.memorySuiteMissingDefaultSourceTags(OLD_SAVED, 'flashback')), ['img', 'lb-lazy']);
  assert.deepEqual(Array.from(api.memorySuiteMissingDefaultSourceTags(OLD_SAVED, 'hayaku')), [], 'HAYAKU never shows the notice');
});

test('the tag inventory reads treatment from the projection, so nested and excluded items are not offered again', () => {
  const api = sdk();
  const rules = api.memorySuiteNormalizeSourceRules(OLD_SAVED);
  const rows = Object.fromEntries(api.memorySuiteSourceTagInventory(MESSAGES, rules).map(row => [row.name, row]));
  assert.equal(rows['status-window'].treatment, 'ignoredTags');
  assert.equal(rows['status-window'].messages, 2);
  assert.equal(rows['status-window'].example, 'HP 10 · 위치: 도서관');
  assert.equal(rows.img.treatment, 'analyzed');
  assert.equal(rows.img.hint, '이미지');
  assert.equal(rows.choice.treatment, 'analyzed');
  assert.equal(rows['@html-comment'].treatment, 'ignoredTags');
  assert.equal(rows['@inlay'].treatment, 'covered', 'an inlay inside an excluded lb-xnai is already left out');
  assert.equal(api.memorySuiteSourceTagInventory(['<x-hayaku>'], null).length, 1, 'without rules every item is listed');
  // Suite-owned packet envelopes never appear as user tags.
  assert.equal(api.memorySuiteSourceTagInventory(['본문 <!-- HAYAKU_STATE_PACKET_START {"a":1} HAYAKU_STATE_PACKET_END -->'], rules).length, 0);
});

test('the shared editor shows the missing-defaults notice and the finder, and adds rules only to the draft', async () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  const window = dom.window;
  window.eval(POLICY + '\n' + CONTROLS);
  const writes = [];
  const policy = window.createLibraSourceInputPolicy({ read: async () => JSON.stringify({ ignoredTags: OLD_SAVED.ignoredTags, sourceRules: OLD_SAVED }), write: async body => { writes.push(JSON.parse(body)); return true; } });
  const host = window.document.querySelector('main');
  window.mountMemorySuiteSourceInputControls(host, { owner: 'libra', policy, readSample: async () => ({ text: MESSAGES.at(-1) }), readSamples: async () => MESSAGES });
  const find = selector => host.querySelector(selector);
  const wait = async fn => { for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw Error('WAIT_TIMEOUT'); };
  const ruleValues = () => [...host.querySelectorAll('[data-source-input-row] [data-rule-value]')].map(node => node.value).filter(Boolean);
  await wait(() => !find('[data-source-input-add]').disabled);
  const notice = find('[data-source-missing-defaults]');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /<img>, <lb-lazy>, <lb-stage>, <lb-stage-marker>/);
  find('[data-source-missing-defaults-add]').click();
  for (const name of ['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker']) assert.ok(ruleValues().includes(name), name);
  assert.equal(notice.hidden, true);
  assert.equal(writes.length, 0, 'the notice changes only the draft');

  find('[data-source-tag-find]').click();
  await wait(() => host.querySelector('[data-source-tag-finder-row="choice"]'));
  const imgRow = find('[data-source-tag-finder-row="img"]');
  assert.equal(imgRow.dataset.treatment, 'ignoredTags', 'the finder follows the draft, including rules just added');
  assert.equal(imgRow.querySelector('[data-source-tag-finder-add]'), null, 'a handled item offers no action');
  const choice = find('[data-source-tag-finder-row="choice"]');
  choice.querySelector('[data-source-tag-finder-add="ignoredTags"]').click();
  assert.ok(ruleValues().includes('choice'));
  assert.equal(find('[data-source-tag-finder-row="choice"]').dataset.treatment, 'ignoredTags');
  assert.equal(writes.length, 0);

  await find('[data-source-input-apply]').onclick();
  const saved = writes.at(-1).sourceRules;
  for (const name of ['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker', 'choice', 'status-window']) assert.ok(saved.ignoredTags.includes(name), name);
  window.close();
});

test('LIBRA’s own editor carries the same notice and finder over the current chat', async () => {
  const dom = new JSDOM('<main></main>'), document = dom.window.document;
  const seam = 'const libraSourceInput = createLibraSourceInputPolicy(libraSourceInputConfig);';
  const chat = { id: 'finder-chat', message: [{ role: 'user', chatId: 'finder-u', data: '문을 연다.' }, { role: 'char', chatId: 'finder-a', data: '하연은 웃었다.\n<choice>1. 간다</choice>\n<img src="x.png">' }] };
  chat.messages = chat.message;
  const character = { chaId: 'finder-char', name: '하연', chats: [chat], chatPage: 0, lorebook: [] };
  const host = { getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getCharacter: async () => character, getChar: async () => character,
    getCharacterFromIndex: async () => character, getChatFromIndex: async () => chat, getChat: async () => chat, getCurrentChat: async () => chat,
    getDatabase: async () => ({ characters: [character], personas: [], modules: [] }) };
  const f = await createLibraVmHarness({}, host, { contextGlobals: { document }, transformSource: source => {
    assert.equal(source.split(seam).length, 2);
    return source.replace(seam, seam + ' globalThis.__mountInput=mountLibraSourceInputControls;');
  } });
  try {
    await f.api.setSourceEditRules(OLD_SAVED);
    const panel = document.querySelector('main');
    f.context.__mountInput(panel);
    const find = selector => panel.querySelector(selector);
    const wait = async fn => { for (let i = 0; i < 300; i++) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw Error('WAIT_TIMEOUT'); };
    await wait(() => !find('[data-source-input-add]').disabled);
    assert.equal(find('[data-source-missing-defaults]').hidden, false, 'a saved set missing defaults is pointed out');
    find('[data-source-tag-find]').click();
    const choice = await wait(() => find('[data-source-tag-finder-row="choice"]'));
    assert.equal(choice.dataset.treatment, 'analyzed');
    choice.querySelector('[data-source-tag-finder-add="unwrapTags"]').click();
    await find('[data-source-input-apply]').onclick();
    assert.ok(Array.from(f.api.getSourceEditRules().unwrapTags).includes('choice'));
  } finally { await f.cleanup?.(); dom.window.close(); }
});
