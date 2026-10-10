'use strict';
// Fixed synthetic controls ONLY. They do not import the product, server, fixture,
// or test568; their eventual execution is a separate admission decision.
const assert = require('node:assert/strict');
const w = require('./libra_568_one_record_witness.cjs');
const scope = 'seventh-server-scope', prefix = `libra:v1:scope:${scope}:`;
const memoryKey = prefix + 'memory:1:r1', manifestKey = prefix + 'manifest', headKey = prefix + 'continuity-state';
const stamp = '2026-10-10T00:00:00.000Z', later = '2026-10-10T00:00:01.000Z';
const settings = { enabled: true, key: '', provider: 'voyageai', url: 'https://api.voyageai.com/v1/embeddings', model: 'voyage-4-lite', fallback: null };
const sort = rows => rows.sort(w.compareRows);
const stores = w.storeWitness('/synthetic/fixture-568', '/synthetic/fixture-568/stores/libra/libra.sqlite');
const time0 = Date.parse(stamp), time1 = Date.parse(later);
const physicalRow = (owner, key, raw, revision = 7, space = 'plugin') => owner === 'local' ? w.localRow(key, raw) : w.serverRow({ space, key, value_json: JSON.stringify(raw), deleted: 0, revision, digest: w.sha256(JSON.stringify(raw)), updated_at: time0 }, stores);
const refreshEnvelope = row => { if (row.owner === 'server') { row.value_json = JSON.stringify(row.raw); row.valueChars = row.value_json.length; row.valueBytes = Buffer.byteLength(row.value_json); row.digest = w.sha256(row.value_json); } };
function seed(mode, hostWorldlineId = w.deriveHostWorldlineId({ characterId: 'unified-char', chatId: 'unified-chat', scopeKey: scope })) {
  const records = new Map(), messages = [], pairs = [], rawRefs = [], receipts = [], raw = [], receiptStages = [], microJobs = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    const i = turn - 1, u = { role: 'user', chatId: `t${turn}-u`, data: `사용자 ${turn}` }, a = { role: 'assistant', chatId: `t${turn}-a`, data: `답변 ${turn}` };
    messages.push(u, a); const pair = { turn, userChatId: u.chatId, assistantChatId: a.chatId, user: u.data, assistant: a.data }; pairs.push(pair);
    const sourceDigest = w.digest([pair]);
    const side = message => ({ chatIds: [message.chatId], text: message.data,
      rawPayloadDigests: [w.digest({ type: 'string', value: message.data })], sanitizedTextDigests: [w.digest(message.data)] });
    const identity = { turn, user: side(u), assistant: side(a) }, revisionId = w.digest(identity).replace(/[^a-z0-9]/gi, '');
    const origin = { scopeKey: scope, worldlineId: hostWorldlineId, sessionEpoch: 0, turn, sourceRevisionId: revisionId, sourceDigest, completionProvenance: 'validated_original_source_rows' };
    const segment = (message, index) => ({ index, messageId: message.chatId, identitySource: 'chatId', rawType: 'string', rawValue: message.data,
      contributesText: true, rawPayloadDigest: w.digest({ type: 'string', value: message.data }), utf8ByteLength: Buffer.byteLength(message.data), utf8Sha256: w.sha256(message.data) });
    const body = { schema: 'libra.completed_turn_raw_packet.v1', origin, user: { segments: [segment(u, i * 2)] }, assistant: { segments: [segment(a, i * 2 + 1)] } };
    const packet = { ...body, packetDigest: w.sha256(JSON.stringify(body)) };
    const receiptKey = prefix + `source-receipt:${hostWorldlineId}:e0:t${turn}:${revisionId}`, captureKey = prefix + `source-receipt-capture:${hostWorldlineId}:e0:t${turn}:${revisionId}`, receiptHeadKey = prefix + `source-receipt-head:${hostWorldlineId}:e0:t${turn}`;
    const ref = { schema: 'libra.completed_turn_raw_ref.v1', storageKey: receiptKey, field: 'rawSourcePacket', packetDigest: packet.packetDigest,
      originRelation: 'current_original_capture', algorithm: 'SHA-256', scopeKey: scope, worldlineId: hostWorldlineId, sessionEpoch: 0, turn, sourceRevisionId: revisionId, sourceDigest };
    const binding = { scopeKey: scope, worldlineId: hostWorldlineId, sessionEpoch: 0, turn, revisionId, sourceDigest };
    const receipt = { schema: 'libra.completed_turn_receipt.v1', ...binding,
      user: { ...identity.user, sourceMessageCount: 1 }, assistant: { ...identity.assistant, sourceMessageCount: 1 }, rawSourcePacket: packet, rawPacketRef: ref };
    const head = { schema: 'libra.completed_turn_head.v1', ...binding, receiptKey };
    records.set(receiptKey, receipt); records.set(receiptHeadKey, head);
    records.set(captureKey, { schema: 'libra.completed_turn_capture.v1', ...binding, receiptKey, captureSource: 'completed_pair_reconcile', captureSources: ['completed_pair_reconcile'], rawPacketRef: ref });
    rawRefs.push(ref); receipts.push({ status: 'verified', reason: '', receipt, head, receiptKey, headKey: receiptHeadKey });
    raw.push({ status: 'verified', packet, rawPacketRef: ref });
    receiptStages.push({ turn, scopeKey: scope, status: 'verified', receiptRef: receiptKey, identity: { scopeKey: scope, worldlineId: hostWorldlineId, sessionEpoch: 0, turn, revisionId, sourceDigest, userChatIds: [u.chatId], assistantChatIds: [a.chatId] } });
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
  const worldlineMeta = { schema: 'libra.worldline_meta.v1', scopeKey: scope, worldlineId: hostWorldlineId,
    parentWorldlineId: '', forkTurn: 0, forkFingerprint: '', createdAt: stamp };
  records.set(manifestKey, { schema: 'libra.manifest.v1', scopeKey: scope, characterId: 'unified-char', chatId: 'unified-chat', worldlineMeta, memories: { '1': ref }, stats: { commits: 1, embeddings: 0 }, updatedAt: stamp });
  records.set(headKey, { schema: 'libra.continuity_state.v2', scopeKey: scope, worldlineId: 'main', throughSessionEpoch: 0, status: 'ready', throughTurn: 5,
    unifiedApplied: { memoryId: memory.memoryId, revision: 1, artifactDigest }, reviewedThroughCanonical: { ...ref } });
  records.set(prefix + 'run:run-568', { runId: 'run-568', status: 'complete', promptProvenance, commit: { memoryKey, artifactDigest } });
  records.set(prefix + 'registry', { schema: 'synthetic.protected.registry', contents: 'keep exactly' });
  const owners = mode === 'plugin_only' ? ['local'] : mode === 'server_only' ? ['server'] : ['local', 'server'];
  const rows = sort(owners.flatMap(owner => [...records].map(([key, value]) => physicalRow(owner, key, JSON.stringify(value)))));
  rows.push(w.localRow(w.SCOPE_REGISTRY_KEY, JSON.stringify({
    'unified-char::unified-chat': { scopeKey: scope, characterId: 'unified-char', chatId: 'unified-chat', source: 'preexisting_explicit_user_scope' }
  }))); sort(rows);
  const lineage = { schema: 'librarian.host_lineage.v1', hostVersion: '2026.8.250', owner: 'libra',
    characterId: 'unified-char', hostChatId: 'unified-chat', scopeKey: scope, kind: 'independent_chat',
    status: 'independent', reason: 'no_native_branch_marker', pathVerified: true, inheritanceEligible: false,
    parentChatId: '', parentName: '', forkMessageId: '', markerIndex: -1, forkMessageIndex: -2,
    commonPrefixMessages: 0, commonPrefixPairs: 0, canonicalPrefixEnd: 0, partialCanonicalPairs: 0,
    prefixDigest: '', path: ['unified-chat'], worldlineMeta };
  const before = { mode, rows, stores: w.copy(stores), clock: { startedAt: time0, endedAt: time0 }, origin: 'http://127.0.0.1:12345', source: { characterId: 'unified-char', characterAlias: 'unified-char', chatPage: 0, characterChatIds: [{ id: 'unified-chat', chatId: 'unified-chat' }], chat: { id: 'unified-chat', chatId: 'unified-chat', message: messages, messages } },
    projections: owners.map(owner => ({ owner, key: headKey, value: { status: 'ready', throughTurn: 5 } })), calls: [], requests: [], sourceHashes: { ...w.SOURCE_HASHES } };
  const after = w.copy(before); after.clock = { startedAt: time1, endedAt: time1 };
  change(after, memoryKey, value => { value.embedding = w.terminalEmbedding(); }, true);
  change(after, manifestKey, value => { value.memories['1'].embeddingStatus = 'disabled'; value.memories['1'].updatedAt = later; if (mode === 'plugin_only') value.updatedAt = later; }, true);
  after.requests.push({ url: after.origin + '/v1/kv/get', method: 'GET' });
  return { before, after, admission: w.copy(before), result: { ok: true, attempted: 1, completed: 1, results: [{ memoryId: memory.memoryId, status: 'disabled', diagnostic: null }] },
    evidence: { lineage, receipts, raw, recovery: { scopeKey: scope, reason: '', receiptStages, microJobs, receiptJobs: [] } }, settings: w.copy(settings), evidenceKey };
}
function change(snapshot, key, mutate, increment = false) {
  for (const row of snapshot.rows.filter(row => row.key === key)) {
    const value = JSON.parse(row.raw); mutate(value); row.raw = JSON.stringify(value);
    if (increment && row.owner === 'server') { row.revision += 1; row.updated_at = time1; }
    refreshEnvelope(row);
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
  ['vector transaction', c => { c.after.rows.push(physicalRow('server', prefix + 'unified-vector-tx:memory-568', '{}', 1)); sort(c.after.rows); }],
  ['orphan wrong-binding transaction', c => { c.after.rows.push(physicalRow('local', prefix + 'unified-vector-tx:orphan', '{"memoryKey":"wrong"}')); sort(c.after.rows); }],
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
  ['reappeared basis row', c => { const k = JSON.parse(c.after.rows.find(r => r.key === memoryKey).raw).unifiedBasis.snapshotKey; c.after.rows.push(physicalRow('server', k, '{}', 1)); sort(c.after.rows); }],
  ['changed prompt provenance', c => change(c.after, memoryKey, x => { x.promptProvenance.stages.ariadne.profileName = 'wrong'; })],
  ['changed run provenance', c => change(c.after, prefix + 'run:run-568', x => { x.promptProvenance.stages.ariadne.profileName = 'wrong'; })],
  ['changed registry', c => change(c.after, prefix + 'registry', x => { x.contents += '!'; })],
  ['changed Head', c => change(c.after, headKey, x => { x.throughTurn = 4; })],
  ['changed currentness', c => { c.after.projections[0].value.throughTurn = 4; }],
  ['changed physical revision', c => { c.after.rows.find(r => r.key === headKey && r.owner === 'server').revision++; }],
  ['extra owner row', c => { c.after.rows.push(physicalRow('local', prefix + 'extra', '{}')); sort(c.after.rows); }],
  ['removed owner row', c => { c.after.rows = c.after.rows.filter(r => r.key !== prefix + 'registry'); }],
  ['unchanged JSON different protected bytes', c => { const row = c.after.rows.find(r => r.key === prefix + 'registry'); row.raw += ' '; refreshEnvelope(row); }],
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
  ['embedding only', rows => { const row = rows.find(r => r.key === memoryKey); const x = JSON.parse(row.raw); x.embedding.reason = 'later mutation'; row.raw = JSON.stringify(x); refreshEnvelope(row); }],
  ['missing old row', rows => { rows.splice(rows.findIndex(r => r.key === memoryKey), 1); }],
  ['changed old key', rows => { rows.find(r => r.key === memoryKey).key += ':other'; }],
  ['changed old physical revision', rows => { rows.find(r => r.key === memoryKey && r.owner === 'server').revision++; }],
  ['changed old canonical', rows => { const row = rows.find(r => r.key === memoryKey); const x = JSON.parse(row.raw); x.canonicalArtifact.facts[0].text += '!'; row.raw = JSON.stringify(x); refreshEnvelope(row); }],
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
  ['orphan wrong-target transaction after terminal admission', 'mirror', c => { c.after.rows.push(physicalRow('server', prefix + 'unified-vector-tx:orphan', '{"memoryKey":"wrong-target"}', 1)); sort(c.after.rows); }],
  ['admission-only loopback request removed', 'plugin_only', c => { c.after.requests.pop(); }],
  ['admission-only loopback request replaced', 'plugin_only', c => { c.after.requests[1].url = c.after.origin + '/r1-replacement'; }],
  ['admission-only loopback requests reordered', 'plugin_only', c => { [c.after.requests[1], c.after.requests[2]] = [c.after.requests[2], c.after.requests[1]]; }],
  ['plugin manifest stats changed after terminal admission', 'plugin_only', c => change(c.after, manifestKey, x => { x.stats.commits++; })],
  ['plugin manifest authority changed after terminal admission', 'plugin_only', c => change(c.after, manifestKey, x => { x.branchGuard = { status: 'tampered' }; })]
];
// Independent fixture vector: fixed input strings and pinned two-domain digest
// formula, not a value read from any product receipt/raw output.
const knownHost = 'wl_1bb7a7bbae868e06';
const foreignHost = 'wl_0000000000000000';
const captureKeyFor = c => c.evidence.receipts[0].receiptKey.replace(':source-receipt:', ':source-receipt-capture:');
function rebindEvidenceToHostInsteadOfLogical(c) {
  const evidence = JSON.parse(c.before.rows.find(row => row.key === c.evidenceKey).raw);
  evidence.binding.identity = w.branchDigest(JSON.stringify([scope, knownHost,
    evidence.rows.map(row => [row.userMessageId, row.assistantMessageId])]));
  evidence.payloadDigest = w.evidenceDigest(JSON.stringify({ binding: evidence.binding,
    normalizationVersion: evidence.normalizationVersion, rows: evidence.rows }));
  const b = evidence.binding, key = prefix + 'source-evidence:v1:' + w.evidenceDigest([b.owner, b.scopeKey, b.unitKey, b.identity, b.sourceDigest]);
  for (const row of c.before.rows.filter(row => row.key === c.evidenceKey)) { row.key = key; row.raw = JSON.stringify(evidence); refreshEnvelope(row); }
  change(c.before, memoryKey, x => { Object.assign(x.sourceEvidenceRef, { key, identity: b.identity, payloadDigest: evidence.payloadDigest }); });
  change(c.before, manifestKey, x => { x.memories['1'].sourceEvidenceDigest = evidence.payloadDigest; });
  sort(c.before.rows);
}
const identityNegatives = [
  ['host outputs replaced with logical main', 'plugin_only', c => {}, 'main'],
  ['logical Canonical main replaced with host', 'plugin_only', c => change(c.before, memoryKey, x => { x.worldlineId = knownHost; })],
  ['wrong independent character id', 'plugin_only', c => { c.before.source.characterId = 'other-character'; }],
  ['wrong independent character alias', 'plugin_only', c => { c.before.source.characterAlias = 'other-character'; }],
  ['wrong independent chat id', 'plugin_only', c => { c.before.source.chat.id = 'other-chat'; }],
  ['wrong independent chat alias', 'plugin_only', c => { c.before.source.chat.chatId = 'other-chat'; }],
  ['wrong scope input in physical registry', 'plugin_only', c => change(c.before, w.SCOPE_REGISTRY_KEY, x => { x['unified-char::unified-chat'].scopeKey = 'other-scope'; })],
  ['wrong registry mapping key', 'plugin_only', c => change(c.before, w.SCOPE_REGISTRY_KEY, x => { x['other::chat'] = x['unified-char::unified-chat']; delete x['unified-char::unified-chat']; })],
  ['missing physical local registry anchor', 'plugin_only', c => { c.before.rows = c.before.rows.filter(row => row.key !== w.SCOPE_REGISTRY_KEY); }],
  ['self-consistent foreign host in every output domain', 'mirror', c => {}, foreignHost],
  ['single rawRef host changed', 'plugin_only', c => change(c.before, memoryKey, x => { x.rawPacketRefs[0].worldlineId = foreignHost; })],
  ['single receipt host changed', 'plugin_only', c => change(c.before, c.evidence.receipts[0].receiptKey, x => { x.worldlineId = foreignHost; })],
  ['single capture host changed', 'plugin_only', c => change(c.before, captureKeyFor(c), x => { x.worldlineId = foreignHost; })],
  ['single completed-turn Head host changed', 'plugin_only', c => change(c.before, c.evidence.receipts[0].headKey, x => { x.worldlineId = foreignHost; })],
  ['single raw packet origin host changed', 'plugin_only', c => change(c.before, c.evidence.receipts[0].receiptKey, x => { x.rawSourcePacket.origin.worldlineId = foreignHost; })],
  ['public receipt-stage host changed', 'plugin_only', c => { c.evidence.recovery.receiptStages[0].identity.worldlineId = foreignHost; }],
  ['correct host IDs but wrong receipt physical key', 'plugin_only', c => { c.before.rows.find(row => row.key === c.evidence.receipts[0].receiptKey).key += ':wrong'; sort(c.before.rows); }],
  ['unexpected native branch marker in fixture input', 'plugin_only', c => { Object.assign(c.before.source.chat.message[1], { isComment: true, disabled: true, data: '{{specialcomment::branchedfrom::parent::name::fork::}}' }); }],
  ['public lineage character mismatch', 'plugin_only', c => { c.evidence.lineage.characterId = 'other-character'; }],
  ['public lineage unverified status', 'plugin_only', c => { c.evidence.lineage.status = 'unverified'; }],
  ['public lineage unverified path', 'plugin_only', c => { c.evidence.lineage.pathVerified = false; }],
  ['public lineage unexpectedly inheritance eligible', 'plugin_only', c => { c.evidence.lineage.inheritanceEligible = true; }],
  ['manifest host metadata wrong schema', 'plugin_only', c => change(c.before, manifestKey, x => { x.worldlineMeta.schema = 'wrong'; })],
  ['manifest host metadata wrong scope', 'plugin_only', c => change(c.before, manifestKey, x => { x.worldlineMeta.scopeKey = 'other-scope'; })],
  ['manifest host metadata wrong host', 'plugin_only', c => change(c.before, manifestKey, x => { x.worldlineMeta.worldlineId = foreignHost; })],
  ['manifest host identity missing', 'plugin_only', c => change(c.before, manifestKey, x => { delete x.worldlineMeta.worldlineId; })],
  ['raw host identity malformed', 'plugin_only', c => change(c.before, memoryKey, x => { x.rawPacketRefs[0].worldlineId = 'wl_not_hex'; })],
  ['correct host closure but source evidence rebound to host rather than logical main', 'plugin_only', rebindEvidenceToHostInsteadOfLogical],
  ['host raw-ref epoch mismatch', 'plugin_only', c => change(c.before, memoryKey, x => { x.rawPacketRefs[0].sessionEpoch = 1; })],
  ['cross-owner host disagreement', 'mirror', c => { const row = c.before.rows.find(row => row.owner === 'server' && row.key === memoryKey); const value = JSON.parse(row.raw); value.rawPacketRefs[0].worldlineId = foreignHost; row.raw = JSON.stringify(value); refreshEnvelope(row); }],
  ['identity changes by admission', 'plugin_only', c => { c.admission.source.chatPage = 1; }],
  ['source metadata changes by admission', 'plugin_only', c => { c.admission.source.chat.name = 'changed at admission'; }],
  ['registry raw changes by admission', 'plugin_only', c => { c.admission.rows.find(row => row.key === w.SCOPE_REGISTRY_KEY).raw += ' '; }],
  ['identity changes after admission', 'plugin_only', c => { c.after.source.characterAlias = 'other-character'; }],
  ['source metadata changes after admission', 'plugin_only', c => { c.after.source.chat.name = 'changed after admission'; }],
  ['registry raw changes after admission', 'plugin_only', c => { c.after.rows.find(row => row.key === w.SCOPE_REGISTRY_KEY).raw += ' '; }],
  ['independent fixture source hash changed', 'plugin_only', c => { c.before.sourceHashes['PROGRAM/tests/fixtures/libra_server_runtime_fixture.cjs'] = '0'.repeat(64); }],
  ['manifest unexpected parent metadata', 'plugin_only', c => change(c.before, manifestKey, x => { x.worldlineMeta.parentWorldlineId = foreignHost; })],
  ['public lineage host metadata mismatch', 'plugin_only', c => { c.evidence.lineage.worldlineMeta.worldlineId = foreignHost; }],
  ['public lineage branch-marker reason', 'plugin_only', c => { c.evidence.lineage.kind = 'native_branch'; c.evidence.lineage.reason = 'parent_unavailable'; }],
  ['coherent foreign receipt/raw closure despite correct manifest and lineage host', 'mirror', c => {
    for (const snapshot of [c.before, c.admission, c.after]) change(snapshot, manifestKey, x => { x.worldlineMeta.worldlineId = knownHost; });
    c.evidence.lineage.worldlineMeta.worldlineId = knownHost;
  }, foreignHost]
];
// These literal counts are the admission boundary. Never infer or grow a test
// budget from a mutable runtime queue or loop until it happens to be idle.
assert.equal(negatives.length, 74);
assert.equal(postNegatives.length, 6);
assert.equal(terminalAdmissionNegatives.length, 16);
assert.equal(identityNegatives.length, 41);
let passed = 0;
assert.equal(w.deriveHostWorldlineId({ characterId: 'unified-char', chatId: 'unified-chat', scopeKey: scope }), knownHost);
assert.notEqual(knownHost, w.LOGICAL_WORLDLINE); passed++;
for (const mode of ['plugin_only', 'mirror', 'server_only']) {
  const c = seed(mode); verify(c); passed++;
  const settled = seed(mode); settled.before = w.copy(settled.after); settled.admission = w.copy(settled.after); settled.result = w.copy(zero); verify(settled); passed++;
  const timer = seed(mode); timer.admission = w.copy(timer.after); timer.result = w.copy(zero); verify(timer); passed++;
  const lateTimer = seed(mode); lateTimer.result = w.copy(zero); verify(lateTimer); passed++;
}
for (const [label, mutate] of negatives) {
  const c = seed('server_only'); verify(c); const initial = w.typedText(c); mutate(c); assert.notEqual(w.typedText(c), initial, label + ': actual mutation'); assert.throws(() => verify(c), undefined, label); passed++;
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
for (const [label, mode, mutate, hostOverride] of identityNegatives) {
  const c = seed(mode, hostOverride);
  if (hostOverride === undefined) verify(c); // All ordinary mutations start from valid distinct-domain evidence.
  if (hostOverride !== undefined) {
    // Forgery seeds intentionally agree across every host output; input IDs and
    // local registry remain unchanged, so they cannot authorize a foreign host.
    assert.equal(c.evidence.lineage.worldlineMeta.worldlineId, hostOverride);
    for (const row of c.evidence.receipts) assert.equal(row.receipt.worldlineId, hostOverride);
    for (const row of c.evidence.raw) { assert.equal(row.rawPacketRef.worldlineId, hostOverride); assert.equal(row.packet.origin.worldlineId, hostOverride); }
  }
  const initial = JSON.stringify(c);
  mutate(c);
  if (hostOverride === undefined) assert.notEqual(JSON.stringify(c), initial, `${label}: actual mutation`);
  assert.throws(() => verify(c), undefined, label); passed++;
}
const c = seed('mirror'), baseline = w.oldRows(c.after);
w.assertOldRows(baseline, c.after.rows); passed++;
for (const [label, mutate] of postNegatives) { const rows = w.copy(c.after.rows); mutate(rows); assert.throws(() => w.assertOldRows(baseline, rows), undefined, label); passed++; }
assert.throws(() => w.assertOldRows([], c.after.rows)); passed++;
const marker = new Error('same synthetic queue exception'); assert.throws(() => w.unwrapQueueOutcome({ error: marker }), error => error === marker); passed++;
assert.equal(passed, 153);
// Fixed v4 additions. The adapter functions used here are the same pure mapping
// functions used by test568. vm runs only these literal synthetic expressions,
// never the product. This file has NOT been executed during preparation.
const vm = require('node:vm');
const added = [];
const add = (name, run) => added.push({ name, run });
const validTyped = [
  ['null', null], ['empty string', ''], ['string null', 'null'], ['JSON-looking string', '{"a":1}'],
  ['false', false], ['true', true], ['finite fraction', 1.25], ['zero', 0],
  ['empty record', {}], ['empty array', []], ['nested Unicode', { 한글: ['é', null, { n: 2 }] }],
  ['ordered a b', { a: 1, b: 2 }], ['ordered b a', { b: 2, a: 1 }]
];
for (const owner of ['local', 'server']) for (const [label, value] of validTyped) add(`typed ${owner} ${label}`, () => {
  const x = seed('mirror');
  const row = physicalRow(owner, 'aux:typed', value);
  for (const snapshot of [x.before, x.admission, x.after]) { snapshot.rows.push(w.copy(row)); sort(snapshot.rows); }
  verify(x); // complete original queue/public/settings predicates, not an encoder-only pass
  assert.equal(typeof row.raw, typeof value); assert.equal(w.typedText(row.raw), w.typedText(value));
});
for (const [label, expression] of [
  ['VM plain', '({ a: [1, null, "한글"] })'], ['VM null prototype', 'Object.assign(Object.create(null), { a: 1 })'],
  ['VM array', '[1, {a: true}]']
]) add(label, () => {
  const input = vm.runInNewContext(expression);
  const detached = w.freezeCopy(input);
  assert.equal(w.typedText(detached), w.typedText(input)); assert.ok(Object.isFrozen(detached));
  const row = w.localRow('aux:VM', input); w.validateRows([row], stores);
});
add('detached frozen nested value', () => {
  const value = { a: [1, { b: 'old' }] }, before = w.freezeCopy(value);
  value.a[1].b = 'new'; assert.equal(before.a[1].b, 'old');
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.a) && Object.isFrozen(before.a[1]));
});
add('type and key order distinctions', () => {
  for (const [a, b] of [[null, 'null'], [{ a: 1 }, '{"a":1}'], [1, '1'], [false, 'false'], [{ a: 1, b: 2 }, { b: 2, a: 1 }], [{}, []], [{}, Object.create(null)]]) assert.notEqual(w.typedText(a), w.typedText(b));
});
const fakeBinding = () => {
  const local = new Map(), backend = { getItem() {}, setItem() {}, removeItem() {}, keys() {} };
  const localGetter = async () => backend, host = { pluginStorage: backend, safeLocalStorage: backend, getLocalPluginStorage: localGetter };
  const database = {}, filePath = stores.server.filePath, repository = { namespace: 'libra', filePath, database };
  return { local, backend, localGetter, host, database, repository, filePath, fixtureDir: stores.server.fixtureDir };
};
add('one physical Map and three source-anchored aliases', () => { const input = fakeBinding(); const guard = w.bindingGuard(input); assert.deepEqual(guard(input), stores); });
const aliasMutations = [
  ['Map replaced', x => { x.local = new Map(); }], ['backend replaced', x => { x.backend = { ...x.backend }; }],
  ['plugin alias', x => { x.host.pluginStorage = {}; }], ['safe alias', x => { x.host.safeLocalStorage = {}; }],
  ['getter alias', x => { x.host.getLocalPluginStorage = async () => ({}); }],
  ['backend method', x => { x.backend.setItem = () => {}; }], ['repository handle', x => { x.repository = { ...x.repository }; }],
  ['database handle', x => { x.database = {}; }], ['repository path', x => { x.repository.filePath += ':other'; }]
];
for (const [label, mutate] of aliasMutations) add(`alias ${label}`, () => { const input = fakeBinding(), guard = w.bindingGuard(input); guard(input); mutate(input); assert.throws(() => guard(input)); });
add('same key in two server spaces remains two rows', () => {
  const rows = sort([physicalRow('server', 'aux:same', { a: 1 }, 7, 'plugin'), physicalRow('server', 'aux:same', null, 7, 'local')]);
  w.validateRows(rows, stores); assert.notEqual(w.rowId(rows[0]), w.rowId(rows[1]));
});
add('separator-containing local identities do not collide', () => {
  const rows = sort([physicalRow('local', 'a\0b', null), physicalRow('local', 'a', { b: null }), physicalRow('server', 'a\nb', null)]);
  w.validateRows(rows, stores); assert.equal(new Set(rows.map(w.rowId)).size, 3);
});
add('other-space Head lookalike does not substitute Canonical owner', () => {
  const x = seed('mirror');
  for (const snapshot of [x.before, x.admission, x.after]) { snapshot.rows.push(physicalRow('server', headKey, { auxiliary: true }, 7, 'local')); sort(snapshot.rows); }
  verify(x);
});
const lossFactories = [
  ['undefined', () => undefined], ['function', () => () => 1], ['symbol', () => Symbol('data')], ['BigInt', () => 1n],
  ['NaN', () => NaN], ['positive Infinity', () => Infinity], ['negative Infinity', () => -Infinity], ['negative zero', () => -0],
  ['sparse array', () => new Array(2)], ['extra array property', () => Object.assign([1], { extra: true })],
  ['array nonenumerable', () => Object.defineProperty([1], 'extra', { value: true })],
  ['array accessor', counter => Object.defineProperty([1], '0', { enumerable: true, get() { counter.calls++; return 1; } })],
  ['Date', () => new Date(0)], ['Map', () => new Map()], ['Set', () => new Set()], ['boxed number', () => new Number(1)],
  ['class instance', () => new (class Example { constructor() { this.a = 1; } })()],
  ['custom prototype', () => Object.assign(Object.create({ inherited: true }), { a: 1 })],
  ['null-prototype array', () => Object.setPrototypeOf([1], null)],
  ['cycle', () => { const x = {}; x.self = x; return x; }],
  ['nonenumerable record', () => Object.defineProperty({}, 'hidden', { value: 1 })],
  ['symbol record key', () => ({ [Symbol('key')]: 1 })],
  ['own callable toJSON', counter => ({ toJSON() { counter.calls++; return null; } })],
  ['own toJSON accessor', counter => Object.defineProperty({}, 'toJSON', { enumerable: true, get() { counter.calls++; return () => null; } })],
  ['record getter', counter => Object.defineProperty({}, 'a', { enumerable: true, get() { counter.calls++; return null; } })],
  ['inherited callable toJSON', counter => vm.runInNewContext('Object.prototype.toJSON = () => { tick(); return null; }; ({a:1})', { tick: () => counter.calls++ })],
  ['inherited toJSON accessor', counter => vm.runInNewContext('Object.defineProperty(Object.prototype, "toJSON", {get(){tick(); return () => null;}}); ({a:1})', { tick: () => counter.calls++ })],
  ['VM array prototype data', () => vm.runInNewContext('Array.prototype.extra = true; [1]')],
  ['VM class', () => vm.runInNewContext('new (class Example { constructor(){this.a=1;} })()')],
  ['VM Date', () => vm.runInNewContext('new Date(0)')],
  ['VM custom prototype', () => vm.runInNewContext('Object.assign(Object.create({a:1}), {b:2})')]
];
for (const [label, make] of lossFactories) for (const placement of ['root', 'nested', 'whole witness']) add(`reject ${label} ${placement}`, () => {
  const counter = { calls: 0 }, bad = make(counter);
  const input = placement === 'root' ? bad : placement === 'nested' ? { a: [bad] } : { source: { candidate: bad }, rows: [], calls: [], requests: [] };
  assert.throws(() => w.freezeCopy(input), /568 typed:/, label); assert.equal(counter.calls, 0, 'no getter/toJSON invocation');
});
const rowMutations = [
  ['namespace', row => { row.namespace = 'flashback'; }], ['space', row => { row.space = 'wrong'; }],
  ['store', row => { row.storeId += ':other'; }], ['owner', row => { row.owner = 'local'; }],
  ['null Canonical', row => { row.raw = null; refreshEnvelope(row); }], ['object Canonical', row => { row.raw = JSON.parse(row.raw); refreshEnvelope(row); }],
  ['Canonical plugin moved to local space', row => { row.space = 'local'; }],
  ['envelope malformed', row => { row.value_json = '{'; row.valueChars = 1; row.valueBytes = 1; row.digest = w.sha256('{'); }],
  ['envelope parsed mismatch', row => { row.value_json = '{}'; row.valueChars = 2; row.valueBytes = 2; row.digest = w.sha256('{}'); }],
  ['digest', row => { row.digest = '0'.repeat(64); }], ['revision unsafe', row => { row.revision = Number.MAX_SAFE_INTEGER + 1; }],
  ['timestamp fraction', row => { row.updated_at += 0.5; }], ['timestamp future', row => { row.updated_at = time1 + 1; }],
  ['deleted', row => { row.deleted = 1; }], ['extra metadata', row => { row.unreviewed = true; }],
  ['envelope character length', row => { row.valueChars++; }], ['envelope byte length', row => { row.valueBytes++; }]
];
for (const [label, mutate] of rowMutations) add(`row rejection ${label}`, () => {
  const x = seed('server_only'); verify(x); const row = x.before.rows.find(row => row.key === memoryKey);
  const initial = w.typedText(row); mutate(row); assert.notEqual(w.typedText(row), initial); sort(x.before.rows); assert.throws(() => verify(x));
});
const auxMutations = [
  ['value', row => { row.raw.a = 2; refreshEnvelope(row); }], ['type', row => { row.raw = '{"a":1,"b":2}'; refreshEnvelope(row); }],
  ['key order', row => { row.raw = { b: 2, a: 1 }; refreshEnvelope(row); }],
  ['envelope-only whitespace', row => { row.value_json += ' '; row.valueChars++; row.valueBytes++; row.digest = w.sha256(row.value_json); }],
  ['digest', row => { row.digest = '0'.repeat(64); }], ['revision', row => { row.revision++; }],
  ['timestamp', row => { row.updated_at++; }], ['identity', row => { row.space = 'local'; }]
];
for (const phase of ['before to admission', 'admission to after', 'terminal admission to after']) for (const [label, mutate] of auxMutations) add(`aux ${phase} ${label}`, () => {
  const x = phase === 'terminal admission to after' ? terminalAdmissionSeed('mirror') : seed('mirror');
  for (const snapshot of [x.before, x.admission, x.after]) { snapshot.rows.push(physicalRow('server', 'aux:protected', { a: 1, b: 2 })); sort(snapshot.rows); }
  verify(x); const initialBefore = w.typedText(x.before), initialAdmission = w.typedText(x.admission);
  const target = phase === 'before to admission' ? x.admission : x.after;
  const old = w.typedText(target); mutate(target.rows.find(row => row.key === 'aux:protected')); sort(target.rows);
  assert.notEqual(w.typedText(target), old); assert.equal(w.typedText(x.before), initialBefore);
  if (phase !== 'before to admission') assert.equal(w.typedText(x.admission), initialAdmission);
  assert.throws(() => verify(x));
});
for (const phase of ['before to admission', 'admission to after', 'terminal admission to after']) for (const operation of ['add', 'remove']) add(`aux ${phase} ${operation} row`, () => {
  const x = phase === 'terminal admission to after' ? terminalAdmissionSeed('mirror') : seed('mirror'); verify(x);
  const target = phase === 'before to admission' ? x.admission : x.after;
  if (operation === 'add') target.rows.push(physicalRow('local', 'aux:extra', { a: 1 }));
  else target.rows = target.rows.filter(row => row.key !== prefix + 'registry');
  sort(target.rows); assert.throws(() => verify(x));
});
for (const schema of ['libra.micro_work.v1', 'libra.unified_server_vector_tx.v1', 'libra.embedding_projection.v2']) add(`structured prohibited schema ${schema}`, () => {
  const x = seed('mirror'); verify(x); x.after.rows.push(physicalRow('server', 'aux:hidden', { schema })); sort(x.after.rows); assert.throws(() => verify(x));
});
const forgedTransitions = [
  ['wrong embedding envelope', row => { row.value_json = JSON.stringify({ embedding: 'disabled' }); row.valueChars = row.value_json.length; row.valueBytes = row.valueChars; row.digest = w.sha256(row.value_json); }],
  ['same payload rewrite revision twice', row => { row.revision++; }],
  ['commit before interval', row => { row.updated_at = time0 - 1; }],
  ['commit after interval', row => { row.updated_at = time1 + 1; }],
  ['extra derived metadata', row => { row.unreviewed = 1; }],
  ['derived owner moved space', row => { row.space = 'local'; }],
  ['derived envelope whitespace', row => { row.value_json += ' '; row.valueChars++; row.valueBytes++; row.digest = w.sha256(row.value_json); }]
];
for (const [label, mutate] of forgedTransitions) add(`forged transition ${label}`, () => {
  const x = seed('server_only'); verify(x); mutate(x.after.rows.find(row => row.key === memoryKey)); sort(x.after.rows); assert.throws(() => verify(x));
});
for (const [label, mutate] of [
  ['envelope', row => { row.value_json += ' '; }], ['digest', row => { row.digest = '0'.repeat(64); }],
  ['timestamp', row => { row.updated_at++; }], ['space', row => { row.space = 'local'; }],
  ['namespace', row => { row.namespace = 'other'; }], ['store', row => { row.storeId += ':other'; }],
  ['type', row => { row.raw = JSON.parse(row.raw); }]
]) add(`post-v5 complete old ${label}`, () => {
  const x = seed('mirror'), baseline = w.oldRows(x.after), rows = w.copy(x.after.rows);
  w.assertOldRows(baseline, rows); mutate(rows.find(row => row.owner === 'server' && row.key === memoryKey)); assert.throws(() => w.assertOldRows(baseline, rows));
});
const boundaryCases = [
  ['string code units', n => 'x'.repeat(n), w.LIMITS.rowChars, value => w.copy(value)],
  ['total text code units', n => [...Array(16).fill('x'.repeat(w.LIMITS.rowChars)), ...(n === w.LIMITS.totalChars ? [] : ['!'])], w.LIMITS.totalChars, value => w.copy(value)],
  ['key code units', n => ({ ['k'.repeat(n)]: null }), w.LIMITS.keyChars, value => w.copy(value)],
  ['record members', n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, null])), w.LIMITS.recordKeys, value => w.copy(value)],
  ['array items', n => Array(n).fill(null), w.LIMITS.arrayItems, value => w.copy(value)],
  ['depth', n => { let value = null; for (let i = 0; i < n; i++) value = { a: value }; return value; }, w.LIMITS.depth, value => w.copy(value)],
  ['nodes', n => [...Array.from({ length: 16 }, () => Array(4094).fill(null)), ...Array(n - 65521).fill(null)], w.LIMITS.nodes, value => w.copy(value)],
  ['rows', n => sort(Array.from({ length: n }, (_, i) => physicalRow('local', `aux:${i}`, null))), w.LIMITS.rows, value => w.validateRows(value, stores)],
  ['request count', n => { const x = seed('plugin_only'); x.before.requests = Array.from({ length: n }, () => ({ url: x.before.origin + '/bounded', method: 'GET' })); return x.before; }, w.LIMITS.requests, value => w.physical(value)],
  ['envelope UTF-8 bytes', n => { const raw = '한'.repeat(699050) + (n === w.LIMITS.envelopeBytes ? '' : 'x'); return { space: 'plugin', key: 'aux:bytes', value_json: JSON.stringify(raw), deleted: 0, revision: 1, digest: w.sha256(JSON.stringify(raw)), updated_at: time0 }; }, w.LIMITS.envelopeBytes, value => w.serverRow(value, stores)]
];
for (const [label, make, limit, check] of boundaryCases) {
  add(`boundary exact ${label}`, () => { check(make(limit)); });
  add(`boundary one over ${label}`, () => { let returned = false; assert.throws(() => { check(make(limit + 1)); returned = true; }); assert.equal(returned, false, 'no partial/normalized snapshot returned'); });
}
for (const owner of ['local', 'server']) add(`concealed structured Canonical target ${owner}`, () => { const x = seed('mirror'); verify(x); const value = JSON.parse(x.before.rows.find(row => row.key === memoryKey).raw); for (const snapshot of [x.before, x.admission, x.after]) { snapshot.rows.push(physicalRow(owner, 'aux:concealed-canonical', value)); sort(snapshot.rows); } assert.throws(() => verify(x)); });
add('other-space old-key auxiliary is distinct from Canonical old owners', () => { const x = seed('mirror'); for (const snapshot of [x.before, x.admission, x.after]) { snapshot.rows.push(physicalRow('server', memoryKey, { auxiliary: true }, 7, 'local')); sort(snapshot.rows); } verify(x); w.assertOldRows(w.oldRows(x.after), x.after.rows); });
add('repeated noncyclic references copied as values', () => { const shared = { a: 1 }, original = { a: shared, b: shared }, detached = w.freezeCopy(original); assert.notEqual(detached.a, detached.b); assert.equal(w.typedText(detached), w.typedText(original)); });
add('invalid timestamp range', () => { const x = seed('server_only'); verify(x); x.before.rows.find(row => row.key === memoryKey).updated_at = Number.MAX_SAFE_INTEGER; assert.throws(() => verify(x)); });
add('non-source ISO spelling', () => { const x = seed('plugin_only'); verify(x); change(x.after, manifestKey, value => { value.memories['1'].updatedAt = '2026-10-10T00:00:01Z'; }); assert.throws(() => verify(x)); });
add('pinned SDK producer hash', () => { const x = seed('mirror'); verify(x); x.before.sourceHashes['PROGRAM/sdk/MemorySuiteStorageClient.libra.source.js'] = '0'.repeat(64); assert.throws(() => verify(x)); });
add('batch timestamps disagree inside interval', () => { const x = seed('server_only'); verify(x); x.after.clock = { startedAt: time1 + 10, endedAt: time1 + 10 }; x.after.rows.find(row => row.key === memoryKey).updated_at = time1 + 1; assert.throws(() => verify(x)); });
add('ref timestamp outside capture interval', () => { const x = seed('plugin_only'); verify(x); change(x.after, manifestKey, value => { value.memories['1'].updatedAt = '2026-10-10T00:00:02.000Z'; value.updatedAt = '2026-10-10T00:00:02.000Z'; }); assert.throws(() => verify(x)); });
add('SQLite null-prototype input record', () => { const value_json = '{"a":[null,true,2]}'; const record = Object.assign(Object.create(null), { space: 'plugin', key: 'aux:sqlite', value_json, deleted: 0, revision: 1, digest: w.sha256(value_json), updated_at: time0 }); const row = w.serverRow(record, stores); assert.equal(row.value_json, value_json); assert.deepEqual(row.raw, { a: [null, true, 2] }); w.validateRows([row], stores); });
add('server input unknown field rejected', () => { const value_json = 'null'; const record = { space: 'plugin', key: 'aux:sqlite', value_json, deleted: 0, revision: 1, digest: w.sha256(value_json), updated_at: time0, unknown: true }; assert.throws(() => w.serverRow(record, stores)); });
add('serialized alias mapping forged', () => { const x = seed('mirror'); verify(x); x.before.stores.local.aliases[1] = 'independent-second-store'; assert.throws(() => verify(x)); });
add('server ref may be prepared before capture while commit stays inside interval', () => { const x = seed('server_only'); x.before.clock = { startedAt: time0 + 500, endedAt: time0 + 500 }; x.admission = w.copy(x.before); change(x.after, manifestKey, value => { value.memories['1'].updatedAt = '2026-10-10T00:00:00.250Z'; }); verify(x); });
add('server same-millisecond metadata commit is not a second write', () => { const x = seed('server_only'); for (const row of x.after.rows.filter(row => [memoryKey, manifestKey].includes(row.key))) row.updated_at = time0; change(x.after, manifestKey, value => { value.memories['1'].updatedAt = stamp; }); verify(x); });
// All counts are fixed in source before admission, never inferred from a product queue.
assert.equal(validTyped.length, 13); assert.equal(aliasMutations.length, 9); assert.equal(lossFactories.length, 31);
assert.equal(rowMutations.length, 17); assert.equal(auxMutations.length, 8); assert.equal(forgedTransitions.length, 7); assert.equal(boundaryCases.length, 10);
assert.equal(added.length, 235);
for (const { name, run } of added) { run(); passed++; }
assert.equal(passed, 388);

