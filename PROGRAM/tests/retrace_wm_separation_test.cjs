'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const shellMatch = retrace => retrace.match(/root\.innerHTML = ("(?:\\.|[^"\\])*");/s);
const program = process.env.REGRESSION_PROGRAM || path.resolve(__dirname, '..');
const retrace = fs.readFileSync(path.join(program, 'plugins/RETRACE.js'), 'utf8');
const lia = fs.readFileSync(path.join(program, 'plugins/LIA_Persona_Linker.js'), 'utf8');

// Restoring any standalone WM handoff, IPC, or management surface must fail here.
test('RETRACE excludes standalone WM integration surfaces', () => {
  const markers = ['WmHandoffReceipt', 'libra_world_manager', 'includeWm', 'wmHandoff', 'WmIpc', 'wm-import', 'serverControlWm', 'wmImport', 'wmRequired', 'wmVerified'];
  assert.deepEqual(markers.filter(marker => retrace.includes(marker)), []);
});
test('RETRACE keeps four memory peers and all five server namespaces', () => {
  assert.ok(retrace.includes("ACTIVE_RETRACE_PEER_KEYS = Object.freeze(['flashback', 'hayaku', 'libra', 'lia'])"));
  assert.ok(retrace.includes("MEMORY_SUITE_OWNER_STATUS_ORDER = Object.freeze(['flashback', 'hayaku', 'libra', 'lia'])"));
  // The approved GUI embeds one literal shell. Parse it instead of matching
  // unescaped markup in JavaScript source; all five selectable namespaces remain.
  const match = shellMatch(retrace); assert.ok(match, 'literal approved shell');
  const document = new JSDOM(JSON.parse(match[1])).window.document;
  assert.deepEqual([...document.querySelectorAll('[data-control-namespace]')].map(n => n.value).sort(), ['flashback','hayaku','lia','libra','retrace']);
  for (const node of document.querySelectorAll('[data-control-namespace]')) assert.equal(node.type, 'checkbox', 'namespace remains independently selectable');
  for (const action of ['backup-create', 'backup-check', 'restore-plan', 'restore-execute']) {
    assert.ok(document.querySelector('[data-server-control="' + action + '"]'), action);
  }
});
test('LIBRA internal World Manager refresh and ordinary LIA handoffs remain', () => {
  assert.ok(retrace.includes('libraApi?.rebuildWorldManagerState'));
  assert.ok(retrace.includes("await libraApi.rebuildWorldManagerState({ reason: 'retrace_handoff_completed', persist: true })"));
  assert.ok(lia.includes('async function adoptLivePersonaHandoff('));
  assert.ok(lia.includes('async function verifyChatHandoff('));
  assert.ok(lia.includes('action === "adopt_chat_handoff"'));
  assert.ok(lia.includes('action === "verify_chat_handoff"'));
});
test('LIA excludes its WM-only persona preactivation bridge', () => {
  for (const marker of ['prepareLivePersonaHandoff', 'targetPersonaPreactivation', 'prepare_chat_handoff', 'includeWm', 'wmHandoff']) {
    assert.equal(lia.includes(marker), false, marker);
  }
});
