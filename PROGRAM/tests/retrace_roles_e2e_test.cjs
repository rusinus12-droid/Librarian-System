'use strict';
// RE:TRACE end-to-end verification — its two declared roles, EXECUTING the real plugin.
//
// RE:TRACE's header states what it is:
//   //@name flashback_hayaku_bridge
//   //@display-name RE:TRACE
//   //@description  LIBRA, HAYAKU, Flashback, and LIA next-session handoff and Librarian System server control
//
// so there are exactly two roles to verify end to end:
//   (1) SERVER CONTROL (관제창) — it reads the memory state of the four owners and the state of
//       the Memory Suite server behind them.
//   (2) SESSION HANDOFF BRIDGE (세션 승계) — it drives a next-session handoff to each owner over
//       each owner's own IPC channel, and refuses when a precondition fails.
//
// Why this test exists: the existing RE:TRACE suites either read the plugin source as TEXT
// (`retrace_server_handoff_test`, `retrace_gui_ux_contract_test`) or slice a function out of it and
// drive it against stub objects (`retrace_server_control_flow_test`). Nothing executes the plugin
// against a real server while a real peer plugin answers its IPC. This does.
//
// The harness (`hayaku_runtime_harness.cjs` with `loadRetrace: true`) boots the real HAYAKU plugin and
// the real RETRACE.js into ONE VM context over a shared host, so RE:TRACE's `postPluginChannelMessage`
// reaches HAYAKU's real listener. That shared-host routing is how the harness models the host IPC bus:
// it infers the sender from the destination, and RE:TRACE's own plugin id is `flashback_hayaku_bridge`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createMemorySuiteServer } = require('../server/server.cjs');

const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');
const RETRACE = fs.readFileSync(path.join(PLUGINS_DIR, 'RETRACE.js'), 'utf8');

// The owners RE:TRACE declares, and the wire endpoints it uses for each. Read from the plugin so the
// test cannot drift: a channel renamed in RETRACE.js fails here rather than passing silently.
const OWNERS = Object.freeze([
  { key: 'libra', id: 'libra', request: 'libra_memory_bridge_request_v1' },
  { key: 'flashback', id: 'flashback_memory', request: 'flashback_memory_bridge_request_v1' },
  { key: 'hayaku', id: 'hayaku_locator_continuity', request: 'hayaku_memory_bridge_request_v1' },
  { key: 'lia', id: 'lia_persona_linker', request: 'lia_persona_handoff_request_v1' }
]);

const observations = { roles: {}, controlPanel: {}, handoff: {} };

// ------------------------------------------------------------------------------------------------
// Static premises: the declared roles and the IPC surface. These are the PRECONDITION for the
// executed checks below, not the evidence for them.
// ------------------------------------------------------------------------------------------------
{
  const header = RETRACE.slice(0, RETRACE.indexOf('const ') > 0 ? RETRACE.indexOf('const ') : 4000);
  observations.roles.pluginId = RETRACE.match(/^\/\/@name (.+)$/m)?.[1]?.trim() || null;
  observations.roles.displayName = RETRACE.match(/^\/\/@display-name (.+)$/m)?.[1]?.trim() || null;
  observations.roles.declaresHandoffAndServerControl = /next-session handoff and Librarian System server control/i.test(header);
  observations.roles.version = RETRACE.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1] || null;
  observations.roles.allowedIpc = (RETRACE.match(/^\/\/@allowed-ipc (.+)$/gm) || []).map(line => line.replace('//@allowed-ipc ', '').trim());

  observations.roles.channelsDeclared = {};
  for (const owner of OWNERS) {
    // The request channel appears in RETRACE with an owner-specific constant name.
    const constant = owner.key === 'lia' ? 'LIA_IPC_REQUEST_CHANNEL'
      : `${owner.key === 'flashback' ? 'FLASHBACK' : owner.key.toUpperCase()}_IPC_REQUEST_CHANNEL`;
    observations.roles.channelsDeclared[owner.key] = {
      constant,
      declaredInPlugin: RETRACE.includes(`${constant} = '${owner.request}'`)
    };
    assert.equal(observations.roles.channelsDeclared[owner.key].declaredInPlugin, true,
      `RE:TRACE must declare ${constant} = '${owner.request}'`);
  }
  assert.equal(observations.roles.declaresHandoffAndServerControl, true,
    'RE:TRACE must declare both roles (next-session handoff + server control)');
}

