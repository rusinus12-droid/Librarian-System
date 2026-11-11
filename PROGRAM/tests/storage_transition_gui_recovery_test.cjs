'use strict';
// Verifies that a pending/paused global storage transition (__memory_suite_internal_sync_job_v1__:<owner>)
// keeps owner memory reads protected while still registering GUI entry buttons, opening each plugin's
// real GUI directly on the server/storage recovery panel, and transitioning back to the normal view
// once the storage transition completes.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { create, pause, until, META } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const { createHandlerFixture } = require('./fixtures/shared_reanalysis_handler_fixture.cjs');

const owners = {
  Flashback: 'flashback',
  LIBRA: 'libra',
  HAYAKU: 'hayaku'
};

const artifactRoot = process.env.GLOBAL_MODE_ARTIFACT_ROOT;
const kinds = artifactRoot ? ['Full', 'Min'] : ['Full'];
const ownerEntries=Object.entries(owners).filter(([name])=>!process.env.GLOBAL_MODE_OWNER||name===process.env.GLOBAL_MODE_OWNER);
const recoveryKinds=['migration', 'legacy_rollback', 'legacy_rollback_resume', 'expired_rollback', 'restored_server', 'restored_witness', 'missing_destination', 'maintenance', 'slow_completion']
  .filter(kind=>!process.env.GLOBAL_MODE_RECOVERY_CASE||kind===process.env.GLOBAL_MODE_RECOVERY_CASE);

const hash = value => {
  let h = 0x811c9dc5;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(36);
};
const hash64 = value => {
  let h = 0xcbf29ce484222325n;
  for (const c of value) h = BigInt.asUintN(64, (h ^ BigInt(c.charCodeAt(0))) * 0x100000001b3n);
  return 'h64' + h.toString(36);
};

function seedOwnerRoots(name) {
  const characterId = 'audit-character';
  const chatId = 'audit-chat';
  if (name === 'Flashback') {
    const scopeKey = `char:${hash(characterId)}|chat:${hash(chatId)}`;
    const storageHash = hash(scopeKey);
    return [
      [
        `vector_rag_memory:scope:${storageHash}:manifest:v2`,
        JSON.stringify({
          schema: 'vector_rag_memory.scope_manifest.v2',
          version: 2,
          scopeKey,
          storageHash,
          characterId,
          chatId,
          canonicalCharacterId: characterId,
          canonicalChatId: chatId,
          canonicalScopeId: scopeKey,
          shardCount: 0,
          count: 0,
          shardSummaries: []
        })
      ]
    ];
  }
  if (name === 'LIBRA') {
    const scopeKey = `char:${hash(characterId)}|chat:${hash(chatId)}`;
    return [
      [
        `libra:v1:scope:${scopeKey}:manifest`,
        JSON.stringify({
          schema: 'libra.manifest.v1',
          scopeKey,
          characterId,
          chatId,
          memories: {},
          inheritedMemories: []
        })
      ]
    ];
  }
  const scopeKey = 'chat_' + hash64(characterId + '\n' + chatId);
  return [
    [
      'hayaku.v2.ledger.' + scopeKey,
      JSON.stringify({
        version: 'hayaku_storage_ledger_v2',
        scopeKey,
        identity: { schema: 'hayaku.scope_identity.v1', scopeKey, characterId, chatId },
        records: [],
        slotHeads: [],
        tombstones: []
      })
    ]
  ];
}

async function settleOwnerStore(s) {
  let before = JSON.stringify([...s.values]);
  let stable = 0;
  for (let i = 0; i < 30; i += 1) {
    await pause(80);
    const next = JSON.stringify([...s.values]);
    stable = next === before ? stable + 1 : 0;
    if (stable === 3) return;
    before = next;
  }
}

