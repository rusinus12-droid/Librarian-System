'use strict';
const { fixture: localFixture } = require('./libra_lore_link_index_fixture.cjs');
const { serverFixture, withLorebook } = require('./libra_server_runtime_fixture.cjs');
const { waitFor } = require('./libra_vm_harness.cjs');
const QUOTE = '민아가 은빛 열쇠를 준호에게 잠시 건넸다.';

async function fixture({ mode = 'plugin_only', minimum = false } = {}) {
  let listener;
  const host = { addRisuChatListener: async (_kind, handler) => { listener = handler; return true; } };
  const server = mode === 'server_only' ? await serverFixture({ mode, host }) : null;
  const f = server ? withLorebook(server.f) : await localFixture({ host });
  try {
    await f.run(); await f.r.api.retryPendingUnifiedVectors();
    const values = server?.local || f.r.values;
    const registry = JSON.parse(values.get('libra:v1:scope-registry:v1'));
    const scopeKey = Object.values(registry).find(row => row.chatId === f.chat.id).scopeKey;
    // This fake host explicitly configures its stored route before measuring the reader.
    // The shipped issuer still resolves and validates it; projection never creates a route.
    values.set('__memory_suite_internal_scope_routes_v1__:libra', JSON.stringify({
      schema: 'memory-suite.scope-routing.v1', namespace: 'libra', pluginId: 'LIBRA', legacyGlobalModeImported: true,
      entries: { [scopeKey]: { scopeId: scopeKey, scopeKey, mode, origin: 'user_explicit', updatedAt: 1 } }
    }));
    f.chat.message.push({ role: 'user', chatId: 't6-u', data: '열쇠는 누가 보관하지?' },
      { role: 'assistant', chatId: 't6-a', data: minimum ? QUOTE.repeat(30) : QUOTE });
    f.chat.messages = f.chat.message;
    f.control.onCall = async args => {
      if (minimum) return { type: 'error', result: 'fixture_micro_provider_unavailable' };
      const input = JSON.parse(args[0].messages[1].content);
      return { type: 'success', result: JSON.stringify({ schema: 'libra.micro_producer_envelope.v1',
        personCandidates: { spans: [], relations: [] }, micro: { schema: 'libra.micro_memory.v1', ...input.binding,
          claims: [{ changeKind: 'world', text: QUOTE, actor: '민아', target: '은빛 열쇠', temporalRole: 'current',
            certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none', evidence: {
              role: 'assistant', messageId: input.assistant.messageId, startOffset: 0, endOffset: QUOTE.length, exactQuote: QUOTE } }] } }) };
    };
    listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
    await new Promise(resolve => setTimeout(resolve, 5));
    const active = await f.r.api.debugReadActiveMicroMemory(6);
    if (active.status !== 'verified') throw new Error('graph fixture failed to publish a real Micro');
    f.control.onCall = async () => { throw new Error('graph projection must not invoke a provider'); };
    return { f, server, scopeKey, active,
      project: options => f.r.api.getMemoryGraphProjectionPage({ expectedScopeKey: scopeKey, ...options }),
      async cleanup() { if (server) await server.cleanup(); else await f.r.cleanup(); } };
  } catch (error) { if (server) await server.cleanup(); else await f.r.cleanup(); throw error; }
}
module.exports = { fixture, QUOTE };
