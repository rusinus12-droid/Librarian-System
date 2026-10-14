'use strict';
// N01 first increment contract: the four sources' inventory, unread cursor and delta/tombstone rules.
//
// Every test below must be able to fail. The negative controls deliberately break one rule each —
// a stale cursor, a deletion reported without a tombstone, a page treated as the whole family, a
// revision that cannot be verified — so a contract that always returns "complete" cannot pass.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const resolveTool = name => {
  const candidates = [path.join(__dirname, '..', 'tools', name), path.join(__dirname, name)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('Cannot resolve tool module: ' + name);
};

const createMemoryGraphInventory = resolveTool('libra_memory_graph_inventory.cjs');
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const inventory = createMemoryGraphInventory({ fingerprint: sha256 });
const pluginPath = path.join(__dirname, '..', 'plugins', 'LIBRA.js');

const entries = count => Array.from({ length: count }, (_, index) => ({
  key: 'm' + String(index + 1).padStart(2, '0'), revision: 'rev-1', turn: index + 1, digest: sha256('m' + index)
}));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('N01: each family declares only what its owner can report, and the basis symbols exist in the plugin', () => {
  const profiles = inventory.FAMILY_SUPPORT_PROFILES;
  assert.ok(Object.isFrozen(profiles));
  assert.deepEqual(Object.keys(profiles).sort(), [...inventory.SOURCE_FAMILIES].sort());
  assert.equal(profiles.lore.removalObservable, true, 'the lore index reports removals/confirmations');
  for (const family of ['canonical', 'micro', 'state']) {
    assert.equal(profiles[family].removalObservable, false, family + ' cannot report a tombstone');
  }
  const source = fs.readFileSync(pluginPath, 'utf8');
  for (const family of inventory.SOURCE_FAMILIES) {
    const basis = inventory.supportBasisSymbols(family);
    assert.ok(basis.length >= 3, family + ' must name the symbols behind its claim');
    for (const symbol of basis) {
      assert.ok(source.includes(symbol), 'basis symbol ' + symbol + ' must exist in plugins/LIBRA.js');
    }
  }
  assert.equal(source.includes('libra_inventory_claimed_without_basis'), false, 'negative control: a fabricated basis symbol is not in the plugin');
});

