'use strict';
// Windows reports "another handle has the file open" as EPERM/EACCES/EBUSY on rename. The journal
// write is already durable in its temp file at that point, so the updater retries briefly instead
// of surfacing a failed update. These tests pin both halves: the retry on win32 and the fast fail
// everywhere else (where EPERM means a real permission problem).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { renameWithRetry, atomicWriteJson, readJournal, SCHEMA } = require('../../UPDATER/core/journal.cjs');

function codedError(code) {
  const error = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

function countingRename(failures, code) {
  const calls = { count: 0 };
  calls.rename = async (from, to) => {
    calls.count += 1;
    if (calls.count <= failures) throw codedError(code);
    return fs.promises.rename(from, to);
  };
  return calls;
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-rename-retry-'));
  try {
    // 1. win32: a transient refusal is retried and the rename lands.
    const first = countingRename(2, 'EPERM');
    const from = path.join(dir, 'a.tmp');
    const to = path.join(dir, 'a.json');
    fs.writeFileSync(from, '{"ok":true}');
    await renameWithRetry(from, to, { rename: first.rename, platform: 'win32', baseDelayMs: 0 });
    assert.equal(first.count, 3, 'three attempts: two refusals then success');
    assert.equal(fs.readFileSync(to, 'utf8'), '{"ok":true}');
    assert.equal(fs.existsSync(from), false);

    // 2. win32: a non-transient code is not retried.
    const missing = countingRename(99, 'ENOENT');
    await assert.rejects(
      renameWithRetry(path.join(dir, 'nope.tmp'), path.join(dir, 'nope.json'), { rename: missing.rename, platform: 'win32', baseDelayMs: 0 }),
      /simulated ENOENT/
    );
    assert.equal(missing.count, 1);

    // 3. other platforms: EPERM is a real permission error and must surface immediately.
    const posix = countingRename(99, 'EPERM');
    await assert.rejects(
      renameWithRetry(path.join(dir, 'b.tmp'), path.join(dir, 'b.json'), { rename: posix.rename, platform: 'linux', baseDelayMs: 0 }),
      /simulated EPERM/
    );
    assert.equal(posix.count, 1);

    // 4. win32: a persistent refusal still fails after the bounded number of attempts.
    const stubborn = countingRename(99, 'EBUSY');
    await assert.rejects(
      renameWithRetry(path.join(dir, 'c.tmp'), path.join(dir, 'c.json'), { rename: stubborn.rename, platform: 'win32', attempts: 4, baseDelayMs: 0 }),
      /simulated EBUSY/
    );
    assert.equal(stubborn.count, 4);

    // 5. the journal path itself is wired through the retry: a real write still lands and parses.
    const journalPath = path.join(dir, 'UPDATER', 'update-state.json');
    await atomicWriteJson(journalPath, { schema: SCHEMA, status: 'staging' });
    assert.equal(readJournal(journalPath).status, 'staging');
    assert.deepEqual(fs.readdirSync(path.dirname(journalPath)), ['update-state.json'], 'temp file is gone');

    console.log('updater_journal_rename_retry_test: PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
