'use strict';
// Phase C: structured profile items, exact scoped mutations and canonical-derived history.
// The deployed plugin and real HTTP/SQLite storage are exercised in every supported mode;
// the local configured-provider fixture supplies deterministic artifacts and captures prompts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { sourceRows } = require('./fixtures/unified_vertical_source.json');

const MODES = process.env.LIBRA_SEMANTIC_HISTORY_MODE
  ? [process.env.LIBRA_SEMANTIC_HISTORY_MODE] : ['plugin_only', 'mirror', 'server_only'];
const clone = value => JSON.parse(JSON.stringify(value));
const storedJsonFieldBytes = (raw, field) => {
  const source = String(raw), marker = `\"${field}\"`;
  const fieldAt = source.indexOf(marker);
  assert.ok(fieldAt >= 0, `stored memory has ${field} field`);
  const colonAt = source.indexOf(':', fieldAt + marker.length);
  let start = colonAt + 1;
  while (/\s/.test(source[start] || '')) start++;
  const opening = source[start];
  assert.ok(opening === '{' || opening === '[', `stored ${field} is a JSON object or array`);
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '\"') quoted = false;
      continue;
    }
    if (char === '\"') { quoted = true; continue; }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`stored ${field} JSON bytes are unterminated`);
};
const pluginSource = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const sourceBetween = (start, end) => {
  const a = pluginSource.indexOf(start); const b = pluginSource.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `plugin source anchors found: ${start} .. ${end}`);
  return pluginSource.slice(a, b);
};
const guiNode = (tag, attrs = {}, children = []) => ({tag, ...attrs, children: children.filter(Boolean)});
const guiFlat = node => Array.isArray(node) ? node.flatMap(guiFlat) : [node, ...(node?.children || []).flatMap(guiFlat)];
const correctionRequestFromShippedEditor = (row, view, nextValues) => {
  const ctx=vm.createContext({
    guiEl:guiNode,guiAsArray:value=>Array.isArray(value)?value:[],guiAsObject:value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{},
    text:value=>String(value??'').trim(),cloneJson:value=>clone(value),worldManagerIsUnified:()=>true,
    worldManagerSupersedableProfileCorrectionId:()=>'',worldManagerArticleFieldLabel:value=>String(value),
    worldManagerArticleValue:value=>String(value??''),worldManagerDisplayReferences:value=>value,queueGuiNavigationRender:()=>{},
    fieldNode:(label,control,note='')=>guiNode('div',{dataset:{field:label}},[guiNode('label',{text:label}),control,note?guiNode('small',{text:note}):null]),
    guiLazyDetails:(attrs,summary,render)=>{const result=render();return guiNode('details',attrs,[summary,...(Array.isArray(result)?result:[result])]);},
    optionNodes:(items,value)=>items.map(([optionValue,label])=>guiNode('option',{value:optionValue,text:label,selected:String(optionValue)===String(value)})),Gui:{},String,Number,Array,Object,JSON
  });
  vm.runInContext(`${sourceBetween('const worldManagerDraftKey =','const worldManagerInput =')}
    ${sourceBetween('const worldManagerInput =','const openWorldManagerCorrectionEditor =')}
    ${sourceBetween('const openWorldManagerCorrectionEditor =','const worldManagerHeadHasCorrection =')}
    ${sourceBetween('const buildUnifiedWorldStateEditor =','const buildWorldManagerIdentityMerge =')}
    Object.assign(globalThis,{openWorldManagerCorrectionEditor,worldManagerCorrectionRequest,buildUnifiedWorldStateEditor});`,ctx);
  ctx.openWorldManagerCorrectionEditor('characters',row,view);
  const draft=ctx.Gui.worldManagerEditDraft;
  const editor=guiNode('div',{},ctx.buildUnifiedWorldStateEditor(draft,view));
  const inputs=guiFlat(editor).filter(node=>node?.dataset?.worldProfileCollectionEditor);
  const displayed=Object.fromEntries(inputs.map(node=>[node.dataset.worldProfileCollectionEditor,node.value??guiFlat(node).map(child=>String(child.text||'')).join(' ')]));
  for(const [field,value] of Object.entries(nextValues||{})){
    const input=inputs.find(node=>node.dataset.worldProfileCollectionEditor===field);
    assert.ok(input,`shipped correction editor has ${field} field`);
    if(field==='boundaries'){
      for(let index=0;index<value.length;index++){
        const row=value[index],fields={content:'worldProfileBoundaryContent',topic:'worldProfileBoundaryTopic',kind:'worldProfileBoundaryKind',targetRef:'worldProfileBoundaryTarget',act:'worldProfileBoundaryAct',when:'worldProfileBoundaryWhen'};
        for(const [key,dataset] of Object.entries(fields)){
          const control=guiFlat(input).find(node=>node?.dataset?.[dataset]===String(index));
          assert.ok(control,`shipped boundary row ${index} has ${key} control`);
          const prior=control.value??'';const desired=key==='targetRef'?row.scope?.targetRef||'':key==='act'||key==='when'?row.scope?.[key]||'':row[key]||'';
          if(String(prior)!==String(desired)){
            if(dataset==='worldProfileBoundaryTarget')control.onChange({target:{value:desired}});
            else control.onInput({target:{value:desired}});
          }
        }
      }
    }else input.onInput({target:{value:JSON.stringify(value)}});
  }
  return {request:ctx.worldManagerCorrectionRequest(draft),displayed};
};
const rowFor = (chat, ref) => (chat.message || []).find(row => row.chatId === ref)
  || sourceRows.find(row => row.ref === ref);
