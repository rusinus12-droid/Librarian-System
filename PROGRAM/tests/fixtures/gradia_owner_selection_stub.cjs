'use strict';
// Running HAYAKU and Flashback as GRADIA sees them over the plugin channel: they choose their own memory.
const crypto = require('node:crypto');
const create = require('../../tools/gradia_plugin_read.cjs');
const ids = { hayaku: 'hayaku_locator_continuity', flashback: 'flashback_memory' };
const primitives = { fingerprint: value => crypto.createHash('sha256').update(value).digest('hex'), byteLength: value => Buffer.byteLength(value) };
module.exports = async function startOwnerSelections(bus, owners) {
  const running = [];
  for (const [owner, { scope, content, finalDelivery = true }] of Object.entries(owners)) {
    const stub = create({ role: 'owner', owner, api: bus.api(ids[owner]), primitives,
      boundary: async () => ({ scope, mode: 'server_only' }), capture: async () => { throw new Error('server mode reads through the server'); },
      select: async () => ({ content, finalDelivery }) });
    await stub.start();
    running.push(stub);
  }
  return async () => { for (const stub of running) await stub.dispose(); };
};
