/* MEMORY SUITE SOURCE TURN ACCOUNTING v1 — BEGIN
 * Pure accounting over owner-verified final emitted evidence. UTF-16 offsets.
 * verified/current are assertions supplied AFTER the owner's existing final
 * guards; this helper does not verify storage, confer authority, or set quotas.
 * Locator IDs, record IDs, ordinal ranges and digests alone are not turn IDs.
 */
function countMemorySuiteSourceTurns(input) {
  'use strict';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string' ? value : '';
  const identityText = value => typeof value === 'string' && value.trim().length > 0;
  const owner = string(input?.owner);
  const identities = new Map(), lanes = new Map(), reasons = new Set();
  let unresolvedUnits = 0, emittedUnits = 0;
  const laneState = name => {
    if (!lanes.has(name)) lanes.set(name, { keys: new Set(), unresolved: 0, emitted: 0 });
    return lanes.get(name);
  };
  const unresolvedInput = reason => {
    unresolvedUnits += 1; reasons.add(reason);
  };
  if (!Array.isArray(input?.units)) unresolvedInput('units_unavailable');
  else for (let index = 0; index < input.units.length; index += 1) {
    const unit = input.units[index];
    if (!object(unit) || typeof unit.emittedText !== 'string') { unresolvedInput('emission_unavailable'); continue; }
    if (!unit.emittedText.length) continue;
    emittedUnits += 1;
    const lane = identityText(unit.lane) ? unit.lane : 'unclassified', state = laneState(lane);
    state.emitted += 1;
    let unresolved = unit.attributionComplete !== true;
    if (unresolved) reasons.add('attribution_incomplete');
    if (!Array.isArray(unit.contributors) || !unit.contributors.length) {
      unresolved = true; reasons.add('original_turn_unresolved');
    } else for (let at = 0; at < unit.contributors.length; at += 1) {
      const contributor = unit.contributors[at];
      let reason = '';
      if (!object(contributor) || contributor.verified !== true) reason = 'contributor_unverified';
      else if (contributor.current !== true || contributor.deleted === true || contributor.rolledBack === true) reason = 'contributor_not_current';
      else if (![owner, contributor.scope, contributor.generation, contributor.originalTurnId].every(identityText)) reason = 'original_identity_incomplete';
      else if (!object(contributor.range) || !Number.isSafeInteger(contributor.range.start)
        || !Number.isSafeInteger(contributor.range.end) || contributor.range.start < 0
        || contributor.range.end <= contributor.range.start || contributor.range.end > unit.emittedText.length
        || typeof contributor.text !== 'string'
        || unit.emittedText.slice(contributor.range.start, contributor.range.end) !== contributor.text) reason = 'emitted_range_unverified';
      if (reason) { unresolved = true; reasons.add(reason); continue; }
      const identity = [owner, contributor.scope, contributor.generation, contributor.originalTurnId];
      const key = JSON.stringify(identity);
      if (!identities.has(key)) identities.set(key, { identity, lanes: new Set() });
      identities.get(key).lanes.add(lane); state.keys.add(key);
    }
    if (unresolved) { unresolvedUnits += 1; state.unresolved += 1; }
  }
  const known = identities.size;
  const descriptors = [...identities.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, row]) => ({ owner: row.identity[0], scope: row.identity[1], generation: row.identity[2],
      originalTurnId: row.identity[3], lanes: [...row.lanes].sort() }));
  return {
    schema: 'memory-suite.source-turn-accounting.v1', basis: 'final_emitted_evidence', owner,
    status: unresolvedUnits ? known ? 'partial' : 'unknown' : 'complete',
    knownUniqueOriginalTurns: known, completeUniqueOriginalTurns: unresolvedUnits ? null : known,
    emittedUnits, unresolvedUnits, reasons: [...reasons].sort(),
    lanes: [...lanes.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([lane, state]) => ({
      lane, emittedUnits: state.emitted, knownUniqueOriginalTurns: state.keys.size,
      completeUniqueOriginalTurns: state.unresolved ? null : state.keys.size, unresolvedUnits: state.unresolved
    })),
    overlap: {
      multipleLanesKnownOriginalTurns: descriptors.filter(row => row.lanes.length > 1).length,
      coreOptionalKnownOriginalTurns: descriptors.filter(row => row.lanes.includes('core') && row.lanes.some(lane => lane !== 'core')).length
    },
    identities: descriptors
  };
}
/* MEMORY SUITE SOURCE TURN ACCOUNTING v1 — END */
