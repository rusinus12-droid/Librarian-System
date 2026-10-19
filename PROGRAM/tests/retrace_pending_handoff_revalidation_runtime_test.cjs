'use strict';

// Exercise the deployed owners and public handoff. Only host faults/readback
// observations are injected; reconciliation and owner verification stay intact.
const assert = require('node:assert/strict');
const { run } = require('./fixtures/retrace_u1_owner_writer_fixture.cjs');

const exercise = async (booted, host, result) => {
  const api = booted.retrace;
  const initial = await api.inspectPendingNextSessionHandoff();
  assert.equal(result.ok, false);
  assert.equal(initial.journal.state, 'pending_owner_handoffs');
  assert.equal(initial.journal.ownerStatus.lia.verified, true);
  assert.equal(initial.journal.ownerStatus.hayaku.verified, false);
  assert.equal(host.faults.ledgerCorrupted, true, 'real target ledger fault ran');
  host.faults.corruptTargetLedger = false;
  await host.pluginStorage.setItem(host.faults.targetLedgerKey, host.faults.savedTargetLedgerRaw);
  const recovery = await api.adoptHayakuSessionHandoff({ targetChatId: initial.targetChatId,
    transferId: initial.journal.transferId, sourceScopeKey: initial.bridge.sourceHayakuScopeKey,
    expectedRecords: 5, attempts: 1 });
  assert.equal(recovery.verified, true, 'delayed HAYAKU owner finishes independently');
  assert.equal((await api.inspectPendingHandoffDurableStatus(initial)).hayaku.verified, true);

  const target = () => host.chats.find(chat => chat.id === initial.targetChatId);
  const livePersonaId = target().bindedPersona;
  const values = host.pluginStorage.values;
  const source = host.chats.find(chat => chat.id === initial.bridge.sourceChatId);
  const sourceBefore = JSON.stringify(source);
  const traffic = [];
  const send = host.postPluginChannelMessage;
  host.postPluginChannelMessage = async function (peer, channel, message) {
    traffic.push({ channel, action: message?.action, kind: message?.kind });
    return await send.call(this, peer, channel, message);
  };
  let providerCalls = 0;
  const provider = host.runLLMModel;
  host.runLLMModel = async (...args) => { providerCalls += 1; return await provider(...args); };
  const pending = async owner => {
    // Deliberately reuse the original GUI preview. The product must reload it.
    await api.reconcilePendingHandoffJournalFromDurableReadback(initial);
    const current = await api.inspectPendingNextSessionHandoff();
    assert.equal(current.pending, true, `${owner}: remains resumable`);
    assert.equal(current.journal.state, 'pending_owner_handoffs');
    assert.equal(current.journal.ownerStatus[owner].verified, false);
    assert.equal(current.journal.completedAt, 0);
    return current;
  };
  const cases = [];

  target().bindedPersona = 'other-native-persona';
  await pending('lia');
  assert.equal(target().bindedPersona, 'other-native-persona', 'refresh never silently rebinds Persona');
  cases.push('current LIA binding rejects stale success');
  target().bindedPersona = livePersonaId;

  const fbReceipt = initial.journal.ownerStatus.flashback.receipt;
  const fbRow = [...values].find(([, raw]) => {
    try { const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return value?.scopeKey === fbReceipt.targetScopeKey && value?.copyTransferId === initial.journal.transferId;
    } catch (_) { return false; }
  });
  assert.ok(fbRow, 'target Flashback manifest located from owner identity');
  const fb = typeof fbRow[1] === 'string' ? JSON.parse(fbRow[1]) : structuredClone(fbRow[1]);
  fb.copyAdoptedComplete = false;
  values.set(fbRow[0], JSON.stringify(fb));
  await pending('flashback');
  values.set(...fbRow);
  cases.push('current Flashback target rejects stale success');

  const libraScope = (await booted.context.__LIBRA__.getHostLineageStatus()).scopeKey;
  const libraKey = `libra:v1:scope:${libraScope}:manifest`;
  const libraRaw = values.get(libraKey);
  assert.ok(libraRaw, 'target LIBRA manifest exists');
  const libra = typeof libraRaw === 'string' ? JSON.parse(libraRaw) : structuredClone(libraRaw);
  libra.lastSessionHandoff.transferId += '-changed';
  values.set(libraKey, JSON.stringify(libra));
  await pending('libra');
  values.set(libraKey, libraRaw);
  cases.push('current LIBRA target rejects stale success');

  const hyKey = host.faults.targetLedgerKey;
  const hyRaw = values.get(hyKey);
  const hy = typeof hyRaw === 'string' ? JSON.parse(hyRaw) : structuredClone(hyRaw);
  hy.archiveRef.recordCount += 1;
  values.set(hyKey, JSON.stringify(hy));
  await pending('hayaku');
  values.set(hyKey, hyRaw);
  cases.push('current HAYAKU target rejects stale success');

  // A fresh LIA check must happen after the other owner reads, not before them.
  let drifted = false;
  const drift = message => {
    if (message.action === 'verify_session_handoff' && message.ok === true) {
      drifted = true; target().bindedPersona = 'other-native-persona';
    }
  };
  host.listeners.get('libra_memory_bridge_response_v1').add(drift);
  try { await pending('lia'); } finally { host.listeners.get('libra_memory_bridge_response_v1').delete(drift); }
  assert.equal(drifted, true, 'binding drift occurs during a real owner read');
  target().bindedPersona = livePersonaId;
  cases.push('binding drift during another owner read is rejected');

  // A concurrent owner retry must not have its journal overwritten by the GUI.
  let updated = false;
  const concurrent = async message => {
    if (!updated && message.action === 'verify_session_handoff' && message.ok === true) {
      updated = true;
      // Model another host writer using the journal's public FNV-1a envelope.
      // This also runs against Min, which removes private _test helpers.
      const journal = structuredClone(target().memorySessionBridge.handoffJournal);
      delete journal.journalDigest;
      journal.attempts = 42;
      journal.lastError = 'concurrent_retry';
      let hash = 14695981039346656037n;
      const payload = JSON.stringify(journal);
      for (let index = 0; index < payload.length; index += 1) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(payload.charCodeAt(index))) * 1099511628211n);
      }
      journal.journalDigest = `h64${hash.toString(36)}`;
      target().memorySessionBridge.handoffJournal = journal;
      assert.equal((await api.inspectPendingNextSessionHandoff()).available, true, 'concurrent host journal is valid');
    }
  };
  host.listeners.get('libra_memory_bridge_response_v1').add(concurrent);
  try {
    await assert.rejects(() => api.reconcilePendingHandoffJournalFromDurableReadback(initial),
      error => error.code === 'RETRACE_HOST_WRITE_CONFLICT');
  } finally { host.listeners.get('libra_memory_bridge_response_v1').delete(concurrent); }
  assert.equal(updated, true);
  assert.equal((await api.inspectPendingNextSessionHandoff()).journal.attempts, 42);
  cases.push('concurrent journal retry preserved');

  const complete = await api.reconcilePendingHandoffJournalFromDurableReadback(initial);
  if (complete.pending) console.error('REVALIDATION_COMPLETION_DIAGNOSTIC', JSON.stringify(Object.fromEntries(
    Object.entries(complete.journal.ownerStatus).map(([owner, status]) => [owner,
      { verified: status.verified, reason: status.reason, error: status.receipt?.error, diagnostics: status.receipt?.diagnostics, verification: status.verification }]))));
  assert.equal(complete.journal.state, 'completed');
  assert.equal(complete.pending, false);
  for (const owner of ['flashback', 'hayaku', 'libra', 'lia']) {
    assert.equal(complete.journal.ownerStatus[owner].required, true);
    assert.equal(complete.journal.ownerStatus[owner].verified, true, `${owner}: fresh verified receipt`);
  }
  assert.equal(complete.journal.ownerStatus.lia.receipt.livePersonaId, livePersonaId, 'fork identity survives failed checks');
  assert.equal((await api.reconcilePendingHandoffJournalFromDurableReadback(initial)).reconciled, false,
    'stale GUI preview cannot reopen a completed handoff');
  assert.equal(JSON.stringify(host.chats.find(chat => chat.id === source.id)), sourceBefore);
  assert.equal(providerCalls, 0, 'readback spends no provider calls');
  assert.equal(traffic.filter(row => row.kind === 'request' &&
    /^(?:adopt_|prepare_|memory_suite_prepare)/.test(row.action || '')).length, 0,
    'GUI reconciliation only reads owner data');
  cases.push('restored owners complete same target without adoption or model calls');
  console.log('PENDING_REVALIDATION_RESULT ' + JSON.stringify({ cases, state: complete.journal.state, providerCalls }));
};

