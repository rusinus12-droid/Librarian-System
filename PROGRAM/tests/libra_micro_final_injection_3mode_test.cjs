'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const DETAIL = '도서관 전체는 정숙 구역';


(async () => {
  // Task 9 consumer cutover: the Classic response mode must present a verified one-turn Micro as
  // turn evidence, not as five-turn Canonical memory. Same durable Micro as above, different
  // consumer; the assertion is on the exact injected block, not on a flag.
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fx = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fx;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async args => {
        const input = JSON.parse(args[0].messages[1].content);
        const startOffset = input.assistant.text.indexOf(DETAIL);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...input.binding,
            claims: [{changeKind: 'world', text: `${DETAIL}이다.`, actor: '', target: '도서관',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'none', evidence: {role: 'assistant',
                messageId: input.assistant.messageId, startOffset,
                endOffset: startOffset + DETAIL.length, exactQuote: DETAIL}}]}
        })};
      };
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
        messageIndex: 1});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);

      await f.r.api.saveLibraProviderConfig({responseFamily: 'libra', libraResponseMode: 'classic'});
      const delivered = await f.control.hooks.beforeRequest([
        {role: 'user', content: '도서관의 정숙 규칙을 고려해서 이어줘.'}
      ], 'model');
      const classicBlock = delivered.map(row => String(row.content || '')).join('\n');
      assert.ok(classicBlock.includes(DETAIL),
        `${mode}: the Classic block carries the verified Micro evidence`);
      assert.match(classicBlock, /TURN EVIDENCE \(MICRO\)/,
        `${mode}: Classic labels a one-turn Micro as turn evidence`);
      assert.doesNotMatch(classicBlock, /\[(?:HISTORICAL|LATEST RELEVANT) CANONICAL EVIDENCE[^\]]*\]\n[^\n]*${DETAIL}/,
        `${mode}: Classic must not label that Micro as Canonical evidence`);
      const viewer = f.r.api.getLastMemoryRecallViewer();
      assert.ok(viewer?.rows?.some(row => row.kind === 'micro'),
        `${mode}: the delivery rows keep the Micro kind for diagnostics`);
      console.log(`PASS pre-Canonical Micro Classic final input in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
