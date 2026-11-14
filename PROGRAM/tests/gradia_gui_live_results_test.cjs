'use strict';

// Run results must show while the settings GUI stays open: each finished stage appears
// during the run, and the final state appears after it, without reopening the GUI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const page of ['results', 'pipeline', 'providers']) {
  test(`finished stages appear live on the ${page} page while the run is still going`, async t => {
    const f = await fixture(t, { writingMode: 'rp', unified: false });
    const seenDuringRun = {};
    f.controls.onModel = async (_idx, body) => {
      const sys = systemOf(body);
      const stage = (sys.match(/"stage":\s*"([^"]+)"/) || [])[1] || '';
      if (stage === 'aide_plot') {
        // SHADOW finished earlier in this run; give the live refresh time to land.
        await sleep(1200);
        seenDuringRun.shadowResult = f.document.querySelector('[data-page="results"] [data-subpanel="s"]')?.textContent || '';
        seenDuringRun.shadowBadge = f.document.querySelector('[data-select-row="shadow"] .badge')?.textContent || '';
      }
      f.controls.output = sys.includes('draft_patch_v1')
        ? JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ok: true, analysis: { summary: 'ok', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], edits: [] })
        : 'LIVE_SHADOW_DRAFT 민아는 문 앞에 섰다.';
    };
    await f.host.plugin.saveRuntimeSettings({ ...await f.host.plugin.getRuntimeSettings(), mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', enable_shadow_act: true, enable_character_aide: false, enable_world_aide: false, enable_plot_aide: true, lore_activation_mode: 'off' });
    await f.host.plugin.openSettingsGui();
    await f.host.plugin.debugNavigateGui(page);
    f.chat.message.push({ role: 'user', chatId: 'u9', data: '문을 연다.' });
    await f.host.hooks.beforeRequest(f.chat.message.map(r => ({ role: r.role, content: r.data, chatId: r.chatId, messageId: r.chatId })), 'model');
    assert.match(seenDuringRun.shadowResult, /LIVE_SHADOW_DRAFT/, 'SHADOW result shows before Plot AIDE finishes');
    assert.match(seenDuringRun.shadowBadge, /성공/, 'SHADOW badge shows success during the run');
    await sleep(1200);
    assert.match(f.document.querySelector('[data-select-row="plot"] .badge')?.textContent || '', /성공/, 'Plot AIDE shows after the run without reopening');
  });
}
