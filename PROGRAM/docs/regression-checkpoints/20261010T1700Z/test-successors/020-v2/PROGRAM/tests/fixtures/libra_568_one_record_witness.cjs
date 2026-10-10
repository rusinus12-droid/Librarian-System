'use strict';
// Pure, finite witness for the single T1..T5/v4 fixture. No product imports or I/O.
// Preparation may replace only the exact missing-key embedding and manifest
// metadata. Sections/anchors/retrieval already exist at initial commit and stay exact.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const VERSION = 'libra.retrieval_projection.v2';
const LIMITS = Object.freeze({ rows: 256, rowChars: 1048576, totalChars: 16777216, requests: 4096 });
const copy = value => JSON.parse(JSON.stringify(value));
const json = value => JSON.stringify(value);
const same = (a, b, label) => assert.equal(json(a), json(b), `568 witness: ${label}`);
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
// Test-only reproduction of the pinned source's stored non-cryptographic digest.
const digest = value => {
  const body = typeof value === 'string' ? value : json(value ?? null);
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) hash = Math.imul(hash ^ body.charCodeAt(index), 16777619);
  hash = Math.imul(hash ^ 31, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${body.length + 1}`;
};
const evidenceDigest = value => {
  const body = typeof value === 'string' ? value : json(value);
  let a = 2166136261, b = 2246822507;
  for (let i = 0; i < body.length; i += 1) {
    a = Math.imul(a ^ body.charCodeAt(i), 16777619);
    b = Math.imul(b ^ body.charCodeAt(i), 3266489909);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + body.length;
};
const branchDigest = body => {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < body.length; i += 1) {
    a = Math.imul(a ^ body.charCodeAt(i), 16777619);
    b = Math.imul(b ^ ((body.charCodeAt(i) + i) >>> 0), 2246822519); b ^= b >>> 13;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + body.length;
};
const parsed = row => { try { return JSON.parse(row.raw); } catch { return null; } };
const ownersFor = mode => mode === 'plugin_only' ? ['local'] : mode === 'server_only' ? ['server'] : ['local', 'server'];
const terminalEmbedding = () => ({ status: 'disabled', reason: 'API Key', projectionVersion: VERSION, vectorCount: 0 });
const rowId = row => `${row.owner}\0${row.key}`;
function exactRows(w, key) {
  const rows = w.rows.filter(row => row.key === key);
  same(rows.map(row => row.owner).sort(), ownersFor(w.mode), `exact owners for ${key}`);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.raw, rows[0].raw, '568 witness: physical copies are byte-identical');
  return rows;
}
function physical(w) {
  assert.ok(['plugin_only', 'mirror', 'server_only'].includes(w.mode));
  assert.ok(Array.isArray(w.rows) && w.rows.length > 0 && w.rows.length <= LIMITS.rows);
  assert.equal(new Set(w.rows.map(rowId)).size, w.rows.length, '568 witness: unique physical rows');
  let total = 0;
  for (const row of w.rows) {
    assert.ok(['local', 'server'].includes(row.owner));
    assert.ok(typeof row.key === 'string' && row.key.length > 0);
    assert.equal(typeof row.raw, 'string');
    assert.ok(row.raw.length <= LIMITS.rowChars); total += row.raw.length;
    if (row.owner === 'local') assert.equal(row.revision, null);
    else assert.ok(Number.isSafeInteger(row.revision) && row.revision > 0);
    assert.ok(!/unified-vector-tx:|:vector:/.test(row.key), '568 witness: no vector/transaction residue, including orphan owners');
    assert.notEqual(parsed(row)?.schema, 'libra.micro_work.v1', '568 witness: no synthetic automatic Micro work');
  }
  assert.ok(total <= LIMITS.totalChars);
  assert.ok(Array.isArray(w.calls));
  assert.equal(w.calls.length, 0, '568 witness: restarted provider is still silent');
  assert.ok(Array.isArray(w.requests) && w.requests.length <= LIMITS.requests);
  const origin = new URL(w.origin);
  assert.equal(origin.origin, w.origin);
  assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(origin.port && !origin.username && !origin.password);
  for (const request of w.requests) assert.equal(new URL(request.url).origin, w.origin, '568 witness: no external traffic');
  same(w.sourceHashes, SOURCE_HASHES, 'pinned product and fixture file hashes');
  const manifests = w.rows.filter(row => row.key.endsWith(':manifest'));
  assert.equal(new Set(manifests.map(row => row.key)).size, 1, '568 witness: exactly one current scope');
  const manifestKey = manifests[0]?.key;
  const manifest = parsed(exactRows(w, manifestKey)[0]);
  assert.equal(manifest.schema, 'libra.manifest.v1');
  assert.ok(manifest.scopeKey);
  const prefix = `libra:v1:scope:${manifest.scopeKey}:`;
  assert.equal(manifestKey, prefix + 'manifest');
  for (const row of w.rows) if (row.key.startsWith('libra:v1:scope:')) assert.ok(row.key.startsWith(prefix), '568 witness: no foreign scope owner');
  same(Object.keys(manifest.memories), ['1'], 'exact one target; public queue has no target argument');
  assert.equal(manifest.characterId, w.source.characterId);
  assert.equal(manifest.chatId, w.source.chat.chatId);
  assert.equal(w.source.characterId, 'unified-char'); assert.equal(w.source.characterAlias, 'unified-char');
  assert.equal(w.source.chatPage, 0); assert.equal(w.source.chat.chatId, 'unified-chat');
  const messages = w.source.chat.message;
  assert.equal(messages.length, 10); same(w.source.chat.messages, messages, 'source aliases');
  for (let i = 0; i < 10; i += 1) {
    assert.equal(messages[i].chatId, `t${1 + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}`);
    assert.equal(messages[i].role, i % 2 ? 'assistant' : 'user');
    assert.equal(typeof messages[i].data, 'string');
  }
  const ref = manifest.memories['1'];
  const memories = w.rows.filter(row => /:memory:\d+:/.test(row.key));
  assert.equal(new Set(memories.map(row => row.key)).size, 1, '568 witness: no extra memory target');
  assert.equal(ref.key, prefix + `memory:1:r${ref.revision}`);
  const memory = parsed(exactRows(w, ref.key)[0]);
  assert.equal(memory.schema, 'libra.canonical_memory.v1');
  assert.equal(memory.scopeKey, manifest.scopeKey);
  assert.equal(memory.artifactSchema, 'libra.canonical_artifact.v4');
  assert.equal(memory.canonicalArtifact?.schema, memory.artifactSchema);
  assert.equal(memory.status, 'committed'); assert.equal(memory.worldlineId, 'main');
  same(memory.turnRange, { start: 1, end: 5 }, 'old turn range');
  assert.ok(memory.memoryId && memory.runId && Number.isSafeInteger(memory.revision) && memory.revision > 0);
  for (const field of ['memoryId', 'revision', 'sourceDigest', 'artifactDigest', 'artifactSchema', 'status', 'worldlineId', 'recordAdmissionDigest', 'runId', 'turnRange']) same(ref[field], memory[field], `ref binding ${field}`);
  assert.equal(ref.sessionEpoch, 0); assert.equal(ref.inheritedSessionHistory, false);
  assert.equal(memory.artifactDigest, digest(memory.canonicalArtifact), '568 witness: canonical artifact digest');
  assert.equal(memory.recordAdmissionDigest, memory.artifactValidation.admission ? digest(memory.artifactValidation.admission) : '');
  assert.equal(memory.renderValidation.contentHash, digest(memory.text));
  assert.equal(memory.promptProvenance.compiledHash, digest(memory.promptProvenance.stages));
  assert.equal(ref.promptCompiledHash, memory.promptProvenance.compiledHash);
  const originIdentity = memory.unifiedOrigin || Object.fromEntries(['scopeKey', 'memoryId', 'revision', 'sourceDigest', 'artifactDigest', 'turnRange'].map(key => [key, memory[key]]));
  assert.equal(ref.unifiedOriginDigest, digest(originIdentity));
  assert.equal(memory.retrieval.version, VERSION); assert.ok(memory.sections && memory.anchors);
  if (memory.embedding.status === 'disabled') same(memory.embedding, terminalEmbedding(), 'exact terminal embedding');
  else same(memory.embedding, { status: 'pending', projectionVersion: VERSION }, 'exact initial pending embedding');
  assert.equal(ref.embeddingStatus, memory.embedding.status, '568 witness: row/ref agree');
  assert.equal(ref.retrievalVersion, VERSION); assert.equal(ref.vectorCount, 0);
  assert.equal(memory.unifiedBasis.scopeKey, manifest.scopeKey);
  assert.ok(memory.unifiedBasis.snapshotKey.startsWith(prefix) && memory.unifiedBasis.snapshotDigest);
  // Completed State removes this temporary snapshot (LIBRA.js:53166/53186).
  assert.equal(w.rows.filter(row => row.key === memory.unifiedBasis.snapshotKey).length, 0);
  const headKey = prefix + 'continuity-state', head = parsed(exactRows(w, headKey)[0]);
  assert.equal(head.schema, 'libra.continuity_state.v2'); assert.equal(head.scopeKey, manifest.scopeKey);
  assert.equal(head.status, 'ready'); assert.equal(head.throughTurn, 5);
  assert.equal(head.worldlineId, 'main'); assert.equal(head.throughSessionEpoch, 0);
  for (const field of ['memoryId', 'revision', 'artifactDigest']) assert.equal(head.unifiedApplied[field], memory[field]);
  assert.equal(head.reviewedThroughCanonical.memoryId, memory.memoryId);
  assert.equal(head.reviewedThroughCanonical.revision, memory.revision);
  for (const field of ['key', 'artifactDigest', 'sourceDigest', 'artifactSchema', 'worldlineId', 'sessionEpoch', 'turnRange']) same(head.reviewedThroughCanonical[field], ref[field], `Head cursor ${field}`);
  const projections = w.projections.filter(row => row.key === headKey);
  same(projections.map(row => row.owner).sort(), ownersFor(w.mode), 'current Head projection owners');
  assert.equal(w.projections.length, projections.length);
  for (const row of projections) { assert.equal(row.value.status, 'ready'); assert.equal(row.value.throughTurn, 5); }
  const sourceRef = memory.sourceEvidenceRef;
  assert.equal(sourceRef.schema, 'memory-suite.source-evidence-ref.v1');
  assert.equal(sourceRef.owner, 'libra'); assert.equal(sourceRef.scopeKey, manifest.scopeKey);
  const evidence = parsed(exactRows(w, sourceRef.key)[0]), binding = evidence.binding;
  assert.equal(evidence.schema, 'memory-suite.source-evidence.v1');
  same([binding.owner, binding.scopeKey, binding.unitKey, binding.start, binding.end], ['libra', manifest.scopeKey, '1', 1, 5], 'source evidence scope/range');
  assert.equal(binding.identity, branchDigest(json([manifest.scopeKey, 'main', Array.from({ length: 5 }, (_, i) => [messages[i * 2].chatId, messages[i * 2 + 1].chatId])])));
  assert.equal(binding.identity, sourceRef.identity); assert.equal(binding.sourceDigest, memory.sourceDigest);
  assert.equal(sourceRef.sourceDigest, memory.sourceDigest);
  assert.equal(sourceRef.payloadDigest, evidence.payloadDigest); assert.equal(ref.sourceEvidenceDigest, evidence.payloadDigest);
  assert.equal(sourceRef.normalizationVersion, evidence.normalizationVersion);
  assert.equal(sourceRef.key, prefix + 'source-evidence:v1:' + evidenceDigest([binding.owner, binding.scopeKey, binding.unitKey, binding.identity, binding.sourceDigest]));
  assert.equal(evidence.payloadDigest, evidenceDigest(json({ binding, normalizationVersion: evidence.normalizationVersion, rows: evidence.rows })));
  assert.equal(evidence.rows.length, 5);
  const pairs = evidence.rows.map((row, index) => {
    const turn = index + 1, u = messages[index * 2], a = messages[index * 2 + 1];
    same([row.turn, row.userMessageId, row.assistantMessageId], [turn, u.chatId, a.chatId], 'source evidence ordered IDs');
    same([row.userRaw, row.assistantRaw, row.userText, row.assistantText], [u.data, a.data, u.data, a.data], 'original source UTF-8 strings');
    assert.equal(row.rawAvailable, true);
    return { turn, userChatId: u.chatId, assistantChatId: a.chatId, user: row.userText, assistant: row.assistantText };
  });
  assert.equal(memory.sourceDigest, digest(pairs));
  same(memory.sourcePairs, pairs.map(({ turn, userChatId, assistantChatId }) => ({ turn, userChatId, assistantChatId })), 'canonical ordered source pairs');
  assert.equal(memory.rawPacketRefs.length, 5);
  const receipts = [];
  for (let i = 0; i < 5; i += 1) {
    const rawRef = memory.rawPacketRefs[i], turn = i + 1;
    same([rawRef.schema, rawRef.algorithm, rawRef.scopeKey, rawRef.worldlineId, rawRef.sessionEpoch, rawRef.turn],
      ['libra.completed_turn_raw_ref.v1', 'SHA-256', manifest.scopeKey, 'main', 0, turn], 'exact consumed raw binding');
    assert.equal(rawRef.originRelation, 'current_original_capture');
    assert.equal(rawRef.sourceDigest, digest([pairs[i]]));
    const receiptKey = prefix + `source-receipt:main:e0:t${turn}:${rawRef.sourceRevisionId}`;
    const captureKey = prefix + `source-receipt-capture:main:e0:t${turn}:${rawRef.sourceRevisionId}`;
    assert.ok([receiptKey, captureKey].includes(rawRef.storageKey));
    const receipt = parsed(exactRows(w, receiptKey)[0]);
    const receiptHeadKey = prefix + `source-receipt-head:main:e0:t${turn}`;
    const receiptHead = parsed(exactRows(w, receiptHeadKey)[0]);
    assert.equal(receiptHead.schema, 'libra.completed_turn_head.v1'); assert.equal(receiptHead.receiptKey, receiptKey);
    assert.equal(receipt.schema, 'libra.completed_turn_receipt.v1');
    const receiptIdentity = { turn, ...Object.fromEntries(['user', 'assistant'].map(role => [role, {
      chatIds: receipt[role].chatIds, text: receipt[role].text,
      rawPayloadDigests: receipt[role].rawPayloadDigests, sanitizedTextDigests: receipt[role].sanitizedTextDigests
    }])) };
    assert.equal(rawRef.sourceRevisionId, digest(receiptIdentity).replace(/[^a-z0-9]/gi, ''));
    for (const record of [receipt, receiptHead]) same([record.scopeKey, record.worldlineId, record.sessionEpoch, record.turn, record.revisionId, record.sourceDigest],
      [manifest.scopeKey, 'main', 0, turn, rawRef.sourceRevisionId, rawRef.sourceDigest], 'receipt/head binding');
    const capture = parsed(exactRows(w, captureKey)[0]);
    assert.equal(capture.schema, 'libra.completed_turn_capture.v1'); assert.equal(capture.receiptKey, receiptKey);
    for (const field of ['scopeKey', 'worldlineId', 'sessionEpoch', 'turn', 'revisionId', 'sourceDigest']) same(capture[field], receipt[field], `capture binding ${field}`);
    assert.equal(capture.captureSource, 'completed_pair_reconcile');
    same(capture.captureSources, ['completed_pair_reconcile'], 'historical capture provenance');
    const record = parsed(exactRows(w, rawRef.storageKey)[0]);
    let packet;
    if (rawRef.field === 'rawSourcePacket') packet = record.rawSourcePacket;
    else { assert.match(rawRef.field, /^rawSourceVariants\.[a-f0-9]{64}$/); assert.equal(rawRef.storageKey, captureKey); packet = record.rawSourceVariants?.[rawRef.field.slice(18)]; }
    assert.ok(packet); assert.equal(packet.schema, 'libra.completed_turn_raw_packet.v1');
    assert.equal(rawRef.packetDigest, packet.packetDigest);
    if (rawRef.field !== 'rawSourcePacket') assert.equal(rawRef.field, 'rawSourceVariants.' + packet.packetDigest);
    assert.ok(json(record.rawPacketRef) === json(rawRef) || record.rawVariantRefs?.some(value => json(value) === json(rawRef)));
    const { packetDigest, ...body } = packet;
    assert.equal(packetDigest, sha256(json(body)));
    same(packet.origin, { scopeKey: manifest.scopeKey, worldlineId: 'main', sessionEpoch: 0, turn,
      sourceRevisionId: rawRef.sourceRevisionId, sourceDigest: rawRef.sourceDigest, completionProvenance: 'validated_original_source_rows' }, 'raw packet origin');
    for (const [role, offset] of [['user', 0], ['assistant', 1]]) {
      const segments = packet[role].segments; assert.equal(segments.length, 1);
      const segment = segments[0], message = messages[i * 2 + offset];
      same([segment.index, segment.messageId, segment.rawType, segment.rawValue, segment.contributesText], [i * 2 + offset, message.chatId, 'string', message.data, true], 'exact original segment');
      assert.ok(segment.identitySource);
      assert.equal(segment.rawPayloadDigest, digest({ type: segment.rawType, value: segment.rawValue }));
      assert.equal(segment.utf8Sha256, sha256(segment.rawValue)); assert.equal(segment.utf8ByteLength, Buffer.byteLength(segment.rawValue, 'utf8'));
      same(receipt[role].chatIds, [message.chatId]); same(receipt[role].rawPayloadDigests, [segment.rawPayloadDigest]);
      assert.equal(receipt[role].sourceMessageCount, 1); assert.equal(receipt[role].text, message.data);
    }
    receipts.push({ receiptKey, receiptHeadKey, receipt, receiptHead, rawRef, packet });
  }
  const run = parsed(exactRows(w, prefix + 'run:' + memory.runId)[0]);
  assert.ok(['complete', 'complete_with_warnings'].includes(run.status));
  assert.equal(run.runId, memory.runId); assert.equal(run.commit.memoryKey, ref.key);
  assert.equal(run.commit.artifactDigest, memory.artifactDigest); same(run.promptProvenance, memory.promptProvenance, 'run prompt provenance');
  return { manifestKey, manifest, memory, ref, prefix, receipts };
}
function verifyPublic(w, evidence) {
  const ctx = physical(w), status = evidence.recovery;
  assert.equal(status.scopeKey, ctx.memory.scopeKey); assert.equal(status.reason, '');
  assert.equal(status.receiptStages.length, 5); assert.equal(status.microJobs.length, 5);
  assert.equal(evidence.receipts.length, 5); assert.equal(evidence.raw.length, 5);
  assert.equal(new Set(status.receiptStages.map(row => row.receiptRef)).size, 5);
  const stages = [...status.receiptStages].sort((a, b) => a.turn - b.turn);
  const micros = [...status.microJobs].sort((a, b) => a.turn - b.turn);
  for (let i = 0; i < 5; i += 1) {
    const expected = ctx.receipts[i], active = evidence.receipts[i], raw = evidence.raw[i], stage = stages[i], micro = micros[i];
    assert.equal(active.status, 'verified'); assert.equal(active.reason, '');
    assert.equal(active.receiptKey, expected.receiptKey); assert.equal(active.headKey, expected.receiptHeadKey);
    same(active.receipt, expected.receipt, 'public receipt matches protected owner bytes'); same(active.head, expected.receiptHead, 'public receipt Head');
    assert.equal(raw.status, 'verified'); same(raw.rawPacketRef, expected.rawRef, 'public active capture is exact consumed capture'); same(raw.packet, expected.packet, 'public raw packet');
    assert.equal(stage.turn, i + 1); assert.equal(stage.status, 'verified'); assert.equal(stage.receiptRef, expected.receiptKey);
    same([stage.identity.scopeKey, stage.identity.worldlineId, stage.identity.sessionEpoch, stage.identity.turn], [ctx.memory.scopeKey, 'main', 0, i + 1], 'public receipt scope/worldline/epoch');
    same(stage.identity.userChatIds, expected.receipt.user.chatIds, 'public receipt user IDs'); same(stage.identity.assistantChatIds, expected.receipt.assistant.chatIds, 'public receipt assistant IDs');
    assert.equal(stage.scopeKey, ctx.memory.scopeKey); assert.equal(stage.identity.revisionId, expected.receipt.revisionId); assert.equal(stage.identity.sourceDigest, expected.receipt.sourceDigest);
    assert.equal(micro.turn, i + 1); assert.equal(micro.scopeKey, stage.scopeKey); assert.equal(micro.receiptRef, stage.receiptRef);
    assert.equal(micro.revisionId, stage.identity.revisionId); assert.equal(micro.sourceDigest, stage.identity.sourceDigest);
    assert.equal(micro.status, 'unknown'); assert.equal(micro.physicalAttemptsUsed, 0); assert.equal(micro.logicalAttempts, 0);
    assert.equal(micro.attemptId, ''); same(micro.history, [], 'no automatic Micro history');
  }
}
function verifySettings(settings) {
  assert.equal(settings.enabled, true); assert.equal(settings.key, '');
  assert.equal(settings.provider, 'voyageai'); assert.equal(settings.url, 'https://api.voyageai.com/v1/embeddings');
  assert.equal(settings.model, 'voyage-4-lite'); assert.equal(settings.fallback, null);
}
function verifySettingsPair(before, after) { verifySettings(before); verifySettings(after); same(after, before, 'entire offline embedding settings unchanged'); }
function verifyTransition(before, after, terminal = false) {
  const a = physical(before), b = physical(after);
  same(after.source, before.source, 'entire chat/source/IDs unchanged');
  same(after.sourceHashes, before.sourceHashes, 'source file hashes unchanged');
  same(after.projections, before.projections, 'positive Head/currentness unchanged');
  same(after.calls, before.calls, 'all Canonical/Micro/other/total calls unchanged');
  same(after.requests.slice(0, before.requests.length), before.requests, 'request witness append-only');
  assert.ok(after.requests.length >= before.requests.length);
  assert.equal(after.origin, before.origin); assert.equal(after.mode, before.mode);
  same(after.rows.map(rowId), before.rows.map(rowId), 'all owners, rows, keys, existence exact');
  const changed = a.memory.embedding.status === 'pending' && b.memory.embedding.status === 'disabled';
  for (let i = 0; i < before.rows.length; i += 1) {
    const old = before.rows[i], next = after.rows[i];
    if (!changed || ![a.ref.key, a.manifestKey].includes(old.key)) { same(next, old, 'protected raw bytes and physical revision'); continue; }
    const expected = parsed(old), actual = parsed(next);
    assert.equal(old.raw, json(expected), '568 witness: mutable owner starts in exact product JSON serialization');
    same(Object.keys(actual), Object.keys(expected), 'derived update keeps memory/manifest field order');
    if (old.key === a.ref.key) expected.embedding = terminalEmbedding();
    else {
      const nextStamp = actual.memories['1'].updatedAt;
      assert.ok(Number.isFinite(Date.parse(nextStamp)) && Date.parse(nextStamp) >= Date.parse(expected.memories['1'].updatedAt));
      expected.memories['1'].embeddingStatus = 'disabled';
      expected.memories['1'].updatedAt = nextStamp;
      if (before.mode === 'plugin_only') {
        assert.ok(Number.isFinite(Date.parse(actual.updatedAt)) && Date.parse(actual.updatedAt) >= Date.parse(expected.updatedAt));
        expected.updatedAt = actual.updatedAt;
      }
    }
    assert.equal(next.raw, json(expected), '568 witness: exact source-justified preparation raw transformation');
    if (old.owner === 'server') assert.equal(next.revision, old.revision + 1, '568 witness: exactly one derived write per owner');
    else assert.equal(next.revision, null);
  }
  if (terminal) { same(b.memory.embedding, terminalEmbedding(), 'final terminal row'); assert.equal(b.ref.embeddingStatus, 'disabled'); }
  return { before: a, after: b, changed };
}
function unwrapQueueOutcome(outcome) {
  if (Object.hasOwn(outcome, 'error')) throw outcome.error;
  return outcome.value;
}
function verifyQueue(result, before, after, admission = before) {
  const admitted = verifyTransition(before, admission).after;
  verifyTransition(admission, after, true); // R1: protect the adjacent post-admission interval.
  const ctx = verifyTransition(before, after, true); // Retain the total one-transition/revision bound.
  same(Object.keys(result).sort(), ['attempted', 'completed', 'ok', 'results'], 'exact queue result shape; no stale/error/reason');
  assert.equal(result.ok, true); assert.ok(Number.isInteger(result.attempted) && result.attempted >= 0 && result.attempted <= 1);
  assert.equal(result.completed, result.attempted); assert.ok(Array.isArray(result.results)); assert.equal(result.results.length, result.attempted);
  if (result.attempted === 1) {
    assert.equal(admitted.memory.embedding.status, 'pending');
    same(result.results[0], { memoryId: ctx.before.memory.memoryId, status: 'disabled', diagnostic: null }, 'exact successful target and diagnostic');
  }
  // attempted:0 is admitted only with the exact physical terminal proof above.
  return ctx;
}
function oldRows(w) {
  const ctx = physical(w);
  return copy(exactRows(w, ctx.ref.key));
}
function assertOldRows(baseline, rows) {
  assert.ok(Array.isArray(baseline) && baseline.length >= 1 && baseline.length <= 2, '568 witness: nonempty settled old record baseline');
  assert.equal(new Set(baseline.map(rowId)).size, baseline.length);
  assert.equal(new Set(baseline.map(row => row.key)).size, 1);
  same(rows.filter(row => row.key === baseline[0].key).map(rowId).sort(), baseline.map(rowId).sort(), 'post-v5 exact old owner set');
  for (const old of baseline) {
    const current = rows.filter(row => rowId(row) === rowId(old)); assert.equal(current.length, 1);
    same(current[0], old, 'strict whole-old-record raw bytes/key/owner/revision after new v5 write');
  }
}
const SOURCE_HASHES = Object.freeze({
  "PROGRAM/plugins/LIBRA.js": "81d64516659a7450ad68de7e07bfb29813d9768c7ab6015063a31ad7b16426d0",
  "PROGRAM/tests/fixtures/libra_server_runtime_fixture.cjs": "58dde9f825010ed764ed42492fb3f7afeb3d60b67ed0a01b437727498e8fa7dd",
  "PROGRAM/tests/fixtures/libra_unified_runtime_fixture.cjs": "168e6a402eea9981aadceca84bdfdd80fc887d1b2d1914c1e402cffd4b3f2a52",
  "PROGRAM/tests/fixtures/libra_vm_harness.cjs": "c0d619b8bb0beedb68d61168458200af7a8aa10a8e3ce33eeb8121c1c9150100",
  "PROGRAM/tests/fixtures/unified_vertical_source.json": "09f5ee4a717cb786d2c8d54f5562eb6801f5ee4c4e6c14bcaf3043fbce560ecb",
  "PROGRAM/server/server.cjs": "3b6f11cb7469ed10e7beb61d5ca8a3757566da82387447fc44d8ec2719b2b132"
});
module.exports = { VERSION, LIMITS, SOURCE_HASHES, copy, digest, evidenceDigest, branchDigest, sha256, terminalEmbedding,
  physical, verifyPublic, verifySettings, verifySettingsPair, verifyTransition, unwrapQueueOutcome, verifyQueue, oldRows, assertOldRows };
