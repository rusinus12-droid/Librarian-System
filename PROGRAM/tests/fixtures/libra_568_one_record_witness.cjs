'use strict';
// Pure, finite witness for the single T1..T5/v4 fixture. No product imports or I/O.
// Preparation may replace only the exact missing-key embedding and manifest
// metadata. Sections/anchors/retrieval already exist at initial commit and stay exact.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const VERSION = 'libra.retrieval_projection.v2';
const LOGICAL_WORLDLINE = 'main';
const SCOPE_REGISTRY_KEY = 'libra:v1:scope-registry:v1';
const FIXTURE_IDENTITY = Object.freeze({ characterId: 'unified-char', chatId: 'unified-chat', scopeKey: 'seventh-server-scope' });
const LIMITS = Object.freeze({ rows: 256, rowChars: 1048576, totalChars: 16777216, requests: 4096,
  depth: 64, nodes: 65536, recordKeys: 4096, arrayItems: 4096, keyChars: 4096, envelopeBytes: 2097152 });
// Descriptor traversal is deliberately before serialization. Reflection is not a
// hostile-Proxy sandbox; no getters/toJSON are called. Own-key metadata is inspected
// once, then bounded before descriptors/payload are copied. Repeated acyclic references
// are detached as values; physical Map/backend aliases are witnessed separately.
const objectSource = Function.prototype.toString.call(Object);
const arraySource = Function.prototype.toString.call(Array);
const arrayPrototypeKeys = Reflect.ownKeys(Array.prototype);
const validTimestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const sourceIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
function plainPrototype(proto) {
  if (proto === null) return true;
  if (Object.getPrototypeOf(proto) !== null) return false;
  const names = Reflect.ownKeys(proto);
  if (names.some(key => typeof key !== 'string') || names.length !== 12
    || names.slice().sort().join('|') !== '__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__|__proto__|constructor|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|toLocaleString|toString|valueOf') return false;
  const c = Object.getOwnPropertyDescriptor(proto, 'constructor');
  return !!c && Object.hasOwn(c, 'value') && typeof c.value === 'function'
    && Function.prototype.toString.call(c.value) === objectSource && c.value.prototype === proto;
}
function encodeData(value, { frozen = false, tags = false, row = false } = {}) {
  const active = new Set(); let nodes = 0, chars = 0;
  const text = string => { assert.ok(string.length <= LIMITS.rowChars, '568 typed: string limit');
    chars += string.length; assert.ok(chars <= (row ? LIMITS.rowChars : LIMITS.totalChars), '568 typed: total text limit'); return string; };
  const visit = (item, depth) => {
    assert.ok(depth <= LIMITS.depth, '568 typed: depth limit');
    assert.ok(++nodes <= LIMITS.nodes, '568 typed: node limit');
    if (item === null) return tags ? ['null'] : null;
    if (typeof item === 'string') { text(item); return tags ? ['string', item] : item; }
    if (typeof item === 'boolean') return tags ? ['boolean', item] : item;
    if (typeof item === 'number') { assert.ok(Number.isFinite(item) && !Object.is(item, -0), '568 typed: lossless finite number'); return tags ? ['number', item] : item; }
    assert.equal(typeof item, 'object', '568 typed: unsupported value');
    assert.ok(!active.has(item), '568 typed: cycle');
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (array) {
      const c = proto && Object.getOwnPropertyDescriptor(proto, 'constructor');
      const inherited = proto && Reflect.ownKeys(proto);
      assert.ok(inherited && inherited.length === arrayPrototypeKeys.length && inherited.every(key => arrayPrototypeKeys.includes(key)), '568 typed: unmodified intrinsic array prototype');
      assert.ok(c && Object.hasOwn(c, 'value') && typeof c.value === 'function'
        && Function.prototype.toString.call(c.value) === arraySource && c.value.prototype === proto
        && plainPrototype(Object.getPrototypeOf(proto)), '568 typed: plain array prototype');
    } else assert.ok(plainPrototype(proto), '568 typed: plain record prototype');
    for (let cursor = item; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
      const d = Object.getOwnPropertyDescriptor(cursor, 'toJSON');
      if (d) assert.ok(Object.hasOwn(d, 'value') && typeof d.value !== 'function', '568 typed: no accessor/callable toJSON');
    }
    const keys = Reflect.ownKeys(item);
    assert.ok(keys.every(key => typeof key === 'string'), '568 typed: no symbol keys');
    assert.ok(keys.length <= (array ? LIMITS.arrayItems + 1 : LIMITS.recordKeys), '568 typed: member limit');
    active.add(item);
    let result;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, 'length');
      assert.ok(length && Object.hasOwn(length, 'value') && Number.isSafeInteger(length.value)
        && length.value >= 0 && length.value <= LIMITS.arrayItems, '568 typed: array length limit');
      assert.equal(keys.length, length.value + 1, '568 typed: dense array without extra properties');
      assert.equal(keys[keys.length - 1], 'length');
      result = [];
      for (let index = 0; index < length.value; index += 1) {
        assert.equal(keys[index], `${index}`, '568 typed: dense ordered array');
        const d = Object.getOwnPropertyDescriptor(item, keys[index]);
        assert.ok(d && d.enumerable && Object.hasOwn(d, 'value'), '568 typed: array data descriptor');
        result.push(visit(d.value, depth + 1));
      }
      if (tags) result = ['array', result];
    } else {
      const entries = []; result = proto === null ? Object.create(null) : {};
      for (const key of keys) {
        assert.ok(key.length <= LIMITS.keyChars, '568 typed: key limit'); text(key);
        const d = Object.getOwnPropertyDescriptor(item, key);
        assert.ok(d && d.enumerable && Object.hasOwn(d, 'value'), '568 typed: enumerable data descriptor');
        const next = visit(d.value, depth + 1);
        if (tags) entries.push([key, next]);
        else Object.defineProperty(result, key, { value: next, enumerable: true, writable: true, configurable: true });
      }
      if (tags) result = [proto === null ? 'null-record' : 'record', entries];
    }
    active.delete(item);
    return frozen ? Object.freeze(result) : result;
  };
  return visit(value, 0);
}
const copy = value => encodeData(value);
const freezeCopy = value => encodeData(value, { frozen: true });
const typedText = value => JSON.stringify(encodeData(value, { tags: true }));
const json = value => JSON.stringify(copy(value));
const same = (a, b, label) => assert.equal(typedText(a), typedText(b), `568 witness: ${label}`);
const exactFields = (value, fields, label) => same(Object.keys(value).sort(), [...fields].sort(), label);
const LOCAL_STORE = 'fixture-local-map';
const LOCAL_ALIASES = Object.freeze(['pluginStorage', 'safeLocalStorage', 'getLocalPluginStorage']);
function storeWitness(fixtureDir, filePath) {
  assert.equal(typeof fixtureDir, 'string'); assert.ok(fixtureDir.startsWith('/') && !fixtureDir.endsWith('/'));
  assert.equal(filePath, fixtureDir + '/stores/libra/libra.sqlite');
  return { local: { storeId: LOCAL_STORE, aliases: [...LOCAL_ALIASES] },
    server: { storeId: filePath, namespace: 'libra', filePath, fixtureDir } };
}
function bindingGuard(input) {
  const pinned = { ...input }, methods = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'keys'].map(key => [key, input.backend[key]]));
  const check = current => {
    for (const key of ['local', 'backend', 'repository', 'database', 'host', 'localGetter']) assert.equal(current[key], pinned[key], `568 binding: same ${key}`);
    assert.ok(current.local instanceof Map, '568 binding: one actual local Map');
    assert.equal(current.host.pluginStorage, current.backend); assert.equal(current.host.safeLocalStorage, current.backend);
    assert.equal(current.host.getLocalPluginStorage, current.localGetter); assert.equal(typeof current.localGetter, 'function');
    for (const key of Object.keys(methods)) { assert.equal(typeof methods[key], 'function'); assert.equal(current.backend[key], methods[key]); }
    assert.equal(current.repository.database, current.database); assert.equal(current.repository.namespace, 'libra');
    assert.equal(current.repository.filePath, pinned.filePath); assert.equal(current.filePath, pinned.filePath); assert.equal(current.fixtureDir, pinned.fixtureDir);
    return storeWitness(current.fixtureDir, current.filePath);
  };
  check(input); return check;
}
// Database values are mapped without dropping space or replacing the original envelope.
function localRow(key, raw) { assert.ok(typeof key === 'string' && key.length > 0 && key.length <= LIMITS.keyChars, '568 row: local identity key'); return { owner: 'local', storeId: LOCAL_STORE, key, raw: encodeData(raw, { row: true }), revision: null }; }
function serverRow(record, stores) {
  record = copy(record);
  exactFields(record, ['space', 'key', 'value_json', 'deleted', 'revision', 'digest', 'updated_at'], 'server input fields');
  assert.ok(['plugin', 'local'].includes(record.space));
  assert.ok(typeof record.key === 'string' && record.key.length > 0 && record.key.length <= LIMITS.keyChars);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(record.key));
  assert.equal(record.deleted, 0); assert.ok(Number.isSafeInteger(record.revision) && record.revision > 0);
  assert.ok(validTimestamp(record.updated_at));
  assert.equal(typeof record.value_json, 'string');
  assert.equal(record.digest, sha256(record.value_json));
  assert.ok(record.value_json.length <= LIMITS.rowChars && Buffer.byteLength(record.value_json, 'utf8') <= LIMITS.envelopeBytes, '568 row: bounded original envelope');
  return { owner: 'server', storeId: stores.server.storeId, namespace: stores.server.namespace,
    space: record.space, key: record.key, raw: encodeData(JSON.parse(record.value_json), { row: true }), revision: record.revision,
    value_json: record.value_json, valueChars: record.value_json.length, valueBytes: Buffer.byteLength(record.value_json, 'utf8'),
    digest: record.digest, updated_at: record.updated_at, deleted: record.deleted };
}
const rowId = row => json(row.owner === 'local' ? [row.owner, row.storeId, row.key] : [row.owner, row.storeId, row.namespace, row.space, row.key]);
const compareRows = (a, b) => rowId(a) < rowId(b) ? -1 : rowId(a) > rowId(b) ? 1 : 0;
const canonicalAddress = row => row.owner === 'local' || (row.owner === 'server' && row.space === 'plugin');
function validateRows(rows, stores) {
  rows = copy(rows); stores = copy(stores);
  same(stores, storeWitness(stores.server.fixtureDir, stores.server.filePath), 'physical store/alias mapping');
  assert.ok(rows.length > 0 && rows.length <= LIMITS.rows, '568 row: row count');
  for (const row of rows) {
    assert.ok(['local', 'server'].includes(row.owner));
    assert.ok(typeof row.key === 'string' && row.key.length > 0 && row.key.length <= LIMITS.keyChars);
    assert.equal(row.storeId, row.owner === 'local' ? LOCAL_STORE : stores.server.storeId);
    if (row.owner === 'server') { assert.equal(row.namespace, 'libra'); assert.ok(['plugin', 'local'].includes(row.space)); }
  }
  assert.equal(new Set(rows.map(rowId)).size, rows.length, '568 row: full physical identity unique');
  same(rows.map(rowId), [...rows].sort(compareRows).map(rowId), 'deterministic full identity order');
  for (const row of rows) {
    encodeData(row.raw, { row: true });
    assert.ok(['local', 'server'].includes(row.owner));
    assert.ok(typeof row.key === 'string' && row.key.length > 0 && row.key.length <= LIMITS.keyChars);
    if (row.owner === 'local') {
      exactFields(row, ['owner', 'storeId', 'key', 'raw', 'revision'], 'local fields');
      assert.equal(row.storeId, LOCAL_STORE); assert.equal(row.revision, null);
    } else {
      exactFields(row, ['owner', 'storeId', 'namespace', 'space', 'key', 'raw', 'revision', 'value_json', 'valueChars', 'valueBytes', 'digest', 'updated_at', 'deleted'], 'server fields');
      assert.equal(row.storeId, stores.server.storeId); assert.equal(row.namespace, 'libra'); assert.ok(['plugin', 'local'].includes(row.space));
      assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(row.key));
      assert.ok(Number.isSafeInteger(row.revision) && row.revision > 0);
      assert.ok(validTimestamp(row.updated_at)); assert.equal(row.deleted, 0);
      assert.equal(typeof row.value_json, 'string'); assert.ok(row.value_json.length <= LIMITS.rowChars);
      assert.equal(row.valueChars, row.value_json.length); assert.equal(row.valueBytes, Buffer.byteLength(row.value_json, 'utf8'));
      assert.ok(row.valueBytes <= LIMITS.envelopeBytes); assert.equal(row.digest, sha256(row.value_json));
      same(row.raw, copy(JSON.parse(row.value_json)), 'raw interpretation of retained original envelope');
    }
  }
  return rows;
}
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
const parsed = row => { if (typeof row.raw !== 'string') return null; let value; try { value = JSON.parse(row.raw); } catch { return null; } return copy(value); };
const ownersFor = mode => mode === 'plugin_only' ? ['local'] : mode === 'server_only' ? ['server'] : ['local', 'server'];
const terminalEmbedding = () => ({ status: 'disabled', reason: 'API Key', projectionVersion: VERSION, vectorCount: 0 });
function exactRows(w, key) {
  const rows = w.rows.filter(row => canonicalAddress(row) && row.key === key);
  same(rows.map(row => row.owner).sort(), ownersFor(w.mode), `exact owners for ${key}`);
  assert.ok(rows.length > 0);
  for (const row of rows) { assert.equal(typeof row.raw, 'string', '568 witness: exact Canonical address holds a string'); assert.equal(row.raw, rows[0].raw, '568 witness: physical copies are byte-identical'); }
  return rows;
}
// Host identity is derived only from constrained fixture input and the physical
// seeded registry. Receipt/raw/lineage outputs never supply its expectation.
const deriveHostWorldlineId = ({ characterId, chatId, scopeKey }) => {
  const parts = [characterId, chatId, scopeKey];
  return 'wl_' + digest(['host-worldline-a', ...parts]).split(':')[0]
    + digest(['host-worldline-b', ...parts]).split(':')[0];
};
function fixtureIdentity(w) {
  const source = w.source;
  assert.equal(source.characterId, FIXTURE_IDENTITY.characterId);
  assert.equal(source.characterAlias, FIXTURE_IDENTITY.characterId);
  assert.equal(source.chat.id, FIXTURE_IDENTITY.chatId);
  assert.equal(source.chat.chatId, FIXTURE_IDENTITY.chatId);
  assert.equal(source.chatPage, 0);
  same(source.characterChatIds, [{ id: FIXTURE_IDENTITY.chatId, chatId: FIXTURE_IDENTITY.chatId }], 'independent fixture chat inventory');
  for (const message of source.chat.message) {
    assert.ok(!Object.hasOwn(message, 'msg'), '568 witness: direct fixture source rows');
    assert.notEqual(message.isComment, true, '568 witness: no native branch marker/comment input');
    assert.notEqual(message.disabled, true, '568 witness: no disabled native branch marker input');
  }
  const localRegistry = w.rows.filter(row => row.owner === 'local' && row.key === SCOPE_REGISTRY_KEY);
  assert.equal(localRegistry.length, 1, '568 witness: exact physical local scope registry anchor');
  const registry = parsed(localRegistry[0]);
  const registryId = `${source.characterId}::${source.chat.id}`;
  const expected = { [registryId]: { scopeKey: FIXTURE_IDENTITY.scopeKey,
    characterId: FIXTURE_IDENTITY.characterId, chatId: FIXTURE_IDENTITY.chatId,
    source: 'preexisting_explicit_user_scope' } };
  same(registry, expected, 'unchanged exact fixture-seeded scope mapping');
  for (const row of w.rows.filter(row => canonicalAddress(row) && row.key === SCOPE_REGISTRY_KEY)) assert.equal(row.raw, localRegistry[0].raw, '568 witness: registry copies agree with independent local anchor');
  const identity = { characterId: source.characterId, chatId: source.chat.id, scopeKey: registry[registryId].scopeKey };
  return { ...identity, hostWorldlineId: deriveHostWorldlineId(identity), logicalWorldlineId: LOGICAL_WORLDLINE };
}
function verifyHostMeta(meta, identity) {
  assert.equal(meta.schema, 'libra.worldline_meta.v1');
  assert.equal(meta.scopeKey, identity.scopeKey);
  assert.equal(meta.worldlineId, identity.hostWorldlineId);
  assert.match(meta.worldlineId, /^wl_[a-f0-9]{16}$/);
  assert.equal(meta.parentWorldlineId, ''); assert.equal(meta.forkTurn, 0); assert.equal(meta.forkFingerprint, '');
  assert.ok(Number.isFinite(Date.parse(meta.createdAt)));
}
function physical(w) {
  w = copy(w);
  assert.ok(['plugin_only', 'mirror', 'server_only'].includes(w.mode));
  validateRows(w.rows, w.stores);
  for (const row of w.rows) {
    assert.ok(!/unified-vector-tx:|:vector:/.test(row.key), '568 witness: no vector/transaction residue, including orphan owners');
    const value = typeof row.raw === 'string' ? parsed(row) : row.raw;
    assert.notEqual(value?.schema, 'libra.micro_work.v1', '568 witness: no structured or textual synthetic Micro work');
    assert.notEqual(value?.schema, 'libra.unified_server_vector_tx.v1', '568 witness: no concealed structured transaction');
    assert.notEqual(value?.schema, 'libra.embedding_projection.v2', '568 witness: no concealed structured vector projection');
  }
  exactFields(w.clock, ['startedAt', 'endedAt'], 'capture clock fields');
  for (const value of Object.values(w.clock)) assert.ok(validTimestamp(value));
  assert.ok(w.clock.startedAt <= w.clock.endedAt);
  for (const row of w.rows) if (row.owner === 'server') assert.ok(row.updated_at <= w.clock.endedAt, '568 witness: no future server timestamp');
  assert.ok(Array.isArray(w.calls));
  assert.equal(w.calls.length, 0, '568 witness: restarted provider is still silent');
  assert.ok(Array.isArray(w.requests) && w.requests.length <= LIMITS.requests);
  const origin = new URL(w.origin);
  assert.equal(origin.origin, w.origin);
  assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(origin.port && !origin.username && !origin.password);
  for (const request of w.requests) assert.equal(new URL(request.url).origin, w.origin, '568 witness: no external traffic');
  same(w.sourceHashes, SOURCE_HASHES, 'pinned product and fixture file hashes');
  const identity = fixtureIdentity(w), hostWorldlineId = identity.hostWorldlineId;
  const manifests = w.rows.filter(row => canonicalAddress(row) && row.key.endsWith(':manifest'));
  assert.equal(new Set(manifests.map(row => row.key)).size, 1, '568 witness: exactly one current scope');
  const manifestKey = manifests[0]?.key;
  const manifest = parsed(exactRows(w, manifestKey)[0]);
  assert.equal(manifest.schema, 'libra.manifest.v1');
  assert.equal(manifest.scopeKey, identity.scopeKey);
  assert.equal(manifest.characterId, identity.characterId); assert.equal(manifest.chatId, identity.chatId);
  verifyHostMeta(manifest.worldlineMeta, identity);
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
  for (const row of w.rows) {
    const value = typeof row.raw === 'string' ? parsed(row) : row.raw;
    if (value?.schema === 'libra.canonical_memory.v1') assert.ok(canonicalAddress(row)
      && typeof row.raw === 'string' && row.key === ref.key, '568 witness: no concealed additional Canonical target');
  }
  const memories = w.rows.filter(row => canonicalAddress(row) && /:memory:\d+:/.test(row.key));
  assert.equal(new Set(memories.map(row => row.key)).size, 1, '568 witness: no extra memory target');
  assert.equal(ref.key, prefix + `memory:1:r${ref.revision}`);
  const memory = parsed(exactRows(w, ref.key)[0]);
  assert.equal(memory.schema, 'libra.canonical_memory.v1');
  assert.equal(memory.scopeKey, manifest.scopeKey);
  assert.equal(memory.artifactSchema, 'libra.canonical_artifact.v4');
  assert.equal(memory.canonicalArtifact?.schema, memory.artifactSchema);
  assert.equal(memory.status, 'committed'); assert.equal(memory.worldlineId, LOGICAL_WORLDLINE);
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
  assert.equal(head.worldlineId, LOGICAL_WORLDLINE); assert.equal(head.throughSessionEpoch, 0);
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
  assert.equal(binding.identity, branchDigest(json([manifest.scopeKey, LOGICAL_WORLDLINE, Array.from({ length: 5 }, (_, i) => [messages[i * 2].chatId, messages[i * 2 + 1].chatId])])));
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
      ['libra.completed_turn_raw_ref.v1', 'SHA-256', manifest.scopeKey, hostWorldlineId, 0, turn], 'exact consumed raw binding');
    assert.equal(rawRef.originRelation, 'current_original_capture');
    assert.equal(rawRef.sourceDigest, digest([pairs[i]]));
    const receiptKey = prefix + `source-receipt:${hostWorldlineId}:e0:t${turn}:${rawRef.sourceRevisionId}`;
    const captureKey = prefix + `source-receipt-capture:${hostWorldlineId}:e0:t${turn}:${rawRef.sourceRevisionId}`;
    assert.ok([receiptKey, captureKey].includes(rawRef.storageKey));
    const receipt = parsed(exactRows(w, receiptKey)[0]);
    const receiptHeadKey = prefix + `source-receipt-head:${hostWorldlineId}:e0:t${turn}`;
    const receiptHead = parsed(exactRows(w, receiptHeadKey)[0]);
    assert.equal(receiptHead.schema, 'libra.completed_turn_head.v1'); assert.equal(receiptHead.receiptKey, receiptKey);
    assert.equal(receipt.schema, 'libra.completed_turn_receipt.v1');
    const receiptIdentity = { turn, ...Object.fromEntries(['user', 'assistant'].map(role => [role, {
      chatIds: receipt[role].chatIds, text: receipt[role].text,
      rawPayloadDigests: receipt[role].rawPayloadDigests, sanitizedTextDigests: receipt[role].sanitizedTextDigests
    }])) };
    assert.equal(rawRef.sourceRevisionId, digest(receiptIdentity).replace(/[^a-z0-9]/gi, ''));
    for (const record of [receipt, receiptHead]) same([record.scopeKey, record.worldlineId, record.sessionEpoch, record.turn, record.revisionId, record.sourceDigest],
      [manifest.scopeKey, hostWorldlineId, 0, turn, rawRef.sourceRevisionId, rawRef.sourceDigest], 'receipt/head binding');
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
    same(packet.origin, { scopeKey: manifest.scopeKey, worldlineId: hostWorldlineId, sessionEpoch: 0, turn,
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
  return { manifestKey, manifest, memory, ref, prefix, receipts, identity };
}
function verifyPublic(w, evidence) {
  w = copy(w); evidence = copy(evidence);
  const ctx = physical(w), status = evidence.recovery;
  const lineage = evidence.lineage, identity = ctx.identity;
  for (const [key, value] of Object.entries({ schema: 'librarian.host_lineage.v1', hostVersion: '2026.8.250',
    owner: 'libra', characterId: identity.characterId, hostChatId: identity.chatId, scopeKey: identity.scopeKey,
    kind: 'independent_chat', status: 'independent', reason: 'no_native_branch_marker', pathVerified: true,
    inheritanceEligible: false, parentChatId: '', parentName: '', forkMessageId: '', markerIndex: -1,
    forkMessageIndex: -2, commonPrefixMessages: 0, commonPrefixPairs: 0, canonicalPrefixEnd: 0,
    partialCanonicalPairs: 0, prefixDigest: '' })) same(lineage[key], value, `independent public lineage ${key}`);
  same(lineage.path, [identity.chatId], 'independent public lineage path');
  verifyHostMeta(lineage.worldlineMeta, identity);
  same(lineage.worldlineMeta, ctx.manifest.worldlineMeta, 'public lineage corroborates protected host metadata');
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
    same([stage.identity.scopeKey, stage.identity.worldlineId, stage.identity.sessionEpoch, stage.identity.turn], [ctx.memory.scopeKey, identity.hostWorldlineId, 0, i + 1], 'public receipt scope/worldline/epoch');
    same(stage.identity.userChatIds, expected.receipt.user.chatIds, 'public receipt user IDs'); same(stage.identity.assistantChatIds, expected.receipt.assistant.chatIds, 'public receipt assistant IDs');
    assert.equal(stage.scopeKey, ctx.memory.scopeKey); assert.equal(stage.identity.revisionId, expected.receipt.revisionId); assert.equal(stage.identity.sourceDigest, expected.receipt.sourceDigest);
    assert.equal(micro.turn, i + 1); assert.equal(micro.scopeKey, stage.scopeKey); assert.equal(micro.receiptRef, stage.receiptRef);
    assert.equal(micro.revisionId, stage.identity.revisionId); assert.equal(micro.sourceDigest, stage.identity.sourceDigest);
    assert.equal(micro.status, 'unknown'); assert.equal(micro.physicalAttemptsUsed, 0); assert.equal(micro.logicalAttempts, 0);
    assert.equal(micro.attemptId, ''); same(micro.history, [], 'no automatic Micro history');
  }
}
function verifySettings(settings) {
  settings = copy(settings);
  assert.equal(settings.enabled, true); assert.equal(settings.key, '');
  assert.equal(settings.provider, 'voyageai'); assert.equal(settings.url, 'https://api.voyageai.com/v1/embeddings');
  assert.equal(settings.model, 'voyage-4-lite'); assert.equal(settings.fallback, null);
}
function verifySettingsPair(before, after) { verifySettings(before); verifySettings(after); same(after, before, 'entire offline embedding settings unchanged'); }
function verifyTransition(before, after, terminal = false) {
  before = copy(before); after = copy(after);
  const a = physical(before), b = physical(after);
  same(after.stores, before.stores, 'stable physical stores and aliases');
  assert.ok(after.clock.startedAt >= before.clock.endedAt, '568 witness: ordered capture intervals');
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
    if (!changed || !canonicalAddress(old) || ![a.ref.key, a.manifestKey].includes(old.key)) { same(next, old, 'protected raw bytes and physical revision'); continue; }
    const expected = parsed(old), actual = parsed(next);
    assert.equal(old.raw, json(expected), '568 witness: mutable owner starts in exact product JSON serialization');
    same(Object.keys(actual), Object.keys(expected), 'derived update keeps memory/manifest field order');
    if (old.key === a.ref.key) expected.embedding = terminalEmbedding();
    else {
      const nextStamp = actual.memories['1'].updatedAt;
      assert.ok(sourceIso(nextStamp) && Date.parse(nextStamp) >= Date.parse(expected.memories['1'].updatedAt));
      expected.memories['1'].embeddingStatus = 'disabled';
      expected.memories['1'].updatedAt = nextStamp;
      if (before.mode === 'plugin_only') {
        assert.ok(Date.parse(nextStamp) >= before.clock.endedAt, '568 witness: plugin ref update follows pending capture');
        assert.ok(sourceIso(actual.updatedAt) && Date.parse(actual.updatedAt) >= Date.parse(expected.updatedAt));
        assert.ok(Date.parse(actual.updatedAt) >= Date.parse(nextStamp) && Date.parse(actual.updatedAt) <= after.clock.startedAt, '568 witness: plugin save follows ref update inside interval');
        expected.updatedAt = actual.updatedAt;
      }
    }
    assert.equal(next.raw, json(expected), '568 witness: exact source-justified preparation raw transformation');
    const expectedRow = copy(old); expectedRow.raw = json(expected);
    if (old.owner === 'server') {
      expectedRow.revision = old.revision + 1;
      expectedRow.value_json = json(expectedRow.raw);
      expectedRow.valueChars = expectedRow.value_json.length; expectedRow.valueBytes = Buffer.byteLength(expectedRow.value_json, 'utf8');
      expectedRow.digest = sha256(expectedRow.value_json);
      assert.ok(next.updated_at >= old.updated_at && next.updated_at >= before.clock.endedAt
        && next.updated_at <= after.clock.startedAt, '568 witness: source commit timestamp inside protected interval');
      if (old.key === a.manifestKey) assert.ok(next.updated_at >= Date.parse(actual.memories['1'].updatedAt), '568 witness: server commit follows ref timestamp');
      expectedRow.updated_at = next.updated_at;
    }
    same(next, expectedRow, 'exact derived raw/envelope/identity/revision/metadata transform');
  }
  if (changed && before.mode !== 'plugin_only') {
    const writes = after.rows.filter(row => row.owner === 'server' && canonicalAddress(row) && [a.ref.key, a.manifestKey].includes(row.key));
    assert.equal(writes.length, 2); assert.equal(new Set(writes.map(row => row.updated_at)).size, 1, '568 witness: one batch commit timestamp');
  }
  if (terminal) { same(b.memory.embedding, terminalEmbedding(), 'final terminal row'); assert.equal(b.ref.embeddingStatus, 'disabled'); }
  return { before: a, after: b, changed };
}
function unwrapQueueOutcome(outcome) {
  if (Object.hasOwn(outcome, 'error')) throw outcome.error;
  return outcome.value;
}
function verifyQueue(result, before, after, admission = before) {
  result = copy(result);
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
  return freezeCopy(exactRows(w, ctx.ref.key));
}
function assertOldRows(baseline, rows) {
  baseline = copy(baseline); rows = copy(rows);
  assert.ok(Array.isArray(baseline) && baseline.length >= 1 && baseline.length <= 2, '568 witness: nonempty settled old record baseline');
  assert.equal(new Set(baseline.map(rowId)).size, baseline.length);
  assert.equal(new Set(baseline.map(row => row.key)).size, 1);
  same(rows.filter(row => canonicalAddress(row) && row.key === baseline[0].key).map(rowId).sort(), baseline.map(rowId).sort(), 'post-v5 exact old owner set');
  for (const old of baseline) {
    const current = rows.filter(row => rowId(row) === rowId(old)); assert.equal(current.length, 1);
    same(current[0], old, 'strict whole-old-record raw bytes/key/owner/revision after new v5 write');
  }
}
// Current candidate pin refreshed for reviewed Micro/canonical/response admission fixes; the logical witness is unchanged.
// Prior queue-recovery candidate: de627d1b971635fe8eb1c233e73550ab965f13759a0ef4afbe74898a3b096a69.
// Prior dispatch-only candidate: d2a16b862dafad18e0f8dd14f6ac5356173dcaca222ae8d484190ca765f659b6.
// Historical product pin ea6e638bef18340126b23a246efcf56457bb16d0bb0b9ee0bce014b931d2f180 remains in the frozen baseline receipts.
const SOURCE_HASHES = Object.freeze({
  "PROGRAM/plugins/LIBRA.js": "4b2335890dcb5f55c68edaf1312da952c0297c68048a7fdb3ab91579543c7753",
  "PROGRAM/tests/fixtures/libra_server_runtime_fixture.cjs": "58dde9f825010ed764ed42492fb3f7afeb3d60b67ed0a01b437727498e8fa7dd",
  "PROGRAM/tests/fixtures/libra_unified_runtime_fixture.cjs": "168e6a402eea9981aadceca84bdfdd80fc887d1b2d1914c1e402cffd4b3f2a52",
  "PROGRAM/tests/fixtures/libra_vm_harness.cjs": "c0d619b8bb0beedb68d61168458200af7a8aa10a8e3ce33eeb8121c1c9150100",
  "PROGRAM/tests/fixtures/unified_vertical_source.json": "09f5ee4a717cb786d2c8d54f5562eb6801f5ee4c4e6c14bcaf3043fbce560ecb",
  "PROGRAM/sdk/MemorySuiteStorageClient.libra.source.js": "af3349dbcb14bb59c92792b68ba49965cd599333343a172ecf0de8132ac91517",
  "PROGRAM/server/server.cjs": "3b6f11cb7469ed10e7beb61d5ca8a3757566da82387447fc44d8ec2719b2b132"
});
module.exports = { VERSION, LIMITS, SOURCE_HASHES, LOCAL_STORE, LOCAL_ALIASES, encodeData, freezeCopy, typedText, storeWitness, bindingGuard, localRow, serverRow, rowId, compareRows, validateRows, canonicalAddress, LOGICAL_WORLDLINE, SCOPE_REGISTRY_KEY, FIXTURE_IDENTITY, deriveHostWorldlineId, copy, digest, evidenceDigest, branchDigest, sha256, terminalEmbedding,
  physical, verifyPublic, verifySettings, verifySettingsPair, verifyTransition, unwrapQueueOutcome, verifyQueue, oldRows, assertOldRows };
