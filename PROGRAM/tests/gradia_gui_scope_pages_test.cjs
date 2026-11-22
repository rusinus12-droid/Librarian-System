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
    for (const attr of ['data-npc-disposition-panel', 'data-forced-bond-cards', 'data-body-state-cards', 'data-intimacy-cards', 'data-scene-variance',
      'data-body-state-readings', 'data-world-dynamics-readings', 'data-intimacy-readings']) {
      assert.equal(d.querySelectorAll(`[${attr}]`).length, 1, attr + ' exists once');
      assert.ok(d.querySelector(`section[data-page="${attr === 'data-scene-variance' ? 'writing' : 'chat'}"] [${attr}]`), attr + ' is on its scope page');
      assert.equal(d.querySelector(`.stage-detail [${attr}]`), null, attr + ' is not inside a stage panel');
    }
    assert.equal(d.querySelector('[data-forced-bond-proposals]'), null, 'AI-proposed relationship section is removed');
    const dispAuto = d.querySelectorAll('section[data-page="chat"] [data-npc-disposition-field="auto"]');
    assert.equal(dispAuto.length, 1, 'NPC disposition auto-card toggle exists once');
    assert.equal(dispAuto[0].checked, true, 'NPC disposition auto-card generation is on by default');
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

// ---- Phase 2: search, why a stage does not run, settings that differ from defaults ----

const change = (f, node) => node.dispatchEvent(new f.doc.defaultView.Event('change', { bubbles: true }));

test('settings search finds a setting by name, synonym and stage, and goes to it', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    const d = f.doc;
    d.querySelector('[data-settings-search-open]').click();
    const input = await until(() => d.querySelector('[data-settings-search-input]'), 'search dialog');
    const search = query => { input.value = query; input.dispatchEvent(new f.doc.defaultView.Event('input')); return [...d.querySelectorAll('.search-hit')].map(node => node.textContent); };
    assert.ok(search('nsfw').some(text => text.startsWith('성인 장면 표현')), 'a synonym finds the adult-scene selector');
    assert.ok(search('대기 세계관').some(text => /대기 시간/.test(text) && /세계관 AIDE/.test(text)), 'words from the stage narrow it');
    assert.ok(search('기본값').some(text => text.startsWith('모든 NPC 기본값')));
    assert.ok(search('관계 카드').every(text => !/^세라/.test(text)), 'card contents are not settings');
    search('대기 세계관');
    [...d.querySelectorAll('.search-hit')].find(node => /세계관 AIDE/.test(node.textContent)).click();
    await until(() => d.querySelector('.stage-detail.is-on')?.dataset.detail === 'world', 'world panel selected');
    assert.equal(f.plugin.debugGuiStateInfo().pageId, 'pipeline');
    assert.ok(d.querySelector('.stage-detail[data-detail="world"] .is-flash'), 'the setting is highlighted');
    assert.equal(d.querySelector('[data-settings-search-input]'), null, 'the dialog closes');
    d.dispatchEvent(new f.doc.defaultView.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    assert.ok(await until(() => d.querySelector('[data-settings-search-input]'), 'Ctrl+K opens search'));
  } finally { await f.close(); }
});

test('a stage panel says why it will not run, or who runs it, with a link to the cause', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('pipeline');
    const d = f.doc;
    const notes = detail => [...d.querySelectorAll(`.stage-detail[data-detail="${detail}"] [data-stage-blockers] .note`)];
    const intimacy = d.querySelector('#on-s8');
    intimacy.checked = true; change(f, intimacy);
    const blocker = await until(() => notes('intimacy').find(node => /성인 장면 표현이 OFF라 정사 AIDE가 실행되지 않습니다/.test(node.textContent)), 'NSFW blocker');
    assert.equal(blocker.querySelector('button').dataset.go, 'writing');
    assert.equal(blocker.querySelector('button').dataset.goSub, 'nsfw');
    const body = d.querySelector('#on-s6');
    body.checked = true; change(f, body);
    const character = d.querySelector('#on-s2');
    character.checked = false; change(f, character);
    await until(() => notes('body_state').some(node => /인물 AIDE가 꺼져 있어 .+ 대신 처리합니다/.test(node.textContent)), 'host note');
    const bond = d.querySelector('section[data-page="chat"] [data-chat-section="bond"] [data-chat-blockers]');
    assert.match(bond.textContent, /억결 AIDE가 꺼져 있어 이 카드들은 지금 쓰이지 않습니다/);
  } finally { await f.close(); }
});

