'use strict';
// A plugin-local raw reader for the same published source formats as the server
// logical readers. Metadata below is private content evidence, NOT a server
// revision/reset/transaction certificate. Re-read every dependency at each gate.
module.exports = function createPluginSnapshot(options) {
  const { fingerprint, byteLength } = options.primitives;
  const instance = 'plugin-local:' + Date.now() + ':' + Math.random();
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  return async (request, authority = {}) => {
    let reading = true, closed = false;
    const cache = new Map();
    let loadedBytes = 0;
    const rawLimit = 7 * request.maxCorpusBytes + 2097152;
    const get = async key => {
      authority.check?.();
      if (closed) fail('LIB_READ_STALE');
      if (reading && cache.has(key)) return cache.get(key);
      const value = await options.read(key);
      authority.check?.();
      if (closed) fail('LIB_READ_STALE');
      const serialized = JSON.stringify(value ?? null), size = byteLength(serialized);
      loadedBytes += size;
      if (loadedBytes > rawLimit) fail('LIB_READ_BUDGET_EXCEEDED');
      const row = { value: value ?? null, exists: value != null, tombstone: false,
        revision: 1, updatedAt: 0, digest: fingerprint(serialized), valueBytes: size };
      if (reading) cache.set(key, row);
      return row;
    };
    const repository = { database: { exec() {} }, getMetadata: async (_space, key) => await get(key),
      get: async (_space, key, limits) => {
        const row = await get(key);
        if (row.valueBytes > limits.maxValueBytes) fail('LIB_READ_BUDGET_EXCEEDED');
        return row;
      } };
    const session = options.createReadSession({ getRepository: () => repository, dataInstanceId: instance,
      epochs: () => ({}), canRead: () => !closed });
    const snapshot = await session.capture({ scope: request.scope, maxCorpusBytes: request.maxCorpusBytes });
    reading = false; cache.clear();
    let currentTail = Promise.resolve();
    return { items: snapshot.items,
      async assertCurrent() {
        const task = currentTail.then(async () => {
          loadedBytes = 0;
          if (closed) fail('LIB_READ_STALE');
          return (await session.current(snapshot)).current === true;
        });
        currentTail = task.catch(() => {});
        return await task;
      },
      close() { closed = true; cache.clear(); }
    };
  };
};
