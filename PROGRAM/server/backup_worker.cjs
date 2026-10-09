'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

const sqlString = value => `'${String(value).replace(/'/g, "''")}'`;

const sha256File = filePath => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
};

const snapshot = task => {
  const source = new DatabaseSync(task.sourcePath, { readOnly: true });
  try {
    source.exec('PRAGMA busy_timeout=5000;');
    source.exec(`VACUUM INTO ${sqlString(task.targetPath)};`);
  } finally {
    source.close();
  }

  const target = new DatabaseSync(task.targetPath, { readOnly: true });
  try {
    const integrity = String(target.prepare('PRAGMA integrity_check;').get()?.integrity_check || 'unknown');
    if (integrity !== 'ok') throw new Error(`backup_integrity_failed:${task.namespace}:${integrity}`);
    const records = Number(target.prepare('SELECT COUNT(*) AS count FROM kv').get()?.count || 0);
    const liveRecords = Number(target.prepare('SELECT COUNT(*) AS count FROM kv WHERE deleted = 0').get()?.count || 0);
    const tombstones = Number(target.prepare('SELECT COUNT(*) AS count FROM kv WHERE deleted = 1').get()?.count || 0);
    return {
      file: task.file,
      sha256: sha256File(task.targetPath),
      bytes: fs.statSync(task.targetPath).size,
      records,
      liveRecords,
      tombstones
    };
  } finally {
    target.close();
  }
};

try {
  const stores = {};
  for (const task of Array.isArray(workerData?.tasks) ? workerData.tasks : []) {
    stores[task.namespace] = snapshot(task);
  }
  parentPort.postMessage({ ok: true, stores });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.stack || error) });
  process.exitCode = 1;
}