test('바꾼 설정 lists what differs from the defaults and can restore one', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('pipeline');
    const d = f.doc;
    const before = d.querySelectorAll('[data-changed-settings] .changed-row').length;
    const world = d.querySelector('#on-s3');
    world.checked = false; change(f, world);
    const row = await until(() => [...d.querySelectorAll('[data-changed-settings] .changed-row')].find(node => /세계관 AIDE · 사용/.test(node.textContent)), 'changed row');
    assert.match(row.textContent, /현재 꺼짐 · 기본 켜짐/);
    assert.equal(d.querySelectorAll('[data-changed-settings] .changed-row').length, before + 1);
    assert.equal(d.querySelector('[data-changed-count]').textContent, String(before + 1));
    [...row.querySelectorAll('button')].find(node => node.textContent === '기본값으로').click();
    await until(() => d.querySelector('#on-s3').checked === true, 'restored');
    assert.equal(d.querySelectorAll('[data-changed-settings] .changed-row').length, before);
  } finally { await f.close(); }
});

// ---- Phase 3: one table for every stage's use, preset and limits ----

test('the stage table lists stages in run order and edits the same values as the stage panels', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('pipeline');
    const d = f.doc;
    const box = await until(() => d.querySelector('section[data-page="pipeline"] [data-stage-matrix] table'), 'stage table');
    const rows = [...box.querySelectorAll('[data-matrix-row]')].map(node => node.dataset.matrixRow);
    assert.deepEqual(rows, ['shadow_act', 'aide_character', 'aide_body_state', 'aide_knowledge_boundary', 'aide_dialogue', 'aide_intimacy', 'aide_relationship_sim', 'aide_world', 'aide_world_dynamics', 'aide_plot', 'aide_forced_bond']);
    const cell = (id, field) => box.querySelector(`[data-matrix-row="${id}"] [data-matrix-field="${field}"]`);
    const turns = cell('aide_world', 'turnWindow');
    turns.value = '12'; change(f, turns);
    await until(() => d.querySelector('.stage-detail[data-detail="world"] [data-turns]').value === '12', 'panel follows the table');
    assert.ok(cell('aide_world', 'turnWindow').closest('td').classList.contains('is-changed'), 'a changed value is marked');
    const cap = cell('aide_plot', 'maxChars');
    cap.value = '999999'; change(f, cap);
    await until(() => cell('aide_plot', 'maxChars').value === '60000', 'clamped like the panel');
    const enabled = cell('aide_intimacy', 'enabled');
    enabled.checked = true; change(f, enabled);
    await until(() => d.querySelector('#on-s8').checked === true, 'panel switch follows the table');
    const status = box.querySelector('[data-matrix-row="aide_intimacy"] [data-matrix-status]');
    await until(() => /실행 안 됨/.test(status.textContent) && /성인 장면 표현이 OFF/.test(status.textContent), 'status gives the reason');
    assert.match(box.querySelector('[data-matrix-row="aide_body_state"] [data-matrix-status]').textContent, /꺼짐/);
  } finally { await f.close(); }
});

test('a value applied to every stage reaches every row', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('pipeline');
    const d = f.doc;
    const box = await until(() => d.querySelector('[data-stage-matrix] table'), 'stage table');
    box.querySelector('[data-matrix-bulk="timeoutSeconds"]').value = '90';
    box.querySelector('[data-matrix-bulk-apply="timeoutSeconds"]').click();
    await until(() => [...box.querySelectorAll('[data-matrix-field="timeoutSeconds"]')].every(node => node.value === '90'), 'every row at 90 s');
    const state = f.plugin.debugGuiStateInfo();
    assert.equal(state.dirty, true, 'the change waits for save');
  } finally { await f.close(); }
});
