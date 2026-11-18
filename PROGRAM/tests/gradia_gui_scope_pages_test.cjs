'use strict';

// GUI settings by scope (2026-11-18): settings that apply to every chat and every stage live on
// the 작성 방식 page, settings and records of the current chat on the 이 채팅 page, and stage
// panels keep only what belongs to their stage, plus a pointer where data used to be.
// Design: docs/gradia/GUI-SETTINGS-SCOPE-20261118.md

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradia, sleep } = require('./fixtures/companion_gui_fixture.cjs');

const until = async (check, label, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > end) throw new Error('WAIT_TIMEOUT: ' + label); await sleep(20); }
};

test('the sidebar offers 작성 방식 and 이 채팅, and each control lives in one place', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    const d = f.doc;
    const nav = [...d.querySelectorAll('.sidebar .nav-item[data-go]')].map(node => node.dataset.go);
    assert.deepEqual(nav.slice(nav.indexOf('pipeline'), nav.indexOf('pipeline') + 3), ['pipeline', 'writing', 'chat']);
    for (const attr of ['data-npc-disposition-panel', 'data-forced-bond-cards', 'data-forced-bond-proposals', 'data-body-state-cards', 'data-intimacy-cards', 'data-scene-variance',
      'data-body-state-readings', 'data-world-dynamics-readings', 'data-intimacy-readings']) {
      assert.equal(d.querySelectorAll(`[${attr}]`).length, 1, attr + ' exists once');
      assert.ok(d.querySelector(`section[data-page="${attr === 'data-scene-variance' ? 'writing' : 'chat'}"] [${attr}]`), attr + ' is on its scope page');
      assert.equal(d.querySelector(`.stage-detail [${attr}]`), null, attr + ' is not inside a stage panel');
    }
    for (const key of ['nsfwMode', 'nsfwGuidanceEnabled', 'nsfwInjectFinalRequest', 'biancaInject']) {
      assert.ok(d.querySelector(`section[data-page="writing"] [data-existing-response-field="${key}"]`), key + ' on 작성 방식');
      assert.equal(d.querySelector(`.stage-detail[data-detail="main"] [data-existing-response-field="${key}"]`), null, key + ' left the main card');
    }
    assert.match(d.querySelector('section[data-page="writing"] .page-title').textContent, /모든 채팅/);
    assert.match(d.querySelector('section[data-page="chat"] .page-title').textContent, /이 채팅/);
    assert.ok(d.querySelectorAll('.stage-detail .scope-chip--stage').length >= 9, 'every stage panel is marked 이 단계');
  } finally { await f.close(); }
});

test('a stage panel pointer opens the 이 채팅 page at its section', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('pipeline');
    const d = f.doc;
    for (const [detail, sub] of [['char', 'disposition'], ['forced_bond', 'bond'], ['body_state', 'state'], ['intimacy', 'intimacy'], ['world_dynamics', 'readings']]) {
      assert.ok(d.querySelector(`.stage-detail[data-detail="${detail}"] [data-go="chat"][data-go-sub="${sub}"]`), `${detail} points to ${sub}`);
    }
    d.querySelector('.stage-detail[data-detail="forced_bond"] [data-go="chat"]').click();
    await until(() => f.plugin.debugGuiStateInfo().pageId === 'chat', 'chat page');
    const section = await until(() => d.querySelector('section[data-page="chat"] [data-chat-section="bond"].is-flash'), 'bond section highlighted');
    assert.ok(section.querySelector('[data-forced-bond-cards]'));
    d.querySelector('.stage-detail[data-detail="shadow"] [data-go="writing"]').click();
    await until(() => f.plugin.debugGuiStateInfo().pageId === 'writing', 'writing page');
  } finally { await f.close(); }
});

test('RP 세부 모드 on 작성 방식 is filled, and disabled with a reason in Novel mode', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('writing');
    const d = f.doc;
    const select = await until(() => d.querySelector('section[data-page="writing"] [data-existing-response-field="rpImpersonationScope"]'), 'scope select');
    assert.equal(select.options.length, 3);
    if (d.querySelector('.mode-switch [aria-pressed="true"]')?.dataset.mode === 'novel') {
      assert.equal(select.disabled, true);
      assert.match(d.querySelector('[data-writing-rp-scope-hint]').textContent, /소설 모드에서는 쓰이지 않습니다/);
    }
  } finally { await f.close(); }
});
