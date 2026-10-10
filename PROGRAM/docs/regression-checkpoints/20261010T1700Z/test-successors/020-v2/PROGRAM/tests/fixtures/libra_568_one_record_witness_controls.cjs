'use strict';
// Fixed synthetic controls ONLY. They do not import the product, server, fixture,
// or test568; their eventual execution is a separate admission decision.
const assert = require('node:assert/strict');
const w = require('./libra_568_one_record_witness.cjs');
const scope = 'synthetic-568', prefix = `libra:v1:scope:${scope}:`;
const memoryKey = prefix + 'memory:1:r1', manifestKey = prefix + 'manifest', headKey = prefix + 'continuity-state';
const stamp = '2026-10-10T00:00:00.000Z', later = '2026-10-10T00:00:01.000Z';
const settings = { enabled: true, key: '', provider: 'voyageai', url: 'https://api.voyageai.com/v1/embeddings', model: 'voyage-4-lite', fallback: null };
const sort = rows => rows.sort((a, b) => a.owner.localeCompare(b.owner) || a.key.localeCompare(b.key));
function seed(mode) {
  const records = new Map(), messages = [], pairs = [], rawRefs = [], receipts = [], raw = [], receiptStages = [], microJobs = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    const i = turn - 1, u = { role: 'user', chatId: `t${turn}-u`, data: `사용자 ${turn}` }, a = { role: 'assistant', chatId: `t${turn}-a`, data: `답변 ${turn}` };
    messages.push(u, a); const pair = { turn, userChatId: u.chatId, assistantChatId: a.chatId, user: u.data, assistant: a.data }; pairs.push(pair);
    const sourceDigest = w.digest([pair]);
    const side = message => ({ chatIds: [message.chatId], text: message.data,
      rawPayloadDigests: [w.digest({ type: 'string', value: message.data })], sanitizedTextDigests: [w.digest(message.data)] });
    const identity = { turn, user: side(u), assistant: side(a) }, revisionId = w.digest(identity).replace(/[^a-z0-9]/gi, '');
    const origin = { scopeKey: scope, worldlineId: 'main', sessionEpoch: 0, turn, sourceRevisionId: revisionId, sourceDigest, completionProvenance: 'validated_original_source_rows' };
    const segment = (message, index) => ({ index, messageId: message.chatId, identitySource: 'chatId', rawType: 'string', rawValue: message.data,
      contributesText: true, rawPayloadDigest: w.digest({ type: 'string', value: message.data }), utf8ByteLength: Buffer.byteLength(message.data), utf8Sha256: w.sha256(message.data) });
    const body = { schema: 'libra.completed_turn_raw_packet.v1', origin, user: { segments: [segment(u, i * 2)] }, assistant: { segments: [segment(a, i * 2 + 1)] } };
    const packet = { ...body, packetDigest: w.sha256(JSON.stringify(body)) };
    const receiptKey = prefix + `source-receipt:main:e0:t${turn}:${revisionId}`, captureKey = prefix + `source-receipt-capture:main:e0:t${turn}:${revisionId}`, receiptHeadKey = prefix + `source-receipt-head:main:e0:t${turn}`;
    const ref = { schema: 'libra.completed_turn_raw_ref.v1', storageKey: receiptKey, field: 'rawSourcePacket', packetDigest: packet.packetDigest,
      originRelation: 'current_original_capture', algorithm: 'SHA-256', scopeKey: scope, worldlineId: 'main', sessionEpoch: 0, turn, sourceRevisionId: revisionId, sourceDigest };
    const binding = { scopeKey: scope, worldlineId: 'main', sessionEpoch: 0, turn, revisionId, sourceDigest };
    const receipt = { schema: 'libra.completed_turn_receipt.v1', ...binding,
      user: { ...identity.user, sourceMessageCount: 1 }, assistant: { ...identity.assistant, sourceMessageCount: 1 }, rawSourcePacket: packet, rawPacketRef: ref };
    const head = { schema: 'libra.completed_turn_head.v1', ...binding, receiptKey };
    records.set(receiptKey, receipt); records.set(receiptHeadKey, head);
    records.set(captureKey, { schema: 'libra.completed_turn_capture.v1', ...binding, receiptKey, captureSource: 'completed_pair_reconcile', captureSources: ['completed_pair_reconcile'], rawPacketRef: ref });
    rawRefs.push(ref); receipts.push({ status: 'verified', reason: '', receipt, head, receiptKey, headKey: receiptHeadKey });
    raw.push({ status: 'verified', packet, rawPacketRef: ref });
    receiptStages.push({ turn, scopeKey: scope, status: 'verified', receiptRef: receiptKey, identity: { scopeKey: scope, worldlineId: 'main', sessionEpoch: 0, turn, revisionId, sourceDigest, userChatIds: [u.chatId], assistantChatIds: [a.chatId] } });
    microJobs.push({ turn, scopeKey: scope, status: 'unknown', receiptRef: receiptKey, revisionId, sourceDigest, physicalAttemptsUsed: 0, logicalAttempts: 0, attemptId: '', history: [] });
  }
  const sourceDigest = w.digest(pairs), binding = { owner: 'libra', scopeKey: scope, unitKey: '1', start: 1, end: 5, identity: w.branchDigest(JSON.stringify([scope, 'main', pairs.map(pair => [pair.userChatId, pair.assistantChatId])])), sourceDigest };
  const evidence = { schema: 'memory-suite.source-evidence.v1', binding, normalizationVersion: 'synthetic-normalization', rows: pairs.map(pair => ({ turn: pair.turn,
    userMessageId: pair.userChatId, assistantMessageId: pair.assistantChatId, userText: pair.user, assistantText: pair.assistant, userRaw: pair.user, assistantRaw: pair.assistant, rawAvailable: true })) };
  evidence.payloadDigest = w.evidenceDigest(JSON.stringify({ binding, normalizationVersion: evidence.normalizationVersion, rows: evidence.rows }));
  const evidenceKey = prefix + 'source-evidence:v1:' + w.evidenceDigest([binding.owner, binding.scopeKey, binding.unitKey, binding.identity, binding.sourceDigest]); records.set(evidenceKey, evidence);
  const canonicalArtifact = { schema: 'libra.canonical_artifact.v4', facts: [{ text: 'synthetic protected canonical fact' }] }, artifactDigest = w.digest(canonicalArtifact), admission = { status: 'accepted' }, stages = { ariadne: { profileName: 'synthetic' } };
  const promptProvenance = { stages, compiledHash: w.digest(stages) };
  const memory = { schema: 'libra.canonical_memory.v1', scopeKey: scope, memoryId: 'memory-568', revision: 1, status: 'committed', worldlineId: 'main', turnRange: { start: 1, end: 5 }, sourceDigest,
    artifactSchema: canonicalArtifact.schema, canonicalArtifact, artifactDigest, artifactValidation: { admission }, recordAdmissionDigest: w.digest(admission), text: 'synthetic rendered canonical',
    renderValidation: { contentHash: w.digest('synthetic rendered canonical') }, promptProvenance, runId: 'run-568',
    retrieval: { version: w.VERSION, sparseFields: {}, textHashes: {} }, sections: { summary: 'synthetic' }, anchors: {},
    embedding: { status: 'pending', projectionVersion: w.VERSION }, unifiedBasis: { scopeKey: scope, snapshotKey: prefix + 'unified-basis:memory-568:1', snapshotDigest: 'deleted-temporary-basis-digest' },
    sourceEvidenceRef: { schema: 'memory-suite.source-evidence-ref.v1', owner: 'libra', scopeKey: scope, key: evidenceKey, payloadDigest: evidence.payloadDigest, identity: binding.identity, sourceDigest, normalizationVersion: evidence.normalizationVersion },
    sourcePairs: pairs.map(({ turn, userChatId, assistantChatId }) => ({ turn, userChatId, assistantChatId })), rawPacketRefs: rawRefs };
  const ref = { ...Object.fromEntries(['memoryId', 'revision', 'sourceDigest', 'artifactDigest', 'artifactSchema', 'status', 'worldlineId', 'recordAdmissionDigest', 'runId', 'turnRange'].map(k => [k, memory[k]])),
    key: memoryKey, sessionEpoch: 0, inheritedSessionHistory: false, promptCompiledHash: promptProvenance.compiledHash, sourceEvidenceDigest: evidence.payloadDigest,
    unifiedOriginDigest: w.digest(Object.fromEntries(['scopeKey', 'memoryId', 'revision', 'sourceDigest', 'artifactDigest', 'turnRange'].map(k => [k, memory[k]]))),
    embeddingStatus: 'pending', retrievalVersion: w.VERSION, vectorCount: 0, updatedAt: stamp };
  records.set(memoryKey, memory);
  records.set(manifestKey, { schema: 'libra.manifest.v1', scopeKey: scope, characterId: 'unified-char', chatId: 'unified-chat', memories: { '1': ref }, stats: { commits: 1, embeddings: 0 }, updatedAt: stamp });
  records.set(headKey, { schema: 'libra.continuity_state.v2', scopeKey: scope, worldlineId: 'main', throughSessionEpoch: 0, status: 'ready', throughTurn: 5,
    unifiedApplied: { memoryId: memory.memoryId, revision: 1, artifactDigest }, reviewedThroughCanonical: { ...ref } });
  records.set(prefix + 'run:run-568', { runId: 'run-568', status: 'complete', promptProvenance, commit: { memoryKey, artifactDigest } });
  records.set(prefix + 'registry', { schema: 'synthetic.protected.registry', contents: 'keep exactly' });
  const owners = mode === 'plugin_only' ? ['local'] : mode === 'server_only' ? ['server'] : ['local', 'server'];
  const rows = sort(owners.flatMap(owner => [...records].map(([key, value]) => ({ owner, key, raw: JSON.stringify(value), revision: owner === 'server' ? 7 : null }))));
  const before = { mode, rows, origin: 'http://127.0.0.1:12345', source: { characterId: 'unified-char', characterAlias: 'unified-char', chatPage: 0, chat: { chatId: 'unified-chat', message: messages, messages } },
    projections: owners.map(owner => ({ owner, key: headKey, value: { status: 'ready', throughTurn: 5 } })), calls: [], requests: [], sourceHashes: { ...w.SOURCE_HASHES } };
  const after = w.copy(before);
  change(after, memoryKey, value => { value.embedding = w.terminalEmbedding(); }, true);
  change(after, manifestKey, value => { value.memories['1'].embeddingStatus = 'disabled'; value.memories['1'].updatedAt = later; if (mode === 'plugin_only') value.updatedAt = later; }, true);
  after.requests.push({ url: after.origin + '/v1/kv/get', method: 'GET' });
  return { before, after, admission: w.copy(before), result: { ok: true, attempted: 1, completed: 1, results: [{ memoryId: memory.memoryId, status: 'disabled', diagnostic: null }] },
    evidence: { receipts, raw, recovery: { scopeKey: scope, reason: '', receiptStages, microJobs, receiptJobs: [] } }, settings: w.copy(settings), evidenceKey };
}
function change(snapshot, key, mutate, increment = false) {
  for (const row of snapshot.rows.filter(row => row.key === key)) {
    const value = JSON.parse(row.raw); mutate(value); row.raw = JSON.stringify(value);
    if (increment && row.owner === 'server') row.revision += 1;
  }
}
const zero = { ok: true, attempted: 0, completed: 0, results: [] };
const verify = c => { w.verifyPublic(c.before, c.evidence); w.verifySettingsPair(settings, c.settings); w.verifyQueue(w.unwrapQueueOutcome({ value: c.result }), c.before, c.after, c.admission); };
const negatives = [
  ['empty target', c => change(c.before, manifestKey, x => { x.memories = {}; })],
  ['extra target', c => change(c.before, manifestKey, x => { x.memories['6'] = w.copy(x.memories['1']); })],
  ['missing memory', c => { c.before.rows = c.before.rows.filter(r => r.key !== memoryKey); }],
  ['wrong owner', c => { c.before.rows.find(r => r.key === memoryKey).owner = 'unexpected'; }],
  ['duplicate owner', c => { c.before.rows.push(w.copy(c.before.rows.find(r => r.key === memoryKey))); }],
  ['wrong schema', c => change(c.before, memoryKey, x => { x.artifactSchema = 'v5'; })],
  ['wrong range', c => change(c.before, memoryKey, x => { x.turnRange.end = 10; })],
  ['wrong source hash', c => { c.before.sourceHashes['PROGRAM/plugins/LIBRA.js'] = '0'.repeat(64); }],
  ['wrong queue ok', c => { c.result.ok = false; }],
  ['stale queue', c => { c.result.staleDiscarded = true; }],
  ['reason queue', c => { c.result.reason = ''; }],
  ['error queue', c => { c.result.error = ''; }],
  ['negative attempted', c => { c.result.attempted = -1; }],
  ['two attempted', c => { c.result.attempted = 2; }],
  ['fraction attempted', c => { c.result.attempted = 0.5; }],
  ['completed mismatch', c => { c.result.completed = 0; }],
  ['result count mismatch', c => { c.result.results = []; }],
  ['wrong result identity', c => { c.result.results[0].memoryId = 'different'; }],
  ['duplicate result identity', c => { c.result.results.push(w.copy(c.result.results[0])); }],
  ['result diagnostic', c => { c.result.results[0].diagnostic = { ok: false }; }],
  ['result not disabled', c => { c.result.results[0].status = 'ready'; }],
  ['stale attempted after admission settled', c => { c.admission = w.copy(c.after); }],
  ['zero without progress', c => { c.after = w.copy(c.before); c.result = w.copy(zero); }],
  ['pending row', c => change(c.after, memoryKey, x => { x.embedding.status = 'pending'; })],
  ['pending ref', c => change(c.after, manifestKey, x => { x.memories['1'].embeddingStatus = 'pending'; })],
  ['wrong terminal reason', c => change(c.after, memoryKey, x => { x.embedding.reason = 'anything'; })],
  ['wrong terminal vector count', c => change(c.after, memoryKey, x => { x.embedding.vectorCount = 1; })],
  ['wrong projection version', c => change(c.after, memoryKey, x => { x.embedding.projectionVersion = 'old'; })],
  ['wrong retrieval version', c => change(c.after, manifestKey, x => { x.memories['1'].retrievalVersion = 'old'; })],
  ['vector transaction', c => { c.after.rows.push({ owner: 'server', key: prefix + 'unified-vector-tx:memory-568', raw: '{}', revision: 1 }); sort(c.after.rows); }],
  ['orphan wrong-binding transaction', c => { c.after.rows.push({ owner: 'local', key: prefix + 'unified-vector-tx:orphan', raw: '{"memoryKey":"wrong"}', revision: null }); sort(c.after.rows); }],
  ['changed scope', c => change(c.after, manifestKey, x => { x.scopeKey = 'other'; })],
  ['changed chat', c => { c.after.source.chat.chatId = 'other'; }],
  ['changed raw source text', c => { c.after.source.chat.message[0].data += '!'; }],
  ['changed source ID', c => { c.after.source.chat.message[0].chatId = 'other'; }],
  ['changed worldline', c => change(c.after, memoryKey, x => { x.worldlineId = 'other'; })],
  ['changed epoch', c => change(c.after, manifestKey, x => { x.memories['1'].sessionEpoch = 1; })],
  ['changed artifact', c => change(c.after, memoryKey, x => { x.canonicalArtifact.facts[0].text += '!'; })],
  ['changed admission', c => change(c.after, memoryKey, x => { x.recordAdmissionDigest = 'wrong'; })],
  ['changed source evidence', c => change(c.after, c.evidenceKey, x => { x.rows[0].userRaw += '!'; })],
  ['missing source evidence', c => { c.after.rows = c.after.rows.filter(r => r.key !== c.evidenceKey); }],
  ['changed raw ref', c => change(c.after, memoryKey, x => { x.rawPacketRefs[0].packetDigest = '0'.repeat(64); })],
  ['changed raw packet segment', c => change(c.after, c.evidence.receipts[0].receiptKey, x => { x.rawSourcePacket.user.segments[0].rawValue += '!'; })],
  ['changed UTF-8 digest', c => change(c.after, c.evidence.receipts[0].receiptKey, x => { x.rawSourcePacket.user.segments[0].utf8Sha256 = '0'.repeat(64); })],
  ['changed consumed variant', c => { c.evidence.raw[0].rawPacketRef.field = 'rawSourceVariants.' + '0'.repeat(64); }],
  ['changed receipt revision', c => change(c.after, c.evidence.receipts[0].receiptKey, x => { x.revisionId = 'wrong'; })],
  ['changed receipt Head', c => change(c.after, c.evidence.receipts[0].headKey, x => { x.receiptKey = 'wrong'; })],
  ['changed basis digest', c => change(c.after, memoryKey, x => { x.unifiedBasis.snapshotDigest = 'wrong'; })],
  ['reappeared basis row', c => { const k = JSON.parse(c.after.rows.find(r => r.key === memoryKey).raw).unifiedBasis.snapshotKey; c.after.rows.push({ owner: 'server', key: k, raw: '{}', revision: 1 }); sort(c.after.rows); }],
  ['changed prompt provenance', c => change(c.after, memoryKey, x => { x.promptProvenance.stages.ariadne.profileName = 'wrong'; })],
  ['changed run provenance', c => change(c.after, prefix + 'run:run-568', x => { x.promptProvenance.stages.ariadne.profileName = 'wrong'; })],
  ['changed registry', c => change(c.after, prefix + 'registry', x => { x.contents += '!'; })],
  ['changed Head', c => change(c.after, headKey, x => { x.throughTurn = 4; })],
  ['changed currentness', c => { c.after.projections[0].value.throughTurn = 4; }],
  ['changed physical revision', c => { c.after.rows.find(r => r.key === headKey && r.owner === 'server').revision++; }],
  ['extra owner row', c => { c.after.rows.push({ owner: 'local', key: prefix + 'extra', raw: '{}', revision: null }); sort(c.after.rows); }],
  ['removed owner row', c => { c.after.rows = c.after.rows.filter(r => r.key !== prefix + 'registry'); }],
  ['unchanged JSON different protected bytes', c => { c.after.rows.find(r => r.key === prefix + 'registry').raw += ' '; }],
  ['Canonical provider increment', c => { c.after.calls.push(['LIBRA LONG-TERM MEMORY EXTRACTION']); }],
  ['Micro provider increment', c => { c.after.calls.push(['LIBRA MICRO SOURCE CONTRACT']); }],
  ['other provider increment', c => { c.after.calls.push(['other']); }],
  ['external traffic', c => { c.after.requests.push({ url: 'https://example.invalid/localhost', method: 'POST' }); }],
  ['settings key', c => { c.settings.key = 'synthetic-invalid-key'; }],
  ['settings disabled', c => { c.settings.enabled = false; }],
  ['settings provider', c => { c.settings.provider = 'other'; }],
  ['sections changed', c => change(c.after, memoryKey, x => { x.sections.summary += '!'; })],
  ['anchors changed', c => change(c.after, memoryKey, x => { x.anchors.extra = true; })],
  ['retrieval changed', c => change(c.after, memoryKey, x => { x.retrieval.sparseFields.extra = true; })],
  ['manifest stats changed', c => change(c.after, manifestKey, x => { x.stats.commits++; })],
  ['server manifest root timestamp changed', c => change(c.after, manifestKey, x => { x.updatedAt = later; })],
  ['receipt public unverified', c => { c.evidence.receipts[0].status = 'pending'; }],
  ['raw public unverified', c => { c.evidence.raw[0].status = 'pending'; }],
  ['public receipt count wrong', c => { c.evidence.recovery.receiptStages.pop(); }],
  ['public Micro attempt', c => { c.evidence.recovery.microJobs[0].physicalAttemptsUsed = 1; }]
];
const postNegatives = [
  ['embedding only', rows => { const row = rows.find(r => r.key === memoryKey); const x = JSON.parse(row.raw); x.embedding.reason = 'later mutation'; row.raw = JSON.stringify(x); }],
  ['missing old row', rows => { rows.splice(rows.findIndex(r => r.key === memoryKey), 1); }],
  ['changed old key', rows => { rows.find(r => r.key === memoryKey).key += ':other'; }],
  ['changed old physical revision', rows => { rows.find(r => r.key === memoryKey && r.owner === 'server').revision++; }],
  ['changed old canonical', rows => { const row = rows.find(r => r.key === memoryKey); const x = JSON.parse(row.raw); x.canonicalArtifact.facts[0].text += '!'; row.raw = JSON.stringify(x); }],
  ['extra old owner', rows => { rows.push(w.copy(rows.find(r => r.key === memoryKey))); }]
];
// R1 controls start with a known-valid terminal-at-admission zero-attempt
// witness. Only final evidence changes. These are fixed cases, not queue retries.
function terminalAdmissionSeed(mode) {
  const c = seed(mode);
  c.admission = w.copy(c.after);
  c.admission.requests.push(
    { url: c.admission.origin + '/r1-admission-first', method: 'GET' },
    { url: c.admission.origin + '/r1-admission-second', method: 'GET' });
  c.after = w.copy(c.admission);
  c.result = w.copy(zero);
  return c;
}
const terminalAdmissionNegatives = [
  ['plugin root timestamp advances after terminal admission', 'plugin_only', c => change(c.after, manifestKey, x => { x.updatedAt = '2026-10-10T00:00:02.000Z'; })],
  ['plugin ref timestamp advances after terminal admission', 'plugin_only', c => change(c.after, manifestKey, x => { x.memories['1'].updatedAt = '2026-10-10T00:00:02.000Z'; })],
  ['plugin root rewinds after admission but remains later than initial', 'plugin_only', c => change(c.after, manifestKey, x => { x.updatedAt = '2026-10-10T00:00:00.500Z'; })],
  ['plugin ref rewinds after admission but remains later than initial', 'plugin_only', c => change(c.after, manifestKey, x => { x.memories['1'].updatedAt = '2026-10-10T00:00:00.500Z'; })],
  ['terminal embedding-only mutation', 'plugin_only', c => change(c.after, memoryKey, x => { x.embedding.reason = 'changed after terminal admission'; })],
  ['terminal memory same parsed value different raw bytes', 'plugin_only', c => { c.after.rows.find(r => r.key === memoryKey).raw += ' '; }],
  ['protected receipt changes after terminal admission', 'plugin_only', c => change(c.after, c.evidence.receipts[0].receiptKey, x => { x.r1Tamper = true; })],
  ['protected capture changes after terminal admission', 'plugin_only', c => change(c.after, c.evidence.receipts[0].receiptKey.replace(':source-receipt:', ':source-receipt-capture:'), x => { x.r1Tamper = true; })],
  ['protected Head changes after terminal admission', 'plugin_only', c => change(c.after, headKey, x => { x.r1Tamper = true; })],
  ['second server revision after terminal admission', 'server_only', c => { c.after.rows.find(r => r.key === memoryKey && r.owner === 'server').revision++; }],
  ['orphan wrong-target transaction after terminal admission', 'mirror', c => { c.after.rows.push({ owner: 'server', key: prefix + 'unified-vector-tx:orphan', raw: '{"memoryKey":"wrong-target"}', revision: 1 }); sort(c.after.rows); }],
  ['admission-only loopback request removed', 'plugin_only', c => { c.after.requests.pop(); }],
  ['admission-only loopback request replaced', 'plugin_only', c => { c.after.requests[1].url = c.after.origin + '/r1-replacement'; }],
  ['admission-only loopback requests reordered', 'plugin_only', c => { [c.after.requests[1], c.after.requests[2]] = [c.after.requests[2], c.after.requests[1]]; }],
  ['plugin manifest stats changed after terminal admission', 'plugin_only', c => change(c.after, manifestKey, x => { x.stats.commits++; })],
  ['plugin manifest authority changed after terminal admission', 'plugin_only', c => change(c.after, manifestKey, x => { x.branchGuard = { status: 'tampered' }; })]
];
// These literal counts are the admission boundary. Never infer or grow a test
// budget from a mutable runtime queue or loop until it happens to be idle.
assert.equal(negatives.length, 74);
assert.equal(postNegatives.length, 6);
assert.equal(terminalAdmissionNegatives.length, 16);
let passed = 0;
for (const mode of ['plugin_only', 'mirror', 'server_only']) {
  const c = seed(mode); verify(c); passed++;
  const settled = seed(mode); settled.before = w.copy(settled.after); settled.admission = w.copy(settled.after); settled.result = w.copy(zero); verify(settled); passed++;
  const timer = seed(mode); timer.admission = w.copy(timer.after); timer.result = w.copy(zero); verify(timer); passed++;
  const lateTimer = seed(mode); lateTimer.result = w.copy(zero); verify(lateTimer); passed++;
}
for (const [label, mutate] of negatives) {
  const c = seed('server_only'); mutate(c); assert.throws(() => verify(c), undefined, label); passed++;
}
for (const [label, mode, mutate] of terminalAdmissionNegatives) {
  const c = terminalAdmissionSeed(mode);
  verify(c); // Prove the negative begins from a valid terminal-admission witness.
  const before = JSON.stringify(c.before), admission = JSON.stringify(c.admission), final = JSON.stringify(c.after);
  mutate(c);
  assert.equal(JSON.stringify(c.before), before, `${label}: initial witness unchanged`);
  assert.equal(JSON.stringify(c.admission), admission, `${label}: admission witness unchanged`);
  assert.notEqual(JSON.stringify(c.after), final, `${label}: genuinely changed final evidence`);
  assert.throws(() => verify(c), undefined, label); passed++;
}
const c = seed('mirror'), baseline = w.oldRows(c.after);
w.assertOldRows(baseline, c.after.rows); passed++;
for (const [label, mutate] of postNegatives) { const rows = w.copy(c.after.rows); mutate(rows); assert.throws(() => w.assertOldRows(baseline, rows), undefined, label); passed++; }
assert.throws(() => w.assertOldRows([], c.after.rows)); passed++;
const marker = new Error('same synthetic queue exception'); assert.throws(() => w.unwrapQueueOutcome({ error: marker }), error => error === marker); passed++;
assert.equal(passed, 111);
console.log(JSON.stringify({ test: 'libra_568_one_record_witness_controls', passed, syntheticOnly: true }));