const entityId = (head, name) => head?.characters?.find(row => row.name === name)?.id || '';
const readJson = (snapshot, pattern) => {
  const key = [...snapshot.local.keys()].find(candidate => pattern.test(candidate));
  if (key) { try { return JSON.parse(snapshot.local.get(key)); } catch {} }
  return null;
};
const headOf = snapshot => readJson(snapshot, /:continuity-state$/) || snapshot.getHead();
const allStoredRows = snapshot => {
  const rows = snapshot.storedRows().map(row => ({ key: row.key, raw: row.raw, value: row.value }));
  const seen = new Set(rows.map(row => row.key));
  for (const [key, raw] of snapshot.local.entries()) {
    if (seen.has(key)) continue;
    let value = raw;
    try { value = JSON.parse(raw); } catch {}
    rows.push({ key, raw, value });
  }
  return rows;
};
const manifestOf = snapshot => snapshot.getManifest()
  || allStoredRows(snapshot).find(row => /:manifest$/.test(row.key))?.value || null;
const memoryRows = snapshot => allStoredRows(snapshot)
  .filter(row => /:memory:\d+:/.test(row.key))
  .filter(row => row.value?.canonicalArtifact)
  .sort((a, b) => Number(/:memory:(\d+):/.exec(a.key)?.[1] || 0) - Number(/:memory:(\d+):/.exec(b.key)?.[1] || 0));