async function openServerPanelNormally(s) {
  await s.open();
  await pause(180);
  if (s.name === 'LIBRA') {
    await settleOwnerStore(s);
    const firstRun = s.doc.querySelector('[data-libra-quick-dialog] .dialog__actions button');
    if (firstRun) await s.click('[data-libra-quick-dialog] .dialog__actions button');
    const serverNav = s.doc.querySelector('.sidebar [data-go="server"], [data-go="server"]');
    if (serverNav) {
      await s.click('.sidebar [data-go="server"], [data-go="server"]');
    } else {
      await s.click('.topbar [data-go="settings"]');
      await until(() => s.doc.querySelector('.setnav [data-subtab="store"]'), 'LIBRA settings store subtab');
      await s.click('.setnav [data-subtab="store"]');
    }
  } else if (s.name === 'HAYAKU') {
    await s.click('[data-hayaku-viewer-goto="server"]');
  } else {
    await s.click('[data-go="connect"]');
    await s.click('button[data-group="c"][data-subtab="srv"]');
  }
  await until(() => s.doc.querySelector('[data-apply]'), `${s.name} server panel mounted`, 10000);
  if (s.name === 'Flashback') {
    // Finish the real startup upgrade before capturing a recoverable job. A
    // short quiet interval can precede Flashback's deferred retirement sweep;
    // mixing a pre-upgrade plan with post-upgrade source bytes is not a reload.
    for (const [key, value] of seedOwnerRoots(s.name)) {
      if (/:manifest:v2$/.test(key)) await s.api.retireExternalSources(JSON.parse(value).scopeKey);
    }
  }
  await settleOwnerStore(s);
}

