'use strict';
// The three memory plugins compare and copy tag rules over plugin IPC. RisuAI delivers a
// message only when sender and receiver each list the other in //@allowed-ipc; without that
// every peer showed "응답 없음" even when installed. This runs the upstream channel code against
// the shipped headers.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const createRisuChannelHost = require('./fixtures/risu_plugin_channel_host.cjs');

const root = path.join(__dirname, '..');
const SDK = fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInput.libra.source.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceInputControls.source.js'), 'utf8');
const FILES = { libra: 'LIBRA.js', hayaku: 'HAYAKU_Locator_Continuity.js', flashback: 'Flashback_Memory.js', gradia: 'GRADIA.js' };
const IDS = { libra: 'libra', hayaku: 'hayaku_locator_continuity', flashback: 'flashback_memory', gradia: 'serial_gradation_agents_for_rp' };
const header = file => fs.readFileSync(path.join(root, 'plugins', file), 'utf8').split('\n').slice(0, 40).filter(l => l.startsWith('//@')).join('\n');

test('every memory plugin reaches the other two through the real RisuAI channel rules', async () => {
  const host = createRisuChannelHost(Object.fromEntries(Object.entries(FILES).map(([owner, file]) => [IDS[owner], header(file)])));
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  dom.window.eval(SDK);
  const store = {}, syncs = {};
  for (const owner of Object.keys(FILES)) {
    const policy = dom.window.createMemorySuiteSourceInputPolicy({ owner, busy: () => false,
      read: async () => owner in store ? JSON.stringify(store[owner]) : null,
      write: async body => { store[owner] = JSON.parse(body); return true; } });
    syncs[owner] = dom.window.createMemorySuiteSourceRuleSync({ owner, policy, api: () => host.api(IDS[owner]) });
    assert.equal(await syncs[owner].start(), true);
  }
  try {
    for (const owner of Object.keys(FILES)) {
      const states = await syncs[owner].compare();
      for (const [peer, state] of Object.entries(states)) assert.notEqual(state.state, 'absent', `${owner} → ${peer}`);
    }
    assert.deepEqual(host.warnings, []);
  } finally { host.dispose(); dom.window.close(); }
});