// V5_R1_LOWER_BOUND_CONTROLS_BEGIN
// Fixed source-derived correction only. Old388 remain above, byte-for-byte.
const pluginLowerBoundError = /568 witness: plugin ref update follows pending capture/;
const setPluginStamps = (snapshot, reference, root) => change(snapshot, manifestKey, value => {
  value.memories['1'].updatedAt = reference; value.updatedAt = root;
});
const delayedPluginSeed = (beforeOffset, admissionOffset) => {
  const x = seed('plugin_only');
  x.before.clock = { startedAt: time0 + beforeOffset, endedAt: time0 + beforeOffset };
  x.admission = w.copy(x.before);
  x.admission.clock = { startedAt: time0 + admissionOffset, endedAt: time0 + admissionOffset };
  return x;
};
const proveOnlyPluginStampsChanged = (old, next, reference, root) => {
  const expected = w.copy(old); setPluginStamps(expected, reference, root);
  assert.equal(w.typedText(next), w.typedText(expected), 'only the two literal synthetic manifest timestamps changed');
  assert.notEqual(w.typedText(next), w.typedText(old), 'genuine timestamp mutation');
};
const pluginTimestampLowerBoundCases = [
  ['reference before initial capture with root inside interval', () => {
    const x = delayedPluginSeed(500, 500); verify(x);
    const before = w.typedText(x.before), admission = w.typedText(x.admission), oldAfter = w.copy(x.after);
    const reference = '2026-10-10T00:00:00.250Z', root = '2026-10-10T00:00:00.750Z';
    setPluginStamps(x.after, reference, root);
    assert.equal(w.typedText(x.before), before); assert.equal(w.typedText(x.admission), admission);
    proveOnlyPluginStampsChanged(oldAfter, x.after, reference, root);
    assert.throws(() => w.verifyTransition(x.before, x.after, true), pluginLowerBoundError);
    assert.throws(() => verify(x), pluginLowerBoundError);
  }],
  ['reference after initial capture but before pending admission', () => {
    const x = delayedPluginSeed(200, 500); verify(x);
    const before = w.typedText(x.before), admission = w.typedText(x.admission), oldAfter = w.copy(x.after);
    const reference = '2026-10-10T00:00:00.400Z', root = '2026-10-10T00:00:00.750Z';
    setPluginStamps(x.after, reference, root);
    assert.equal(w.typedText(x.before), before); assert.equal(w.typedText(x.admission), admission);
    proveOnlyPluginStampsChanged(oldAfter, x.after, reference, root);
    w.verifyTransition(x.before, x.after, true); // End-to-end alone cannot detect this adjacent-edge violation.
    assert.throws(() => w.verifyTransition(x.admission, x.after, true), pluginLowerBoundError);
    assert.throws(() => verify(x), pluginLowerBoundError);
  }],
  ['timer terminal admission with both timestamps before initial capture', () => {
    const x = delayedPluginSeed(500, 500);
    x.admission = w.copy(x.after); x.after = w.copy(x.admission); x.result = w.copy(zero); verify(x);
    const before = w.typedText(x.before), oldAdmission = w.copy(x.admission), oldAfter = w.copy(x.after);
    const reference = '2026-10-10T00:00:00.250Z', root = '2026-10-10T00:00:00.300Z';
    setPluginStamps(x.admission, reference, root); x.after = w.copy(x.admission);
    assert.equal(w.typedText(x.before), before); assert.equal(w.typedText(x.after), w.typedText(x.admission));
    proveOnlyPluginStampsChanged(oldAdmission, x.admission, reference, root);
    proveOnlyPluginStampsChanged(oldAfter, x.after, reference, root);
    w.verifyTransition(x.admission, x.after, true); // Exact terminal equality is still positive.
    assert.throws(() => w.verifyTransition(x.before, x.admission), pluginLowerBoundError);
    assert.throws(() => verify(x), pluginLowerBoundError);
  }],
  ['plugin same-millisecond lower-bound equality', () => {
    const x = delayedPluginSeed(500, 500); verify(x);
    const before = w.typedText(x.before), admission = w.typedText(x.admission), oldAfter = w.copy(x.after);
    const boundary = '2026-10-10T00:00:00.500Z';
    setPluginStamps(x.after, boundary, boundary);
    assert.equal(w.typedText(x.before), before); assert.equal(w.typedText(x.admission), admission);
    proveOnlyPluginStampsChanged(oldAfter, x.after, boundary, boundary);
    assert.equal(Date.parse(boundary), x.admission.clock.endedAt);
    verify(x);
  }]
];
assert.equal(pluginTimestampLowerBoundCases.length, 4);
for (const [label, run] of pluginTimestampLowerBoundCases) { run(); passed++; }
assert.equal(passed, 392);
// V5_R1_LOWER_BOUND_CONTROLS_END

console.log(JSON.stringify({ test: 'libra_568_one_record_witness_controls', passed, syntheticOnly: true }));
