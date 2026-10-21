'use strict';
// Current consumer rebinding preserves the historical notes below. Their old
// beforeRequest observation is not a claim about the present Classic route.
// A17/T07 -- DELIVERY OF A SUCCESSOR THAT RECALL DID NOT SELECT.
//
// WHY THIS SUITE WAS REWRITTEN FIVE TIMES, and what review said each time:
//   v1 called the closure helper and matched `/이행/`, which the SUPERSEDED wording also
//      matches, and never touched the request path. Review: not evidence.
//   v2 drove the host `beforeRequest` replacer -- measured to return the input messages
//      UNCHANGED, so that replacer is not the injection channel. Review: measures nothing.
//   v3 built the layer row ITSELF and fed it to the partition/prompt helpers. Review:
//      "실제 제품의 recall -> 패킷 구성 -> 모델 요청 연결이 끊겨도 이 시험은 통과할 수 있다."
//   v4 observed the product's packet but asserted the closure COULD NOT link, on a reading
//      of C24-C25 that review corrected: "분석용 State에서 영속 ID 제거는 교차 배치 연결
//      자체를 금지하는 조항이 아닙니다." `01` section 7.3 names the reference to use.
//   v5 (this file) creates the case the requirement is really about: recall packs ONE
//      memory -- the OPEN promise -- so the LATER artifact that states the outcome is NOT
//      selected. The closure is then the only route by which the outcome can reach the
//      model, so a broken recall -> closure -> packet wiring cannot pass this suite.
//
// Every measurement is taken from the PRODUCT: its own recall, its own closure, and its own
// preflight packet. The test synthesises no memory, no layer row and no prompt fragment.
const assert = require('node:assert/strict');
const { actualClassicPacket, deliveredClosureRows, assertHealthyEmpty, assertOriginalOrdinarySelection } = require('./fixtures/libra_actual_classic_request.cjs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const OLD = '아직 이행되지 않았다';
const NEW = '이행되었다';
const QUESTION = '은빛 열쇠 반환 약속은 아직 이행되지 않았다';
const candidateRowsFromPrompt = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const appendBatch = (f, startTurn) => {
  const extra = f.chat.message.slice(0, 10).map((message, index) => ({
    ...message,
    chatId: `t${startTurn + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}`
  }));
  f.chat.message.push(...extra);
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    const api = f.r.api;
    assert.equal(typeof f.control.hooks.beforeRequest, 'function',
      `${mode}: the product registers the actual retained request consumer`);
    const prompts = [];
    f.control.onCall = args => {
      const rows = candidateRowsFromPrompt(args);
      prompts.push(rows);
      if (prompts.length === 3) {
        const candidate = rows.find(row => row.summary === '은빛 열쇠 반환'
          && JSON.stringify(row.participants) === JSON.stringify([
            { role: 'owner', name: '지호' }, { role: 'target', name: '민아' }
          ]));
        const fact = f.control.artifact?.facts?.find(row => row.tempFactId === 'f12');
        if (candidate?.alias && fact?.values?.thread) fact.values.thread.linkCandidateAlias = candidate.alias;
      }
      return { type: 'success', result: JSON.stringify(f.control.artifact) };
    };

    const shift = n => {
      const a = JSON.parse(JSON.stringify(artifact()));
      a.schema = 'libra.canonical_artifact.v5';
      for (const x of [...a.entities, ...a.facts]) {
        for (const e of x.evidenceSpans || []) e.ref = e.ref.replace(/^t(\d+)/, (_, d) => 't' + (Number(d) + n));
      }
      return a;
    };

    // ── batch 1: the promise is OPEN -- this is what recall will select.
    const first = shift(0);
    const openFact = first.facts.find(x => x.tempFactId === 'f12');
    openFact.values.thread = { summary: '은빛 열쇠 반환', status: 'open', kind: 'promise', participants: [
      { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }
    ] };
    openFact.text = `은빛 열쇠 반환 약속은 ${OLD}.`;
    f.control.artifact = first;
    observation.batch1 = (await f.run()).completed;
    // Capture the actual first committed owner record, not a preview selection.
    const originalScope = (await api.getHostLineageStatus()).scopeKey;
    const physicalRows = mode === 'server_only' ? snapshot.storedRows().map(row => ({key:row.key,value:row.value}))
      : [...snapshot.local.entries()].map(([key,raw]) => { let value; try { value=JSON.parse(raw); } catch {} return {key,value}; });
    const originalManifest = physicalRows.find(row => row.key === `libra:v1:scope:${originalScope}:manifest`)?.value;
    const originalRef = originalManifest?.memories?.['1'];
    assert.ok(originalRef?.key, `${mode}: first committed manifest supplies the original memory address`);
    const originalBody = physicalRows.find(row => row.key === originalRef.key)?.value;
    assert.ok(originalBody?.canonicalArtifact?.facts?.some(fact => fact.text.includes(OLD)),
      `${mode}: the captured original canonical body contains the open promise`);
    for (const field of ['memoryId','revision','sourceDigest','artifactDigest']) {
      assert.equal(originalBody[field], originalRef[field], `${mode}: original body and manifest agree on ${field}`);
    }
    assert.equal(originalBody.scopeKey, originalScope);
    const originalIdentity = {memoryId:String(originalBody.memoryId),revision:Number(originalBody.revision),
      scopeKey:originalScope,memoryKey:originalRef.key,sourceDigest:originalBody.sourceDigest,artifactDigest:originalBody.artifactDigest,
      turnRange:JSON.parse(JSON.stringify(originalRef.turnRange)),sessionEpoch:Number(originalRef.sessionEpoch||0),inherited:originalRef.inheritedSessionHistory===true};


    // ── batch 2: the promise under test is NOT restated. Only the OTHER thread (the question)
    //    is worked, so the promise stays a live open item and the closure is the only thing
    //    that can supply its outcome.
    appendBatch(f, 6);
    const middle = shift(5);
    const midFact = middle.facts.find(x => x.tempFactId === 'f13');
    midFact.values.thread = { summary: '공연 허가자를 알아냈다', status: 'resolved', kind: 'question', link: 'resolve', resolution: 'completed' };
    midFact.text = '공연 허가자가 누구인지 밝혀졌다.';
    f.control.artifact = middle;
    observation.batch2 = (await f.run()).completed;

    // ── batch 3: the promise is fulfilled and DECLARES the link (`01` section 7.3 kind;
    //    T05 stores the validated link on the canonical fact).
    appendBatch(f, 11);
    const later = shift(10);
    const outcomeSourceRow = f.chat.message.find(message => message.chatId === 't15-a');
    const outcomeEvidence = '은빛 열쇠 반환 약속이 이행되었다.';
    const outcomeSource = `${outcomeSourceRow?.data || ''} ${outcomeEvidence}`;
    if (outcomeSourceRow) outcomeSourceRow.data = outcomeSource;
    for (const item of [...later.entities, ...later.facts]) {
      for (const span of item.evidenceSpans || []) if (span.ref === 't15-a') span.quote = outcomeSource;
    }
    const doneFact = later.facts.find(x => x.tempFactId === 'f12');
    doneFact.values.thread = { summary: '은빛 열쇠 반환', status: 'resolved', kind: 'promise', link: 'resolve', resolution: 'fulfilled',
      participants: [ { role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' } ],
    };
    doneFact.evidenceSpans = [{ ref: 't15-a', quote: outcomeEvidence }];
    doneFact.text = `은빛 열쇠 반환 약속이 ${NEW}.`;
    f.control.artifact = later;
    observation.batch3 = (await f.run()).completed;
    assert.equal(observation.batch1 + observation.batch2 + observation.batch3, 3, `${mode}: all three batches commit`);
    observation.candidateBatchCounts = prompts.map(rows => rows.length);
    assert.equal(prompts[2]?.length, 1, `${mode}: the request-local candidate list contains the still-open promise; the separate pending question is not a link target`);
    const promiseCandidate = prompts[2]?.find(row => row.summary === '은빛 열쇠 반환'
      && JSON.stringify(row.participants) === JSON.stringify([
        { role: 'owner', name: '지호' }, { role: 'target', name: '민아' }
      ]));
    assert.ok(promiseCandidate?.alias, `${mode}: the third request receives a fresh role-labelled alias for the promise`);
    assert.notEqual(prompts[1]?.[0]?.alias, prompts[2]?.[0]?.alias,
      `${mode}: accepted successor uses the current request's alias after the previous request's alias expires`);

    // ── constrain recall to ONE memory so the later artifact stays UNSELECTED.
    const current = await api.getLibraMemorySettings?.().catch(() => null);
    await api.saveLibraMemorySettings({ ...(current?.settings || current || {}), recallMaxMemories: 1, unifiedMaxUnits: 1 })
      .catch(error => ({ error: String(error?.message || error) }));

    // ── (1) WHAT RECALL SELECTED -- the product's own selection, not the test's.
    const recall = await api.previewUnifiedMemoryRecall(QUESTION);
    const rows = recall.memories || [];
    observation.selectedCount = rows.length;
    observation.selectedMemoryIds = rows.map(m => m.memory?.memoryId);
    const selectionText = JSON.stringify(rows.map(m => m.excerpt || m.text || ''));
    observation.selectionHasOutcome = selectionText.includes(NEW);
    observation.selectionHasOpenWording = selectionText.includes(OLD);
    assert.equal(observation.selectionHasOpenWording, true,
      `${mode}: the selection carries the OPEN promise the question is about`);
    assert.equal(observation.selectionHasOutcome, false,
      `${mode}: and NOT the outcome -- the artifact stating it is unselected, which makes the closure the only route`);

    // ── (2) THE PRODUCT'S OWN PACKET
    const preflight = await actualClassicPacket(f, QUESTION, rows[0]?.memory?.scopeKey);
    const packet = preflight?.evidencePacket;
    observation.packetPresent = !!packet;
    assert.ok(packet, `${mode}: the product builds a request packet for this input`);
    const layers = packet.layers || {};
    observation.layerSizes = Object.fromEntries(Object.entries(layers).map(([key, value]) => [key, (value || []).length]));
    const packetText = preflight.actualClassic.block;
    const selectedOrdinaryRows = assertOriginalOrdinarySelection(preflight, originalIdentity);
    assert.equal(selectedOrdinaryRows.some(row => String(row.selectedText || row.text || '').includes(NEW)), false,
      `${mode}: no selected ordinary successor supplies the later outcome`);
    const ordinaryRows = preflight.actualClassic.deliveredRows.filter(row => row.closure !== true);
    const ordinaryText = ordinaryRows.map(row => String(row.selectedText || row.text || '')).join('\n');
    assert.equal(new Set(ordinaryRows.map(row => `${row.memoryId}:${row.revision}`)).size, 1,
      `${mode}: this actual request selected only the original memory outside closure`);
    assert.equal(ordinaryText.includes(OLD), true, `${mode}: this request selected the open promise`);
    assert.equal(ordinaryText.includes(NEW), false, `${mode}: ordinary actual selection cannot supply the outcome`);
    const actualClosures = deliveredClosureRows(preflight);
    assert.equal(actualClosures.filter(row => row.text.includes(NEW)).length, 1,
      `${mode}: one validated later closure fact actually reaches the returned block`);
    assert.equal(preflight.actualClassic.viewer.closureInjectedFacts, 1,
      `${mode}: the actual renderer records that one closure admission`);

    // ── (3) THE DELIVERY: the outcome must reach the packet even though the artifact that
    //        states it was never selected. Only the closure can put it there, so this is the
    //        wiring claim review said the earlier versions could not test.
    observation.packetCarriesOutcome = packetText.includes(NEW);
    observation.packetCarriesOpenWording = packetText.includes(OLD);
    observation.closureCount = recall?.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount ?? null;
    observation.closureDiagnostics = recall?.diagnostics?.recallContinuityClosure?.diagnostics || null;
    assert.equal(observation.closureCount, 1,
      `${mode}: only the accepted lifecycle successor is added to Recall closure (${JSON.stringify({ closure: recall?.diagnostics?.recallContinuityClosure, prompts, packet: packet.layers?.memory?.map(row => ({ text: row.text, closure: row.closure, memoryId: row.memoryId })), localThreads:[...snapshot.local.entries()].flatMap(([key,raw])=>{try{const v=JSON.parse(raw);return (v?.canonicalArtifact?.facts||[]).filter(f=>f.claimKind==='thread').map(f=>({key,id:f.tempFactId,value:f.values?.thread}));}catch{return [];}}),serverThreadKeys:snapshot.storedRows().map(row=>row.key).filter(key=>/memory|manifest/.test(key)) })})`);
    assert.equal(observation.packetCarriesOutcome, true,
      `${mode}: the successor recall did NOT select still reaches the packet, so recall -> closure -> packet is wired`);

    // ── (4) the currentness verdict is one of the three honest ones (`01` section 11).
    observation.currentness = recall?.diagnostics?.recallContinuityClosure?.currentness ?? null;
    observation.closureCount = recall?.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount ?? null;
    if (observation.currentness !== null) {
      assert.ok(['current', 'last-known', 'unknown'].includes(observation.currentness),
        `${mode}: the closure reports a real verdict (got ${observation.currentness})`);
    }

    // ── (5) CONTROL: the same question against a store with NO canonical data must carry
    //        neither wording, proving the packet is store-derived rather than canned.
    {
      const control = await serverFixture({ mode });
      try {
        const emptyScope = (await control.f.r.api.getHostLineageStatus()).scopeKey;
        const controlPreflight = await actualClassicPacket(control.f, QUESTION, emptyScope, { allowEmpty: true });
        assertHealthyEmpty(controlPreflight);
        const controlText = controlPreflight.actualClassic.block;
        assert.equal(controlPreflight.actualClassic.deliveredRows.length, 0,
          `${mode}: a fresh healthy empty request has no injected canonical rows`);
        assert.equal(Object.values(controlPreflight.evidencePacket.layers || {}).flat().length, 0,
          `${mode}: the sealed empty result contains no canonical layer evidence`);
        observation.controlPacketCarriesOutcome = controlText.includes(NEW);
        observation.controlPacketCarriesOpenWording = controlText.includes(OLD);
        assert.equal(observation.controlPacketCarriesOutcome, false,
          `${mode}: an empty store's packet does not carry the outcome`);
        assert.equal(observation.controlPacketCarriesOpenWording, false,
          `${mode}: nor the open wording`);
      } finally { await control.cleanup(); }
    }
  } finally { await snapshot.cleanup(); }
  return observation;
};

const run = async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  console.log(JSON.stringify({
    test: 'libra_main_memory_recall_successor_delivery',
    passed: 1,
    boundary: "recall constrained to one memory so the successor stays unselected; the PRODUCT's actual Classic output is then asserted to carry the outcome the unselected later artifact states, with an empty-store control in each mode",
    results
  }));
};
run().catch(error => { console.error(error?.message || error); console.error(error?.stack); process.exit(1); });
