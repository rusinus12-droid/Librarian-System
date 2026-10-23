'use strict';
// Refusal-only logical read admission. This is not activation, writer ownership,
// a forensic SHM snapshot, or permission to perform a later mutation.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const OWNERS = Object.freeze(['libra','hayaku','flashback','lia','retrace']);
const MAX_COMPONENTS = 128;
function unavailable() {
  throw Object.assign(new Error('AUTHORITY_LIFECYCLE_UNAVAILABLE'), { code:'AUTHORITY_LIFECYCLE_UNAVAILABLE',statusCode:503 });
}
function unknown(reason = 'authority_evidence_unreadable') {
  return Object.assign(new Error('AUTHORITY_QUARANTINED: Cannot establish legacy-only storage; admission did not change protected files. Preserve DATA and use a separately reviewed recovery path.'), { code:'AUTHORITY_QUARANTINED',statusCode:503,reason });
}
function wrap(error) {
  if (['AUTHORITY_LIFECYCLE_UNAVAILABLE','AUTHORITY_QUARANTINED'].includes(error?.code)) return error;
  return unknown();
}
function stat(file) {
  try { return fs.lstatSync(file,{bigint:true}); }
  catch (e) { if (e.code === 'ENOENT') return null; throw unknown(); }
}
function same(a,b) {
  return !!a && !!b && ['dev','ino','mode','size','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
}
function sameDir(a,b) {
  return !!a && !!b && ['dev','ino','mode'].every(k => a[k] === b[k]);
}
function sameEntry(a,b) { return a === null ? b === null : same(a,b); }
function checkedPath(input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw unknown('authority_path_invalid');
  const raw = path.resolve(input);
  const full = (process.platform === 'darwin' && /^\/(?:var|tmp|etc)(?:\/|$)/.test(raw) && stat('/' + raw.split('/')[1])?.isSymbolicLink()) ? '/private' + raw : raw;
  const root = path.parse(full).root;
  const parts = full.slice(root.length).split(path.sep).filter(Boolean);
  if (parts.length > MAX_COMPONENTS) throw unknown('authority_path_depth');
  let current = root;
  for (let i=0;i<parts.length;i++) {
    current = path.join(current,parts[i]); const s = stat(current);
    if (!s) return full;
    if (s.isSymbolicLink() || (i < parts.length-1 && !s.isDirectory())) throw unknown('authority_path_type');
  }
  return full;
}
function regular(file) {
  const s = stat(checkedPath(file));
  if (s && !s.isFile()) throw unknown('authority_file_type');
  if (s && s.nlink !== 1n) throw unknown('authority_file_links');
  return s;
}
function assertNoAuthorityFilesystemEvidence(dataDir) {
  try {
    const root = checkedPath(dataDir), before = stat(root);
    if (!before) return;
    if (!before.isDirectory()) throw unknown('authority_root_type');
    const config = path.join(root,'config'), stores = path.join(root,'stores');
    for (const dir of [config,stores]) {
      const s = stat(checkedPath(dir));
      if (s && !s.isDirectory()) throw unknown('authority_directory_type');
    }
    if (stat(checkedPath(path.join(stores,'_authority')))) unavailable();
    if (stat(config)) {
      let dir;
      try {
        dir = fs.opendirSync(config); let entry, count=0;
        while ((entry=dir.readSync())) {
          if (++count > 256) throw unknown('authority_config_inventory_limit');
          if (entry.name.toLowerCase().startsWith('server-authority.json')) unavailable();
        }
      } finally { if (dir) dir.closeSync(); }
    }
    // Fixed protected paths only. This filesystem-only function does not prove
    // absence of orphan SQL objects and must not be used as root SQL admission.
    for (const n of OWNERS) for (const suffix of ['','-wal','-shm','-journal']) regular(path.join(stores,n,n+'.sqlite'+suffix));
    if (!sameDir(before,stat(root))) throw unknown('authority_path_changed');
  } catch (e) { throw wrap(e); }
}
function inspectDatabase(db) {
  if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE lower(name) GLOB 'authority_*' LIMIT 1").get()) unavailable();
  const version = db.prepare('PRAGMA main.user_version').get()?.user_version;
  if (!Number.isInteger(version) || version < 0) throw unknown('authority_schema_version_invalid');
  if (version > 1) unavailable();
  const meta = db.prepare("SELECT type,typeof(sql) sql_type,length(CAST(sql AS BLOB)) bytes,CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=65536 THEN sql ELSE NULL END sql FROM main.sqlite_schema WHERE lower(name)='metadata' LIMIT 2").all();
  if (!meta.length) return;
  if (meta.length !== 1 || meta[0].type !== 'table' || meta[0].sql_type !== 'text' || meta[0].sql === null || /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(meta[0].sql)) throw unknown('authority_metadata_shape');
  const names = new Set(); let columns=0;
  for (const row of db.prepare("PRAGMA main.table_xinfo('metadata')").iterate()) {
    if (++columns > 64 || row.hidden !== 0) throw unknown('authority_metadata_shape');
    names.add(row.name);
  }
  if (!names.has('key') || !names.has('value')) throw unknown('authority_metadata_shape');
  const values = db.prepare("SELECT typeof(value) value_type,length(CAST(value AS BLOB)) bytes,CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=16 THEN value ELSE NULL END value FROM main.metadata NOT INDEXED WHERE key COLLATE BINARY='database_schema_version' LIMIT 2").all();
  if (!values.length) return;
  if (values.length !== 1 || values[0].value_type !== 'text' || values[0].value === null || !/^(0|[1-9][0-9]*)$/.test(values[0].value)) throw unknown('authority_metadata_version_invalid');
  if (values[0].value !== '0' && values[0].value !== '1') unavailable();
  if (Number(values[0].value) !== version) throw unknown('authority_metadata_version_inconsistent');
}
function assertNoAuthorityDatabaseFile(filePath) {
  let db, begun=false, failure=null;
  try {
    const file = checkedPath(filePath), before = regular(file);
    const sidecars = Object.fromEntries(['-wal','-shm','-journal'].map(s => [s,regular(file+s)]));
    if (!before || before.size === 0n) {
      if (Object.values(sidecars).some(s => s && s.size > 0n)) throw unknown('authority_orphan_sidecar');
      return;
    }
    // No raw source fs.open/read/hash/close: rogue FDs can release SQLite's
    // process-wide POSIX locks. SQLite exclusively owns inspection file handles.
    db = new DatabaseSync(file,{readOnly:true});
    db.exec('BEGIN'); begun=true;
    inspectDatabase(db);
    if (!same(before,regular(file))) throw unknown('authority_path_changed');
    for (const suffix of ['-wal','-journal']) {
      const after=regular(file+suffix), prior=sidecars[suffix];
      if (suffix === '-wal' && prior === null && after?.size === 0n) continue;
      if (!sameEntry(prior,after)) throw unknown('authority_source_changed');
    }
  } catch (e) { failure=wrap(e); }
  finally {
    if (db && begun) try { db.exec('ROLLBACK'); } catch { failure ||= unknown('authority_read_end_failed'); }
    if (db) try { db.close(); } catch { failure ||= unknown('authority_read_close_failed'); }
  }
  if (failure) throw failure;
}
function assertNoAuthorityDataRoot(dataDir) {
  const root=checkedPath(dataDir);
  assertNoAuthorityFilesystemEvidence(root);
  for (const n of OWNERS) assertNoAuthorityDatabaseFile(path.join(root,'stores',n,n+'.sqlite'));
  assertNoAuthorityFilesystemEvidence(root);
}
function assertNoAuthorityAncestry(targetPath) {
  let current=checkedPath(targetPath), steps=0;
  while (true) {
    if (++steps > MAX_COMPONENTS+1) throw unknown('authority_path_depth');
    const s=stat(current);
    if (s?.isDirectory()) assertNoAuthorityDataRoot(current);
    const parent=path.dirname(current); if (parent === current) break; current=parent;
  }
}
module.exports = { assertNoAuthorityFilesystemEvidence,assertNoAuthorityDataRoot,assertNoAuthorityDatabaseFile,assertNoAuthorityAncestry };
