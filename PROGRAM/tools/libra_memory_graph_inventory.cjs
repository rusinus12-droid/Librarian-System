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

  // N01-A: Explicit per-family incremental source currentness & conservative reread contracts.
  // Declares what owner change proofs guarantee without re-reading historical window record bodies
  // versus what must retain request-level rereading or consumed-readset physical verification.
  const FAMILY_CURRENTNESS_CONTRACTS = Object.freeze({
    canonical: Object.freeze({
      family: 'canonical',
      proofMode: 'owner_manifest_ref_table_and_registry',
      proofBasis: Object.freeze(['owner_manifest_ref_table', 'entity_registry', 'restore_epoch', 'approved_evidence_binding']),
      guaranteedScope: Object.freeze(['unchanged_window_canonical_record_bodies', 'unchanged_window_canonical_assertions_and_edges']),
      reReadRequiredScope: Object.freeze(['owner_manifest_head', 'entity_registry_head', 'changed_canonical_windows', 'consumed_readset_physical_records']),
      skipUnchangedWindowBodyRead: true,
      reReadRequiredEveryRequest: false,
      unobservableWithoutFullAudit: Object.freeze(['unpinned_raw_storage_tampering_without_manifest_revision_change']),
      evidenceSymbols: Object.freeze(['canonicalReaderRefIdentity', 'loadManifest', 'ENTITY_REGISTRY_SCHEMA', 'microRestoreGeneration'])
    }),
    micro: Object.freeze({
      family: 'micro',
      proofMode: 'host_turn_pair_and_micro_head_revision',
      proofBasis: Object.freeze(['host_completed_turn_pair_digest', 'completed_turn_head_revision', 'micro_memory_head_revision', 'micro_work_attempt_digest', 'restore_epoch']),
      guaranteedScope: Object.freeze(['unchanged_window_micro_turn_record_bodies', 'unchanged_window_completed_turn_receipt_bodies', 'unchanged_window_micro_candidate_units']),
      reReadRequiredScope: Object.freeze(['host_chat_turn_pairs', 'per_turn_completed_and_micro_heads', 'changed_micro_windows', 'consumed_readset_physical_records']),
      skipUnchangedWindowBodyRead: true,
      reReadRequiredEveryRequest: false,
      unobservableWithoutFullAudit: Object.freeze(['unpinned_raw_micro_record_tampering_without_head_or_pair_change']),
      evidenceSymbols: Object.freeze(['completedTurnRevisionId', 'readActiveCompletedTurnReceipt', 'libra.micro_memory_head.v1', 'microRestoreGeneration'])
    }),
    state: Object.freeze({
      family: 'state',
      proofMode: 'scope_singleton_state_head_and_correction_journal',
      proofBasis: Object.freeze(['continuity_state_head', 'state_worldline_meta', 'state_correction_journal_revision', 'entity_registry', 'restore_epoch']),
      guaranteedScope: Object.freeze(['scope_singleton_state_projection_across_historical_windows']),
      reReadRequiredScope: Object.freeze(['scope_state_head_every_request', 'state_correction_journal_head_every_request', 'consumed_state_decision_keys']),
      skipUnchangedWindowBodyRead: true,
      reReadRequiredEveryRequest: true,
      unobservableWithoutFullAudit: Object.freeze([]),
      evidenceSymbols: Object.freeze(['loadContinuityStateForResponse', 'loadStateCorrectionJournal', 'stateWorldlineMeta'])
    }),
    lore: Object.freeze({
      family: 'lore',
      proofMode: 'host_lore_snapshot_and_link_index_reread',
      proofBasis: Object.freeze(['host_risu_lore_snapshot_digest', 'lore_link_mapping_head', 'lore_link_index_basis_digest']),
      guaranteedScope: Object.freeze(['scope_singleton_lore_projection_across_historical_windows']),
      reReadRequiredScope: Object.freeze(['host_risu_lore_snapshot_every_request', 'lore_link_mapping_every_request', 'lore_link_index_basis_every_request']),
      skipUnchangedWindowBodyRead: false,
      reReadRequiredEveryRequest: true,
      unobservableWithoutFullAudit: Object.freeze([]),
      evidenceSymbols: Object.freeze(['loadRisuContextSnapshot', 'loreLinkAllowedEntries', 'buildLoreLinkIndex'])
    })
  });

  const profileFor = family => FAMILY_SUPPORT_PROFILES[text(family)] || null;
  const currentnessContractFor = family => {
    const contract = FAMILY_CURRENTNESS_CONTRACTS[text(family)];
    if (!contract) fail('family_unsupported');
    return contract;
  };
  const supportBasisSymbols = family => {
    const profile = profileFor(family);
    if (!profile) fail('family_unsupported');
    return profile.basis;
  };

  const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  const verifyIncrementalSourceProofs = (published, live) => {
    if (!published || !live || published.schema !== 'libra.graph_corpus_owner_proof.v1'
      || live.schema !== 'libra.graph_corpus_owner_proof.v1') fail('owner_proof_invalid');
    if (!Array.isArray(published.windows) || !Array.isArray(live.windows) || !published.windows.length) fail('owner_proof_windows_invalid');
    const frameChanged = published.scopeKey !== live.scopeKey
      || published.worldlineId !== live.worldlineId
      || Number(published.restoreEpoch) !== Number(live.restoreEpoch)
      || (published.cutoffTurn ?? null) !== (live.cutoffTurn ?? null);
    const windowCountChanged = published.windows.length !== live.windows.length;
    const canonicalWindows = new Set(), microWindows = new Set(), stateReasons = [], loreReasons = [];
    const canonicalReasons = [], microReasons = [];
    if (published.manifestDigest !== live.manifestDigest) canonicalReasons.push('manifest_ref_table_changed');
    if (published.registryDigest !== live.registryDigest) {
      canonicalReasons.push('entity_registry_changed');
      stateReasons.push('entity_registry_changed');
    }
    if (published.turnPairsDigest !== live.turnPairsDigest) microReasons.push('host_turn_pairs_changed');
    const maxWindows = Math.max(published.windows.length, live.windows.length);
    for (let index = 0; index < maxWindows; index++) {
      const before = published.windows[index], after = live.windows[index];
      if (!before || !after) {
        canonicalWindows.add(index);
        microWindows.add(index);
        continue;
      }
      if (!sameJson(before.canonicalSlice, after.canonicalSlice)) canonicalWindows.add(index);
      if (!sameJson(before.microSlice, after.microSlice)) microWindows.add(index);
    }
    if (canonicalWindows.size && !canonicalReasons.length) canonicalReasons.push('canonical_window_slice_changed');
    if (microWindows.size && !microReasons.length) microReasons.push('micro_window_head_or_pair_changed');
    if (!sameJson(published.stateProof, live.stateProof)) stateReasons.push('state_head_or_correction_changed');
    if (!sameJson(published.loreProof, live.loreProof)) loreReasons.push('host_lore_or_link_basis_changed');
    if (frameChanged) {
      for (const list of [canonicalReasons, microReasons, stateReasons, loreReasons]) list.push('frame_or_restore_epoch_changed');
    }
    if (windowCountChanged) {
      canonicalReasons.push('window_count_changed');
      microReasons.push('window_count_changed');
    }
    const buildVerdict = (family, reasons, windowsChanged = []) => {
      const contract = FAMILY_CURRENTNESS_CONTRACTS[family];
      const uniqueReasons = [...new Set(reasons)];
      return Object.freeze({
        family,
        status: uniqueReasons.length === 0 && windowsChanged.length === 0 ? 'verified' : 'changed',
        proofMode: contract.proofMode,
        skipUnchangedWindowBodyRead: contract.skipUnchangedWindowBodyRead,
        reReadRequiredEveryRequest: contract.reReadRequiredEveryRequest,
        guaranteedScope: contract.guaranteedScope,
        reReadRequiredScope: contract.reReadRequiredScope,
        changedWindows: Object.freeze([...windowsChanged].sort((a, b) => a - b)),
        reasons: Object.freeze(uniqueReasons)
      });
    };
    const allWindowIndices = Array.from({ length: maxWindows }, (_, index) => index);
    const familyVerdicts = Object.freeze({
      canonical: buildVerdict('canonical', canonicalReasons, [...canonicalWindows]),
      micro: buildVerdict('micro', microReasons, [...microWindows]),
      state: buildVerdict('state', stateReasons, stateReasons.length ? [0] : []),
      lore: buildVerdict('lore', loreReasons, loreReasons.length ? [0] : [])
    });
    const changedFamilies = SOURCE_FAMILIES.filter(family => familyVerdicts[family].status !== 'verified');
    const changedWindowSet = new Set([...canonicalWindows, ...microWindows]);
    if (stateReasons.length || loreReasons.length || frameChanged) changedWindowSet.add(0);
    const changedWindows = [...changedWindowSet].sort((a, b) => a - b);
    const unchangedWindows = allWindowIndices.filter(index => !changedWindowSet.has(index));
    const sharedSingletonUnchanged = !frameChanged
      && published.registryDigest === live.registryDigest
      && stateReasons.length === 0
      && loreReasons.length === 0;
    const minWindows = Math.min(published.windows.length, live.windows.length);
    const reusableWindows = sharedSingletonUnchanged
      ? Array.from({ length: minWindows }, (_, index) => index)
          .filter(index => !canonicalWindows.has(index) && !microWindows.has(index))
      : [];
    const canonicalKeys = new Set(), microTurns = new Set();
    for (const win of live.windows) {
      for (const item of Array.isArray(win?.canonicalSlice) ? win.canonicalSlice : []) {
        if (item?.refIdentity?.key) canonicalKeys.add(String(item.refIdentity.key));
      }
      for (const item of Array.isArray(win?.microSlice) ? win.microSlice : []) {
        if (Number.isSafeInteger(item?.turn)) microTurns.add(Number(item.turn));
      }
    }
    return Object.freeze({
      schema: 'libra.graph_corpus_currentness.v1',
      status: !frameChanged && !windowCountChanged && changedFamilies.length === 0 && changedWindows.length === 0 ? 'verified' : 'stale_source',
      mode: 'incremental_owner_proof',
      frameChanged,
      windowCountChanged,
      publishedWindowCount: published.windows.length,
      liveWindowCount: live.windows.length,
      liveCanonicalTotal: canonicalKeys.size,
      liveMicroTurnTotal: microTurns.size,
      changedFamilies: Object.freeze(changedFamilies),
      changedWindows: Object.freeze(changedWindows),
      unchangedWindows: Object.freeze(unchangedWindows),
      reusableWindows: Object.freeze(reusableWindows),
      liveWindows: Object.freeze(live.windows.map((win, index) => Object.freeze({
        ordinal: index,
        canonicalOffset: Number.isSafeInteger(win?.canonicalOffset) ? win.canonicalOffset : null,
        microOffset: Number.isSafeInteger(win?.microOffset) ? win.microOffset : null,
        limit: Number.isSafeInteger(win?.limit) ? win.limit : null
      }))),
      familyVerdicts,
      guaranteedFamiliesWithoutBodyReRead: Object.freeze(SOURCE_FAMILIES.filter(f => FAMILY_CURRENTNESS_CONTRACTS[f].skipUnchangedWindowBodyRead)),
      reReadRequiredEveryRequestFamilies: Object.freeze(SOURCE_FAMILIES.filter(f => FAMILY_CURRENTNESS_CONTRACTS[f].reReadRequiredEveryRequest)),
      bodyReReadRequiredFamilies: Object.freeze(SOURCE_FAMILIES.filter(f => !FAMILY_CURRENTNESS_CONTRACTS[f].skipUnchangedWindowBodyRead)),
      consumedReadSetPhysicalRecheckRequired: true,
      ownerAtomicity: false,
      byteBounded: false
    });
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
    FAMILY_CURRENTNESS_CONTRACTS,
    currentnessContractFor,
    supportBasisSymbols,
    verifyIncrementalSourceProofs,
    buildSourceInventory,
    diffInventories,
    mergeFamilyInventories
  });
};