// The modes RE:TRACE itself declares as handoff-capable (HANDOFF_STORAGE_MODES in the plugin).
const MODES = ['plugin_only', 'server_only'];
observations.modesDeclared = RETRACE.includes("HANDOFF_STORAGE_MODES = Object.freeze(['plugin_only', 'server_only'])");

async function runMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `retrace-roles-e2e-${mode}-`));
  let app = null;
  let runtime = null;
  try {
    // --------------------------------------------------------------------------------------------
    // Real server, real HAYAKU + real RE:TRACE in one context, real HTTP between them.
    // --------------------------------------------------------------------------------------------
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const url = `http://127.0.0.1:${address.port}`;

    // Seed the HAYAKU ledger the way a real chat does it: hidden packet messages in the transcript,
    // reconciled through the plugin's own topology path. A bare packet object is not captured.
    const messages = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      messages.push({ role: 'user', chatId: `u${turn}`, data: `User ${turn}` });
      messages.push({ role: 'char', chatId: `a${turn}`, data: hiddenPacketMessage(`Assistant ${turn}`, createValidPacket({ turn })) });
    }
    const pluginStorage = createStore();
    const safeLocalStorage = createStore();

    // Record every IPC message the plugin posts, so the assertions can name what actually left
    // RE:TRACE rather than trusting a return value.
    const postedMessages = [];
    const originalPost = null;

    runtime = await createHayakuRuntime({
      autoRepair: false,
      loadRetrace: true,
      messages,
      pluginStorage,
      safeLocalStorage,
      arguments: {
        memory_suite_server_mode: mode,
        memory_suite_server_url: url
      },
      nativeFetch: (target, init) => fetch(target, init),
      beforeRetraceLoad: async (host) => {
        // Wrap the shared host so RE:TRACE's IPC is observable. The plugin reads
        // `api.postPluginChannelMessage` at call time, so patching the host here is enough.
        const inner = host.postPluginChannelMessage.bind(host);
        host.postPluginChannelMessage = async (target, channel, message) => {
          postedMessages.push({ target: String(target || ''), channel: String(channel || ''), message });
          return await inner(target, channel, message);
        };
        return undefined;
      }
    });

    // Fill the HAYAKU ledger through its own reconciliation path.
    {
      const scope = await runtime.hayaku._test.currentChatScope();
      await runtime.hayaku._test.reconcileObservedChatTopology(
        scope,
        runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope),
        'retrace_roles_e2e_seed'
      );
    }

    const retrace = runtime.retrace;
    assert.ok(retrace, 'RE:TRACE must expose its public API after load');
    observations.roles.loadedVersion = retrace.version || null;
    observations.roles.exposedSurface = Object.keys(retrace).sort();

    // --------------------------------------------------------------------------------------------
    // ROLE 1 — SERVER CONTROL (관제창). It must see the memory state behind the server.
    // --------------------------------------------------------------------------------------------
    const controlPanel = {};

    // (a) The server side it manages answers it. `/health` is the unauthenticated liveness route the
    //     panel probes first; the data routes require the plugin bootstrap token, so they are exercised
    //     through the owner IPC below (where the plugin itself supplies its credentials) rather than
    //     by this test forging a request.
    const serverRoutes = {};
    {
      const response = await fetch(url + '/health', { method: 'GET' });
      const body = await response.json().catch(() => ({}));
      serverRoutes.health = { status: response.status, ok: response.ok, server: body?.name || '', version: body?.version || '' };
      assert.ok(response.ok, `control panel health route must answer 2xx (got ${response.status})`);
    }
    {
      // An unauthenticated data route must be REFUSED, which is what makes the panel's own
      // authenticated path meaningful: if this returned 200 the auth gate would be absent.
      const response = await fetch(url + '/v1/integrity?namespace=libra', { method: 'GET' });
      serverRoutes.integrityUnauthenticated = { status: response.status, refused: response.status === 401 || response.status === 403 };
      assert.ok([401, 403].includes(response.status),
        `the panel's data routes must require authentication (got ${response.status})`);
    }
    controlPanel.serverRoutes = serverRoutes;

    // (b) It reads the HAYAKU owner through its OWN IPC and reports what came back.
    const hayakuOwnerStatus = await retrace._test.requestMemorySuiteOwnerStorageStatus('hayaku');
    controlPanel.hayakuOwnerStatus = {
      installed: hayakuOwnerStatus.installed,
      connected: hayakuOwnerStatus.connected,
      mode: hayakuOwnerStatus.mode,
      supported: hayakuOwnerStatus.supported,
      state: hayakuOwnerStatus.state
    };
    // The peer plugin is really loaded here, so a failure to reach it is a defect, not a skip.
    assert.equal(hayakuOwnerStatus.installed, true, 'RE:TRACE must see the installed HAYAKU owner');
    assert.equal(hayakuOwnerStatus.connected, true, 'RE:TRACE must reach HAYAKU over its real IPC channel');
    assert.ok(hayakuOwnerStatus.mode, `HAYAKU must report a storage mode (got '${hayakuOwnerStatus.mode}')`);

    // (c) Handoff inspection still reads the live owner, without a standalone viewer API.
    assert.equal(retrace.readHayakuViewer, undefined, 'standalone viewer API is retired');
    const hayakuViewer = (await retrace.inspectTransition()).hayaku;
    controlPanel.hayakuViewer = {
      available: hayakuViewer?.available,
      pluginAvailable: hayakuViewer?.pluginAvailable,
      readSource: hayakuViewer?.readSource,
      packetCount: Array.isArray(hayakuViewer?.packets) ? hayakuViewer.packets.length : null,
      reason: hayakuViewer?.reason || ''
    };
    assert.equal(hayakuViewer?.available, true,
      `handoff inspection must report an available source (got ${JSON.stringify(controlPanel.hayakuViewer)})`);

    observations.controlPanel = controlPanel;  // last mode wins for the summary fields

    // --------------------------------------------------------------------------------------------
    // ROLE 2 — SESSION HANDOFF BRIDGE (세션 승계). It must speak to all four owners, and must
    //          report honestly for owners that do not answer.
    // --------------------------------------------------------------------------------------------
    const handoff = { attempted: {}, pendingInspection: null, storageGate: null };

    // (a) Every owner it declares gets a real IPC request. HAYAKU answers; the three plugins that
    //     are not loaded in this harness must be reported as not-connected rather than as a crash.
    for (const owner of OWNERS) {
      const before = postedMessages.length;
      const status = await retrace._test.requestMemorySuiteOwnerStorageStatus(owner.key);
      const sent = postedMessages.slice(before).filter(item => item.target === owner.id && item.channel === owner.request);
      handoff.attempted[owner.key] = {
        ipcSent: sent.length > 0,
        target: owner.id,
        channel: owner.request,
        action: sent[0]?.message?.action || null,
        schema: sent[0]?.message?.schema || null,
        kind: sent[0]?.message?.kind || null,
        answered: status.connected === true,
        mode: status.mode || '',
        state: status.state || ''
      };
      assert.ok(sent.length > 0,
        `${owner.key}: RE:TRACE must send a real IPC request on ${owner.request}`);
      assert.equal(sent[0].message.action, 'memory_suite_storage_status',
        `${owner.key}: the status request must use the memory_suite_storage_status action`);
      assert.equal(sent[0].message.kind, 'request', `${owner.key}: the IPC message kind must be 'request'`);
      assert.ok(sent[0].message.requestId, `${owner.key}: the IPC request must carry a correlation id`);
    }
    // The loaded peer answers; the three absent peers report not-connected without throwing.
    assert.equal(handoff.attempted.hayaku.answered, true, 'the loaded HAYAKU peer must answer RE:TRACE');
    for (const key of ['libra', 'flashback', 'lia']) {
      assert.equal(handoff.attempted[key].answered, false,
        `${key} is not loaded in this harness, so it must be reported as not connected`);
      assert.notEqual(handoff.attempted[key].state, 'unsupported',
        `${key}: an absent peer must not be misreported as unsupported`);
    }

    // (b) The pending-handoff journal it would resume from is readable and honest when empty.
    const pending = await retrace.inspectPendingNextSessionHandoff();
    handoff.pendingInspection = {
      hasPending: pending?.pending === true,
      hasJournal: !!pending?.journal,
      targetChatId: pending?.targetChatId || ''
    };
    assert.equal(typeof pending?.pending, 'boolean', 'inspectPendingNextSessionHandoff must report a boolean pending flag');

    // (c) The storage gate it enforces before any cross-session transfer is computed from the real
    //     owners, and it must not claim readiness for owners that are absent.
    const gate = await retrace._test.inspectMemorySuiteOwnerStorageGate();
    handoff.storageGate = {
      ready: gate?.ready,
      commonMode: gate?.commonMode || '',
      reason: gate?.reason || '',
      rowCount: Array.isArray(gate?.rows) ? gate.rows.length : null,
      owners: Array.isArray(gate?.rows) ? gate.rows.map(row => ({ owner: row.owner, installed: row.installed, mode: row.mode })) : []
    };
    // Four legacy IPC peers above remain covered; the current readiness inventory also
    // includes WM. This fixture does not load WM, so its row must stay absent/nonparticipating.
    assert.deepEqual(Array.from(handoff.storageGate.owners,row=>row.owner),['flashback','hayaku','libra','lia','wm'],'current five-owner readiness inventory');
    const wmRow=gate.rows.find(row=>row.owner==='wm');assert.equal(wmRow.installed,false);assert.equal(wmRow.connected,false);assert.equal(wmRow.supported,false);

    // The gate's contract, read from `memorySuiteOwnerStorageGateFromRows` in the plugin: it judges
    // the owners that are INSTALLED AND ANSWERING. An owner that is not installed is not a blocking
    // condition — `continueToNextSession` words the requirement as "the storage gate of the installed,
    // responding owners" — so readiness is a claim about the participants, not about all five inventory rows.
    // What must hold is that readiness AGREES with the participants it reports.
    const rows = Array.isArray(gate?.rows) ? gate.rows : [];
    const participants = rows.filter(row => row.connected === true && row.supported === true);
    const modes = [...new Set(participants.map(row => row.mode).filter(mode => mode))];
    const allSameMode = participants.length > 0 && modes.length === 1;
    handoff.storageGate.invariant = {
      participantOwners: participants.map(row => row.owner),
      absentOwners: rows.filter(row => row.installed !== true).map(row => row.owner),
      distinctParticipantModes: modes,
      allSameMode
    };
    assert.ok(allSameMode,
      `every participating owner must report the same handoff mode: ${JSON.stringify(handoff.storageGate.invariant)}`);
    assert.equal(gate?.commonMode, modes[0],
      `the gate's commonMode must be the mode every participant reports (got '${gate?.commonMode}')`);
    assert.equal(gate?.ready, true,
      `the gate must be ready when every participating owner reports the same mode: ${JSON.stringify(handoff.storageGate)}`);

    // (d) NEGATIVE CONTROL — the gate must refuse, not just accept. Driving the real gate function
    //     with owner rows that cannot hand off proves the readiness assertion above is measuring the
    //     gate rather than a function that answers `ready` unconditionally.
    const gateFromRows = retrace._test.memorySuiteOwnerStorageGateFromRows;
    assert.equal(typeof gateFromRows, 'function', 'the gate function must be reachable for the negative control');
    const mixedRows = [
      { owner: 'flashback', installed: true, connected: true, supported: true, mode: 'plugin_only' },
      { owner: 'hayaku', installed: true, connected: true, supported: true, mode: 'server_only' }
    ];
    const refused = gateFromRows(mixedRows, null);
    handoff.negativeControl = { ready: refused?.ready, reason: refused?.reason, commonMode: refused?.commonMode };
    assert.equal(refused?.ready, false, 'mixed per-owner modes still require server integrity evidence');
    assert.equal(refused?.reason, 'server_integrity_not_checked',
      `missing server integrity must be reported as such (got '${refused?.reason}')`);
    assert.equal(refused?.commonMode, 'per_owner', 'the current contract permits independently selected owner modes');
    const verifiedMixed=gateFromRows(mixedRows,{hayaku:{verified:true}});
    assert.equal(verifiedMixed.ready,true);assert.equal(verifiedMixed.commonMode,'per_owner');
    const failedMixed=gateFromRows(mixedRows,{hayaku:{verified:false}});
    assert.equal(failedMixed.ready,false);assert.equal(failedMixed.reason,'owner_server_integrity_failed');
    const refusedEmpty = gateFromRows([], null);
    assert.equal(refusedEmpty?.ready, false, 'a gate with no active owner must not be ready');
    assert.equal(refusedEmpty?.reason, 'no_active_memory_owner',
      `an empty gate must report no_active_memory_owner (got '${refusedEmpty?.reason}')`);

    observations.handoff = handoff;

    return {
      mode,
      serverRoutes,
      hayakuOwnerStatus: controlPanel.hayakuOwnerStatus,
      hayakuViewer: controlPanel.hayakuViewer,
      ownerIpcRequests: Object.keys(handoff.attempted).length,
      ownerAnswered: Object.values(handoff.attempted).filter(item => item.answered).length,
      attempts: handoff.attempted,
      storageGate: handoff.storageGate,
      negativeControl: handoff.negativeControl
    };
  } finally {
    await runtime?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  assert.equal(observations.modesDeclared, true,
    'RE:TRACE must declare the two operational handoff modes');
  const perMode = {};
  for (const mode of MODES) {
    perMode[mode] = await runMode(mode);
  }
  observations.perMode = perMode;
  // Every mode RE:TRACE declares must reach the same verdict: the loaded peer answers, the absent
  // peers are reported absent, and handoff inspection reads a loaded source. A mode where the panel or the
  // bridge behaves differently is the defect this loop exists to catch.
  for (const mode of MODES) {
    const report = perMode[mode];
    assert.equal(report.hayakuOwnerStatus.mode, mode,
      `${mode}: the owner must report the mode it was booted with (got '${report.hayakuOwnerStatus.mode}')`);
    assert.equal(report.hayakuViewer.available, true,
      `${mode}: handoff inspection must read an available HAYAKU source`);
    assert.equal(report.ownerIpcRequests, 4,
      `${mode}: all four owners must be contacted`);
  }
  const modesReported = MODES.map(mode => perMode[mode].hayakuOwnerStatus.mode);
  assert.deepEqual([...new Set(modesReported)].sort(), [...MODES].sort(),
    `the two runs must actually exercise two different modes (got ${JSON.stringify(modesReported)})`);

  process.stdout.write(`${JSON.stringify({
    test: 'retrace_roles_e2e',
    executed: {
      modes: MODES.length,
      serverRoutes: Object.keys(perMode.plugin_only.serverRoutes).length,
      ownerIpcRequestsPerMode: 4,
      handoffSourceReadEveryMode: MODES.every(mode => perMode[mode].hayakuViewer.available === true)
    },
    observations
  }, null, 1)}\n`);
  process.stdout.write('retrace_roles_e2e_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