test('N01: an inventory is a bounded page whose cursor resumes exactly the remainder', () => {
  const all = entries(5);
  const first = inventory.buildSourceInventory({ family: 'canonical', entries: all, pageSize: 2 });
  assert.equal(first.schema, 'libra.source_inventory.v1');
  assert.equal(first.entryCount, 5);
  assert.deepEqual(first.entries.map(entry => entry.key), ['m01', 'm02']);
  assert.equal(first.coverage, 'partial');
  assert.deepEqual(first.unread, [{ family: 'canonical', from: 2, reason: 'page_boundary' }]);
  const second = inventory.buildSourceInventory({ family: 'canonical', entries: all, pageSize: 2, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map(entry => entry.key), ['m03', 'm04']);
  const third = inventory.buildSourceInventory({ family: 'canonical', entries: all, pageSize: 2, cursor: second.nextCursor });
  assert.deepEqual(third.entries.map(entry => entry.key), ['m05']);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(third.unread, []);
  assert.equal(third.coverage, 'partial', 'a full page walk is not a complete family unless the caller says so');
  const declared = inventory.buildSourceInventory({ family: 'canonical', entries: all, pageSize: 5, complete: true });
  assert.equal(declared.coverage, 'complete');
});

test('N01 negative control: a stale, foreign or malformed cursor is refused instead of skipping entries', () => {
  const all = entries(4);
  const page = inventory.buildSourceInventory({ family: 'canonical', entries: all, pageSize: 2 });
  const stale = inventory.buildSourceInventory({ family: 'canonical', entries: [...all, { key: 'm99', revision: 'rev-1' }], pageSize: 2 });
  assert.throws(() => inventory.buildSourceInventory({ family: 'canonical', entries: [...all, { key: 'm99', revision: 'rev-1' }], pageSize: 2, cursor: page.nextCursor }),
    error => error.reason === 'cursor_stale', 'a cursor from another enumeration must be refused');
  assert.notEqual(stale.digest, page.digest);
  assert.throws(() => inventory.buildSourceInventory({ family: 'micro', entries: all, pageSize: 2, cursor: page.nextCursor }),
    error => error.reason === 'cursor_family_mismatch');
  assert.throws(() => inventory.buildSourceInventory({ family: 'canonical', entries: all, pageSize: 2, cursor: { ...page.nextCursor, offset: 99 } }),
    error => error.reason === 'cursor_invalid');
  assert.throws(() => inventory.buildSourceInventory({ family: 'canonical', entries: all, pageSize: 2, cursor: { family: 'canonical', offset: 0, digest: page.digest } }),
    error => error.reason === 'cursor_invalid', 'an unversioned cursor is not accepted');
});

test('N01: the enumeration digest is order independent and revision sensitive', () => {
  const all = entries(4);
  const forward = inventory.buildSourceInventory({ family: 'state', entries: all, pageSize: 4 }).digest;
  const shuffled = inventory.buildSourceInventory({ family: 'state', entries: [...all].reverse(), pageSize: 4 }).digest;
  assert.equal(forward, shuffled, 'enumeration order must not change the digest');
  const revised = inventory.buildSourceInventory({ family: 'state', entries: all.map((entry, index) => index === 1 ? { ...entry, revision: 'rev-2' } : entry), pageSize: 4 }).digest;
  assert.notEqual(revised, forward, 'a revision change must change the digest');
});

test('N01: malformed entries and unknown families are refused', () => {
  assert.throws(() => inventory.buildSourceInventory({ family: 'archive', entries: [] }), error => error.reason === 'family_unsupported');
  assert.throws(() => inventory.buildSourceInventory({ family: 'micro', entries: [{ revision: 'rev-1' }] }), error => error.reason === 'entry_key_required');
  assert.throws(() => inventory.buildSourceInventory({ family: 'micro', entries: [{ key: 'm01' }, { key: 'm01' }] }), error => error.reason === 'entry_key_duplicate');
  assert.throws(() => inventory.buildSourceInventory({ family: 'micro', entries: 'nope' }), error => error.reason === 'entries_invalid');
});

test('N01: a disappeared entry is a deletion only where the owner reports tombstones', () => {
  const before = inventory.buildSourceInventory({ family: 'canonical', entries: entries(3), pageSize: 3, complete: true });
  const after = inventory.buildSourceInventory({ family: 'canonical', entries: entries(2), pageSize: 2, complete: true });
  const delta = inventory.diffInventories(before, after);
  assert.equal(delta.schema, 'libra.source_inventory_delta.v1');
  assert.deepEqual(delta.added, []);
  assert.deepEqual(delta.removed, [], 'canonical cannot prove a deletion');
  assert.deepEqual(delta.unobservableRemoval, ['m03']);
  assert.equal(delta.deltaComplete, false);
  assert.ok(delta.reasons.includes('removal_not_observable'));
  // Negative control for the branch itself: lore does report removals, so the same shape is a deletion.
  const loreBefore = inventory.buildSourceInventory({ family: 'lore', entries: [{ key: 'l1', revision: 'r1' }, { key: 'l2', revision: 'r1' }], pageSize: 2, complete: true });
  const loreAfter = inventory.buildSourceInventory({ family: 'lore', entries: [{ key: 'l1', revision: 'r1' }], pageSize: 1, complete: true });
  const loreDelta = inventory.diffInventories(loreBefore, loreAfter);
  assert.deepEqual(loreDelta.removed, ['l2']);
  assert.deepEqual(loreDelta.unobservableRemoval, []);
});

test('N01: a delta is complete only when both sides covered the family and every revision is verifiable', () => {
  const full = inventory.buildSourceInventory({ family: 'micro', entries: [{ key: 'x1', revision: 'r1' }, { key: 'x2', revision: 'r1' }], pageSize: 2, complete: true });
  const addedOne = inventory.buildSourceInventory({ family: 'micro', entries: [{ key: 'x1', revision: 'r1' }, { key: 'x2', revision: 'r2' }, { key: 'x3', revision: 'r1' }], pageSize: 3, complete: true });
  const delta = inventory.diffInventories(full, addedOne);
  assert.deepEqual(delta.added, ['x3']);
  assert.deepEqual(delta.changed, [{ key: 'x2', from: 'r1', to: 'r2' }]);
  assert.equal(delta.deltaComplete, true, JSON.stringify(delta.reasons));
  // A truncated page must never be diffed against a whole family: every out-of-page key would look
  // deleted. Both the mixed and the page-vs-page shapes are refused.
  const truncated = inventory.buildSourceInventory({ family: 'micro', entries: entries(3), pageSize: 1 });
  assert.notEqual(truncated.nextCursor, null);
  assert.throws(() => inventory.diffInventories(truncated, addedOne), error => error.reason === 'delta_requires_whole_family');
  assert.throws(() => inventory.diffInventories(truncated, truncated), error => error.reason === 'delta_requires_whole_family');
  // A full extent the caller never declared complete still downgrades the delta instead of passing it.
  const undeclared = inventory.buildSourceInventory({ family: 'micro', entries: [{ key: 'x1', revision: 'r1' }, { key: 'x2', revision: 'r1' }, { key: 'x3', revision: 'r1' }], pageSize: 3 });
  const undeclaredDelta = inventory.diffInventories(full, undeclared);
  assert.equal(undeclaredDelta.deltaComplete, false);
  assert.ok(undeclaredDelta.reasons.includes('coverage_not_declared'));
  const unverifiable = inventory.buildSourceInventory({ family: 'micro', entries: [{ key: 'x1', revision: 'r1' }, { key: 'x2' }], pageSize: 2, complete: true });
  const unverifiedDelta = inventory.diffInventories(full, unverifiable);
  assert.deepEqual(unverifiedDelta.unverified, ['x2']);
  assert.equal(unverifiedDelta.deltaComplete, false);
  assert.ok(unverifiedDelta.reasons.includes('revision_unverifiable'));
});

test('N01: the merged set reports missing families and unread regions instead of a whole bound', () => {
  const complete = family => inventory.buildSourceInventory({ family, entries: [{ key: family + '-1', revision: 'r1' }], pageSize: 1, complete: true });
  const all = inventory.mergeFamilyInventories(inventory.SOURCE_FAMILIES.map(complete));
  assert.equal(all.schema, 'libra.source_inventory_set.v1');
  assert.deepEqual(all.missingFamilies, []);
  assert.equal(all.coverage, 'complete');
  assert.equal(all.byteBounded, false, 'an inventory set must never claim a whole byte bound');
  assert.deepEqual(all.removalsNotObservable, ['canonical', 'micro', 'state']);
  const missing = inventory.mergeFamilyInventories([complete('canonical'), complete('lore')]);
  assert.deepEqual(missing.missingFamilies, ['micro', 'state']);
  assert.equal(missing.coverage, 'partial');
  const withUnread = inventory.mergeFamilyInventories([complete('canonical'),
    inventory.buildSourceInventory({ family: 'micro', entries: entries(3), pageSize: 1 })]);
  assert.equal(withUnread.coverage, 'partial');
  assert.ok(withUnread.unreadRegions.length >= 1);
  assert.throws(() => inventory.mergeFamilyInventories([complete('canonical'), complete('canonical')]),
    error => error.reason === 'inventory_family_duplicate');
});

(async () => {
  const results = [];
  for (const t of tests) {
    await t.fn();
    results.push(t.name);
  }
  console.log(JSON.stringify({ suite: 'libra_memory_graph_inventory', passed: results.length, tests: results }));
})();
