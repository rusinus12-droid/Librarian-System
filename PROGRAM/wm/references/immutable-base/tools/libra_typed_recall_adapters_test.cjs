'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./libra_recall_test_runtime.cjs');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'typed-recall-v1.json'), 'utf8'));
const initialFixtureJson = JSON.stringify(fixture);
const clone = value => JSON.parse(JSON.stringify(value));
const entry = (comment, key, content) => ({ comment, key, content: typeof content === 'string' ? content : JSON.stringify(content) });
const memoryEntry = row => entry('lmai_memory', `lmai_memory::${row.id}`, `[META:${JSON.stringify(row.meta)}]\n${row.text}`);
const get = (units, family, id) => units.find(unit => unit.family === family && unit.locator.id === id);

async function main() {
  const { api, char, chat, context } = await load({
    transformCode(code) {
      const close = code.lastIndexOf('\n})();');
      assert.ok(close > 0, 'bundle closure exists');
      return code.slice(0, close)
        + '\n;globalThis.__TYPED_RECALL_TEST__=typeof TypedRecallCorpus!=="undefined"?TypedRecallCorpus:null;globalThis.__TYPED_RECALL_ACCESS__={LibraLoreConsolidator,HierarchicalWorldManager,EntityManager};\n'
        + code.slice(close);
    }
  });
  const corpus = context.__TYPED_RECALL_TEST__;
  assert.ok(corpus && typeof corpus.capture === 'function', 'typed corpus API must be present in the built bundle');
  const empty = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.ok(empty.scopeKey, 'capture binds a concrete scope');

  const signed = (record, domain, recordId) => {
    const copy = clone(record);
    api.IntegrityMetaManager.applyIntegrityMeta(copy, { domain, recordId, scopeKey: empty.scopeKey, turn: 4 });
    return copy;
  };
  const entities = fixture.entity.map(row => {
    const record = signed(row, 'entity', row.name);
    return entry('lmai_entity', `lmai_entity::${row.name}`, record);
  });
  const narrative = signed(fixture.narrative, 'narrative', 'narrative_state');
  const worldStates = signed(fixture.worldStates, 'world', 'world_state');
  chat.localLore = [
    ...fixture.memory.map(memoryEntry),
    ...entities,
    entry('lmai_relation', 'lmai_relation::pendant', signed(fixture.relation, 'relation', fixture.relation.id)),
    entry('lmai_world_graph', 'lmai_world_graph::compact', fixture.worldGraph),
    entry('lmai_world_states', 'lmai_world_states::core', worldStates),
    entry('lmai_narrative', 'lmai_narrative::core', narrative)
  ];
  const initialPayload = JSON.stringify(chat.localLore);
  const snapshot = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.canonicalLore) && Object.isFrozen(snapshot.canonicalLore[0]), 'request snapshot and canonical copy are immutable');
  const units = corpus.enumerate(snapshot, { representation: { maxCharsByType: { memory: 600, entity: 600, world: 600, narrative: 600 } } });
  assert.equal(JSON.stringify(chat.localLore), initialPayload, 'capture and enumeration leave canonical payload unchanged');

  const promiseMemory = get(units, 'memory', 'promise');
  const promiseEntity = get(units, 'entity', 'promise');
  const inactiveWorld = get(units, 'world', 'world_old_tower');
  const storyline = get(units, 'narrative', '8');
  for (const [name, unit] of [['memory', promiseMemory], ['entity', promiseEntity], ['world', inactiveWorld], ['narrative', storyline]]) {
    assert.ok(unit, `${name} is an enumerated resident unit`);
    assert.equal(corpus.inspect(unit, snapshot, {}).eligible, true, `${name} is eligible`);
    assert.ok(unit.text && unit.representationVersion && unit.contentHash && unit.dependencyHash, `${name} has a versioned representation`);
    assert.equal(corpus.resolve(unit.identity, snapshot)?.identity, unit.identity, `${name} resolves through canonical snapshot`);
  }
  assert.notEqual(promiseMemory.identity, promiseEntity.identity, 'same raw id in memory and entity stays typed');
  assert.equal(corpus.inspect(promiseEntity, snapshot, { identities: [promiseEntity.identity] }).reason, 'user_exclusion', 'explicit exclusion cannot be bypassed');
  assert.equal(inactiveWorld.record.isActive, false, 'fixture exercises inactive location');
  assert.equal(corpus.inspect(inactiveWorld, snapshot, {}).eligible, true, 'inactive world is still recallable');
  assert.match(inactiveWorld.text, /오래된 탑/, 'world representation keeps local evidence');
  assert.ok(!promiseEntity.text.includes('ENTITY_SECRET_CANARY'), 'entity representation excludes secret and POV-only fields');
  assert.match(promiseEntity.text, /펜던트 약속을 지킨다/, 'entity representation includes a live canonical relationship');
  assert.ok(!promiseEntity.text.includes('RELATION_SECRET_CANARY'), 'relationship private layer is not embedded');
  assert.ok(!get(units, 'entity', 'entity-collision'), 'duplicate canonical entity id never resolves by array order');
  assert.ok(!get(units, 'narrative', '10'), 'duplicate storyline id never resolves by array order');
  assert.ok(snapshot.diagnostics.some(item => item.reason === 'identity_collision' && item.family === 'entity'), 'entity collision is diagnosed');
  assert.ok(snapshot.diagnostics.some(item => item.reason === 'identity_collision' && item.family === 'narrative'), 'narrative collision is diagnosed');
  const child = get(units, 'narrative', '9');
  assert.ok(child.lineage?.parentIds?.includes('8'), 'split storyline retains parent lineage');
  assert.ok(get(units, 'world', '4'), 'world state is a separate typed retrieval unit');

  assert.equal(corpus.inspect(get(units, 'memory', 'expired'), snapshot, {}).eligible, false, 'memory TTL applies to memory');
  assert.equal(corpus.inspect(get(units, 'memory', 'hidden'), snapshot, {}).eligible, false, 'hidden memory is rejected');
  assert.equal(corpus.inspect(get(units, 'entity', 'entity-absorbed'), snapshot, {}).eligible, false, 'absorbed source is retired');
  assert.equal(corpus.inspect(get(units, 'entity', 'entity-pending'), snapshot, {}).eligible, false, 'pending absorption is not prompt visible');

  const renamed = clone(fixture.entity[0]);
  renamed.name = '민지 새 이름';
  renamed.meta.aliases = ['민지', 'Minji'];
  chat.localLore = chat.localLore.map(row => row.comment === 'lmai_entity' && JSON.parse(row.content).id === 'promise'
    ? entry('lmai_entity', 'lmai_entity::renamed', signed(renamed, 'entity', renamed.name)) : row);
  const afterRename = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  const resolvedRename = corpus.resolve(promiseEntity.identity, afterRename);
  assert.equal(resolvedRename?.record?.name, '민지 새 이름', 'rename preserves stable payload id and resolves current canonical object');
  assert.equal(resolvedRename.identity, promiseEntity.identity, 'rename preserves typed identity');

  const changedGraph = clone(fixture.worldGraph);
  changedGraph.nodes[0][1].rules.custom.oath = '약속은 새로운 세계 규칙을 따른다';
  chat.localLore = chat.localLore.map(row => row.comment === 'lmai_world_graph'
    ? entry('lmai_world_graph', row.key, changedGraph) : row);
  const afterParentRule = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  const changedWorld = corpus.resolve(inactiveWorld.identity, afterParentRule);
  assert.equal(changedWorld.identity, inactiveWorld.identity, 'parent rule edit keeps child node identity');
  assert.notEqual(changedWorld.dependencyHash, inactiveWorld.dependencyHash, 'parent rule edit invalidates child representation dependency');

  const collisionGraph = clone(changedGraph);
  collisionGraph.nodes.push(['world_old_tower', { ...clone(collisionGraph.nodes[1][1]), name: '가짜 탑' }]);
  const graphRow = chat.localLore.find(row => row.comment === 'lmai_world_graph');
  chat.localLore = chat.localLore.map(row => row === graphRow ? entry(row.comment, row.key, collisionGraph) : row);
  const afterNodeCollision = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.equal(corpus.resolve(inactiveWorld.identity, afterNodeCollision), null, 'duplicate graph node id cannot choose one by map insertion');
  assert.ok(afterNodeCollision.diagnostics.some(item => item.family === 'world' && item.reason === 'identity_collision'), 'world node collision is reported');
  chat.localLore = chat.localLore.map(row => row.comment === 'lmai_world_graph' ? graphRow : row);

  const tamperedGraph = signed(changedGraph, 'world', 'world_graph');
  tamperedGraph.nodes[1][1].name = '무결성 변조 탑';
  chat.localLore = chat.localLore.map(row => row.comment === 'lmai_world_graph' ? entry(row.comment, row.key, tamperedGraph) : row);
  const afterTamper = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.equal(corpus.inspect(corpus.resolve(inactiveWorld.identity, afterTamper), afterTamper, {}).eligible, false, 'signed graph tampering blocks graph node recall');
  chat.localLore = chat.localLore.map(row => row.comment === 'lmai_world_graph' ? graphRow : row);

  const noIdEntity = clone(fixture.entity[0]);
  delete noIdEntity.id;
  noIdEntity.name = 'ID 없는 인물';
  chat.localLore.push(entry('lmai_entity', 'lmai_entity::legacy-name-hash', signed(noIdEntity, 'entity', noIdEntity.name)));
  const afterMissingId = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.ok(!corpus.enumerate(afterMissingId).some(unit => unit.family === 'entity' && unit.record.name === noIdEntity.name), 'name-derived legacy identity is not claimed stable');
  assert.ok(afterMissingId.diagnostics.some(item => item.family === 'entity' && item.reason === 'missing_identity'), 'missing stable entity id reduces coverage visibly');
  chat.localLore.pop();

  const pairs = [1, 2, 3, 4].map(t => ({ pairIndex: t, userText: `u${t}`, assistantText: `a${t}` }));
  await api.LibraTurnWorldline.observe('typed-task1-worldline', pairs, { now: 1000 });
  await api.LibraTurnWorldline.observe('typed-task1-worldline', pairs.slice(0, 3), { now: 2000 });
  const sameGraphLive = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지', worldlineState: null });
  const rolledBack = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지', worldlineState: api.LibraTurnWorldline.get('typed-task1-worldline') });
  assert.equal(corpus.inspect(corpus.resolve(promiseMemory.identity, rolledBack), rolledBack, {}).eligible, false, 'rolled-back memory is ineligible');
  assert.equal(corpus.inspect(corpus.resolve(storyline.identity, rolledBack), rolledBack, {}).eligible, false, 'storyline with only rolled-back evidence is ineligible');
  const stateAtFour = corpus.enumerate(rolledBack).find(unit => unit.family === 'world' && unit.subtype === 'state_turn' && unit.locator.id === '4');
  assert.equal(corpus.inspect(stateAtFour, rolledBack, {}).eligible, false, 'rolled-back world state is ineligible');
  assert.ok(!corpus.resolve(inactiveWorld.identity, rolledBack).text.includes('탑은 밤에만 열린다'), 'rolled-back promoted world rule is absent from retrieval text');
  assert.notEqual(corpus.resolve(inactiveWorld.identity, rolledBack).dependencyHash, corpus.resolve(inactiveWorld.identity, sameGraphLive).dependencyHash, 'worldline change invalidates a world node whose promoted rules changed');

  chat.localLore = clone(snapshot.canonicalLore);
  chat.localLore.push(entry('lmai_narrative', 'lmai_narrative::duplicate', narrative));
  const duplicateCore = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.ok(!corpus.enumerate(duplicateCore).some(unit => unit.family === 'narrative'), 'duplicate canonical narrative state does not select first entry');
  assert.ok(duplicateCore.diagnostics.some(item => item.family === 'narrative' && item.reason === 'singleton_collision'), 'duplicate narrative state is diagnosed');

  chat.localLore = clone(snapshot.canonicalLore);
  const mergedState = clone(fixture.narrative);
  mergedState.storylines = mergedState.storylines.filter(item => item.id !== 9);
  mergedState.storylines.find(item => item.id === 8).turns = [4, 5];
  chat.localLore = chat.localLore.map(row => row.comment === 'lmai_narrative'
    ? entry(row.comment, row.key, signed(mergedState, 'narrative', 'narrative_state')) : row);
  const mergedSnapshot = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  const retiredStory = get(units, 'narrative', '9');
  assert.ok(corpus.deriveLineage(snapshot, mergedSnapshot).links.some(link => link.from === retiredStory.identity && link.to === storyline.identity && link.reason === 'narrative_merge'), 'merge maps retired storyline id to surviving arc by unique evidence');
  assert.ok(corpus.deriveLineage(mergedSnapshot, snapshot).links.some(link => link.from === storyline.identity && link.to === retiredStory.identity && link.reason === 'narrative_split'), 'split maps the surviving parent to its unique new child');

  const activeSource = clone(fixture.entity[1]);
  delete activeSource.meta.absorption;
  chat.localLore = clone(snapshot.canonicalLore).map(row => row.comment === 'lmai_entity' && JSON.parse(row.content).id === activeSource.id
    ? entry(row.comment, row.key, signed(activeSource, 'entity', activeSource.name)) : row);
  const beforeAbsorption = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.ok(corpus.deriveLineage(beforeAbsorption, snapshot).links.some(link => link.from === get(units, 'entity', activeSource.id).identity && link.to === promiseEntity.identity && link.reason === 'entity_absorption'), 'absorbed source maps to surviving canonical entity');

  chat.localLore = chat.localLore.map(row => row.key === 'lmai_memory::promise'
    ? memoryEntry({ ...fixture.memory[0], meta: { ...fixture.memory[0].meta, hme: { hiddenFromPrompt: true } } }) : row);
  const afterHidden = corpus.capture(char, chat, { currentTurn: 10, viewerId: '민지' });
  assert.equal(corpus.inspect(corpus.resolve(promiseMemory.identity, afterHidden), afterHidden, {}).eligible, false, 'latest memory state governs final eligibility');
  assert.equal(JSON.stringify(fixture), initialFixtureJson, 'fixture records and oracle declarations remain unchanged');
  const safetyChecks = [];
  const safety = async (name, run) => {
    try { await run(); safetyChecks.push({ name, ok: true }); }
    catch (error) { safetyChecks.push({ name, ok: false, error: error.message }); }
    finally { chat.localLore = clone(snapshot.canonicalLore); }
  };
  const reviewFixture = fixture.safetyReview;
  await safety('public_adapter_collision_and_representation_contract', () => {
    assert.equal(corpus.adapters.entity.resolve({ family: 'entity', subtype: 'canonical', id: 'entity-collision' }, snapshot), null);
    assert.equal(corpus.adapters.narrative.resolve({ family: 'narrative', subtype: 'storyline', id: '10' }, snapshot), null);
    for (const family of ['memory', 'entity', 'world', 'narrative']) {
      const candidate = corpus.adapters[family].enumerate(snapshot)[0];
      const representation = corpus.adapters[family].representation(candidate, snapshot, { maxChars: 64 });
      assert.ok(representation.dependencyHash, `${family} exposes the representation dependency`);
      assert.ok(representation.text.length <= 64);
      assert.equal(representation.trim.truncated, representation.trim.originalChars > 64);
    }
  });
  await safety('unsigned_explicit_scope_and_canonical_alias_exclusions', () => {
    assert.equal(corpus.inspect(promiseEntity, snapshot, { entityNames: ['Minji'] }).eligible, false);
    assert.equal(corpus.adapters.entity.eligibility(promiseEntity, snapshot, { identities: [promiseEntity.identity] }).eligible, false);
    const record = clone(fixture.entity[0]); record.meta.scopeKey = 'foreign-scope';
    chat.localLore = clone(snapshot.canonicalLore).map(row => row.key === promiseEntity.entry.key ? entry(row.comment, row.key, record) : row);
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null });
    assert.equal(corpus.inspect(corpus.resolve(promiseEntity.identity, captured), captured).eligible, false);
  });
  await safety('formatter_resolves_current_canonical_text_and_visibility', () => {
    const forged = { ...promiseEntity, text: 'FORGED_TEXT_CANARY' };
    const sections = corpus.adapters.entity.formatter(forged, snapshot);
    assert.ok(sections.length && sections.every(section => !section.text.includes('FORGED_TEXT_CANARY')));
    assert.equal(corpus.adapters.entity.formatter(promiseEntity, snapshot, { exclusions: { entityNames: ['Minji'] } }).length, 0);
    assert.equal(corpus.adapters.entity.formatter(get(units, 'entity', 'entity-absorbed'), snapshot).length, 0);
  });
  await safety('explicit_capture_ignores_active_foreign_unsigned_shadow', async () => {
    const aChat = { id: 'scope-A', localLore: [] };
    const bChat = { id: 'scope-B', localLore: [] };
    const shadowChar = { id: 'scope-char', chats: [aChat, bChat] };
    const foreign = entry('lmai_entity', 'lmai_entity::foreign', { id: 'foreign', name: 'Foreign Person', meta: { created: 2 } });
    await api.LibraDataStorage.save(shadowChar, aChat, [foreign]);
    await api.LibraDataStorage.save(shadowChar, bChat, [entry('lmai_world_graph', 'lmai_world_graph::B', fixture.worldGraph)]);
    const activeScope = api.LibraDataStorage.getActiveScope();
    api.LibraDataStorage.setActiveScope(api.LibraDataStorage.scopeKeyFor(shadowChar, aChat));
    try {
      const captured = corpus.capture(shadowChar, bChat, { currentTurn: 10, worldlineState: null });
      const capturedUnits = corpus.enumerate(captured);
      assert.ok(!get(capturedUnits, 'entity', 'foreign'), 'scope A shadow must never be relabeled as B');
      assert.ok(get(capturedUnits, 'world', 'world_old_tower'), 'explicit scope B resident shadow is retained');
      assert.equal(api.LibraDataStorage.getActiveScope(), api.LibraDataStorage.scopeKeyFor(shadowChar, aChat));
    } finally { api.LibraDataStorage.setActiveScope(activeScope); }
  });
  for (const mode of ['isolate', 'override', 'extend']) await safety(`world_inheritance_${mode}_and_shadowed_rule`, () => {
    const graph = clone(fixture.worldGraph);
    graph.nodes[0][1].rules.custom.oath = reviewFixture.parentRule;
    graph.nodes[0][1].rules.custom.parentOnly = 'PARENT_ONLY_X_CANARY';
    graph.nodes[1][1].rules.custom = { oath: reviewFixture.childRule };
    graph.nodes[1][1].rules.inheritance = { mode };
    chat.localLore = [entry('lmai_world_graph', 'lmai_world_graph::compact', graph)];
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null });
    const childUnit = corpus.resolve(inactiveWorld.identity, captured);
    assert.ok(childUnit.text.includes(reviewFixture.childRule));
    assert.ok(!childUnit.text.includes(reviewFixture.parentRule), `${mode} must not emit a replaced parent rule`);
    assert.equal(childUnit.text.includes('PARENT_ONLY_X_CANARY'), mode === 'extend', `${mode} controls inheritance of unrelated parent rules`);
    context.__TYPED_RECALL_ACCESS__.HierarchicalWorldManager.loadWorldGraph(chat.localLore, true);
    // Compare the same canonical rule values; loadWorldGraph also performs unrelated
    // legacy field normalization, so restore the captured node objects in this VM only.
    for (const [id, node] of graph.nodes) context.__TYPED_RECALL_ACCESS__.HierarchicalWorldManager.getProfile().nodes.set(id, clone(node));
    assert.equal(context.__TYPED_RECALL_ACCESS__.HierarchicalWorldManager.getEffectiveRules('world_old_tower').custom.oath, reviewFixture.childRule);
  });
  await safety('world_parent_rename_invalidates_child_dependency', () => {
    chat.localLore = clone(snapshot.canonicalLore);
    const before = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null });
    const beforeUnit = corpus.resolve(inactiveWorld.identity, before);
    const graph = clone(fixture.worldGraph);
    graph.nodes[0][1].name = 'RENAMED_PARENT_CANARY';
    chat.localLore = chat.localLore.map(row => row.comment === 'lmai_world_graph' ? entry(row.comment, row.key, graph) : row);
    const changed = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null });
    assert.notEqual(corpus.resolve(inactiveWorld.identity, changed).text, beforeUnit.text);
    assert.notEqual(corpus.resolve(inactiveWorld.identity, changed).dependencyHash, beforeUnit.dependencyHash);
    assert.equal(corpus.inspect(beforeUnit, changed).eligible, false);
  });
  await safety('narrative_mixed_live_and_rollback_has_no_retired_content', () => {
    const state = { storylines: [{ id: 81, name: 'Mixed Arc', arcKey: 'mixed', turns: [3, 4],
      continuityBrief: reviewFixture.retiredEvent, activeThreads: [reviewFixture.retiredEvent],
      recentEvents: [{ turn: 3, brief: reviewFixture.liveEvent }, { turn: 4, brief: reviewFixture.retiredEvent }], evidenceTurns: [3, 4] }] };
    chat.localLore = [entry('lmai_narrative', 'lmai_narrative::core', signed(state, 'narrative', 'narrative_state'))];
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: api.LibraTurnWorldline.get('typed-task1-worldline') });
    const unit = get(corpus.enumerate(captured), 'narrative', '81');
    assert.equal(corpus.inspect(unit, captured).eligible, true, 'separable live evidence is recallable');
    assert.ok(unit.text.includes(reviewFixture.liveEvent));
    assert.ok(!unit.text.includes(reviewFixture.retiredEvent));
    assert.ok(unit.partial?.omittedFields.includes('continuityBrief'), 'unsafe aggregate omission is visible');
    assert.ok(!unit.sourceRefs.map(String).includes('4'), 'retired evidence is not a live source reference');
  });
  await safety('narrative_unseparable_aggregate_is_partial', () => {
    const state = { storylines: [{ id: 82, name: 'Aggregate Arc', turns: [3, 4], continuityBrief: reviewFixture.retiredEvent }] };
    chat.localLore = [entry('lmai_narrative', 'lmai_narrative::core', signed(state, 'narrative', 'narrative_state'))];
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: api.LibraTurnWorldline.get('typed-task1-worldline') });
    const unit = get(corpus.enumerate(captured), 'narrative', '82');
    assert.ok(!unit.text.includes(reviewFixture.retiredEvent));
    assert.equal(corpus.inspect(unit, captured).eligible, false, 'identity alone cannot prove live narrative evidence');
    assert.ok(captured.diagnostics.some(d => d.reason === 'narrative_partial_provenance'));
  });
  await safety('narrative_per_item_provenance_outside_recent_events', () => {
    const state = { storylines: [{ id: 83, name: 'Thread Arc', turns: [3], activeThreads: [
      { turn: 3, text: reviewFixture.liveEvent }, { turn: 4, text: reviewFixture.retiredEvent }
    ] }] };
    chat.localLore = [entry('lmai_narrative', 'lmai_narrative::core', signed(state, 'narrative', 'narrative_state'))];
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: api.LibraTurnWorldline.get('typed-task1-worldline') });
    const unit = get(corpus.enumerate(captured), 'narrative', '83');
    assert.equal(corpus.inspect(unit, captured).eligible, true);
    assert.ok(unit.text.includes(reviewFixture.liveEvent));
    assert.ok(!unit.text.includes(reviewFixture.retiredEvent), 'thread provenance is checked independently of storyline turns');
  });
  await safety('drift_set_input_and_returned_snapshot_cannot_change_decision', () => {
    const vm = require('node:vm');
    const drift = { scopeKey: snapshot.worldlineScopeKey, turns: vm.runInContext('new Set([4])', context),
      metadata: vm.runInContext('new Map([[4, {reason: "rollback"}]])', context) };
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null, ephemeralDriftExclusion: drift });
    const unit = corpus.resolve(promiseMemory.identity, captured);
    assert.equal(corpus.inspect(unit, captured).eligible, false);
    drift.turns.clear(); drift.metadata.get(4).reason = 'changed'; drift.metadata.clear();
    assert.equal(corpus.inspect(unit, captured).eligible, false, 'caller mutation must not change captured drift');
    const exposed = captured.ephemeralDriftExclusion;
    try { if (typeof exposed.turns.clear === 'function') exposed.turns.clear(); else exposed.turns.splice(0); } catch (_) {}
    assert.equal(corpus.inspect(unit, captured).eligible, false, 'returned snapshot mutation must not change captured drift');
    assert.ok(Array.isArray(exposed.turns) && Object.isFrozen(exposed.turns));
    assert.ok(Array.isArray(exposed.metadata) && Object.isFrozen(exposed.metadata[0][1]));
    assert.equal(exposed.metadata[0][1].reason, 'rollback');
  });
  await safety('world_codex_facts_recallable_directives_not_corpus', () => {
    const state = { scopeKey: snapshot.scopeKey, worldCodex: [reviewFixture.codexFact, reviewFixture.codexDisabled],
      activeDirectives: [{ id: 'control', directive: 'CONTROL_DIRECTIVE_CANARY' }] };
    chat.localLore = [entry('lmai_world_additional', 'lmai_world_additional::directives', state)];
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null });
    const facts = corpus.enumerate(captured);
    const codex = get(facts, 'world', 'wc-oath');
    assert.ok(codex, 'canonical additionalState.worldCodex facts are enumerated');
    assert.equal(corpus.inspect(codex, captured).eligible, true);
    assert.ok(codex.text.includes('CODEX_FACT_CANARY'));
    assert.ok(!facts.some(unit => unit.text.includes('CONTROL_DIRECTIVE_CANARY')));
    assert.equal(corpus.inspect(get(facts, 'world', 'wc-disabled'), captured).eligible, false);
    const rolledBackCodex = clone(state); rolledBackCodex.worldCodex[0].updatedTurn = 4;
    chat.localLore = [entry('lmai_world_additional', 'lmai_world_additional::directives', rolledBackCodex)];
    const rolled = corpus.capture(char, chat, { currentTurn: 10, worldlineState: api.LibraTurnWorldline.get('typed-task1-worldline') });
    assert.equal(corpus.inspect(get(corpus.enumerate(rolled), 'world', 'wc-oath'), rolled).eligible, false);
  });
  await safety('entity_rename_preserves_old_alias_relation_and_dependency', () => {
    const renamed = clone(fixture.entity[0]); renamed.name = 'Renamed Person';
    renamed.meta.aliases = [fixture.entity[0].name, 'Minji'];
    chat.localLore = clone(snapshot.canonicalLore).map(row => row.key === promiseEntity.entry.key
      ? entry(row.comment, 'lmai_entity::renamed', signed(renamed, 'entity', renamed.name)) : row);
    const captured = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null });
    const unit = corpus.resolve(promiseEntity.identity, captured);
    assert.ok(unit.text.includes(fixture.relation.currentStatus.summary));
    assert.ok(unit.sourceRefs.includes('lmai_relation::pendant'));
    const changedRelation = clone(fixture.relation); changedRelation.currentStatus.summary = 'CHANGED_ALIAS_RELATION_CANARY';
    chat.localLore = chat.localLore.map(row => row.comment === 'lmai_relation' ? entry(row.comment, row.key, signed(changedRelation, 'relation', changedRelation.id)) : row);
    const changed = corpus.capture(char, chat, { currentTurn: 10, worldlineState: null });
    assert.notEqual(corpus.resolve(unit.identity, changed).dependencyHash, unit.dependencyHash);
  });
  console.log(JSON.stringify({ safetyChecks }, null, 2));
  assert.equal(safetyChecks.filter(check => !check.ok).length, 0, 'all supervised Task1 safety regressions pass');
  console.log(JSON.stringify({ ok: true, families: [...new Set(units.map(unit => unit.family))], diagnostics: snapshot.diagnostics }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
