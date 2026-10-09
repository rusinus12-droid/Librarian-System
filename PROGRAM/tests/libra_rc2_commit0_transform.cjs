'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  rep('planner_narrative_prompt',
`      evidencePacket?.continuity_state_prompt || '',
      evidencePacket?.continuity_state_prompt ? '' : '',
      '[LIBRA RECALL EVIDENCE — READ ONLY; FINAL MODEL WILL NOT SEE THIS RAW DATA]',`,
`      evidencePacket?.continuity_state_prompt || '',
      evidencePacket?.continuity_state_prompt ? '' : '',
      evidencePacket?.narrative_prompt ? '[WORLD MANAGER NARRATIVE — FACTUAL CURRENT STATE / NOT A FUTURE COMMAND]' : '',
      evidencePacket?.narrative_prompt || '',
      evidencePacket?.narrative_prompt ? '' : '',
      evidencePacket?.narrative_direction_prompt ? '[USER NARRATIVE DIRECTION — FUTURE PREFERENCE / NOT AN ACCOMPLISHED FACT]' : '',
      evidencePacket?.narrative_direction_prompt || '',
      evidencePacket?.narrative_direction_prompt ? '' : '',
      '[LIBRA RECALL EVIDENCE — READ ONLY; FINAL MODEL WILL NOT SEE THIS RAW DATA]',`);

  rep('narrative_cache_identity_helper',
`    };

    const plannerCacheKeyFor = (context, evidencePacket, promptProvenance = null, routeIdentity = null) => digest({`,
`    };

    const narrativeCacheIdentityForEvidence = evidencePacket => {
      const narrative = __libraCompletionUnwrapNarrative(evidencePacket?.narrative_state);
      const narrativePrompt = string(evidencePacket?.narrative_prompt || '');
      const direction = evidencePacket?.narrative_direction && typeof evidencePacket.narrative_direction === 'object' ? evidencePacket.narrative_direction : null;
      const directionPrompt = string(evidencePacket?.narrative_direction_prompt || '');
      const narrativeIdentity = narrative || narrativePrompt ? {
        schema: string(narrative?.schema || 'libra.narrative_state.v1'), revision: Number(narrative?.revision || 0),
        updatedThroughTurn: Number(narrative?.updatedThroughTurn || 0), semanticHash: narrative ? digest(narrative) : '',
        promptHash: narrativePrompt ? digest(narrativePrompt) : ''
      } : null;
      const narrativeDirectionIdentity = direction || directionPrompt ? {
        schema: string(direction?.schema || __LIBRA_PLANNER_DIRECTION_SCHEMA), scopeKey: string(direction?.scopeKey || ''),
        updatedAt: Number(direction?.updatedAt || 0), semanticHash: direction ? digest(direction) : '',
        promptHash: directionPrompt ? digest(directionPrompt) : ''
      } : null;
      return { narrativeIdentity, narrativeDirectionIdentity };
    };

    const plannerCacheKeyFor = (context, evidencePacket, promptProvenance = null, routeIdentity = null) => digest({`);

  rep('planner_cache_identity',
`      responseLoreViewHash: string(evidencePacket?.lore_material?.stages?.planner?.viewHash || ''),
      responseLorePromptHash: digest(string(evidencePacket?.lore_prompt || '')),
      continuityState: continuityStateCacheIdentityForEvidence(evidencePacket),
      sources: Object.values(asObject(evidencePacket?.layers)).flatMap`,
`      responseLoreViewHash: string(evidencePacket?.lore_material?.stages?.planner?.viewHash || ''),
      responseLorePromptHash: digest(string(evidencePacket?.lore_prompt || '')),
      continuityState: continuityStateCacheIdentityForEvidence(evidencePacket),
      ...narrativeCacheIdentityForEvidence(evidencePacket),
      sources: Object.values(asObject(evidencePacket?.layers)).flatMap`);

  rep('sga_packet_identity',
`        const raw = await sgaEvidenceForStageLegacy0316(...__args);
        const narrative = await __libraCompletionGetNarrative(__args);
        const scopeKey = __libraCompletionScopeFromArgs(__args);
        const direction = await getPlannerNarrativeDirection({scopeKey});`,
`        const raw = await sgaEvidenceForStageLegacy0316(...__args);
        const narrative = __libraCompletionFindNarrativeInArgs(__args) || await __libraCompletionGetNarrative(__args);
        const scopeKey = __libraCompletionScopeFromArgs(__args);
        const direction = __libraCompletionFindDirectionInArgs(__args) || await getPlannerNarrativeDirection({scopeKey});`);

  rep('sga_direction_prompt',
`        out.narrative_direction = direction;
        if (Array.isArray(out.materials)) {`,
`        out.narrative_direction = direction;
        out.narrative_direction_prompt = plannerNarrativeDirectionPromptBlock(direction);
        if (Array.isArray(out.materials)) {`);

  const cacheNeedle = `      responseLoreStageHashes: Object.fromEntries(Object.entries(asObject(evidencePacket?.lore_material?.stages)).map(([stageId, view]) => [stageId, string(view?.viewHash || '')])),
      continuityState: continuityStateCacheIdentityForEvidence(evidencePacket),
      sources: Object.values(asObject(evidencePacket?.layers)).flatMap`;
  rep('sga_cache_identity', cacheNeedle,
`      responseLoreStageHashes: Object.fromEntries(Object.entries(asObject(evidencePacket?.lore_material?.stages)).map(([stageId, view]) => [stageId, string(view?.viewHash || '')])),
      continuityState: continuityStateCacheIdentityForEvidence(evidencePacket),
      ...narrativeCacheIdentityForEvidence(evidencePacket),
      sources: Object.values(asObject(evidencePacket?.layers)).flatMap`);

  rep('route_narrative_state',
`        let storyArcForRoute = null;
        let continuityStateForRoute = null;
        let responseMaterialSource = null;`,
`        let storyArcForRoute = null;
        let continuityStateForRoute = null;
        let narrativeForRoute = null;
        let narrativeDirectionForRoute = null;
        let responseMaterialSource = null;`);

  rep('route_narrative_load',
`          } catch (error) {
            warn('LIBRA current-state response preparation failed open', error);
            continuityStateForRoute = null;
          }
          try {
            storyArcForRoute = await ensureStoryArcForResponse`,
`          } catch (error) {
            warn('LIBRA current-state response preparation failed open', error);
            continuityStateForRoute = null;
          }
          narrativeForRoute = __libraCompletionUnwrapNarrative(continuityStateForRoute);
          if (!narrativeForRoute) {
            try { narrativeForRoute = await __libraCompletionGetNarrative([context]); }
            catch (error) { warn('LIBRA narrative response preparation failed open', error); narrativeForRoute = null; }
          }
          try {
            narrativeDirectionForRoute = await getPlannerNarrativeDirection({ scopeKey: string(context?.scope?.scopeKey || '') });
          } catch (error) {
            warn('LIBRA narrative direction response preparation failed open', error);
            narrativeDirectionForRoute = null;
          }
          try {
            storyArcForRoute = await ensureStoryArcForResponse`);

  rep('route_evidence_packet',
`          continuityStateForRoute
        );
        const delivery = asObject(result?.delivery);`,
`          continuityStateForRoute
        );
        if (injectionMode !== 'classic') {
          evidencePacket.narrative_state = narrativeForRoute;
          evidencePacket.narrative_prompt = narrativeForRoute ? narrativeStatePromptBlock(narrativeForRoute, injectionMode) : '';
          evidencePacket.narrative_direction = narrativeDirectionForRoute;
          evidencePacket.narrative_direction_prompt = narrativeDirectionForRoute ? plannerNarrativeDirectionPromptBlock(narrativeDirectionForRoute) : '';
        }
        const delivery = asObject(result?.delivery);`);

  rep('route_delivery_identity',
`        delivery.continuityStateThroughTurn = Number(continuityStateForRoute?.throughTurn || 0);

        // Recall is deadline-bounded.`,
`        delivery.continuityStateThroughTurn = Number(continuityStateForRoute?.throughTurn || 0);
        delivery.narrativeUsed = !!narrativeForRoute;
        delivery.narrativeThroughTurn = Number(narrativeForRoute?.updatedThroughTurn || 0);
        delivery.narrativeIdentityHash = narrativeForRoute ? digest(narrativeForRoute) : '';
        delivery.narrativeDirectionUsed = !!narrativeDirectionForRoute?.goal
          || asArray(narrativeDirectionForRoute?.completionConditions).length > 0
          || asArray(narrativeDirectionForRoute?.doNotForce).length > 0
          || asArray(narrativeDirectionForRoute?.softPreferences).length > 0;
        delivery.narrativeDirectionIdentityHash = narrativeDirectionForRoute ? digest(narrativeDirectionForRoute) : '';

        // Recall is deadline-bounded.`);

  return { source, labels };
};
