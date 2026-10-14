'use strict';
// N02 first increment — the per-family representation contract.
//
// The semantic bridge already binds the canonical global projection to a space and rejects mismatches.
// What was missing is the contract around it: which text each family would embed and who would produce
// it, how a representation is identified, and what happens to units that have no vector at all. This
// kernel only describes and classifies — it starts no embedding job and writes nothing.
//
// 1. A family with no vector producer today is DECLARED as such (`vectorToday: false`), so missing
//    coverage is visible rather than implied by silence. Families must not all pretend to have vectors.
// 2. A representation is identified by a tuple (family, unit key, source basis, text hash, viewpoint,
//    space) — never by a copied vector: the canonical global vector stays bound to its source.
// 3. A unit whose vector is absent, in a foreign space, outside the query's temporal view or built on a
//    changed basis is classified with a reason, and still participates through the SAME kernel's
//    lexical/entity/predicate/graph access. No second dense ranker, no heuristic merge layer.
// 4. Coverage is reported as counts that add up, and `vectorCoverageComplete` stays false whenever any
//    unit is not a valid vector representation.
module.exports = function createMemoryGraphRepresentation({ fingerprint } = {}) {
  if (typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_REPRESENTATION_FINGERPRINT_REQUIRED');
  const fail = reason => { const error = new Error('LIBRA_GRAPH_REPRESENTATION_' + reason.toUpperCase()); error.reason = reason; throw error; };
  const text = value => String(value == null ? '' : value).trim();
  const digest = value => {
    const hashed = fingerprint(typeof value === 'string' ? value : JSON.stringify(value));
    if (!/^[a-f0-9]{64}$/.test(String(hashed))) fail('fingerprint_invalid');
    return String(hashed);
  };

  const SOURCE_FAMILIES = Object.freeze(['canonical', 'micro', 'state', 'lore']);

  // What each family would embed, who would produce it, and whether that producer exists today.
  const REPRESENTATION_UNITS = Object.freeze({
    canonical: Object.freeze({
      family: 'canonical', unit: 'source_global_projection', producer: 'owner_projection', maintenance: 'explicit_maintenance_only',
      textBasis: 'owner source record global projection', vectorToday: true, note: 'bound to the source node, never copied onto individual facts'
    }),
    micro: Object.freeze({
      family: 'micro', unit: 'none_declared', producer: 'none_declared', maintenance: 'none',
      textBasis: 'verified Micro claim span (candidate unit once a producer exists)', vectorToday: false,
      note: 'no vector producer today; participates lexically and by entity/predicate'
    }),
    state: Object.freeze({
      family: 'state', unit: 'none_declared', producer: 'none_declared', maintenance: 'none',
      textBasis: 'continuity field value plus evidence (candidate unit once a producer exists)', vectorToday: false,
      note: 'no vector producer today; participates lexically and by entity/predicate'
    }),
    lore: Object.freeze({
      family: 'lore', unit: 'none_declared', producer: 'none_declared', maintenance: 'none',
      textBasis: 'lore entry passage (candidate unit once a producer exists)', vectorToday: false,
      note: 'no vector producer today; participates lexically and by entity/predicate'
    })
  });

  const CHANNELS = Object.freeze(['vector', 'lexical', 'entity', 'predicate', 'graph']);

  // What each family would embed, who would embed it, and what may never trigger embedding. Declaring a
  // family without a producer is a decision, not an omission: the document embedding path consults this
  // gate, so a later change cannot start embedding a family silently.
  const PRODUCER_POLICIES = Object.freeze({
    canonical: Object.freeze({
      family: 'canonical', authorized: true, activation: 'explicit_maintenance_only',
      textUnit: 'owner source projection', textBasis: 'canonical commit envelope (turn range + source digest)',
      requiresOwnerBasis: true, precondition: Object.freeze([])
    }),
    micro: Object.freeze({
      family: 'micro', authorized: false, activation: 'none',
      textUnit: 'analysis receipt text', textBasis: 'not built', requiresOwnerBasis: true,
      precondition: Object.freeze([
        'a maintenance API that re-embeds a receipt only when its revision is still current',
        'an explicit budget for that maintenance, visible to the owner',
        'a receipt text basis that cannot be assembled from uncommitted analysis'
      ])
    }),
    state: Object.freeze({
      family: 'state', authorized: false, activation: 'none',
      textUnit: 'field evidence text', textBasis: 'not built', requiresOwnerBasis: true,
      precondition: Object.freeze([
        'a text basis that keeps certainty and disposition visible, so a vector cannot read as settled fact',
        'an explicit maintenance API and budget, as for micro',
        'a rule for fields whose evidence is withdrawn'
      ])
    }),
    lore: Object.freeze({
      family: 'lore', authorized: false, activation: 'none',
      textUnit: 'link passage text', textBasis: 'not built', requiresOwnerBasis: true,
      precondition: Object.freeze([
        'a tombstone-aware maintenance path, since lore is the family whose removals are observable',
        'an explicit maintenance API and budget, as for micro',
        'a passage locator that survives revision'
      ])
    })
  });
  const FORBIDDEN_TRIGGERS = Object.freeze(['query', 'write', 'load', 'session_start', 'boot', 'prefetch']);
  const producerPolicies = () => Object.freeze(SOURCE_FAMILIES.map(family => PRODUCER_POLICIES[family]));
  // Embedding is allowed only for a declared producer, only under explicit maintenance, and only with a
  // real owner basis. Everything else is refused by name rather than skipped quietly.
  const mayEmbed = ({ family, trigger, hasOwnerBasis } = {}) => {
    const wanted = text(family);
    const policy = PRODUCER_POLICIES[wanted];
    const asked = text(trigger);
    if (!policy) fail('family_unsupported', { family: wanted });
    if (!asked) fail('trigger_required', { family: wanted });
    const verdict = { family: wanted, trigger: asked, allowed: false, reason: '' };
    if (FORBIDDEN_TRIGGERS.includes(asked)) return Object.freeze({ ...verdict, reason: 'trigger_not_maintenance' });
    if (asked !== 'explicit_maintenance') return Object.freeze({ ...verdict, reason: 'trigger_not_maintenance' });
    if (policy.authorized !== true) return Object.freeze({ ...verdict, reason: 'producer_not_authorized' });
    if (policy.requiresOwnerBasis === true && hasOwnerBasis !== true) return Object.freeze({ ...verdict, reason: 'owner_basis_required' });
    return Object.freeze({ ...verdict, allowed: true });
  };

  const declaredUnits = () => Object.freeze(SOURCE_FAMILIES.map(family => REPRESENTATION_UNITS[family]));

  const representationId = ({ family, unitKey, sourceBasis, textHash, viewpoint = {}, space = {} } = {}) => {
    const unit = REPRESENTATION_UNITS[text(family)];
    if (!unit) fail('family_unsupported');
    if (!text(unitKey)) fail('unit_key_required');
    if (!text(textHash)) fail('text_hash_required');
    if (!text(sourceBasis)) fail('source_basis_required');
    if (!text(space.spaceId) || !text(space.provider) || !text(space.model) || !Number.isSafeInteger(space.dimension) || space.dimension < 1) {
      fail('space_binding_incomplete');
    }
    const bound = {
      family: unit.family,
      unitKey: text(unitKey),
      sourceBasis: text(sourceBasis),
      textHash: text(textHash),
      viewpoint: Object.freeze({
        worldlineId: text(viewpoint.worldlineId) || 'main',
        restoreEpoch: Number.isSafeInteger(viewpoint.restoreEpoch) ? viewpoint.restoreEpoch : 0,
        asOfTurn: Number.isSafeInteger(viewpoint.asOfTurn) ? viewpoint.asOfTurn : null,
        viewerId: text(viewpoint.viewerId)
      }),
      space: Object.freeze({
        spaceId: text(space.spaceId), provider: text(space.provider), model: text(space.model),
        dimension: Number(space.dimension), metric: text(space.metric) || 'cosine',
        taskPair: text(space.taskPair), profileDigest: text(space.profileDigest)
      })
    };
    return Object.freeze({
      schema: 'libra.representation_id.v1',
      representationId: digest(['libra.representation_id.v1', bound.family, bound.unitKey, bound.sourceBasis, bound.textHash, bound.viewpoint, bound.space]),
      ...bound
    });
  };

  const classifyRepresentation = ({ representation, space, viewpoint = {} } = {}) => {
    if (!representation || representation.schema !== 'libra.representation_id.v1') return Object.freeze({ status: 'missing', reason: 'representation_missing' });
    if (!space || !text(space.spaceId) || !text(space.provider) || !text(space.model) || !Number.isSafeInteger(space.dimension)) {
      fail('query_space_binding_incomplete');
    }
    const boundSpace = representation.space;
    if (boundSpace.spaceId !== text(space.spaceId) || boundSpace.provider !== text(space.provider) || boundSpace.model !== text(space.model)
      || boundSpace.dimension !== Number(space.dimension) || (text(space.metric) && boundSpace.metric !== text(space.metric))
      || text(boundSpace.taskPair) !== text(space.taskPair) || text(boundSpace.profileDigest) !== text(space.profileDigest)) {
      return Object.freeze({ status: 'foreign_space', reason: 'embedding_space_mismatch' });
    }
    const boundView = representation.viewpoint || {};
    if (text(boundView.viewerId) !== text(viewpoint.viewerId)) {
      return Object.freeze({ status: 'out_of_view', reason: 'representation_other_viewer' });
    }
    const asOfTurn = Number.isSafeInteger(viewpoint.asOfTurn) ? viewpoint.asOfTurn : null;
    if (asOfTurn !== null && !Number.isSafeInteger(boundView.asOfTurn)) {
      return Object.freeze({ status: 'out_of_view', reason: 'representation_viewpoint_unknown' });
    }
    if (asOfTurn !== null && boundView.asOfTurn > asOfTurn) {
      return Object.freeze({ status: 'out_of_view', reason: 'representation_outside_temporal_view' });
    }
    if (text(viewpoint.worldlineId) && boundView.worldlineId !== text(viewpoint.worldlineId)) {
      return Object.freeze({ status: 'out_of_view', reason: 'representation_other_worldline' });
    }
    if (Number.isSafeInteger(viewpoint.restoreEpoch) && boundView.restoreEpoch !== Number(viewpoint.restoreEpoch)) {
      return Object.freeze({ status: 'out_of_view', reason: 'representation_other_restore_epoch' });
    }
    return Object.freeze({ status: 'valid', reason: '' });
  };

  const classifyAgainstBasis = (representation, currentBasis) => {
    if (!representation || representation.schema !== 'libra.representation_id.v1') return Object.freeze({ status: 'missing', reason: 'representation_missing' });
    if (text(currentBasis) && representation.sourceBasis !== text(currentBasis)) {
      return Object.freeze({ status: 'stale_basis', reason: 'representation_basis_changed' });
    }
    return Object.freeze({ status: 'valid', reason: '' });
  };

  const planRepresentationAccess = ({ family, units = [], space, viewpoint = {} } = {}) => {
    const declaration = REPRESENTATION_UNITS[text(family)];
    if (!declaration) fail('family_unsupported');
    if (!Array.isArray(units)) fail('units_invalid');
    const coverage = { valid: 0, missing: 0, foreignSpace: 0, outOfView: 0, staleBasis: 0 };
    const planned = [];
    for (const unit of units) {
      const verdict = unit?.representation ? classifyRepresentation({ representation: unit.representation, space, viewpoint }) : { status: 'missing', reason: 'representation_missing' };
      const basisVerdict = verdict.status === 'valid' && unit.currentBasis !== undefined
        ? classifyAgainstBasis(unit.representation, unit.currentBasis) : verdict;
      const finalVerdict = verdict.status === 'valid' ? basisVerdict : verdict;
      if (finalVerdict.status === 'valid') coverage.valid += 1;
      else if (finalVerdict.status === 'foreign_space') coverage.foreignSpace += 1;
      else if (finalVerdict.status === 'out_of_view') coverage.outOfView += 1;
      else if (finalVerdict.status === 'stale_basis') coverage.staleBasis += 1;
      else coverage.missing += 1;
      const useVector = finalVerdict.status === 'valid' && declaration.vectorToday === true;
      planned.push(Object.freeze({
        unitKey: text(unit.unitKey),
        representationId: finalVerdict.status === 'valid' ? unit.representation.representationId : null,
        status: finalVerdict.status,
        reason: finalVerdict.reason,
        channels: Object.freeze(useVector ? ['vector', 'lexical', 'entity', 'predicate', 'graph'] : ['lexical', 'entity', 'predicate', 'graph'])
      }));
    }
    const total = planned.length;
    const counted = coverage.valid + coverage.missing + coverage.foreignSpace + coverage.outOfView + coverage.staleBasis;
    if (counted !== total) fail('coverage_miscount');
    return Object.freeze({
      schema: 'libra.representation_access_plan.v1',
      family: declaration.family,
      declaration,
      units: Object.freeze(planned),
      unitCount: total,
      coverage: Object.freeze(coverage),
      vectorCoverageComplete: total > 0 && coverage.valid === total,
      channels: CHANNELS,
      separateDenseRanker: false,
      heuristicMergeLayer: false,
      jobsStarted: 0,
      writes: 0,
      byteBounded: false
    });
  };

  return Object.freeze({
    SOURCE_FAMILIES, REPRESENTATION_UNITS, CHANNELS, FORBIDDEN_TRIGGERS, PRODUCER_POLICIES,
    declaredUnits, producerPolicies, mayEmbed, representationId, classifyRepresentation, classifyAgainstBasis, planRepresentationAccess
  });
};
