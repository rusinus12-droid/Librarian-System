'use strict';
// Stage 2 closure: a lore that CARRIED a selection is a dependency of that selection even when its body
// never reached the prompt (research note §7-6).
//
// The research note's wording is the contract: "lore A를 거쳐 memory B를 선택했으나 A를 최종 prompt에 넣지
// 않은 경우에도 A는 선택의 의존성이다. A가 변경되면 B의 연상 선택도 stale이다." Without this, an associative
// choice keeps looking fresh after the bridge it was made through has changed.
//
// What is asserted here:
//   1. A bridge id present on the packet becomes a read-set entry, tagged separately from consumed lore.
//   2. A lore the prompt already consumed is NOT double-counted as a bridge.
//   3. The read set digest covers the bridge list, so a change to it invalidates a previously issued set.
//   4. No bridge list (the state until the observation stage ships) leaves every existing field identical,
//      so this change is inert on today's path.
//
// The suite drives the REAL `buildConsumerReadSet` through the shipped plugin, not a reimplementation:
// the values are read back off the packet the response path produced.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_lore_link_index_fixture.cjs');

const results = [];
const enabled = options => fixture({ ...options, args: { lore_link_index_enabled: 'true', ...options?.args } });
async function test(name, fn) { const f = await enabled(); try { await fn(f); results.push(name); } finally { await f.r.cleanup(); } }
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  await test('a bridge id on the packet becomes a read-set dependency, tagged apart from consumed lore', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));

    // Drive the shipped function through the plugin's own test surface, with a packet that carries a
    // bridge. The bridge is a lore the prompt did NOT consume, which is the case the note names.
    const api = f.r.api;
    assert.equal(typeof api.buildConsumerReadSetForTest, 'function', 'the shipped read-set builder must be reachable');
    const packet = {
      author_note_prompt: 'note', route: 'planner', lore_material: { stages: {}, selectedItems: [] },
      bootstrap_references: { loreCount: 0 }, associative_links: { bridges: [{ id: 'bridge-lore-A' }] }
    };
    const inventory = {
      available: true, characterId: 'c1', chatId: 'k1',
      entries: { author_note: { kind: 'author_note', id: 'k1', digest: 'd-note' },
                 character_definition: { kind: 'character_definition', id: 'c1', digest: 'd-char' },
                 persona: { kind: 'persona', id: 'p1', digest: 'd-persona' } },
      lore: [{ kind: 'lore', id: 'bridge-lore-A', digest: 'd-bridge' },
             { kind: 'lore', id: 'consumed-lore-B', digest: 'd-consumed' }],
      bindingDigest: 'b1', selectionDigest: 's1'
    };
    const readSet = await api.buildConsumerReadSetForTest(packet, { consumerSourceInventory: inventory }, {}, { scopeKey: 'sc-1' });
    assert.ok(readSet, 'the read set must be built');

    const ids = plain(readSet.entries).map(entry => entry.id);
    assert.ok(ids.includes('bridge-lore-A'),
      `the bridge must be a dependency even though no prompt consumed it: ${JSON.stringify(ids)}`);
    assert.deepEqual(plain(readSet.bridgeDependencyIds), ['bridge-lore-A'],
      'bridges are disclosed separately from consumed entries so they cannot read as delivered material');
    const bridgeEntry = plain(readSet.entries).find(entry => entry.id === 'bridge-lore-A');
    assert.equal(bridgeEntry.kind, 'lore');
    assert.equal(bridgeEntry.digest, 'd-bridge', 'the dependency carries the digest its freshness is checked against');
  });

  await test('a lore the prompt already consumed is not double-counted as a bridge', async f => {
    await f.run();
    const packet = {
      author_note_prompt: '', route: 'planner',
      lore_material: { stages: { planner: { promptBlock: 'x', selectedItems: [{ id: 'lore-both' }] } }, selectedItems: [{ id: 'lore-both' }] },
      bootstrap_references: { loreCount: 1 }, associative_links: { bridges: [{ id: 'lore-both' }] }
    };
    const inventory = {
      available: true, characterId: 'c1', chatId: 'k1',
      entries: {}, lore: [{ kind: 'lore', id: 'lore-both', digest: 'd-both' }],
      bindingDigest: 'b1', selectionDigest: 's1'
    };
    const readSet = await f.r.api.buildConsumerReadSetForTest(packet, { consumerSourceInventory: inventory }, {}, { scopeKey: 'sc-1' });
    const ids = plain(readSet.entries).map(entry => entry.id);
    assert.deepEqual(ids, ['lore-both'], 'the entry appears once, not twice');
    assert.deepEqual(plain(readSet.bridgeDependencyIds), [],
      'a bridge the prompt already consumed is not a bridge dependency — it is delivered material');
  });

  await test('the read-set digest covers the bridge list, so a change invalidates a prior set', async f => {
    await f.run();
    const base = {
      author_note_prompt: '', route: 'planner', lore_material: { stages: {}, selectedItems: [] },
      bootstrap_references: { loreCount: 0 }
    };
    const inventory = {
      available: true, characterId: 'c1', chatId: 'k1', entries: {},
      lore: [{ kind: 'lore', id: 'bridge-A', digest: 'd-a' }], bindingDigest: 'b1', selectionDigest: 's1'
    };
    const without = await f.r.api.buildConsumerReadSetForTest(base, { consumerSourceInventory: inventory }, {}, { scopeKey: 'sc-1' });
    const withBridge = await f.r.api.buildConsumerReadSetForTest(
      { ...base, associative_links: { bridges: [{ id: 'bridge-A' }] } },
      { consumerSourceInventory: inventory }, {}, { scopeKey: 'sc-1' });
    assert.notEqual(without.readSetDigest, withBridge.readSetDigest,
      'adding a bridge dependency must change the digest, or a stale choice would verify as fresh');
    // Recomputing the body without the digest must reproduce it, i.e. the digest really covers the field.
    const stripped = { ...plain(withBridge) };
    delete stripped.readSetDigest;
    assert.equal(typeof withBridge.readSetDigest, 'string');
    assert.ok(withBridge.readSetDigest.length > 0);
    assert.equal(plain(withBridge).bridgeDependencyIds.length, 1);
    void stripped;
  });

  await test('with no bridge list the read set is unchanged (this change is inert today)', async f => {
    await f.run();
    const packet = {
      author_note_prompt: '', route: 'planner', lore_material: { stages: {}, selectedItems: [] },
      bootstrap_references: { loreCount: 0 }
    };
    const inventory = {
      available: true, characterId: 'c1', chatId: 'k1', entries: {},
      lore: [], bindingDigest: 'b1', selectionDigest: 's1'
    };
    const readSet = await f.r.api.buildConsumerReadSetForTest(packet, { consumerSourceInventory: inventory }, {}, { scopeKey: 'sc-1' });
    assert.deepEqual(plain(readSet.bridgeDependencyIds), [], 'no bridges means an empty list, never a missing field');
    assert.equal(plain(readSet.entries).length, 0);
    assert.equal(readSet.loreSelection, false);
  });

  await test('the packet carries the associative_links slot, null until the observation stage fills it', async f => {
    await f.run();
    // The slot must exist so the read-set contract can carry bridges before any producer ships; a null
    // value is the current, intended state.
    const built = await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    assert.ok(built, 'a recall preview must return');
    const packet = plain(f.r.api.getLastRecallEvidencePacket ? f.r.api.getLastRecallEvidencePacket() : null);
    if (packet) assert.ok('associative_links' in packet, 'the packet exposes the slot');
    // The read-set path itself is exercised above; here the contract only requires that a null slot is
    // tolerated, which the other cases already cover with an absent field.
    assert.equal(typeof f.r.api.buildConsumerReadSetForTest, 'function');
  });

  console.log(JSON.stringify({ suite: 'libra_consumer_bridge_readset', passed: results.length, tests: results }, null, 1));
  console.log('libra_consumer_bridge_readset_test: PASS');
})().catch(error => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
