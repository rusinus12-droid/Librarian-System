'use strict';
// Verifies that a pending/paused global storage transition (__memory_suite_internal_sync_job_v1__:<owner>)
// keeps owner memory reads protected while still registering GUI entry buttons, opening each plugin's
// real GUI directly on the server/storage recovery panel, and transitioning back to the normal view
// once the storage transition completes.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { create, pause, until, META } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const { createHandlerFixture } = require('./fixtures/shared_reanalysis_handler_fixture.cjs');

const owners = {
  Flashback: 'flashback',
  LIBRA: 'libra',
  HAYAKU: 'hayaku'
};

const artifactRoot = process.env.GLOBAL_MODE_ARTIFACT_ROOT;
const kinds = artifactRoot ? ['Full', 'Min'] : ['Full'];
const recoveryKinds=['migration', 'legacy_rollback', 'legacy_rollback_resume', 'expired_rollback', 'restored_server', 'restored_witness', 'missing_destination'];

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
    await s.click('.topbar [data-go="settings"]');
    await until(() => s.doc.querySelector('.setnav [data-subtab="store"]'), 'LIBRA settings store subtab');
    await s.click('.setnav [data-subtab="store"]');
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

async function createPausedGlobalTransitionSnapshot(name, kind, pluginPath, handler) {
  const jobKey = `__memory_suite_internal_sync_job_v1__:${owners[name]}`;
  let capturedPausedJob = null;
  const s = await create(name, kind, {
    pluginPath,
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
  try {
    await openServerPanelNormally(s);
    const selectServerMode = () => {
      const input = s.doc.querySelector('input[value="server_only"]');
      assert.ok(input, `${name}: server_only radio must exist`);
      input.checked = true;
      input.dispatchEvent(new s.dom.window.Event('change', { bubbles: true }));
    };
    const approveApply = async () => {
      selectServerMode();
      const applyBtn = s.doc.querySelector('[data-apply]');
      const pending = applyBtn.onclick();
      await until(
        () => s.doc.querySelector('[data-mode-confirm-approve]')?.onclick
          || (s.doc.querySelector('[data-status]')?.textContent || '').includes('inventory_changed_during_preview'),
        `${name}: migration approval or fresh preview`
      );
      const approveBtn = s.doc.querySelector('[data-mode-confirm-approve]');
      if (approveBtn?.onclick) approveBtn.click();
      await pending;
    };
    await approveApply();
    if ((s.doc.querySelector('[data-status]')?.textContent || '').includes('inventory_changed_during_preview')) {
      await settleOwnerStore(s);
      await approveApply();
    }
    assert.ok(capturedPausedJob, `${name}: must capture in-flight global_mode sync job journal`);
    const stoppedJob = JSON.parse(s.values.get(jobKey));
    assert.equal(stoppedJob.status, 'paused', `${name}: the original migration must actually stop before the reload`);
    assert.equal(Object.keys(stoppedJob.checkpoints || {}).length, 0, `${name}: interruption occurs before scope completion`);
    const snapshotEntries = [...s.values.entries()];
    const map = new Map(snapshotEntries);
    map.set(jobKey, capturedPausedJob);
    return { entries: [...map.entries()], deviceEntries: [...s.deviceValues.entries()], jobKey };
  } finally {
    await s.close();
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
  const results = [];
  for (const [name] of Object.entries(owners)) {
    for (const kind of kinds) for (const recoveryKind of recoveryKinds) {
      const restoredServer=recoveryKind.startsWith('restored_');
      const resumeMigration=['migration','missing_destination'].includes(recoveryKind);
      const handler = createHandlerFixture();
      const pluginPath = artifactRoot
        ? path.join(artifactRoot, kind, META[name][0])
        : path.resolve(__dirname, '../plugins', META[name][0]);
      let s,restoredHandler,restoredRows;
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
          return await (restoredHandler||handler).nativeFetch(...args);
        };

        s = await create(name, kind, {
          pluginPath,
          separateLocalStorage: true,
          initialValues: snapshot.entries,
          initialDeviceValues: snapshot.deviceEntries,
          args: { memory_suite_server_url: handler.url },
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
            () => s.doc.querySelector('#flashbackMemorySuiteServerConnectionPanel [data-global-resume]'),
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
            () => s.doc.querySelector('#libraMemorySuiteServerConnectionPanel [data-global-resume]'),
            'LIBRA server recovery panel mounted',
            8000
          );
          const settingsPage = s.doc.querySelector('.page[data-page="settings"]');
          assert.ok(settingsPage?.classList.contains('is-active'), 'LIBRA opens directly on settings page during transition');
          const retryBtn = s.doc.querySelector('[data-libra-storage-retry]');
          assert.ok(retryBtn, 'LIBRA renders manual storage retry button');
          assert.equal(retryBtn.textContent, '진행 화면으로 이동');
          retryBtn.click();
          await pause(120);
          assert.ok(
            s.doc.querySelector('.page[data-page="settings"]')?.classList.contains('is-active'),
            'LIBRA stays on settings server recovery panel while transition is still locked'
          );
        } else if (name === 'HAYAKU') {
          await until(
            () => s.doc.querySelector('#hayakuMemorySuiteServerConnectionPanel [data-global-resume]'),
            'HAYAKU server recovery panel mounted',
            8000
          );
          const connectPage = s.doc.querySelector('[data-hayaku-viewer-panel="server"]');
          assert.ok(connectPage?.classList.contains('is-active'), 'HAYAKU opens directly on server connection page during transition');
          const notice = s.doc.querySelector('#hayakuStorageTransitionNotice');
          assert.ok(notice && notice.hidden === false, 'HAYAKU displays storage transition notice');
          assert.match(notice.textContent || '', /저장소 이전 대기/, 'HAYAKU transition notice explains storage transition lock');
        }

        // 4. Re-enable server and resume the global transition from the mounted recovery panel, then verify normal screen recovery.
        allowServer = true;
        const resumeBtn = s.doc.querySelector('button[data-job-retry]');
        assert.ok(resumeBtn && typeof resumeBtn.onclick === 'function', `${name} (${kind}): global resume button must be interactive`);
        assert.equal(resumeBtn.textContent, restoredServer?'기기 원본 확인 후 취소':resumeMigration ? '중단한 이전 재개' : '취소 복구 계속');
        const jump = s.doc.querySelector('[data-global-resume]');
        assert.equal(jump.textContent, '진행 화면으로 이동');
        if (recoveryKind === 'legacy_rollback_resume') {
          await jump.onclick();
          assert.equal(s.doc.activeElement, resumeBtn, 'the advanced route focuses the single primary action');
        }
        let resumed=false;
        const resuming=Promise.resolve(resumeBtn.onclick()).finally(()=>{resumed=true;});
        await until(()=>resumed||typeof s.doc.querySelector('[data-mode-confirm-approve]')?.onclick==='function', `${name}: resume or recheck consent`, 12000);
        const approval=s.doc.querySelector('[data-mode-confirm-approve]');
        if(typeof approval?.onclick==='function'){
          if(restoredServer){
            assert.equal(approval.textContent,'기기 경로 복구로 취소');
            assert.match(s.doc.querySelector('[data-mode-confirm-text]').textContent,/현재 서버.*변경하지|현재 서버에 자료를 전송/);
          }else{
            assert(resumeMigration,'continuing cancellation must not ask to restart server migration');
            assert.match(s.doc.querySelector('[data-mode-confirm-text]').textContent,/새 검사|자료가 변경/);
          }
          approval.click();
        }
        await resuming;
        await until(
          () => {
            const rawJob = s.values.get(snapshot.jobKey);
            if (!rawJob) return false;
            try {
              const parsed = JSON.parse(rawJob);
              return !resumeMigration
                ? parsed.status === 'cancelled' && parsed.rollbackComplete === true && !parsed.error
                : parsed.status === 'completed' && parsed.phase === 'completed';
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
        if(!resumeMigration){
          assert.match(s.doc.querySelector('[data-job-title]').textContent,/취소 복구 완료.*100%/);
          assert.match(s.doc.querySelector('[data-job-time]').textContent,/복구 소요: \d+초/);
          const diagnostics=JSON.parse(s.doc.querySelector('[data-job-diagnostics]').value);
          assert.equal(diagnostics.recoveryState,'complete');
          assert.equal(diagnostics.rollbackProgress.verifiedScopes,diagnostics.rollbackProgress.totalScopes);
          if(restoredHandler){
            assert.equal(diagnostics.rollbackPublication.status,'skipped_changed_server');
            assert.deepEqual(restoredHandler.app.repositories[owners[name]].database.prepare('SELECT * FROM kv ORDER BY space,key').all(),restoredRows);
            assert(!restoredHandler.trace.some(row=>row.method!=='GET'),'restored server receives no mutating request');
          }
        }
        if(recoveryKind==='missing_destination'){
          const job=JSON.parse(s.values.get(snapshot.jobKey));
          assert(Object.values(job.checkpoints).some(row=>row.copiedMissingRecords>0),'resume must fill the absent payload behind the already-saved server route');
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
        try { await s?.close?.(); } catch (_) {}
        try { await handler.close(); } catch (_) {}
        try { await restoredHandler?.close(); } catch (_) {}
      }
    }
  }
  assert.equal(results.length, Object.keys(owners).length * kinds.length * recoveryKinds.length);
});
