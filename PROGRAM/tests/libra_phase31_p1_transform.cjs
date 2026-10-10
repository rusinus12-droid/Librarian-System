'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const replace = (label, before, after) => {
    source = replaceExactlyOnce(source, before, after, label);
    labels.push(label);
  };

  replace('pending_state_without_boundary_promotes_canonical',
`    const plannerCanonicalPriorityPartition = (layersValue, authorityValue = null) => {
      const layers = asObject(layersValue);
      const authority = asObject(authorityValue);
      const boundary = normalizeContinuityEvidence(authority.boundaryEvidence);
      const newer = { memory: [], entity: [], world: [], narrative: [] };
      const historical = { memory: [], entity: [], world: [], narrative: [] };
      for (const layerName of Object.keys(newer)) {
        for (const row of asArray(layers[layerName])) {
          const rowEvidence = normalizeContinuityEvidence({
            memoryId: row?.memoryId, revision: row?.revision, sessionEpoch: row?.sessionEpoch,
            inherited: row?.inheritedSessionHistory, turnRange: row?.turnRange, sourceDigest: row?.sourceDigest
          });
          const target = boundary && compareResponseTimelinePosition(rowEvidence, boundary) > 0 ? newer : historical;
          target[layerName].push(clone(row));
        }
      }
      const count = bucket => Object.values(bucket).reduce((sum, rows) => sum + asArray(rows).length, 0);
      return {
        schema: 'libra.planner_canonical_priority.v1',
        boundaryEvidence: clone(boundary),
        stateAuthority: string(authority.authority || 'unavailable'),
        stateCurrent: authority.current === true,
        statePending: authority.pending === true,
        pendingDomains: asArray(authority.pendingDomains).slice(),
        newerThanState: newer,
        historicalAtOrBeforeState: historical,
        newerCount: count(newer),
        historicalCount: count(historical)
      };
    };
`,
`    const plannerCanonicalPriorityPartition = (layersValue, authorityValue = null) => {
      const layers = asObject(layersValue);
      const authority = asObject(authorityValue);
      const boundary = normalizeContinuityEvidence(authority.boundaryEvidence);
      const promoteAllCanonical = authority.pending === true && !boundary;
      const boundaryMode = boundary
        ? 'exact_boundary'
        : promoteAllCanonical
          ? 'pending_without_safe_boundary_all_canonical_newer'
          : 'no_boundary';
      const newer = { memory: [], entity: [], world: [], narrative: [] };
      const historical = { memory: [], entity: [], world: [], narrative: [] };
      for (const layerName of Object.keys(newer)) {
        for (const row of asArray(layers[layerName])) {
          const rowEvidence = normalizeContinuityEvidence({
            memoryId: row?.memoryId, revision: row?.revision, sessionEpoch: row?.sessionEpoch,
            inherited: row?.inheritedSessionHistory, turnRange: row?.turnRange, sourceDigest: row?.sourceDigest
          });
          const target = promoteAllCanonical
            ? newer
            : boundary && compareResponseTimelinePosition(rowEvidence, boundary) > 0
              ? newer
              : historical;
          target[layerName].push(clone(row));
        }
      }
      const count = bucket => Object.values(bucket).reduce((sum, rows) => sum + asArray(rows).length, 0);
      return {
        schema: 'libra.planner_canonical_priority.v1',
        boundaryEvidence: clone(boundary),
        boundaryMode,
        stateAuthority: string(authority.authority || 'unavailable'),
        stateCurrent: authority.current === true,
        statePending: authority.pending === true,
        pendingDomains: asArray(authority.pendingDomains).slice(),
        newerThanState: newer,
        historicalAtOrBeforeState: historical,
        newerCount: count(newer),
        historicalCount: count(historical)
      };
    };
`);

  replace('portable_multiverse_derived_rollback_capture',
`    const capturePortableStateDerivedRollback = async ({ rollback, scope, manifest } = {}) => {
      if (!rollback?.capture || !scope) throw new Error('portable_state_rollback_capture_invalid');
      const sharedKeys = [
        key.continuityState(scope), key.entityRegistry(scope), key.stateCorrections(scope),
        key.stateCorrectionMeta(scope), key.stateCorrectionCommit(scope), key.stateWorldlineMeta(scope),
        key.stateReplayCache(scope), key.stateReplayErrors(scope)
      ];
      for (const storageKey of sharedKeys) await rollback.capture(storageKey);
      for (const ref of statePipelineReplayRefs(manifest)) {
        const memoryId = string(ref?.memoryId || '');
        const revision = Number(ref?.revision || 0);
        if (!memoryId || revision < 1) continue;
        await rollback.capture(key.manualStateDisposition(scope, memoryId, revision));
        await rollback.capture(entityAdmissionStorageKey(scope, memoryId, revision));
        await rollback.capture(key.statePipelineReceipt(scope, memoryId, revision));
        for (const domain of STATE_PIPELINE_DOMAINS) await rollback.capture(key.stateObservation(scope, memoryId, revision, domain));
      }
    };
`,
`    const capturePortableStateDerivedRollback = async ({ rollback, scope, manifest } = {}) => {
      if (!rollback?.capture || !scope) throw new Error('portable_state_rollback_capture_invalid');
      const sharedKeys = [
        key.continuityState(scope), key.entityRegistry(scope), key.stateCorrections(scope),
        key.stateCorrectionMeta(scope), key.stateCorrectionCommit(scope), key.stateWorldlineMeta(scope),
        key.stateReplayCache(scope), key.stateReplayErrors(scope)
      ];
      for (const storageKey of sharedKeys) await rollback.capture(storageKey);
      const refs = statePipelineReplayRefs(manifest);
      const worldlineMeta = await storage.getJson(key.stateWorldlineMeta(scope), null);
      const knownWorldlineIds = new Set(['main']);
      if (worldlineMeta?.activeWorldlineId) knownWorldlineIds.add(string(worldlineMeta.activeWorldlineId));
      for (const [worldlineKey, rowValue] of Object.entries(asObject(worldlineMeta?.worldlines))) {
        const row = asObject(rowValue);
        if (worldlineKey) knownWorldlineIds.add(string(worldlineKey));
        if (row.id) knownWorldlineIds.add(string(row.id));
        if (row.parentId) knownWorldlineIds.add(string(row.parentId));
      }
      for (const ref of refs) {
        if (ref?.logicalWorldlineId) knownWorldlineIds.add(string(ref.logicalWorldlineId));
        if (ref?.worldlineId) knownWorldlineIds.add(string(ref.worldlineId));
      }
      for (const ref of refs) {
        const memoryId = string(ref?.memoryId || '');
        const revision = Number(ref?.revision || 0);
        if (!memoryId || revision < 1) continue;
        await rollback.capture(key.manualStateDisposition(scope, memoryId, revision));
        await rollback.capture(entityAdmissionStorageKey(scope, memoryId, revision));
        for (const worldlineId of knownWorldlineIds) {
          await rollback.capture(key.statePipelineReceipt(scope, memoryId, revision, worldlineId));
          for (const domain of STATE_PIPELINE_DOMAINS) {
            await rollback.capture(key.stateObservation(scope, memoryId, revision, domain, worldlineId));
          }
        }
      }
    };
`);

  return { source, labels };
};
