'use strict';
// The LIBRA owner's unified read, shaped exactly as the storage SDK's unified source expects it.
//
// GRADIA's LIBRA read is served by the owner's unified engine now, not by the server's logical read, so
// fixtures that used to stand up a server read must hand the SDK a provider instead. This one serves the
// same memory-suite.libra-read-session.v1 envelope the consumer validates, from evidence the fixture
// owns, and reports its own currentness so a replaced source still retires the bound draft.
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

module.exports = function createOwnerUnifiedReadProvider(options = {}) {
  const scope = options.scope;
  // The accepted connection decides these, and it is only known after bootstrap, so they resolve per call.
  const resolve = (value, fallback) => async () => { const raw = typeof value === 'function' ? await value() : value; return raw === undefined || raw === null ? fallback : raw; };
  const dataInstanceIdOf = resolve(options.dataInstanceId, 'A'.repeat(32));
  const resetEpochOf = resolve(options.resetEpoch, 0);
  const revisionOf = () => (typeof options.revision === 'function' ? options.revision() : Number(options.revision || 1));

  const selection = () => {
    const rows = (typeof options.items === 'function' ? options.items() : options.items) || [];
    const items = rows.map(row => ({
      id: String(row.id), key: String(row.key), content: String(row.content),
      source: { revision: Number(row.revision || 1), sourceDigest: digest(String(row.content)), turnRange: row.turnRange || { start: 1, end: 1 } }
    }));
    const corpusBytes = items.reduce((total, item) => total + Buffer.byteLength(item.content), 0);
    const evidenceRevision = digest(JSON.stringify([scope, revisionOf(), items.map(item => [item.key, item.source.sourceDigest])]));
    return { items, corpusBytes, evidenceRevision };
  };

  return Object.freeze({
    capture: async request => {
      const asked = request?.scope;
      if (asked && JSON.stringify(asked) !== JSON.stringify(scope)) {
        throw Object.assign(new Error('owner scope mismatch'), { code: 'LIB_READ_SCOPE_UNVERIFIED' });
      }
      const { items, corpusBytes, evidenceRevision } = selection();
      const dataInstanceId = String(await dataInstanceIdOf()), resetEpoch = Number(await resetEpochOf());
      return {
        schema: 'memory-suite.libra-read-session.v1', scope, readOnly: true, complete: true, items, dependencies: [],
        evidenceRevision, corpusBytes, maxCorpusBytes: Number(request?.maxCorpusBytes ?? options.maxCorpusBytes ?? 4194304),
        dataInstanceId, resetEpoch, readIdentity: { scope, dataInstanceId, resetEpoch }
      };
    },
    current: async request => {
      const { evidenceRevision } = selection();
      const verified = typeof options.verify === 'function' ? await options.verify() : true;
      return {
        schema: 'memory-suite.libra-read-session-current.v1',
        current: verified === true && evidenceRevision === request?.proof?.evidenceRevision,
        scope, evidenceRevision, dataInstanceId: String(await dataInstanceIdOf()), resetEpoch: Number(await resetEpochOf())
      };
    }
  });
};
