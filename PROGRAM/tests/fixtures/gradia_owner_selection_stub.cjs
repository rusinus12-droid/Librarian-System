'use strict';
// Running HAYAKU and Flashback as GRADIA sees them over the plugin channel: they choose their own memory.
const crypto = require('node:crypto');
const create = require('../../tools/gradia_plugin_read.cjs');
const ids = { libra: 'libra', hayaku: 'hayaku_locator_continuity', flashback: 'flashback_memory' };
const primitives = { fingerprint: value => crypto.createHash('sha256').update(value).digest('hex'), byteLength: value => Buffer.byteLength(value) };
module.exports = async function startOwnerSelections(bus, owners, options = {}) {
  const running = [];
  for (const [owner, { scope, content, selectError = '', delayMs = 0, onQuery }] of Object.entries(owners)) {
    const stub = create({ role: 'owner', owner, api: bus.api(ids[owner]), primitives,
      boundary: async () => {
        if (options.isMutated?.(owner)) throw Object.assign(new Error('LIB_READ_BOUNDARY_CHANGED'), { code: 'LIB_READ_BOUNDARY_CHANGED' });
        return { scope, mode: 'server_only' };
      },
      capture: async () => { throw new Error('server mode reads through the server'); },
      select: async () => {
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        await onQuery?.();
        if (options.isMutated?.(owner)) throw Object.assign(new Error('LIB_READ_BOUNDARY_CHANGED'), { code: 'LIB_READ_BOUNDARY_CHANGED' });
        if (selectError) throw Object.assign(new Error(selectError), { code: selectError });
        return { content };
      } });
    await stub.start();
    running.push(stub);
  }
  return async () => { for (const stub of running) await stub.dispose(); };
};