// Since 09f07fa2 the GUI applies a mode through the fast engine, which never leaves a per-scope plan.
// The interrupted job under test is one an OLDER build left behind, so the snapshot is produced by a
// throwaway copy of the plugin whose storage bridge is reachable from the test. Only this snapshot step
// runs the copy; the recovery below runs the unmodified plugin.
const BRIDGE_DECLARATION = 'const MemorySuiteStorageBridge = createMemorySuiteStorageBridge(';
const TEST_BRIDGE_GLOBAL = '__memorySuiteTransitionTestBridge';
function snapshotPluginCopy(pluginPath) {
  const source = fs.readFileSync(pluginPath, 'utf8');
  const count = source.split(BRIDGE_DECLARATION).length - 1;
  assert.equal(count, 1, `${path.basename(pluginPath)}: exactly one owner storage bridge declaration`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-snapshot-'));
  const copy = path.join(dir, path.basename(pluginPath));
  fs.writeFileSync(copy, source.replace(BRIDGE_DECLARATION,
    `const MemorySuiteStorageBridge = globalThis.${TEST_BRIDGE_GLOBAL} = createMemorySuiteStorageBridge(`));
  return { copy, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function createPausedGlobalTransitionSnapshot(name, kind, pluginPath, handler) {
  const jobKey = `__memory_suite_internal_sync_job_v1__:${owners[name]}`;
  let capturedPausedJob = null;
  const olderBuild = snapshotPluginCopy(pluginPath);
  let s;
  try {
  s = await create(name, kind, {
    pluginPath: olderBuild.copy,
    separateLocalStorage: true,
    initialValues: seedOwnerRoots(name),
    args: { memory_suite_server_url: handler.url },
    nativeFetch: handler.nativeFetch,
    beforeWrite: async (key, value) => {
      if (key === jobKey && typeof value === 'string') {
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch (_) {}
        if (parsed?.kind === 'global_mode' && parsed.phase === 'copy_verify' && !capturedPausedJob) {
          capturedPausedJob = JSON.stringify({
            ...parsed,
            status: 'paused',
            phase: 'recovery_pending',
            effectsStarted: true,
            error: 'simulated_reload_during_global_transition',
            message: '미완료 · 원본과 실제 경로를 보존했습니다. 문제를 확인한 뒤 이어서 진행하세요.'
          });
          // Stop the actual run at the captured boundary. Letting it finish
          // and replacing only its journal combines different storage times.
          throw new Error('simulated_reload_during_global_transition');
        }
      }
    }
  });
    await openServerPanelNormally(s);
    const bridge = s.context[TEST_BRIDGE_GLOBAL];
    assert.ok(bridge && typeof bridge.previewGlobalMode === 'function', `${name}: snapshot copy exposes its storage bridge`);
    // The older build's approved full-preview migration: the per-scope plan engine.
    const preview = await bridge.previewGlobalMode('server_only');
    assert.equal(preview.completeKnownScopes, true, `${name}: the older build sees every scope`);
    await bridge.setGlobalMode('server_only', { previewFingerprint: preview.inventoryFingerprint })
      // The SDK reports the simulated journal write failure as an unavailable journal.
      .catch(error => assert.match(String(error?.code || error?.message || error), /simulated_reload_during_global_transition|MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE/));
    assert.ok(capturedPausedJob, `${name}: must capture in-flight global_mode sync job journal`);
    const stoppedJob = JSON.parse(s.values.get(jobKey));
    assert.equal(stoppedJob.status, 'paused', `${name}: the original migration must actually stop before the reload`);
    assert.equal(Object.keys(stoppedJob.checkpoints || {}).length, 0, `${name}: interruption occurs before scope completion`);
    const snapshotEntries = [...s.values.entries()];
    const map = new Map(snapshotEntries);
    map.set(jobKey, capturedPausedJob);
    return { entries: [...map.entries()], deviceEntries: [...s.deviceValues.entries()], jobKey };
  } finally {
    try { await s?.close(); } finally { olderBuild.cleanup(); }
  }
}

async function assertOwnerMemoryReadProtected(s, name, kind) {
  if (name === 'Flashback') {
    await assert.rejects(
      () => s.api.loadSettings(true),
      err => err?.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS'
        || String(err?.message || err).includes('memory_suite_storage_transition_in_progress'),
      `${name} (${kind}): loadSettings(true) must stay blocked while transition is pending`
    );
  } else if (name === 'LIBRA') {
    await assert.rejects(
      () => s.api.getLibraMemorySettings(),
      err => err?.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS'
        || String(err?.message || err).includes('memory_suite_storage_transition_in_progress'),
      `${name} (${kind}): getLibraMemorySettings must stay blocked while transition is pending`
    );
  } else if (name === 'HAYAKU') {
    const summary = await s.api.ledger.inspect({ includeRecords: false });
    assert.equal(summary.enabled, false, `${name} (${kind}): ledger.inspect must not fabricate an enabled empty ledger during transition`);
    assert.ok(
      summary.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS'
        || String(summary.reason || '').includes('memory_suite_storage_transition_in_progress'),
      `${name} (${kind}): ledger.inspect must report transition in progress`
    );
  }
}

async function assertOwnerMemoryReadUnlocked(s, name, kind) {
  if (name === 'Flashback') {
    const settings = await s.api.loadSettings(true);
    assert.ok(settings && typeof settings === 'object', `${name} (${kind}): loadSettings(true) must succeed after transition completes`);
  } else if (name === 'LIBRA') {
    const settings = await s.api.getLibraMemorySettings();
    assert.ok(settings && typeof settings === 'object', `${name} (${kind}): getLibraMemorySettings must succeed after transition completes`);
  } else if (name === 'HAYAKU') {
    const summary = await s.api.ledger.inspect({ includeRecords: false });
    assert.equal(summary.enabled, true, `${name} (${kind}): ledger.inspect must succeed after transition completes`);
  }
}

test('owner GUI resumes through one progress action and recovers legacy and expired cancellation', {timeout:240000}, async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
  const results = [];
  assert(ownerEntries.length&&recoveryKinds.length,'requested recovery case and owner must exist');
  for (const [name] of ownerEntries) {
    for (const kind of kinds) for (const recoveryKind of recoveryKinds) {
      const restoredServer=recoveryKind.startsWith('restored_');
      const resumeMigration=['migration','missing_destination','maintenance','slow_completion'].includes(recoveryKind);
      const handler = createHandlerFixture();
      const pluginPath = artifactRoot
        ? path.join(artifactRoot, kind, META[name][0])
        : path.resolve(__dirname, '../plugins', META[name][0]);
      let s,restoredHandler,restoredRows,maintenanceObserved=false,maintenancePhase='',maintenanceTimer;
      try {
        const snapshot = await createPausedGlobalTransitionSnapshot(name, kind, pluginPath, handler);
        if (recoveryKind === 'missing_destination') {
          const values=new Map(snapshot.entries),job=JSON.parse(values.get(snapshot.jobKey));
          const registryKey=`__memory_suite_internal_scope_routes_v1__:${owners[name]}`;
          const registry=JSON.parse(values.get(registryKey)||JSON.stringify(job.globalPlan.registry));
          const scope=job.globalPlan.scopes.find(row=>job.globalPlan.sources.some(source=>{
            const [location,,key]=source.identity.split('\u0000');
            return location!=='server'&&/manifest|ledger/.test(key)&&[row.scopeId,...row.aliases].some(alias=>alias&&key.includes(alias));
          }));
          assert(scope,'a source-backed scope must be available');
          registry.entries[scope.scopeId]={...(registry.entries[scope.scopeId]||{}),...scope,mode:'server_only',origin:'transition_pending',globalMigrationJobId:job.jobId,updatedAt:Date.now()};
          values.set(registryKey,JSON.stringify(registry));snapshot.entries=[...values];
        }
        if (!resumeMigration) {
          const values = new Map(snapshot.entries);
          const job = JSON.parse(values.get(snapshot.jobKey));
          // Historical jobs can predate per-scope sourceMode. The original
          // routing snapshot still binds the settings that cancellation restores.
          for (const scope of job.globalPlan.scopes) delete scope.sourceMode;
          delete job.globalPlan.legacyMode;
          if(recoveryKind==='restored_witness'){
            const source=job.globalPlan.sources.find(row=>row.identity.startsWith('plugin\u0000plugin\u0000'));
            assert(source,'the historical server witness must have an actual local physical original');
            const localKey=source.identity.split('\u0000')[2];
            job.globalPlan.sources.push({identity:'server\u0000plugin\u0000'+localKey+'::memory-suite-scope:v1:'+encodeURIComponent(job.globalPlan.scopes[0].scopeId),
              fingerprint:source.fingerprint,revision:1,digest:'historical-server-witness'});
          }
          const canonical = JSON.stringify(job.globalPlan, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
          job.globalPlanDigest = require('node:crypto').createHash('sha256').update(canonical).digest('hex');
          Object.assign(job, { cancelRequested:true, pauseRequested:true, failedPhase:'rollback_routes', error:'MEMORY_SUITE_GLOBAL_ROLLBACK_READBACK_FAILED' });
          if (recoveryKind === 'expired_rollback') Object.assign(job, {
            updatedAt:Date.now() - 12 * 60 * 60 * 1000,
            resumeExpired:true,
            error:'MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING',
            errorDetails:{cause:'MEMORY_SUITE_JOB_RESUME_EXPIRED'}
          });
          if(restoredServer){
            Object.assign(job,{error:'MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING',errorDetails:{cause:'MEMORY_SUITE_JOB_SERVER_PIN_CHANGED'}});
            restoredHandler=createHandlerFixture();
            restoredHandler.app.repositories[owners[name]].mutate({kind:'set',space:'plugin',key:'restored.sentinel',value:'PRESERVE_RESTORED_SERVER',operationId:'seed_restored'});
            restoredRows=restoredHandler.app.repositories[owners[name]].database.prepare('SELECT * FROM kv ORDER BY space,key').all();
          }
          values.set(snapshot.jobKey, JSON.stringify(job));
          snapshot.entries = [...values.entries()];
        }
        let allowServer = false;
        const gatedFetch = async (...args) => {
          if (!allowServer) {
            throw new Error('simulated_server_offline_on_reload');
          }
          if(recoveryKind==='maintenance'&&!maintenanceObserved&&new URL(args[0]).pathname==='/v1/kv/get'
              &&JSON.parse(s.values.get(snapshot.jobKey)||'null')?.phase==='final_verify'
              &&!new URL(args[0]).searchParams.get('key').startsWith('__memory_suite_')){
            maintenanceObserved=true;
            maintenanceTimer=setTimeout(()=>{maintenancePhase=s.doc.querySelector('[data-job-phase]')?.textContent||'';},100);
            return new Response(JSON.stringify({ok:false,error:'server_maintenance_in_progress'}),{status:503});
          }
          return await (restoredHandler||handler).nativeFetch(...args);
        };

        s = await create(name, kind, {
          pluginPath,
          separateLocalStorage: true,
          initialValues: snapshot.entries,
          initialDeviceValues: snapshot.deviceEntries,
          args: { memory_suite_server_url: handler.url },
          beforeWrite:async(key,value)=>{
            if(recoveryKind==='slow_completion'&&key===snapshot.jobKey&&JSON.parse(value)?.status==='completed')await pause(300);
          },
          nativeFetch: gatedFetch
        });
        await pause(320);

        // 1. GUI entry buttons must be registered even while storage transition is paused/in-progress.
        const settingRegs = s.regs.filter(r => r.kind === 'setting' && typeof r.callback === 'function');
        const buttonRegs = s.regs.filter(r => r.kind === 'button' && typeof r.callback === 'function');
        assert.ok(settingRegs.length > 0, `${name} (${kind}): registerSetting must be called during storage transition`);
        assert.ok(buttonRegs.length > 0, `${name} (${kind}): registerButton must be called during storage transition`);

        // 2. Owner memory reads must remain blocked by the storage transition lock.
        await assertOwnerMemoryReadProtected(s, name, kind);

        // 3. Opening the GUI via the registered setting callback must open the recovery/server panel.
        await settingRegs[0].callback();
        await pause(260);

        if (name === 'Flashback') {
          await until(
            () => s.doc.querySelector('#flashbackMemorySuiteServerConnectionPanel [data-job]'),
            'Flashback server recovery panel mounted',
            8000
          );
          const serverPanel = s.doc.querySelector('#panel-server');
          assert.ok(serverPanel?.classList.contains('is-active'), 'Flashback opens directly on the server recovery tab');
          const notice = s.doc.querySelector('#flashbackStorageTransitionNotice');
          assert.ok(notice && notice.hidden === false, 'Flashback displays storage transition notice');
          const retryBtn = s.doc.querySelector('#flashbackRetryStorageInitBtn');
          assert.ok(retryBtn, 'Flashback renders manual retry button');
          assert.equal(retryBtn.textContent, '진행 화면으로 이동');
          retryBtn.click();
          await pause(120);
          assert.ok(
            s.doc.querySelector('#panel-server')?.classList.contains('is-active'),
            'Flashback stays on server recovery tab when manual retry runs while transition is still locked'
          );
        } else if (name === 'LIBRA') {
          await until(
            () => s.doc.querySelector('#libraMemorySuiteServerConnectionPanel [data-job]'),
            'LIBRA server recovery panel mounted',
            8000
          );
          const serverPage = s.doc.querySelector('.page[data-page="server"]') || s.doc.querySelector('.page[data-page="settings"]');
          assert.ok(serverPage?.classList.contains('is-active'), 'LIBRA opens directly on server page during transition');
          const retryBtn = s.doc.querySelector('[data-libra-storage-retry]');
          assert.ok(retryBtn, 'LIBRA renders manual storage retry button');
          assert.equal(retryBtn.textContent, '진행 화면으로 이동');
          retryBtn.click();
          await pause(120);
          assert.ok(
            (s.doc.querySelector('.page[data-page="server"]') || s.doc.querySelector('.page[data-page="settings"]'))?.classList.contains('is-active'),
            'LIBRA stays on server recovery panel while transition is still locked'
          );
        } else if (name === 'HAYAKU') {
          await until(
            () => s.doc.querySelector('#hayakuMemorySuiteServerConnectionPanel [data-job]'),
            'HAYAKU server recovery panel mounted',
            8000
          );
          const connectPage = s.doc.querySelector('[data-hayaku-viewer-panel="server"]');
          assert.ok(connectPage?.classList.contains('is-active'), 'HAYAKU opens directly on server connection page during transition');
          const notice = s.doc.querySelector('#hayakuStorageTransitionNotice');
          assert.ok(notice && notice.hidden === false, 'HAYAKU displays storage transition notice');
          assert.match(notice.textContent || '', /저장소 이전 대기/, 'HAYAKU transition notice explains storage transition lock');
        }

        // 4. Re-enable server and finish the older build's job through the one recovery action of the
        //    current design: the stale card points to [모드 전환 중 자동 복구] in the advanced actions.
        allowServer = true;
        const panelSelector = `#${owners[name]}MemorySuiteServerConnectionPanel`;
        assert.equal(s.doc.querySelector(`${panelSelector} [data-job-title]`).textContent, '끝나지 않은 전환 작업이 남아 있습니다');
        assert.equal(s.doc.querySelector(`${panelSelector} [data-job-phase]`).textContent, '현재 단계: 조치 필요');
        assert.equal(s.doc.querySelector(`${panelSelector} button[data-job-retry]`).style.display, 'none', 'the stale card offers no in-card resume');
        assert.match(s.doc.querySelector(`${panelSelector} [data-job-workflow]`).textContent,
          restoredServer ? /서버 DATA가 바뀌어.*\n고급 작업의 \[모드 전환 중 자동 복구\]/ : /고급 작업의 \[모드 전환 중 자동 복구\]/);
        const recoverBtn = s.doc.querySelector(`${panelSelector} [data-recover]`);
        assert.ok(recoverBtn && typeof recoverBtn.onclick === 'function', `${name} (${kind}): automatic recovery must be interactive`);
        let resumed=false;
        const resuming=Promise.resolve(recoverBtn.onclick()).finally(()=>{resumed=true;});
        if(restoredServer){
          // A changed server has no direction to choose; only the reviewed device cancellation applies.
          await until(()=>resumed||typeof s.doc.querySelector('[data-mode-confirm-approve]')?.onclick==='function', `${name}: local cancellation consent`, 12000);
          const approval=s.doc.querySelector('[data-mode-confirm-approve]');
          assert.equal(typeof approval?.onclick,'function',s.doc.querySelector(`${panelSelector} [data-status]`)?.textContent);
          assert.equal(approval.textContent,'기기 경로 복구로 취소');
          assert.match(s.doc.querySelector('[data-mode-confirm-text]').textContent,/현재 서버.*변경하지|현재 서버에 자료를 전송/);
          approval.click();
        }else{
          await until(()=>resumed||typeof s.doc.querySelector('[data-ask-a]')?.onclick==='function', `${name}: recovery direction popup`, 12000);
          assert.equal(s.doc.querySelector('[data-ask-a]').textContent,'1) 플러그인 모드로 전환 중');
          assert.equal(s.doc.querySelector('[data-ask-b]').textContent,'2) 서버 모드로 전환 중');
          // An interrupted migration was heading to the server; an interrupted cancellation back to the plugin.
          s.doc.querySelector(resumeMigration ? '[data-ask-b]' : '[data-ask-a]').click();
        }
        await resuming;
        await until(
          () => {
            const rawJob = s.values.get(snapshot.jobKey);
            if (!rawJob) return false;
            try {
              const parsed = JSON.parse(rawJob);
              return restoredServer
                ? parsed.status === 'cancelled' && parsed.rollbackComplete === true && !parsed.error
                : resumeMigration
                  ? parsed.status === 'completed' && parsed.phase === 'completed'
                  : parsed.status === 'completed' && parsed.engine === 'fast' && parsed.targetMode === 'plugin_only';
            } catch (_) {
              return false;
            }
          },
          `${name} (${kind}): transition job completed`,
          // The release gate runs beside CPU-heavy plugin parsing suites. Keep
          // waiting for actual durable completion, with bounded failure evidence.
          30000
        ).catch(error => {
          let job;try {job=JSON.parse(s.values.get(snapshot.jobKey)||'null');}catch(_) {}
          error.message += ' · '+JSON.stringify({status:job?.status,phase:job?.phase,error:job?.error,details:job?.errorDetails,currentScopeId:job?.currentScopeId});
          throw error;
        });

        // Memory read must now succeed after transition completion.
        await assertOwnerMemoryReadUnlocked(s, name, kind);
        const recoveryStatus=s.doc.querySelector(`${panelSelector} [data-status]`).textContent;
        if(restoredServer){
          assert.match(recoveryStatus,/^자동 복구 완료 · 이전 작업을 취소하고 원래 기기 저장 경로로 돌아왔습니다/);
          const diagnostics=JSON.parse(s.doc.querySelector(`${panelSelector} [data-job-diagnostics]`).value);
          assert.equal(diagnostics.rollbackProgress.verifiedScopes,diagnostics.rollbackProgress.totalScopes);
          assert.equal(diagnostics.rollbackPublication.status,'skipped_changed_server');
          assert.deepEqual(restoredHandler.app.repositories[owners[name]].database.prepare('SELECT * FROM kv ORDER BY space,key').all(),restoredRows);
          assert(!restoredHandler.trace.some(row=>row.method!=='GET'),'restored server receives no mutating request');
        }else{
          assert.match(recoveryStatus,new RegExp(`^자동 복구 완료 · 현재 모드: ${resumeMigration?'서버':'플러그인'} 단독`));
          assert.match(recoveryStatus,/끝나지 않은 전환 작업/,'the report names the older job it cleared');
        }
        if(recoveryKind==='missing_destination'){
          const job=JSON.parse(s.values.get(snapshot.jobKey));
          assert(Object.values(job.checkpoints).some(row=>row.copiedMissingRecords>0),'resume must fill the absent payload behind the already-saved server route');
        }
        if(recoveryKind==='maintenance'){
          assert.equal(maintenanceObserved,true);assert.match(maintenancePhase,/서버 작업 종료 대기/);
        }

        if (name === 'Flashback') {
          await until(
            () => s.doc.querySelector('.page[data-page="lab"]')?.classList.contains('is-active'),
            'Flashback returns to overview tab after transition completion',
            8000
          );
          const notice = s.doc.querySelector('#flashbackStorageTransitionNotice');
          assert.ok(!notice || notice.hidden === true, 'Flashback hides transition notice after recovery');
        } else if (name === 'LIBRA') {
          await until(
            () => s.doc.querySelector('.page[data-page="desk"]')?.classList.contains('is-active'),
            'LIBRA returns to reading desk after transition completion',
            8000
          );
        } else if (name === 'HAYAKU') {
          await until(
            () => s.doc.querySelector('[data-hayaku-viewer-panel="overview"]')?.classList.contains('is-active'),
            'HAYAKU returns to overview page after transition completion',
            8000
          );
          const notice = s.doc.querySelector('#hayakuStorageTransitionNotice');
          assert.ok(!notice || notice.hidden === true, 'HAYAKU hides transition notice after recovery');
        }

        results.push({ name, kind, recoveryKind, status: 'PASS' });
        console.log(`PASS ${name} (${kind}, ${recoveryKind}): GUI button registered, memory read protected, recovery action completed, and normal screen restored`);
      } finally {
        clearTimeout(maintenanceTimer);
        try { await s?.close?.(); } catch (_) {}
        try { await handler.close(); } catch (_) {}
        try { await restoredHandler?.close(); } catch (_) {}
      }
    }
  }
  assert.equal(results.length, ownerEntries.length * kinds.length * recoveryKinds.length);
  } finally {
    clearInterval(keepAlive);
  }
});
