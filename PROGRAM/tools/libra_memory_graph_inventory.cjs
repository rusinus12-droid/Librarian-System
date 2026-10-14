'use strict';
// N01 first increment — the four sources' inventory, unread cursor and delta/tombstone contract.
//
// This layer is the precondition N01 names before any durable shard/index work: fix what each owner
// can actually report, and never invent a change record the owner cannot support.
//
// 1. FAMILY_SUPPORT_PROFILES declares, per family, which change kinds the owner can report, and
//    names the symbols that back each claim so the suite can check them against the shipped plugin
//    instead of trusting a table.
// 2. An inventory is a bounded page of a sorted key/revision enumeration plus a cursor bound to the
//    digest of the whole enumeration, so resuming after the set changed fails loudly (cursor_stale)
//    rather than silently skipping entries.
// 3. A delta reports `deltaComplete: false` unless both sides enumerated the whole family AND every
//    reported addition/revision is verifiable. Removals are only called `removed` where the owner
//    can observe a tombstone; everywhere else they are `unobservableRemoval`, not a deletion.
// 4. Nothing here claims a whole-corpus bound: the merged set reports `byteBounded: false`.
module.exports = function createMemoryGraphInventory({ fingerprint } = {}) {
  if (typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_INVENTORY_FINGERPRINT_REQUIRED');
  const fail = reason => { const error = new Error('LIBRA_GRAPH_INVENTORY_' + reason.toUpperCase()); error.reason = reason; throw error; };
  const text = value => String(value == null ? '' : value).trim();
  const hash = value => {
    const digestValue = fingerprint(typeof value === 'string' ? value : JSON.stringify(value));
    if (!/^[a-f0-9]{64}$/.test(String(digestValue))) fail('fingerprint_invalid');
    return String(digestValue);
  };

  const SOURCE_FAMILIES = Object.freeze(['canonical', 'micro', 'state', 'lore']);

  // Only what the owner can actually report. `basis` names the shipped symbols behind each claim;
  // the suite fails if a basis symbol disappears from plugins/LIBRA.js.
  const FAMILY_SUPPORT_PROFILES = Object.freeze({
    canonical: Object.freeze({
      family: 'canonical', revision: true, correction: true, removalObservable: false, restoreEpoch: true,
      cursorBasis: 'turn_range', basis: Object.freeze(['libra.canonical_memory.v1', 'sourceDigest', 'microRestoreGeneration'])
    }),
    micro: Object.freeze({
      family: 'micro', revision: true, correction: false, removalObservable: false, restoreEpoch: true,
      cursorBasis: 'receipt_revision', basis: Object.freeze(['libra.micro_memory.v1', 'receiptRevisionId', 'analysisRevisionId', 'analysisStatus'])
    }),
    state: Object.freeze({
      family: 'state', revision: true, correction: true, removalObservable: false, restoreEpoch: true,
      cursorBasis: 'state_observation', basis: Object.freeze(['libra.continuity_state.v2', 'fieldEvidence', 'manual_state_disposition', 'state_observation.v2'])
    }),
    lore: Object.freeze({
      family: 'lore', revision: true, correction: false, removalObservable: true, restoreEpoch: true,
      cursorBasis: 'lore_digest', basis: Object.freeze(['libra.lore_link_index.v1', 'loreSelectionDigest', 'removals', 'confirmations'])
    })
  });

  const profileFor = family => FAMILY_SUPPORT_PROFILES[text(family)] || null;
  const supportBasisSymbols = family => {
    const profile = profileFor(family);
    if (!profile) fail('family_unsupported');
    return profile.basis;
  };

  const normalizeEntries = entries => {
    if (!Array.isArray(entries)) fail('entries_invalid');
    const seen = new Set();
    const normalized = [];
    for (const entry of entries) {
      const key = text(entry?.key);
      if (!key) fail('entry_key_required');
      if (seen.has(key)) fail('entry_key_duplicate');
      seen.add(key);
      normalized.push(Object.freeze({
        key,
        revision: text(entry.revision) || null,
        turn: Number.isSafeInteger(entry.turn) ? entry.turn : null,
        digest: text(entry.digest) || null
      }));
    }
    return normalized.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  };

  const enumerationDigest = entries => hash(entries.map(entry => [entry.key, entry.revision]));

  const buildSourceInventory = ({ family, entries = [], cursor = null, pageSize = 128, complete = false, ownerUnread = [] } = {}) => {
    const profile = profileFor(family);
    if (!profile) fail('family_unsupported');
    const all = normalizeEntries(entries);
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 128;
    const digest = enumerationDigest(all);
    let offset = 0;
    if (cursor != null) {
      if (cursor.schema !== 'libra.source_inventory_cursor.v1') fail('cursor_invalid');
      if (text(cursor.family) !== profile.family) fail('cursor_family_mismatch');
      if (text(cursor.digest) !== digest) fail('cursor_stale');
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > all.length) fail('cursor_invalid');
      offset = cursor.offset;
    }
    if (!Array.isArray(ownerUnread)) fail('owner_unread_invalid');
    const reportedUnread = [];
    for (const region of ownerUnread) {
      if (text(region?.family) !== profile.family) fail('owner_unread_family_mismatch');
      if (!text(region.cursor)) fail('owner_unread_cursor_required');
      reportedUnread.push(Object.freeze({ family: profile.family, cursor: text(region.cursor), reason: text(region.reason) || 'owner_cursor' }));
    }
    const page = all.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < all.length;
    const pageCoverage = truncated ? 'partial' : (complete === true ? 'complete' : 'partial');
    return Object.freeze({
      schema: 'libra.source_inventory.v1',
      family: profile.family,
      cursorBasis: profile.cursorBasis,
      digest,
      pageSize: size,
      entries: Object.freeze(page),
      entryCount: all.length,
      enumerated: Object.freeze({ from: offset, to: nextOffset, total: all.length }),
      coverage: pageCoverage,
      // A page boundary is an unread region, not a hidden one: callers must be able to report it.
      unread: Object.freeze([
        ...(truncated ? [{ family: profile.family, from: nextOffset, reason: 'page_boundary' }] : []),
        ...reportedUnread
      ]),
      nextCursor: Object.freeze(truncated ? { schema: 'libra.source_inventory_cursor.v1', family: profile.family, offset: nextOffset, digest } : null),
      removalObservable: profile.removalObservable === true,
      support: profile
    });
  };

  const diffInventories = (previous, next, options = {}) => {
    if (!previous || !next || previous.schema !== 'libra.source_inventory.v1' || next.schema !== 'libra.source_inventory.v1') fail('delta_requires_inventories');
    if (previous.family !== next.family) fail('delta_family_mismatch');
    const profile = profileFor(previous.family);
    // A page is not a family: comparing a bounded page against a whole enumeration would report
    // every out-of-page entry as a removal (a fabricated deletion). Both sides must cover the whole
    // enumeration extent; a full extent that the caller never declared complete is a softer case and
    // only downgrades deltaComplete.
    const wholeFamily = value => value.nextCursor === null && value.enumerated.from === 0;
    if (!wholeFamily(previous) || !wholeFamily(next)) fail('delta_requires_whole_family');
    // Two generations can cover different source windows. Then an entry that is absent from the new
    // window is outside it — not deleted — whatever the owner's tombstone support is, and the delta
    // says so instead of reporting a removal it cannot observe.
    const windowChanged = options.windowChanged === true;
    const before = new Map(previous.entries.map(entry => [entry.key, entry]));
    const after = new Map(next.entries.map(entry => [entry.key, entry]));
    const added = [];
    const changed = [];
    const removed = [];
    const unobservableRemoval = [];
    const unverified = [];
    const reasons = [];
    for (const [key, entry] of after) {
      if (!before.has(key)) { added.push(key); continue; }
      const prior = before.get(key);
      if (prior.revision !== entry.revision) changed.push({ key, from: prior.revision, to: entry.revision });
    }
    for (const key of before.keys()) {
      if (after.has(key)) continue;
      // An entry that disappeared is only a deletion where the owner reports tombstones.
      if (!windowChanged && profile.removalObservable === true) removed.push(key); else unobservableRemoval.push(key);
    }
    for (const [key, entry] of after) if (entry.revision === null) unverified.push(key);
    for (const inventory of [previous, next]) if (inventory.coverage !== 'complete') reasons.push('coverage_not_declared');
    if (windowChanged) reasons.push('window_changed');
    else if (unobservableRemoval.length && profile.removalObservable !== true) reasons.push('removal_not_observable');
    if (unverified.length) reasons.push('revision_unverifiable');
    return Object.freeze({
      schema: 'libra.source_inventory_delta.v1',
      family: profile.family,
      added: Object.freeze(added.sort((a, b) => a.localeCompare(b, 'en'))),
      changed: Object.freeze(changed.sort((a, b) => a.key.localeCompare(b.key, 'en'))),
      removed: Object.freeze(removed.sort((a, b) => a.localeCompare(b, 'en'))),
      unobservableRemoval: Object.freeze(unobservableRemoval.sort((a, b) => a.localeCompare(b, 'en'))),
      unverified: Object.freeze(unverified.sort((a, b) => a.localeCompare(b, 'en'))),
      unread: Object.freeze([...previous.unread, ...next.unread]),
      removalObservable: profile.removalObservable === true,
      windowChanged,
      deltaComplete: reasons.length === 0,
      reasons: Object.freeze(reasons)
    });
  };

  const mergeFamilyInventories = (inventories = []) => {
    if (!Array.isArray(inventories)) fail('inventories_invalid');
    const seen = new Set();
    const unreadRegions = [];
    const unverified = [];
    const removalsNotObservable = [];
    const ownerCursors = [];
    let complete = inventories.length > 0;
    for (const inventory of inventories) {
      if (!inventory || inventory.schema !== 'libra.source_inventory.v1') fail('inventory_invalid');
      if (seen.has(inventory.family)) fail('inventory_family_duplicate');
      seen.add(inventory.family);
      if (inventory.coverage !== 'complete') complete = false;
      unreadRegions.push(...inventory.unread);
      if (inventory.removalObservable !== true) removalsNotObservable.push(inventory.family);
      for (const region of inventory.unread) if (region.cursor) ownerCursors.push({ family: inventory.family, cursor: region.cursor, reason: region.reason });
      for (const entry of inventory.entries) if (entry.revision === null) unverified.push({ family: inventory.family, key: entry.key });
    }
    return Object.freeze({
      schema: 'libra.source_inventory_set.v1',
      families: Object.freeze([...seen].sort((a, b) => a.localeCompare(b, 'en'))),
      missingFamilies: Object.freeze(SOURCE_FAMILIES.filter(family => !seen.has(family))),
      coverage: complete && seen.size === SOURCE_FAMILIES.length ? 'complete' : 'partial',
      unreadRegions: Object.freeze(unreadRegions),
      ownerCursors: Object.freeze(ownerCursors),
      unverified: Object.freeze(unverified),
      removalsNotObservable: Object.freeze(removalsNotObservable),
      byteBounded: false
    });
  };

  return Object.freeze({
    SOURCE_FAMILIES,
    FAMILY_SUPPORT_PROFILES,
    supportBasisSymbols,
    buildSourceInventory,
    diffInventories,
    mergeFamilyInventories
  });
};
