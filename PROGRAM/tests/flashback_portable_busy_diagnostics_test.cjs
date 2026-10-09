'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

// Execute the shipped admission, owner, UI-state, and catch functions verbatim.
// DOM, confirmation, and storage boundaries are the only fixture substitutes.
// Moving the shared-owner guard ahead of an existing portable latch must fail
// BUSY_PRIORITY; removing the repair-busy catch classification must fail
// REPAIR_BUSY_UI. No replacement admission/catch implementation is tested.
const ownerSource = between('  let flashbackOwnerLease = null,', '  // Per-scope write mutex:');
const valueSource = between('    const textValue = value =>', '    const cloneJson = value =>');
const busySource = between("  const setBusy = (busy, label = '') => {", '  const downloadTextFile =');
const operationSource = between('    const syncPortableUiState = message => {', '    const previewText =');
const handlerSource = between('    const doExport = async () => {', '    const bindUi = root => {');

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.disabled = false;
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  appendChild(child) { this.children.push(child); return child; }
  matches(selector) {
    return selector === 'button' ? this.tagName === 'BUTTON'
      : selector === '[data-portable-status]' && this.attributes.has('data-portable-status');
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const factory = new Function('env', `
  const { Runtime, runtime, document, config, Error, Date, Math, console,
    applyBusyState, modal, notice, createEnvelope, downloadEnvelope,
    parsePortableJson, validateEnvelope, inspectPortableRestoreOptions,
    restoreModeModal, previewText, restorePortableByMode, refreshRuntime,
    Flashback_PORTABLE_RESTORE_MODES } = env;
  const PLUGIN_NAME = 'Flashback';
  ${ownerSource}
  ${valueSource}
  ${busySource}
  ${operationSource}
  ${handlerSource}
  return {
    acquirePortableOperation, releasePortableOperation, runPortableOperation,
    doExport, doRestoreFile, syncPortableUiState, beginFlashbackOwnerWrite,
    claimFlashbackOwner,
    ownerState: () => ({ lease: flashbackOwnerLease, writers: flashbackOwnerWriters,
      epoch: flashbackOwnerEpoch, lifetime: flashbackOwnerLifetime })
  };
`);

function fixture() {
  const runtimeWrites = [];
  const Runtime = new Proxy({
    maintenanceActiveOperationId: '', portableMemoryActiveOperationId: '',
    guiBusyDepth: 0, guiBusyLabel: ''
  }, { set(target, key, value) {
    runtimeWrites.push({ key, value });
    target[key] = value;
    return true;
  } });
  const runtime = { busy: false, lastError: '', lastRestore: null };
  const root = new FakeElement('div');
  root.appendChild(new FakeElement('button'));
  root.appendChild(new FakeElement('button'));
  const status = root.appendChild(new FakeElement('span'));
  status.setAttribute('data-portable-status', '');
  const errors = [], notices = [], storage = new Map(), writes = [];
  const calls = { task: 0, repaint: 0, clock: 0, random: 0, envelope: 0, file: 0,
    download: 0, parse: 0, validate: 0, inspect: 0, restore: 0, refresh: 0 };
  class ObservedError extends Error {
    constructor(message) { super(message); errors.push(this); }
  }
  const failUnexpected = name => async () => {
    calls[name] += 1;
    throw new Error(`unexpected fixture boundary: ${name}`);
  };
  let boundaryFailure = null;
  const env = {
    Runtime, runtime, config: { uiId: 'portable-test', pluginName: 'Flashback', maxImportBytes: 1024 },
    document: { getElementById: id => id === 'portable-test' ? root : null },
    Error: ObservedError,
    Date: { now: () => { calls.clock += 1; return 1234; } },
    Math: Object.assign(Object.create(Math), { random: () => { calls.random += 1; return 0.5; } }),
    console: { log() {} },
    applyBusyState: () => { calls.repaint += 1; },
    modal: async () => true,
    notice: async (title, body, danger) => { notices.push({ title, body, danger }); },
    createEnvelope: async () => {
      calls.envelope += 1;
      if (boundaryFailure) return boundaryFailure();
      throw new Error('unexpected admitted export');
    },
    downloadEnvelope: failUnexpected('download'),
    parsePortableJson: failUnexpected('parse'), validateEnvelope: failUnexpected('validate'),
    inspectPortableRestoreOptions: failUnexpected('inspect'), restoreModeModal: failUnexpected('inspect'),
    previewText: () => '', restorePortableByMode: failUnexpected('restore'),
    refreshRuntime: failUnexpected('refresh'),
    Flashback_PORTABLE_RESTORE_MODES: { SAME_CHAT: 'same_chat', CHAT_MIGRATION: 'chat_migration', CHAT_COPY: 'chat_copy' }
  };
  const api = factory(env);
  const file = { size: 16, text: async () => {
    calls.file += 1;
    if (boundaryFailure) return boundaryFailure();
    throw new Error('unexpected admitted file read');
  } };
  const task = async () => {
    calls.task += 1;
    writes.push('portable-task');
    storage.set('portable-task', 'written');
    return 'admitted';
  };
  return { api, Runtime, runtime, root, status, errors, notices, calls, runtimeWrites,
    storage, writes, task, file, setBoundaryFailure: fn => { boundaryFailure = fn; } };
}

const repair = 'FLASHBACK_REPAIR_ACTION_BUSY';
const maintenance = 'FLASHBACK_MAINTENANCE_BUSY';
const portable = 'FLASHBACK_PORTABLE_MEMORY_BUSY';
const gui = 'FLASHBACK_GUI_BUSY';
const errorMessages = {
  [repair]: 'FLASHBACK_REPAIR_ACTION_BUSY',
  [maintenance]: '기억 유지보수가 실행 중입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요.',
  [portable]: '다른 기억 또는 GUI 작업이 실행 중입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요.',
  [gui]: '다른 기억 또는 GUI 작업이 실행 중입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요.'
};

function seed(f, { owner, portableActive, maintenanceActive, guiActive }) {
  // The existing export obtains its latch before registering its own writer.
  let operationId = '';
  if (portableActive) operationId = f.api.acquirePortableOperation('backup');
  if (owner === 'lease') assert.ok(f.api.claimFlashbackOwner('archive_repair'));
  if (owner === 'writer') f.api.beginFlashbackOwnerWrite();
  if (maintenanceActive) f.Runtime.maintenanceActiveOperationId = 'existing-maintenance';
  f.Runtime.guiBusyDepth = guiActive ? 2 : 0;
  f.Runtime.guiBusyLabel = guiActive ? 'existing GUI work' : '';
  f.api.syncPortableUiState('');
  f.runtimeWrites.length = 0;
  return operationId;
}

// Complete rejecting truth table. Rows deliberately encode the established
// maintenance-before-portable-before-GUI order, while independent owner work
// wins only when no portable operation already owns the operation latch.
const priorityRows = [
  ['none',   false, false, true,  gui],
  ['none',   false, true,  false, maintenance],
  ['none',   false, true,  true,  maintenance],
  ['none',   true,  false, false, portable],
  ['none',   true,  false, true,  portable],
  ['none',   true,  true,  false, maintenance],
  ['none',   true,  true,  true,  maintenance],
  ['lease',  false, false, false, repair],
  ['lease',  false, false, true,  repair],
  ['lease',  false, true,  false, repair],
  ['lease',  false, true,  true,  repair],
  ['lease',  true,  false, false, portable],
  ['lease',  true,  false, true,  portable],
  ['lease',  true,  true,  false, maintenance],
  ['lease',  true,  true,  true,  maintenance],
  ['writer', false, false, false, repair],
  ['writer', false, false, true,  repair],
  ['writer', false, true,  false, repair],
  ['writer', false, true,  true,  repair],
  ['writer', true,  false, false, portable],
  ['writer', true,  false, true,  portable],
  ['writer', true,  true,  false, maintenance],
  ['writer', true,  true,  true,  maintenance]
];

for (const kind of ['backup', 'restore']) {
  for (const [owner, portableActive, maintenanceActive, guiActive, expectedCode] of priorityRows) {
    test(`BUSY_PRIORITY ${kind}: owner=${owner} portable=${portableActive} maintenance=${maintenanceActive} gui=${guiActive}`, async () => {
      const f = fixture();
      const activeId = seed(f, { owner, portableActive, maintenanceActive, guiActive });
      const before = { runtime: { ...f.Runtime }, owner: f.api.ownerState(), calls: { ...f.calls } };
      let caught;
      try { await f.api.runPortableOperation(kind, f.task); }
      catch (error) { caught = error; }

      // Verify no admission or mutation even when diagnosis is wrong.
      assert.ok(caught instanceof Error, 'busy requests must reject');
      assert.equal(f.calls.task, 0, 'rejected requests never start the storage task');
      assert.deepEqual(f.writes, [], 'no storage write on rejection');
      assert.equal(f.storage.size, 0);
      assert.deepEqual(f.runtimeWrites, [], 'no operation latch or GUI-busy write on rejection');
      assert.deepEqual({ ...f.Runtime }, before.runtime, 'existing operation identity and GUI state survive');
      assert.deepEqual(f.api.ownerState(), before.owner, 'existing owner lease, writer count, and epoch survive');
      assert.deepEqual(f.calls, before.calls, 'no ID generation, repaint, or task execution on rejection');
      assert.equal(f.errors.length, 1, 'one original production error is created');
      assert.strictEqual(caught, f.errors[0], 'the original rejection object is propagated');
      assert.equal(caught.code, expectedCode, 'BUSY_PRIORITY: preserve the most specific existing busy diagnosis');
      assert.equal(caught.message, errorMessages[expectedCode], 'original error text is preserved');
      assert.equal(caught.operationId, expectedCode === repair ? undefined
        : expectedCode === maintenance ? 'existing-maintenance'
          : expectedCode === portable ? activeId : '');
    });
  }

  test(`BUSY_PRIORITY ${kind}: idle operation still admits and releases exactly once`, async () => {
    const f = fixture();
    assert.equal(await f.api.runPortableOperation(kind, f.task), 'admitted');
    assert.equal(f.calls.task, 1);
    assert.deepEqual(f.writes, ['portable-task']);
    assert.equal(f.calls.clock, 1);
    assert.equal(f.calls.random, 1);
    assert.equal(f.calls.repaint, 2);
    assert.equal(f.Runtime.portableMemoryActiveOperationId, '');
    assert.equal(f.Runtime.guiBusyDepth, 0);
    assert.equal(f.Runtime.guiBusyLabel, '');
    assert.equal(f.errors.length, 0);
  });
}

function assertUiResult(f, action, code, blocked, expectedGuiDepth = 0) {
  const prefix = action === 'export' ? '백업' : '복원';
  const label = `${prefix} ${blocked ? '차단' : '실패'}`;
  assert.equal(f.runtime.busy, false, 'handler always clears its local busy flag');
  assert.equal(f.Runtime.portableMemoryActiveOperationId, '', 'handler leaves no new portable operation');
  assert.equal(f.Runtime.guiBusyDepth, expectedGuiDepth, 'handler does not release another operation’s GUI lock');
  assert.ok(f.root.querySelectorAll('button').every(button => button.disabled === (expectedGuiDepth > 0)),
    'portable buttons reflect the remaining shared GUI lock after cleanup');
  assert.deepEqual(f.writes, [], 'blocked or failed operation performs no storage writes');
  assert.equal(f.storage.size, 0);
  assert.equal(f.calls.download, 0);
  assert.equal(f.calls.restore, 0);
  assert.equal(f.calls.refresh, 0);
  assert.equal(f.notices.length, 1, 'one result notice is displayed');
  assert.equal(f.runtime.lastRestore, null, 'no successful restore result is fabricated');
  assert.equal(f.runtime.lastError, errorMessages[code], 'the exact original error message remains available');
  assert.equal(f.status.textContent, label, 'REPAIR_BUSY_UI: busy errors display blocked, not failed');
  assert.equal(f.notices[0].title, label);
  assert.equal(f.notices[0].danger, true);
  const suffix = action === 'restore' ? '\n\n저장 중 실패한 경우 복원 전 상태로 롤백했습니다.' : '';
  assert.equal(f.notices[0].body, `${errorMessages[code]}${suffix}`);
}

for (const action of ['export', 'restore']) {
  const invoke = f => action === 'export' ? f.api.doExport() : f.api.doRestoreFile(f.file);
  for (const [owner, maintenanceActive, guiActive, code] of [
    ['lease', false, false, repair], ['writer', false, false, repair],
    ['none', true, false, maintenance], ['none', false, true, gui]
  ]) {
    test(`REPAIR_BUSY_UI ${action}: ${owner === 'none' ? code : owner} rejection keeps original error and cleanup`, async () => {
      const f = fixture();
      seed(f, { owner, portableActive: false, maintenanceActive, guiActive });
      const before = { runtime: { ...f.Runtime }, owner: f.api.ownerState() };
      assert.equal(await invoke(f), undefined);
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0].code, code, 'UI must not replace the original error code');
      assert.equal(f.errors[0].message, errorMessages[code]);
      assert.deepEqual(f.runtimeWrites, [], 'UI rejection never acquires or clears another operation latch');
      assert.deepEqual({ ...f.Runtime }, before.runtime);
      assert.deepEqual(f.api.ownerState(), before.owner);
      assert.equal(f.calls.envelope, 0, 'rejected export does not read the corpus');
      assert.equal(f.calls.file, 0, 'rejected restore does not read the file');
      assertUiResult(f, action, code, true, guiActive ? 2 : 0);
    });
  }

  test(`REPAIR_BUSY_UI ${action}: repair error after acquisition releases only its own portable and GUI locks`, async () => {
    const f = fixture();
    let lease;
    f.setBoundaryFailure(() => {
      lease = f.api.claimFlashbackOwner('archive_repair');
      assert.ok(lease);
      // The real owner-write boundary, rather than a mocked busy error, rejects.
      f.api.beginFlashbackOwnerWrite();
    });
    assert.equal(await invoke(f), undefined);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].code, repair);
    assert.equal(f.errors[0].message, errorMessages[repair]);
    assert.strictEqual(f.api.ownerState().lease, lease, 'cleanup cannot release the unrelated owner lease');
    assert.equal(lease.current(), true);
    assert.equal(f.api.ownerState().writers, 0);
    assert.equal(f.calls.repaint, 2, 'own GUI admission and release both execute');
    assert.equal(f.calls.envelope + f.calls.file, 1);
    assertUiResult(f, action, repair, true);
  });

  test(`REPAIR_BUSY_UI ${action}: ordinary errors remain failures and still release UI state`, async () => {
    const f = fixture();
    const failure = Object.assign(new Error('fixture storage failure'), { code: 'FIXTURE_STORAGE_FAILED' });
    const before = { code: failure.code, message: failure.message, stack: failure.stack };
    f.setBoundaryFailure(() => { throw failure; });
    assert.equal(await invoke(f), undefined);
    assert.deepEqual({ code: failure.code, message: failure.message, stack: failure.stack }, before);
    assert.equal(f.errors.length, 0, 'UI does not wrap or replace the dependency error');
    assert.equal(f.calls.repaint, 2);
    errorMessages[failure.code] = failure.message;
    assertUiResult(f, action, failure.code, false);
  });
}
