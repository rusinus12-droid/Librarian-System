'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

// SQLite's OS-backed exclusive lock is released when the owner dies, including
// SIGKILL. A PID-file lease would need a racy stale-owner unlink operation.
// This database is updater metadata, never an application DATA database.
async function withUpdateLock(rootDir, action) {
  const root = fs.realpathSync.native(path.resolve(rootDir));
  const inherited = context.getStore();
  if (inherited?.root === root && inherited.active) return action();
  const updater = path.join(root,'UPDATER');
  fs.mkdirSync(updater,{recursive:true,mode:0o700});
  if (fs.lstatSync(updater).isSymbolicLink()) throw new Error('updater_lock_directory_symlink_rejected');
  const target = path.join(updater,'operation-lock.sqlite');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('updater_lock_symlink_rejected');
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(target);
    fs.chmodSync(target,0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (error) {
    try { db?.close(); } catch (_) {}
    if ([5,6].includes(error.errcode) || /locked|busy/i.test(String(error.message))) {
      throw Object.assign(new Error('updater_already_running'),{code:'UPDATER_ALREADY_RUNNING'});
    }
    throw error;
  }
  const lease = {root,active:true};
  try { return await context.run(lease,action); }
  finally {
    lease.active=false;
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  }
}
module.exports={withUpdateLock};
