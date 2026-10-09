'use strict';
// Disposable, no-listener fixture. Source edits below only expose existing
// lexical functions to tests; production transaction bodies are never replaced.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Module } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const controlApi = require('../../server/authority/control-store.cjs');
const ownerApi = require('../../server/authority/owner-store.cjs');
const { ensureDataInstanceIdentity } = require('../../server/core/data-instance-identity.cjs');
const OWNERS = ['libra', 'hayaku', 'flashback', 'lia', 'retrace'];
const program = path.resolve(__dirname, '../..');
const serverPath = path.join(program, 'server/server.cjs');
const strictGuard=require('./authority_strict_guard_probe.cjs').capture();
const deny = () => { if(process.env.LIBRA_NETWORK_AUDIT)fs.appendFileSync(process.env.LIBRA_NETWORK_AUDIT,JSON.stringify({kind:'TASK4_NETWORK_MODEL_WORKER_FORBIDDEN',pid:process.pid})+'\n'); throw Error('TASK4_NETWORK_MODEL_WORKER_FORBIDDEN'); };
function installTraps() {
  // Preserve the exact inherited audited preloader when one is supplied.
  const inheritedGuard=process.env.LIBRA_NETWORK_AUDIT&&process.env.NODE_OPTIONS?.includes('/no-network.cjs');
  if(!inheritedGuard){
  global.fetch = deny;
  global.WebSocket = deny;
  require('node:net').Server.prototype.listen = deny;
  for (const [name, methods] of [['node:net', ['connect', 'createConnection']], ['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:dns', ['lookup', 'resolve']]]) {
    for (const method of methods) require(name)[method] = deny;
  }
  }
  require('node:worker_threads').Worker = class { constructor() { deny(); } };
}
installTraps();
strictGuard?.verify();
function loadServer() {
  const source = fs.readFileSync(serverPath, 'utf8');
  const target = '  return {\n    server,\n    token,';
  assert.equal(source.split(target).length, 2, 'one server return hook anchor');
  let exposed = source.replace(target, `  return {\n    __task4: { writeScopeCatalog, replaceNamespaceScopeIndex, removeCatalogScope, setCatalogScopePinned, saveDeletePlan, prepareJobBackup, advanceDeleteJob, createScopeDeletePlan, executeScopeDeletePlan, namespaceReset, ownerScopeDelete, getLibraNativeArchiveRepair, setMaintenance: value => { maintenanceMode = value; } },\n    server,\n    token,`);
  const repositoryTarget = '  return { namespace, database, filePath, get, getMetadata,';
  assert.equal(exposed.split(repositoryTarget).length, 2, 'one repository return hook anchor');
  exposed = exposed.replace(repositoryTarget, '  return { __task4Maintenance: maintenance, namespace, database, filePath, get, getMetadata,');
  const m = new Module(serverPath, module);
  m.filename = serverPath;
  m.paths = Module._nodeModulePaths(path.dirname(serverPath));
  m._compile(exposed + '\nmodule.exports.__task4 = { createRepository, openDatabase };\n', serverPath);
  return m.exports;
}
function snapshotDurable(root) {
  const out = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath || entry.path, entry.name);
    if (file.endsWith('-shm')) continue;
    out[path.relative(root, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}
function fixture(t, { server = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-authority-task4-'));
  const dataDir = path.join(root, 'DATA');
  fs.mkdirSync(dataDir);
  const loaded = loadServer();
  const app = server ? loaded.createMemorySuiteServer({ dataDir, autoBackup: false, computeEnabled: false, token: 'fixture-only-offline-token-0000000000000000' }) : null;
  const physicalBinding = { ...ensureDataInstanceIdentity(dataDir), controlStoreId: crypto.randomUUID() };
  const repositories = app?.repositories || Object.fromEntries(OWNERS.map(namespace => [namespace, loaded.__task4.createRepository(dataDir, namespace)]));
  const originals = { ...repositories };
  const owners = {}, extraRepos = [], extraHandles = [];
  let control;
  const f = {
    root, dataDir, app, loaded, physicalBinding, repositories, originals, owners,
    activationId: crypto.randomUUID(),
    ownerBindings: Object.fromEntries(OWNERS.map(namespace => [namespace, { filePath: repositories[namespace].filePath, resetEpoch: 0 }])),
    get control() { return control; },
    activate({ open = true } = {}) {
      control = controlApi.initializeAuthorityStore({ ...f, ownerBindings: f.ownerBindings });
      const generation = control.readWitness().generation;
      for (const namespace of OWNERS) {
        const store = ownerApi.bindOwnerStore({ database: originals[namespace].database, namespace, ...f.ownerBindings[namespace], physicalBinding });
        owners[namespace] = store;
        ownerApi.installOwnerGuards(store, { activationId: f.activationId, generation });
      }
      // Explicit disposable-fixture publication. No production flag can do this.
      const db = new DatabaseSync(path.join(dataDir, 'stores/_authority/server-authority.sqlite'));
      try { db.exec("UPDATE authority_state SET status='ready' WHERE singleton=1"); } finally { db.close(); }
      if (open) for (const namespace of OWNERS) repositories[namespace] = f.open(namespace);
      return control;
    },
    open(namespace, maintenance = () => false, selectedControl = control) {
      let repo;
      assert.doesNotThrow(() => { repo = loaded.__task4.createRepository(dataDir, namespace, maintenance, selectedControl); }, 'already-guarded repository needs its real authority transaction integration');
      extraRepos.push(repo); return repo;
    },
    readReceipt(namespace, operationId) {
      return ownerApi.readOwnerReceipt(owners[namespace], { generation: control.readWitness().generation, namespace, operationId });
    },
    readResult(namespace, operationId) {
      const key={generation:control.readWitness().generation,namespace,operationId};
      return ownerApi.readOwnerOperationResult(owners[namespace],key,{expectedReceipt:control.readOperation(key).decision.receipt});
    },
    readControl(sql, ...args) {
      const db = new DatabaseSync(path.join(dataDir, 'stores/_authority/server-authority.sqlite'), { readOnly: true });
      try { return db.prepare(sql).all(...args); } finally { db.close(); }
    },
    track(handle) { extraHandles.push(handle); return handle; },
    request(url, body, options = {}) {
      assert(app && !app.server.listening);
      const handler = app.server.listeners('request')[0];
      const request = new EventEmitter();
      Object.assign(request, { url, method: options.method || 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}`, 'x-memory-suite-admin': '1', ...options.headers }, resume() {}, destroy() {} });
      const response = new EventEmitter(); let result;
      response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; };
      response.getHeader = name => response.headers?.[name];
      response.end = bytes => { result = { status: response.statusCode, body: bytes ? JSON.parse(bytes.toString()) : null }; response.emit('finish'); };
      const handled = handler(request, response);
      const finish = () => { request.emit('data', Buffer.from(JSON.stringify(body || {}))); request.emit('end'); };
      if (!options.defer) finish();
      return { finish, result: handled.then(() => { assert(result); return result; }) };
    }
  };
  t.after(async () => {
    for (const repo of extraRepos.reverse()) repo.close();
    for (const handle of extraHandles.reverse()) { try { handle.close(); } catch {} }
    for (const store of Object.values(owners)) store.close();
    control?.close();
    if (app) { await app.close(); app.diagnosticJournal.close(); }
    for (const repo of Object.values(originals)) repo.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}
const fresh = (key, value, space = 'plugin') => ({ kind: 'set', space, key, value, expectedRevision: 0, expectedDigest: '', expectedExists: false, expectedTombstone: false });
const current = (repo, key, kind = 'remove', value, space = 'plugin') => {
  const row = repo.get(space, key);
  return { kind, space, key, ...(kind === 'set' ? { value } : {}), expectedRevision: row.revision, expectedDigest: row.digest, expectedExists: row.exists, expectedTombstone: row.tombstone };
};
const put = (repo, key, value, operationId = 'fixture-' + crypto.randomUUID()) => repo.mutate({ kind: 'set', space: 'plugin', key, value, operationId });
module.exports = { fixture, snapshotDurable, OWNERS, controlApi, ownerApi, fresh, current, put, program };
