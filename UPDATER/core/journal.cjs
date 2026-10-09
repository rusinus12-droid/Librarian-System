'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 'librarian.update-state.v1';
const TERMINAL = new Set(['complete','rolled_back','aborted']);

// Unsupported directory fsync is tolerated only on platforms/filesystems that
// explicitly reject it. I/O errors must not be reported as durable success.
async function syncDirectory(directory) {
  let handle;
  try { handle = await fsp.open(directory, 'r'); await handle.sync(); }
  catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];
    if (process.platform === 'win32') unsupported.push('EPERM', 'EACCES', 'EISDIR', 'EBADF');
    if (!unsupported.includes(error.code)) throw error;
  } finally { if (handle) await handle.close(); }
}

async function atomicWriteJson(filePath, value) {
  const target = path.resolve(filePath);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  let handle = null;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fsp.rename(temp, target);
    await syncDirectory(path.dirname(target));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

function readJournal(filePath) {
  const target = path.resolve(filePath);
  if (!fs.existsSync(target)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) { throw new Error(`update_journal_invalid_json:${error?.message || error}`); }
  if (parsed?.schema !== SCHEMA) throw new Error('update_journal_schema_invalid');
  return parsed;
}

async function writeJournal(filePath, previous, patch = {}) {
  const next = {
    ...(previous || {}),
    ...patch,
    schema: SCHEMA,
    updatedAt: new Date().toISOString()
  };
  await atomicWriteJson(filePath, next);
  return next;
}

function isTerminal(journal) {
  return !journal || TERMINAL.has(String(journal.status || ''));
}

module.exports = { SCHEMA, TERMINAL, atomicWriteJson, readJournal, writeJournal, isTerminal, syncDirectory };
