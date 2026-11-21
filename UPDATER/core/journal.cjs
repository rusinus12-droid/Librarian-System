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

// Windows refuses a rename while another handle (antivirus, indexer, a reader that has not
// closed yet) is open on the destination, and reports it as EPERM/EACCES/EBUSY. The write is
// already durable in the temp file, so a bounded retry turns that transient refusal into the
// rename that was intended. Other platforms keep failing fast: there EPERM means permission.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameWithRetry(from, to, options = {}) {
  const platform = options.platform || process.platform;
  const rename = options.rename || fsp.rename;
  const attempts = options.attempts || 6;
  const baseDelayMs = options.baseDelayMs === undefined ? 20 : options.baseDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try { return await rename(from, to); }
    catch (error) {
      const transient = platform === 'win32' && TRANSIENT_RENAME_CODES.has(String(error?.code || ''));
      if (!transient || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
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
    await renameWithRetry(temp, target);
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

module.exports = { SCHEMA, TERMINAL, atomicWriteJson, readJournal, writeJournal, isTerminal, syncDirectory, renameWithRetry };