run({ transformHarness(source) {
  const replace = (before, after) => {
    assert.ok(source.includes(before), `public fixture seam changed: ${before.slice(0, 80)}`);
    source = source.replace(before, after);
  };
  if (process.env.RETRACE_TEST_PLUGIN) replace(
    "let pluginSource = fs.readFileSync(path.join(root, 'plugins', file), 'utf8');",
    "let pluginSource = fs.readFileSync(file === 'RETRACE.js' ? process.env.RETRACE_TEST_PLUGIN : path.join(root, 'plugins', file), 'utf8');");
  replace('      faults.ledgerCorrupted = true;',
    "      faults.savedTargetLedgerRaw = typeof raw === 'string' ? raw : JSON.stringify(raw);\n      faults.ledgerCorrupted = true;");
  replace("if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records) || parsed.records.length === 0) return;",
    "if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records) || (parsed.records.length === 0 && !parsed.archiveRef)) return;");
  replace('      parsed.records.pop();',
    '      if (parsed.archiveRef) parsed.archiveRef.recordCount += 1; else parsed.records.pop();');
  replace('      const seeded = await seedOwners(booted.context, host);',
    '      const seeded = await seedOwners(booted.context, host);\n      host.faults.corruptTargetLedger = true;');
  const marker = "      observations.cases.push({\n        case: 'public_normal_flow',";
  replace(marker, `      await (${exercise.toString()})(booted, host, result);\n      return;\n${marker}`);
  return source;
} });
