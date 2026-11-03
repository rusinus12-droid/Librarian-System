'use strict';
// LIBRA's GRADIA memory read runs outside the scope writer queue. When a canonical
// scan rewrites the manifest (in-flight marker, frontiers) while that read runs, the
// owner proof saw a changed shared source and the whole GRADIA read failed with
// LIB_READ_UNIFIED_UNAVAILABLE. A bounded retry must read a consistent state instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const ANCHOR = '    const captureGradiaMemoryEvidenceOnce = async (request, authority) => {';
test('server_only: GRADIA memory read survives a canonical scan writing the manifest', { timeout: 300000 }, async () => {
  // Ten Micro turns reach the canonical scan boundary, so the background scan runs
  // (and writes the manifest) right when the read below starts.
  const x = await fixture({ mode: 'server_only', microCount: 10, transformSource: source => {
    assert.equal(source.split(ANCHOR).length, 2);
    return source.replace(ANCHOR, '    globalThis.__gradiaCapture = (r, a) => captureGradiaMemoryEvidence(r, a);\n' + ANCHOR);
  } });
  try {
    const registry = JSON.parse(x.server.local.get('libra:v1:scope-registry:v1'));
    const row = Object.values(registry).find(r => r.scopeKey === x.scopeKey);
    const request = { id: 'gradia-scan', operationId: 'gradia-scan', queryText: QUOTE, maxCorpusBytes: 4 * 1024 * 1024,
      scope: { scopeKey: x.scopeKey, characterId: row.characterId, chatId: row.chatId } };
    let receipt = null;
    const authority = {
      bindGraph: graph => (receipt = Object.freeze({ selectionReceiptId: request.id, ownerCorpusDigest: crypto.createHash('sha256')
        .update(JSON.stringify({ frame: graph.readerFrame, nodes: graph.nodes.map(n => [n.id, n.bindingId]) })).digest('hex') })),
      verifyReceipt: value => JSON.stringify(value) === JSON.stringify(receipt)
    };
    const execution = await x.f.r.context.__gradiaCapture(request, authority);
    assert.equal(execution.modelDispatchEligible, true);
    assert.ok(String(execution.packet?.renderedText || '').length > 0);
  } finally { await x.cleanup(); }
});
