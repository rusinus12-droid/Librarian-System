'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const start = source.indexOf('    const mainAfterRequestPairProof = (context,pair,health=state.mainAfterRequestHealth) => {');
const end = source.indexOf('    const freshMainAfterRequestPair =', start);
assert.ok(start >= 0 && end > start, 'mainAfterRequestPairProof region found');

const context = {
  TURN_BINDING_FRESHNESS_MS: 120000,
  state: {
    mainAfterRequestHealth: null,
    lastRequestScope: { pendingMicro: null }
  },
  digest: value => `d:${String(value ?? '')}`,
  sourceDigest: pairs => `sd:${pairs.length}`,
  buildPairs: () => [],
  completedTurnRevisionId: pair => pair.revisionId,
  completionAssistantDigest: text => `ad:${String(text || '').replace(/<lb-xnai>[\s\S]*?<\/lb-xnai>/gi, '').trim()}`,
  rawChatMessages: () => [],
  pairRevisionRawPayload: () => '',
  contentToText: v => String(v ?? ''),
  completionPacketProof: () => '',
  stateMemoryFingerprint: v => String(v ?? '')
};
vm.createContext(context);
vm.runInContext(source.slice(start, end) + '\nglobalThis.mainAfterRequestPairProof = mainAfterRequestPairProof;', context);

const health = {
  at: Date.now(),
  microBoundary: {
    scopeKey: 's1',
    turn: 16,
    userHash: 'd:user text',
    prefixDigest: 'sd:0',
    assistantHash: 'ad:assistant narrative',
    legacyAssistantHash: '',
    committedRevisionId: 'rev1'
  }
};
context.state.mainAfterRequestHealth = health;

const ctx = { scope: { scopeKey: 's1' }, chat: {} };
const textEquivalentPair = {
  turn: 16,
  revisionId: '5f7d45fe2636',
  user: { text: 'user text', identityStable: true, identityCanonical: true, chatIds: ['u16'] },
  assistant: { text: 'assistant narrative\n<lb-xnai>{{inlay::1}}</lb-xnai>', sourceMessageCount: 1 }
};
const resEquivalent = context.mainAfterRequestPairProof(ctx, textEquivalentPair, health);
assert.equal(resEquivalent.ok, true, 'text-equivalent revision after committedRevisionId remains valid');

const editedPair = {
  turn: 16,
  revisionId: 'rev_edited',
  user: { text: 'user text', identityStable: true, identityCanonical: true, chatIds: ['u16'] },
  assistant: { text: 'completely different assistant narrative', sourceMessageCount: 1 }
};
const resEdited = context.mainAfterRequestPairProof(ctx, editedPair, health);
assert.equal(resEdited.ok, false);
assert.equal(resEdited.reason, 'assistant_source_changed');

console.log('PASS libra_main_after_request_proof_revision_test');
