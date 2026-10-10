'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
require('./authority_fault_loader.cjs').installTraps();
const { ensureDataInstanceIdentity } = require('../../server/core/data-instance-identity.cjs');
const OWNERS = ['libra', 'hayaku', 'flashback', 'lia', 'retrace'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-authority-'));
  const dataDir = path.join(root, 'DATA'); fs.mkdirSync(dataDir);
  const physicalBinding = { ...ensureDataInstanceIdentity(dataDir), controlStoreId: crypto.randomUUID() };
  const ownerBindings = {}, databases = {}, handles = new Set();
  for (const namespace of OWNERS) {
    const filePath = path.join(dataDir, 'stores', namespace, namespace + '.sqlite');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath); databases[namespace] = db; handles.add(db);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE kv(space TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(space,key));
      CREATE TABLE operations(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      PRAGMA user_version=1;`);
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('namespace', namespace);
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('database_schema_version', '1');
    if (namespace === 'libra') db.exec('CREATE TABLE libra_deleted_owner_scopes(scope_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,backup_id TEXT NOT NULL,deleted_at INTEGER NOT NULL); CREATE TABLE libra_deleted_owner_keys(space TEXT NOT NULL,key TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(space,key));');
    if (namespace === 'flashback') db.exec('CREATE TABLE flashback_writer_fences(alias TEXT PRIMARY KEY,epoch INTEGER NOT NULL,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);');
    ownerBindings[namespace] = { filePath, resetEpoch: 0 };
  }
  const f = { root, dataDir, physicalBinding, ownerBindings, databases,
    activationId: crypto.randomUUID(), children: new Set(),
    track: x => (handles.add(x), x),
    controlPath: path.join(dataDir, 'stores', '_authority', 'server-authority.sqlite'),
    markerPath: path.join(dataDir, 'config', 'server-authority.json'),
    initialize() { return f.track(require('../../server/authority/control-store.cjs').initializeAuthorityStore(f)); },
    // Test-only maintenance publication. No production API can force readiness.
    ready() { const db = new DatabaseSync(f.controlPath); try { db.exec("UPDATE authority_state SET status='ready' WHERE singleton=1"); } finally { db.close(); } },
    activate() {
      const control = f.initialize(); const ownerApi = require('../../server/authority/owner-store.cjs');
      const generation = control.readWitness().generation;
      f.owners = {};
      for (const namespace of OWNERS) {
        const store = ownerApi.bindOwnerStore({ database: databases[namespace], namespace, ...ownerBindings[namespace], physicalBinding });
        ownerApi.installOwnerGuards(store, { activationId:f.activationId, generation }); f.owners[namespace] = f.track(store);
      }
      f.ready(); return control;
    },
    intent(operationId = crypto.randomUUID(), extra = {}) {
      const db = new DatabaseSync(f.controlPath, { readOnly:true });
      let generation; try { generation = db.prepare('SELECT generation FROM authority_state').get().generation; } finally { db.close(); }
      return { generation, namespace:'libra', operationId, fingerprint:'a'.repeat(64), operationClass:'kv', ...extra };
    }
  };
  t.after(async () => { for (const c of f.children) { if(c.child.exitCode===null&&c.child.signalCode===null)c.child.kill('SIGKILL'); await c.done; } for (const h of [...handles].reverse()) { try { h.close(); } catch {} } fs.rmSync(root,{recursive:true,force:true}); });
  return f;
}
function insertSource(db, key='libra:memory:one', value='hello') {
  const json=JSON.stringify({schema:'libra.canonical_memory.v1',memoryId:key,content:value});
  db.prepare('INSERT INTO kv VALUES (?,?,?,0,1,?,0)').run('plugin',key,json,crypto.createHash('sha256').update(json).digest('hex'));
}
function snapshotFiles(root) {
 const result={}; const visit=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const full=path.join(p,e.name); if(e.isDirectory())visit(full);else result[path.relative(root,full)]=fs.readFileSync(full).toString('base64');}}; visit(root);return result;
}
function spawnChild(f,config) {
 const child=spawn(process.execPath,[path.join(__dirname,'authority_process_driver.cjs'),JSON.stringify({dataDir:f.dataDir,...config})],{env:{...process.env,LANG:'C',TZ:'UTC',NODE_OPTIONS:process.env.NODE_OPTIONS,LIBRA_NETWORK_AUDIT:process.env.LIBRA_NETWORK_AUDIT},stdio:['ignore','pipe','pipe','ipc']});
 const events=[],waiters=[];let stderr='',stdout='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-8192));child.stdout.on('data',b=>stdout=(stdout+b).slice(-8192));
 child.on('message',event=>{events.push(event);for(const w of [...waiters])if(w.name===event.event){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(event);}});
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{for(const w of waiters){clearTimeout(w.timer);w.reject(new Error('child ended before '+w.name+': '+code+'/'+signal+' '+stderr));}resolve({code,signal,stderr,stdout,events});});});
 const handle={child,done,events,waitEvent(name){const existing=events.find(e=>e.event===name);if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const waiter={name,resolve,reject};waiter.timer=setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(new Error('child event timeout '+name));},15000);waiters.push(waiter);});}};
 f.children.add(handle);return handle;
}
function durableCounts(f){const db=new DatabaseSync(f.ownerBindings.libra.filePath,{readOnly:true});try{return Object.fromEntries(['kv','operations','authority_write_receipts','authority_source_lifecycle','authority_write_results','authority_write_touches'].map(table=>[table,db.prepare('SELECT count(*) n FROM '+table).get().n]));}finally{db.close();}}
const snapshotDurableFiles=root=>Object.fromEntries(Object.entries(snapshotFiles(root)).filter(([name])=>!name.endsWith('-shm')));
module.exports={fixture,insertSource,snapshotFiles,snapshotDurableFiles,OWNERS,spawnChild,durableCounts};