const recallClosureFor = async (f, snapshot, selectedId, maxRefs = null) => {
  const rows = allStoredRows(snapshot);
  const manifest = manifestOf(snapshot);
  const manifestEntries = Object.entries(manifest?.memories || {})
    .sort((left, right) => Number(left[1]?.turnRange?.start || 0) - Number(right[1]?.turnRange?.start || 0));
  const selectedManifestEntries = Number.isInteger(maxRefs) ? manifestEntries.slice(0, maxRefs) : manifestEntries;
  const selectedManifest = { ...manifest, memories: Object.fromEntries(selectedManifestEntries) };
  const selectedRefs = selectedManifestEntries.map(([, ref]) => ref);
  assert.ok(selectedRefs.length, 'actual committed canonical refs exist');
  const firstRow = rows.find(row => row.key === selectedRefs[0].key)?.value;
  assert.ok(firstRow?.canonicalArtifact?.facts?.length, 'actual producer canonical facts exist');
  const selectedFact = firstRow.canonicalArtifact.facts.find(fact => fact.tempFactId === selectedId);
  assert.ok(selectedFact, 'actual producer fact ' + selectedId + ' exists');
  const registry = rows.find(row => /:entity-registry:v2$/.test(row.key))?.value;
  assert.ok(registry?.entities?.length, 'real Registry is nonempty');
  const result = await f.r.api.debugResolveRecallContinuityClosure({
    selectedFacts: [{ fact: selectedFact, artifact: firstRow.canonicalArtifact, ref: selectedRefs[0] }],
    manifest: selectedManifest,
    registry,
    readFact: async ref => rows.find(row => row.key === ref.key)?.value
  });
  const count = Number(result.diagnostics?.closureCount || 0);
  return {
    result,
    added: result.facts.slice(result.facts.length - count).map(entry => entry.fact || entry),
    selectedRefs,
    rows
  };
};
const appendFivePairs = (f, startTurn) => {
  for (let i = 0; i < 10; i++) {
    const turn = startTurn + Math.floor(i / 2);
    f.chat.message.push({ role: sourceRows[i].role, data: sourceRows[i].text, chatId: `t${turn}-${i % 2 ? 'a' : 'u'}` });
  }
  f.chat.messages = f.chat.message;
};
const batchArtifact = (f, startTurn, addedFacts) => {
  const offset = startTurn - 1;
  const defaultEvidenceRef = `t${startTurn + 3}-a`;
  for (const fact of addedFacts) {
    const evidenceRef = fact.evidenceRef || defaultEvidenceRef;
    const evidenceRow = rowFor(f.chat, evidenceRef);
    if (fact.quote && evidenceRow && !String(evidenceRow.data || '').includes(fact.quote)) {
      evidenceRow.data = `${evidenceRow.data || ''} ${fact.quote}`.trim();
    }
  }
  const value = clone(artifact());
  value.schema = 'libra.canonical_artifact.v5';
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
      span.quote = rowFor(f.chat, span.ref)?.data || rowFor(f.chat, span.ref)?.text || span.quote;
    }
  }
  for (const fact of addedFacts) {
    const evidenceRef = fact.evidenceRef || defaultEvidenceRef;
    const source = rowFor(f.chat, evidenceRef);
    value.facts.push({
      tempFactId: fact.id, domain: 'character', subjectTempRef: fact.subject || 'mina',
      claimKind: fact.claimKind, values: clone(fact.values), text: fact.text,
      temporalRole: fact.temporalRole || 'current_sequence', certainty: fact.certainty || 'confirmed',
      ...(fact.effect ? { effect: fact.effect } : {}),
      evidenceSpans: [{ ref: evidenceRef, quote: fact.quote || source?.data || source?.text }]
    });
  }
  return value;
};
const preference = (id, content, topic, kind = 'preference') => ({
  id, claimKind: 'character_preference',
  values: { preferences: [{ content, topic, kind }] },
  text: content,
  quote: `민아는 ${topic}를 ${kind === 'dislike' ? '더는 좋아하지 않는다' : '좋아한다고 말했다'}.`
});
const boundary = (id, target, when) => ({
  id, claimKind: 'character_boundary',
  values: { boundaries: [{
    content: `민아는 ${target === 'jiho' ? '지호' : target === 'junho' ? '준호' : target}에게 ${when} 편지를 열지 말라고 했다`,
    topic: '편지 열기', kind: 'boundary',
    scope: { subjectRef: 'mina', targetRef: target, act: '편지 열기', when }
  }] },
  text: `민아는 ${target === 'jiho' ? '지호' : target === 'junho' ? '준호' : target}에게 ${when} 편지를 열지 말라고 했다`,
  quote: `민아는 ${target === 'jiho' ? '지호' : target === 'junho' ? '준호' : target}에게 ${when} 편지를 열지 말라고 했다.`
});

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const f = snapshot.f;
  const observation = { mode };
  try {
    f.control.artifact = batchArtifact(f, 1, [
      { ...preference('c_mint', '민트차를 좋아한다', '민트차'), quote: '민아는 민트차를 좋아한다고 말했다.' },
      { ...preference('c_tea', '홍차를 좋아한다', '홍차'), quote: '민아는 홍차를 좋아한다고 말했다.' },
      { ...preference('c_jiho_mint', '민트차를 좋아한다', '민트차'), subject: 'jiho', quote: '지호는 민트차를 좋아한다고 말했다.' },
      { ...preference('c_hypothetical_pineapple','파인애플을 좋아할지도 모른다','파인애플'),
        temporalRole:'hypothetical',certainty:'uncertain',quote:'민아는 파인애플을 좋아할지도 모른다고 추측했다.' },
      boundary('c_b_jiho_today', 'jiho', '오늘'),
      { ...boundary('c_b_junho_tomorrow', 'junho', '내일'), quote: '민아는 준호에게 내일 편지를 열지 말라고 했다.' }
    ]);
    assert.equal((await f.run()).completed, 1, `${mode}: first real provider batch commits`);
    const firstMemory = memoryRows(snapshot).find(row => Number(/:memory:(\d+):/.exec(row.key)?.[1]) === 1)?.value;
    const firstArtifact = firstMemory?.canonicalArtifact;
    const firstHead = headOf(snapshot);
    observation.canonicalStructured = firstArtifact?.facts?.some(row => row.tempFactId === 'c_mint'
      && row.values?.preferences?.[0]?.content === '민트차를 좋아한다'
      && row.values?.preferences?.[0]?.topic === '민트차'
      && row.values?.preferences?.[0]?.kind === 'preference') === true;
    assert.equal(observation.canonicalStructured, true,
      `${mode}: canonical bytes store structured preference item fields`);
    const profileBefore = firstHead?.characters?.find(row => row.name === '민아')?.state || {};
    const preferenceBefore = profileBefore.preferences || [];
    const boundariesBefore = profileBefore.boundaries || [];
    observation.preferenceCount = preferenceBefore.length;
    assert.equal(preferenceBefore.length, 2, `${mode}: separate preference topics coexist`);
    assert.equal(firstHead.characters.find(row=>row.name==='지호')?.state?.preferences?.length,1,
      `${mode}: the same topic belongs to a separate resolved subject identity`);
    observation.boundariesByScope = boundariesBefore.length === 2
      && boundariesBefore.some(item => item.topic === '편지 열기' && item.scope?.targetRef === entityId(firstHead, '지호') && item.scope?.when === '오늘')
      && boundariesBefore.some(item => item.topic === '편지 열기' && item.scope?.targetRef === entityId(firstHead, '준호') && item.scope?.when === '내일');
    assert.equal(observation.boundariesByScope, true,
      `${mode}: same topic with different Registry target and time remains as two structured boundaries`);
    const firstMina = firstHead.characters.find(row => row.name === '민아');
    const originalPreferenceEvidence = clone(firstMina.fieldEvidence?.preferences);
    const originalBoundaryEvidence = clone(firstMina.fieldEvidence?.boundaries);
    const canonicalBytesBefore = JSON.stringify(memoryRows(snapshot).map(row => [row.key, row.raw]));

    appendFivePairs(f, 6);
    f.control.artifact = batchArtifact(f, 6, [
      { ...preference('c_mint_replaced', '민트차를 싫어한다', '민트차', 'dislike'), quote: '민아는 민트차를 더는 좋아하지 않는다고 말했다.' },
      { ...boundary('c_b_reaffirm', 'jiho', '오늘'), quote: '민아는 지호에게 오늘 편지를 열지 말라고 다시 확인했다.' }
    ]);
    assert.equal((await f.run()).completed, 1, `${mode}: replacement and reaffirm batch commits`);
    let head = headOf(snapshot);
    let mina = head.characters.find(row => row.name === '민아');
    let prefs = mina.state.preferences || [];
    let boundaries = mina.state.boundaries || [];
    observation.exactPreferenceReplacement = prefs.length === 2
      && prefs.some(item => item.topic === '민트차' && item.content === '민트차를 싫어한다')
      && prefs.some(item => item.topic === '홍차' && item.content === '홍차를 좋아한다');
    assert.equal(observation.exactPreferenceReplacement, true,
      `${mode}: replacement updates the same subject/topic and keeps the unrelated topic`);
    observation.reaffirmPreservesModificationEvidence = JSON.stringify(mina.fieldEvidence?.boundaries) === JSON.stringify(originalBoundaryEvidence);
    assert.equal(observation.reaffirmPreservesModificationEvidence, true,
      `${mode}: reaffirmation keeps boundary modification evidence while mint replacement receives new provenance`);
    observation.preferenceReplacementUpdatesEvidence = JSON.stringify(mina.fieldEvidence?.preferences) !== JSON.stringify(originalPreferenceEvidence);
    assert.equal(observation.preferenceReplacementUpdatesEvidence, true,
      `${mode}: a genuine preference replacement records its own modification evidence`);
    observation.latestConfirmationOnCanonicalChain = memoryRows(snapshot).length === 2
      && memoryRows(snapshot)[1].value.canonicalArtifact.facts.some(row => row.tempFactId === 'c_b_reaffirm');
    assert.equal(observation.latestConfirmationOnCanonicalChain, true,
      `${mode}: the later confirmation remains in canonical history`);

    const reaffirmClosure = await recallClosureFor(f, snapshot, 'c_b_jiho_today', 2);
    observation.sameValueReaffirmDoesNotCreateClosure = reaffirmClosure.result.diagnostics?.closureCount === 0;
    assert.equal(observation.sameValueReaffirmDoesNotCreateClosure, true,
      mode + ': same-content set reaffirmation is not a semantic Recall successor');

    appendFivePairs(f, 11);
    const jihoSelector = boundary('c_b_remove_jiho', 'jiho', '오늘');
    jihoSelector.effect = 'remove';
    jihoSelector.quote = '민아가 지호에게 했던 오늘의 편지 열람 경계를 해제했다.';
    jihoSelector.text = jihoSelector.quote;
    const emptyClear = { id: 'c_empty_clear', claimKind: 'character_boundary', values: { boundaries: null },
      text: '비어 있는 선택자로 모든 경계를 지우려 했다', effect: 'clear',
      quote: '민아는 다른 편지 열람 경계는 유지한다고 말했다.' };
    emptyClear.quote = '민아는 다른 편지 열람 경계는 유지한다고 말했다.';
    f.control.artifact = batchArtifact(f, 11, [jihoSelector, emptyClear]);
    const thirdRun = await f.run();
    assert.equal(thirdRun.completed, 1, `${mode}: item removal batch commits with invalid empty selector quarantined`);

    const boundaryClosure = await recallClosureFor(f, snapshot, 'c_b_jiho_today');
    const boundaryClosureIds = boundaryClosure.added.map(fact => fact.tempFactId);
    observation.recallClosureIncludesExactRemoval = boundaryClosureIds.includes('c_b_remove_jiho')
      && !boundaryClosureIds.includes('c_empty_clear')
      && boundaryClosure.added.every(fact => fact.claimKind === 'character_boundary'
        && fact.values?.boundaries?.[0]?.scope?.targetRef === 'jiho'
        && fact.values?.boundaries?.[0]?.scope?.when === '오늘');
    if (!boundaryClosureIds.includes('c_b_remove_jiho')) {
      const refShape = ref => ({ memoryId: ref.memoryId, key: ref.key, status: ref.status,
        sessionEpoch: ref.sessionEpoch, turnRange: ref.turnRange, worldlineId: ref.worldlineId });
      const removalRows = boundaryClosure.rows.filter(row =>
        row.value?.canonicalArtifact?.facts?.some(fact => fact.tempFactId === 'c_b_remove_jiho'))
        .map(row => ({ key: row.key, memoryId: row.value.memoryId, revision: row.value.revision,
          sessionEpoch: row.value.sessionEpoch, turnRange: row.value.turnRange, worldlineId: row.value.worldlineId,
          fact: row.value.canonicalArtifact.facts.find(fact => fact.tempFactId === 'c_b_remove_jiho') }));
      console.log(JSON.stringify({ closureDebug: mode, ids: boundaryClosureIds,
        refs: boundaryClosure.selectedRefs.map(refShape), removalRows,
        diagnostics: boundaryClosure.result.diagnostics }));
    }
    assert.equal(observation.recallClosureIncludesExactRemoval, true,
      mode + ': selected same-scope boundary reaches exact removal, never empty clear or sibling scope (' +
        JSON.stringify({ ids: boundaryClosureIds, diagnostics: boundaryClosure.result.diagnostics }) + ')');
    const otherScopeClosure = await recallClosureFor(f, snapshot, 'c_b_junho_tomorrow');
    observation.otherScopeRemovalNotLinked = otherScopeClosure.result.diagnostics?.closureCount === 0;
    assert.equal(observation.otherScopeRemovalNotLinked, true,
      mode + ': Jiho removal does not close the same-topic Junho boundary');
    const preferenceClosure = await recallClosureFor(f, snapshot, 'c_mint');
    observation.preferenceReplacementReachesClosure = preferenceClosure.added.some(fact =>
      fact.tempFactId === 'c_mint_replaced' && fact.values?.preferences?.[0]?.kind === 'dislike');
    assert.equal(observation.preferenceReplacementReachesClosure, true,
      mode + ': same-subject/topic preference replacement remains available through cross-artifact closure');
    head = headOf(snapshot); mina = head.characters.find(row => row.name === '민아'); boundaries = mina.state.boundaries || [];
    observation.exactBoundaryRemoval = boundaries.length === 1
      && boundaries[0].scope?.targetRef === entityId(head, '준호') && boundaries[0].scope?.when === '내일';
    assert.equal(observation.exactBoundaryRemoval, true,
      `${mode}: exact boundary removal leaves the same-topic sibling scope (${JSON.stringify({boundaries, ids:{junho:entityId(head,'준호')},removeFact:memoryRows(snapshot).at(-1)?.value?.canonicalArtifact?.facts?.find(row=>row.tempFactId==='c_b_remove_jiho'),pending:head.unifiedApplied?.pending})})`);
    observation.emptySelectorFailsClosed = boundaries.length > 0
      && boundaries.some(item => item.scope?.targetRef === entityId(head, '준호'));
    assert.equal(observation.emptySelectorFailsClosed, true,
      `${mode}: empty clear selector never deletes the whole collection`);
    const recallPreflight=await f.r.api.prepareInputWriterEvidence('민아의 지호·준호 편지 열람 경계는 지금 어떻게 적용되는가?');
    const packetState=recallPreflight?.evidencePacket?.continuity_state;
    const packetMina=packetState?.characters?.find(row=>row.name==='민아');
    observation.inputWriterPacketUsesExactCurrentHead=packetMina?.state?.boundaries?.length===1
      &&packetMina.state.boundaries[0].scope?.targetRef===entityId(head,'준호')
      &&packetMina.state.boundaries[0].scope?.when==='내일';
    assert.equal(observation.inputWriterPacketUsesExactCurrentHead,true,
      `${mode}: actual Input Writer packet reads the Head after exact removal and preserves the scoped sibling`);
    observation.inputWriterPacketKeepsEmptySelectorPending=packetState?.unifiedApplied?.pending?.some(row=>row.fact==='c_empty_clear'
      &&row.reason==='memory_record_quarantined')===true;
    assert.equal(observation.inputWriterPacketKeepsEmptySelectorPending,true,
      `${mode}: invalid empty selector remains explicitly pending in the Recall consumer's current State`);

    const correctionRow=head.characters.find(row=>row.name==='민아');
    const changedBoundary=clone(correctionRow.state.boundaries[0]);
    changedBoundary.content='민아는 준호에게 내일 소포를 열지 말라고 다시 요청했다';
    const editorResult=correctionRequestFromShippedEditor(correctionRow,{
      throughTurn:head.throughTurn,basis:head.basis,head,characters:head.characters,world:head.world
    },{boundaries:[changedBoundary]});
    assert.ok(!/\[object Object\]|ce_person_|ce_world_/.test(editorResult.displayed.boundaries||''),
      `${mode}: shipped correction editor shows no object coercion or internal Registry ID`);
    const correction=await f.r.api.addWorldManagerCorrection(editorResult.request.options);
    observation.correctionEditorRoundTrip=correction.ok===true&&correction.replay?.ok===true
      &&correction.replay.appliedCorrections.includes(correction.correctionId)
      &&headOf(snapshot).characters.find(row=>row.name==='민아')?.state?.boundaries?.some(item=>item.content===changedBoundary.content
        &&item.scope?.targetRef===entityId(headOf(snapshot),'준호'))===true;
    assert.equal(observation.correctionEditorRoundTrip,true,
      `${mode}: the shipped editor's structured row saves through the real correction journal and Current Head replay`);

    appendFivePairs(f, 16);
    f.control.artifact = batchArtifact(f, 16, [
      { ...preference('c_mint_late', '민트차를 싫어한다', '민트차', 'dislike'),
        evidenceRef: 't19-a', quote: '민아는 민트차를 싫어한다고 말했다.' },
      { ...preference('c_mint_early', '민트차를 좋아한다', '민트차'),
        evidenceRef: 't17-a', quote: '민아는 민트차를 다시 좋아한다고 말했다.' }
    ]);
    assert.equal((await f.run()).completed, 1, `${mode}: reversed fact-array evidence-order batch commits`);
    head = headOf(snapshot); mina = head.characters.find(row => row.name === '민아');
    const orderBatch = memoryRows(snapshot).at(-1)?.value?.canonicalArtifact?.facts || [];
    const orderFacts = orderBatch.filter(fact => ['c_mint_late', 'c_mint_early'].includes(fact.tempFactId));
    observation.factArrayReversedAgainstEvidence = orderFacts.map(fact => fact.tempFactId).join(',') === 'c_mint_late,c_mint_early'
      && orderFacts.map(fact => fact.evidenceSpans?.[0]?.ref).join(',') === 't19-a,t17-a';
    assert.equal(observation.factArrayReversedAgainstEvidence, true,
      `${mode}: canonical facts are deliberately stored opposite their evidence order`);
    observation.stateUsesLatestEvidence = mina.state.preferences.some(item => item.topic === '민트차' && item.content === '민트차를 싫어한다');
    assert.equal(observation.stateUsesLatestEvidence, true,
      `${mode}: Current Head resolves same-batch profile facts by evidence order`);

    const historyPage = await f.r.api.listWorldManagerHistory({ domain: 'characters', limit: 20 });
    const latestMemory = memoryRows(snapshot).at(-1)?.value;
    const historyItem = historyPage.items.find(item => item.memoryId === latestMemory?.memoryId)
      || historyPage.items[0];
    assert.ok(historyItem, `${mode}: the actual History API lists the committed profile batch`);
    let history = await f.r.api.getWorldManagerHistoryDetail({
      memoryId: historyItem.memoryId, revision: historyItem.revision, sourceDigest: historyItem.sourceDigest,
      worldlineId: historyPage.worldlineId
    });
    observation.historyHasTimeline = Array.isArray(history.semanticTimeline?.events)
      && history.semanticTimeline.events.length > 0;
    assert.equal(observation.historyHasTimeline, true, `${mode}: History API exposes derived semantic events`);
    const ids={mina:entityId(head,'민아'),jiho:entityId(head,'지호'),junho:entityId(head,'준호')};
    const identity={minaMint:JSON.stringify(['preference',ids.mina,'민트차']),jihoMint:JSON.stringify(['preference',ids.jiho,'민트차']),
      minaTea:JSON.stringify(['preference',ids.mina,'홍차']),jihoToday:JSON.stringify(['boundary',ids.mina,'편지 열기',ids.jiho,'편지 열기','오늘']),
      junhoTomorrow:JSON.stringify(['boundary',ids.mina,'편지 열기',ids.junho,'편지 열기','내일'])};
    const itemEvents=key=>history.semanticTimeline.events.filter(event=>event.itemIdentity===key);
    const eventTypes=key=>itemEvents(key).map(event=>event.type);
    observation.historyItemSpecificSequences=JSON.stringify({mint:eventTypes(identity.minaMint),jihoMint:eventTypes(identity.jihoMint),tea:eventTypes(identity.minaTea),
      jihoBoundary:eventTypes(identity.jihoToday),junhoBoundary:eventTypes(identity.junhoTomorrow)})===JSON.stringify({mint:['created','replaced','replaced','replaced'],jihoMint:['created'],tea:['created'],
      jihoBoundary:['created','reaffirmed','removed'],junhoBoundary:['created','replaced']});
    observation.timelineFollowsSameBatchEvidenceOrder = (() => {
      const mintEvents = itemEvents(identity.minaMint);
      const lastTwo = mintEvents.slice(-2);
      return JSON.stringify(mintEvents.map(event => event.type)) === JSON.stringify(['created','replaced','replaced','replaced'])
        && lastTwo.map(event => event.content).join('|') === '민트차를 좋아한다|민트차를 싫어한다'
        && lastTwo.map(event => event.evidenceRefs[0]).join(',') === 't17-a,t19-a'
        && lastTwo.every(event => event.canonicalCursor?.turnRange?.start === 16);
    })();
    observation.historyItemSpecificSequences = observation.historyItemSpecificSequences && observation.timelineFollowsSameBatchEvidenceOrder;
    assert.equal(observation.historyItemSpecificSequences,true,
      `${mode}: lifecycle order is attached to exact item identities and follows evidence order even when artifact facts are reversed`);
    const correctedBoundaryEvent=itemEvents(identity.junhoTomorrow).find(event=>event.correctionRef?.correctionId===correction.correctionId);
    observation.correctionHistoryUsesExactIdentityAndAnchor=correctedBoundaryEvent?.type==='replaced'
      &&correctedBoundaryEvent.itemIdentity===identity.junhoTomorrow
      &&correctedBoundaryEvent.correctionRef?.worldlineId===history.semanticTimeline.worldlineId
      &&correctedBoundaryEvent.canonicalCursor?.turnRange?.start===11
      &&correctedBoundaryEvent.previousCursor?.turnRange?.start===1
      &&correctedBoundaryEvent.evidenceRefs?.includes(correction.correctionId);
    assert.equal(observation.correctionHistoryUsesExactIdentityAndAnchor,true,
      `${mode}: correction transition attaches to the exact boundary identity and anchor cursor on its own worldline`);
    observation.hypotheticalDoesNotBecomeCurrentTimelineEvent=!history.semanticTimeline.events.some(event=>event.itemIdentity===JSON.stringify(['preference',ids.mina,'파인애플']));
    assert.equal(observation.hypotheticalDoesNotBecomeCurrentTimelineEvent,true,
      `${mode}: hypothetical or uncertain canonical facts do not become confirmed lifecycle events`);
    const eventStart=event=>Number(event.canonicalCursor?.turnRange?.start||0);
    const jihoBoundary=itemEvents(identity.jihoToday);
    observation.historyEventCursors=JSON.stringify(jihoBoundary.map(event=>eventStart(event)))===JSON.stringify([1,6,11]);
    assert.equal(observation.historyEventCursors,true,`${mode}: lifecycle cursor order follows the exact canonical refs`);
    observation.historyCarriesEvidence = history.semanticTimeline.events.every(event =>
      Array.isArray(event.evidenceRefs) && event.evidenceRefs.length > 0 && Array.isArray(event.evidenceSpans)
        && (event.correctionRef ? event.evidenceRefs.includes(event.correctionRef.correctionId) : event.evidenceSpans.length > 0));
    assert.equal(observation.historyCarriesEvidence, true,
      `${mode}: every lifecycle event cites canonical evidence or its exact correction journal record`);
    const firstRef=memoryRows(snapshot)[0].value;
    const firstHistory=await f.r.api.getWorldManagerHistoryDetail({memoryId:firstRef.memoryId,revision:firstRef.revision,
      sourceDigest:firstRef.sourceDigest,worldlineId:historyPage.worldlineId});
    const firstEvents=firstHistory.semanticTimeline.events;
    observation.requestedCursorConstrainsEvents=firstHistory.semanticTimeline.requestedCursor?.turnRange?.end===5
      &&firstEvents.every(event=>eventStart(event)<=1)&&!firstEvents.some(event=>event.type==='replaced'||event.type==='removed');
    assert.equal(observation.requestedCursorConstrainsEvents,true,
      `${mode}: a requested earlier canonical cursor excludes later transitions and corrections`);
    observation.providerCalls = f.control.calls.length;
    observation.embeddingStatusAfterHistory=String(memoryRows(snapshot).at(-1)?.value?.embedding?.status||'');
    for(let attempt=0;attempt<100&&['pending','retry_pending'].includes(String(memoryRows(snapshot).at(-1)?.value?.embedding?.status||''));attempt++)
      await new Promise(resolve=>setTimeout(resolve,20));
    observation.embeddingStatusAfterBackgroundSettle=String(memoryRows(snapshot).at(-1)?.value?.embedding?.status||'');
    const canonicalBeforeReplay = JSON.stringify(memoryRows(snapshot).map(row => [row.key,storedJsonFieldBytes(row.raw, 'canonicalArtifact')]));
    assert.ok(memoryRows(snapshot).length>=4&&memoryRows(snapshot).every(row=>typeof row.raw==='string'&&row.raw.length>0),
      `${mode}: canonical byte snapshot is non-empty before cold replay`);
    const fullMemoryBeforeReplay=memoryRows(snapshot).map(row=>({key:row.key,raw:row.raw,value:clone(row.value)}));
    observation.embeddingStatusBeforeReplay=String(fullMemoryBeforeReplay.at(-1)?.value?.embedding?.status||'');
    const cacheKey = allStoredRows(snapshot).find(row => /:state-replay-cache:v1$/.test(row.key))?.key;
    assert.ok(cacheKey, `${mode}: a derived State replay cache exists to delete`);
    if (snapshot.local.has(cacheKey)) snapshot.local.delete(cacheKey);
    if (snapshot.storedRows().some(row=>row.key===cacheKey)) await snapshot.mutate(cacheKey, null, 'remove');
    assert.equal(allStoredRows(snapshot).some(row => row.key === cacheKey), false,
      `${mode}: derived replay cache is removed before regeneration`);
    const replay = await f.r.api.rebuildWorldManagerState({ reason: 'phase_c_cold_replay' });
    assert.equal(replay.ok, true, `${mode}: public canonical replay completes`);
    assert.equal(replay.providerCalls, 0, `${mode}: replay receipt reports no provider calls`);
    const canonicalAfterReplay = JSON.stringify(memoryRows(snapshot).map(row => [row.key,storedJsonFieldBytes(row.raw, 'canonicalArtifact')]));
    const fullMemoryAfterReplay=memoryRows(snapshot).map(row=>({key:row.key,raw:row.raw,value:clone(row.value)}));
    observation.embeddingStatusAfterReplay=String(fullMemoryAfterReplay.at(-1)?.value?.embedding?.status||'');
    const afterByKey=new Map(fullMemoryAfterReplay.map(row=>[row.key,row]));
    observation.memoryWrapperByteChanges=fullMemoryBeforeReplay.flatMap(before=>{
      const after=afterByKey.get(before.key);if(!after||before.raw===after.raw)return [];
      const fields=[...new Set([...Object.keys(before.value||{}),...Object.keys(after.value||{})])]
        .filter(field=>JSON.stringify(before.value?.[field])!==JSON.stringify(after.value?.[field])).sort();
      return [{key:before.key,fields,embeddingBefore:before.value?.embedding||null,embeddingAfter:after.value?.embedding||null}];
    });
    observation.fullMemoryWrapperBytesUnchanged=observation.memoryWrapperByteChanges.length===0;
    observation.coldReplayPreservesCanonical = canonicalAfterReplay === canonicalBeforeReplay;
    assert.equal(observation.coldReplayPreservesCanonical, true,
      `${mode}: cold replay and cache removal preserve exact embedded canonicalArtifact JSON bytes`);
    observation.coldReplayProviderCallsZero = f.control.calls.length === observation.providerCalls && replay.providerCalls === 0;
    assert.equal(observation.coldReplayProviderCallsZero, true,
      `${mode}: replay does not call the provider`);
    const historyAfterReplay = await f.r.api.getWorldManagerHistoryDetail({
      memoryId: historyItem.memoryId, revision: historyItem.revision, sourceDigest: historyItem.sourceDigest,
      worldlineId: historyPage.worldlineId
    });
    observation.timelineDeterministic = JSON.stringify(historyAfterReplay.semanticTimeline) === JSON.stringify(history.semanticTimeline);
    assert.equal(observation.timelineDeterministic, true,
      `${mode}: deleting derived cache and replaying regenerates the same timeline`);
    return observation;
  } finally { await snapshot.cleanup(); }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  const project = ({ mode, ...rest }) => rest;
  if (MODES.length > 1) {
    assert.deepEqual(project(results.mirror), project(results.plugin_only), 'mirror matches plugin_only');
    assert.deepEqual(project(results.server_only), project(results.plugin_only), 'server_only matches plugin_only');
  }
  console.log(JSON.stringify({ test: 'libra_main_memory_semantic_history', passed: 1,
    boundary: 'three-mode deployed plugin + local HTTP/SQLite + controlled provider fixture; no live external model or host', results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
