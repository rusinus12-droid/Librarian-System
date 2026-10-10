'use strict';

// This table is deliberately separate from user KV and survives scope deletion.
// A fence is checked inside the SAME SQLite transaction as every protected write.
const aliasForKey = key => String(key || '').match(/^vector_rag_memory:(?:scope:|local-vector-shard:v1:)([A-Za-z0-9_-]{1,128}):/)?.[1] || '';
const fail = code => { throw Object.assign(new Error(code), { statusCode: 409 }); };
function createFlashbackWriterFence(database, namespace, transaction = null) {
  if (namespace !== 'flashback') return { command() { fail('flashback_writer_namespace_required'); }, verify() {} };
  database.exec(`CREATE TABLE IF NOT EXISTS flashback_writer_fences (
    alias TEXT PRIMARY KEY, epoch INTEGER NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`);
  const prepare = transaction?.prepare || (sql => database.prepare(sql));
  const read = prepare('SELECT * FROM flashback_writer_fences WHERE alias=?');
  const write = prepare('INSERT INTO flashback_writer_fences(alias,epoch,owner,expires_at) VALUES(?,?,?,?) ON CONFLICT(alias) DO UPDATE SET epoch=excluded.epoch,owner=excluded.owner,expires_at=excluded.expires_at');
  const command = input => {
    const alias = aliasForKey(input?.key);
    const owner = String(input?.owner || '');
    if (!alias || !/^[A-Za-z0-9._:-]{16,240}$/.test(owner) || !['acquire','renew','release'].includes(input?.action)) {
      throw Object.assign(new Error('invalid_flashback_writer_command'), { statusCode: 400 });
    }
    const body = () => {
      const row = read.get(alias), at = Date.now();
      let epoch = Number(row?.epoch || 0), expiresAt = at + 120000;
      if (input.action === 'acquire') {
        if (row?.owner && row.expires_at > at && row.owner !== owner) fail('FLASHBACK_WRITER_BUSY');
        if (!row || row.owner !== owner || row.expires_at <= at) epoch += 1;
      } else {
        if (!row || row.owner !== owner || epoch !== input.epoch) fail('FLASHBACK_WRITER_FENCED');
        if (input.action === 'renew' && row.expires_at <= at) fail('FLASHBACK_WRITER_EXPIRED');
        if (input.action === 'release') expiresAt = 0;
      }
      write.run(alias, epoch, input.action === 'release' ? '' : owner, expiresAt);
      return { schema:'flashback.writer-fence.v1', alias, owner, epoch, expiresAt };
    };
    if (transaction?.runTransaction) return transaction.runTransaction(input,body);
    database.exec('BEGIN IMMEDIATE');
    try { const result = body(); database.exec('COMMIT'); return result; }
    catch (error) { try { database.exec('ROLLBACK'); } catch (_) {} throw error; }
  };
  const verify = (key, fence, maintenance = false) => {
    const alias = aliasForKey(key);
    if (!alias) return;
    const row = read.get(alias);
    // Existing installations remain readable/migratable; first new writer
    // permanently activates protection before it reads or changes the corpus.
    if (!row) return;
    if (maintenance) {
      if (row.owner && row.expires_at > Date.now()) fail('FLASHBACK_WRITER_BUSY');
      return;
    }
    if (!fence || fence.alias !== alias || fence.epoch !== Number(row.epoch)
      || !row.owner || fence.owner !== row.owner) fail('FLASHBACK_WRITER_FENCED');
    if (row.expires_at <= Date.now()) fail('FLASHBACK_WRITER_EXPIRED');
  };
  return { command, verify };
}
module.exports = { createFlashbackWriterFence, aliasForKey };
