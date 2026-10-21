'use strict';
// Any LIBRA storage write revokes the issued Compiler read sets (by design: the Classic hook then
// falls back to the base request). After a publication, background owner writes may still be in
// flight, so a test that asserts a delivered packet must first wait for the storage to go quiet.
const signature = fx => {
  let local = 0;
  for (const [key, value] of fx.local) local += key.length + String(value ?? '').length;
  let server = 0;
  for (const row of fx.storedRows()) server += Number(row.revision || 0) + row.key.length;
  return `${fx.local.size}:${local}:${fx.storedRows().length}:${server}`;
};
async function settleStorage(fx, {quietMs = 600, timeoutMs = 15000} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = signature(fx), since = Date.now();
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const now = signature(fx);
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return true;
  }
  throw new Error('storage did not become quiet');
}
module.exports = {settleStorage};
