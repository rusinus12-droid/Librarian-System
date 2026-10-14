'use strict';
// Pure projection of JSON snapshots collected by the private owner reader bridge.
// No storage, provider, identity inference, physical-proof issuance or final ranking.
module.exports = function createMemoryGraphReaders({ identity, normalizeName, digestClaim } = {}) {
  if (!identity || typeof identity.meaning !== 'function') throw new TypeError('LIBRA_GRAPH_IDENTITY_REQUIRED');
  const array = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const string = value => typeof value === 'string' ? value : '';
  const clone = value => JSON.parse(JSON.stringify(value));
  const normalized = normalizeName || (value => string(value).normalize('NFKC').trim().toLowerCase());
  const own = (value, key) => Object.hasOwn(object(value), key);
  const project = (snapshot, { nodeLimit = 2048 } = {}) => {
    const frame = clone(snapshot.frame);
    if (!frame.owner || !frame.scopeKey || !frame.worldlineId || !Number.isSafeInteger(frame.restoreEpoch)
      || frame.restoreEpoch < 0 || !Number.isSafeInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > 8192) throw new TypeError('LIBRA_GRAPH_READER_FRAME_INVALID');
    const namespace = 'libra', nodes = new Map(), edges = new Map(), bases = new Map(), units = [];
    const families = Object.fromEntries(['canonical', 'micro', 'state', 'lore'].map(kind => [kind,
      { records: 0, units: 0, reasons: [], representation: kind === 'micro' ? 'producer_bounded' : kind === 'lore' ? 'rendered_passages' : 'stored_schema' }]));
    const note = (family, reason) => { if (!families[family].reasons.includes(reason)) families[family].reasons.push(reason); };
    const check = (needed = 1) => { if (nodes.size + needed > nodeLimit) throw new Error('LIBRA_GRAPH_NODE_BUDGET'); };
    const bound = (key, revision, body) => ({ ...frame, revision, locator: { recordKey: key }, body: clone(body) });
    const legacy = (key, revision, body, originScope = frame.scopeKey, recordKind = 'projection') => ({
      kind: 'revision_bound', ownerNamespace: namespace, originScope, recordKind, recordKey: key,
      revision, restoreEpoch: frame.restoreEpoch, snapshot: clone(body) });
    const keep = node => { nodes.set(node.id, node); return node; };
    const source = (family, key, revision, body, originScope = frame.scopeKey, minChildNodes = 0) => {
      check(1 + minChildNodes); families[family].records++;
      return { node: keep(identity.source({ identity: legacy(key, revision, body, originScope, family), binding: bound(key, revision, body) })),
        family, key, revision, body, originScope };
    };
    const meaning = (src, kind, key, body, anchor, metadata) => {
      check(1); const node = keep(identity.meaning({ source: src.node, kind,
        identity: legacy(key, src.revision, body, src.originScope), anchor,
        binding: bound(key, src.revision, body) }));
      units.push({ nodeId: node.id, family: src.family, ...clone(metadata) }); families[src.family].units++;
      return node;
    };
    const basis = (src, kind, key, body, anchor) => {
      const value = identity.basis({ source: src.node, kind, identity: legacy(key, src.revision, body, src.originScope),
        anchor, binding: bound(key, src.revision, body) }); bases.set(value.id, value); return value;
    };
    const link = (from, to, predicate, reason, qualifier = {}, validTime = null) => {
      if (!to || !reason) return;
      const body = { from: from.id, to: to.id, predicate, qualifier, validTime, basisId: reason.id };
      const value = identity.edge({ from, to, predicate, qualifier, validTime, basis: reason,
        binding: bound('edge:' + reason.id, 1, body) }); edges.set(value.id, value);
    };
    const attempt = (family, run) => { try { run(); } catch (error) {
      if (error.message === 'LIBRA_GRAPH_NODE_BUDGET') note(family, 'node_work_budget'); else throw error;
    } };
    const registry = object(snapshot.registry?.record), entityById = new Map(), names = new Map();
    if (registry.scopeKey && registry.scopeKey !== frame.scopeKey) throw new Error('LIBRA_GRAPH_REGISTRY_SCOPE_INVALID');
    const counts = new Map();
    for (const row of array(registry.entities)) counts.set(row.id, (counts.get(row.id) || 0) + 1);
    let entityBudgetReached = false;
    for (const row of array(registry.entities)) {
      if (row.validated !== true || !string(row.id) || counts.get(row.id) !== 1) continue;
      if (['inactive', 'superseded', 'deleted'].includes(row.status)) continue;
      if (nodes.size >= nodeLimit) { entityBudgetReached = true; break; }
      const key = string(snapshot.registry.key) + '#' + row.id, revision = registry.fingerprint || 'registry_without_revision';
      const node = keep(identity.entity({ identity: legacy(key, revision, row), binding: bound(key, revision, row) }));
      entityById.set(row.id, node);
      for (const name of [row.name, ...array(row.aliases)]) {
        const token = normalized(name); if (!token) continue;
        if (!names.has(token)) names.set(token, new Set()); names.get(token).add(row.id);
      }
    }
    if (entityBudgetReached) {
      for (const family of ['canonical', 'micro', 'state', 'lore']) note(family, 'node_work_budget');
    }
    const entity = value => entityById.get(string(value)) || null;
    const byName = value => { const found = names.get(normalized(value)); return found?.size === 1 ? entity([...found][0]) : null; };
    const canonicalFacts = new Map(), microSpans = new Map();
    const evidenceTurn = span => {
      const match = /^t([1-9]\d*)-[ua]$/.exec(string(span?.ref));
      const value = match ? Number(match[1]) : span?.turn;
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const occurrence = (sourceRow, role, quote, scopeKey, worldlineId, sessionEpoch) => {
      const sourceText = string(sourceRow?.[role]?.text), start = sourceText.indexOf(quote);
      if (!quote || start < 0 || sourceText.indexOf(quote, start + 1) !== -1 || typeof digestClaim !== 'function') return null;
      return { scopeKey, worldlineId, sessionEpoch, turn: sourceRow.turn, role,
        messageId: string(sourceRow[role]?.chatId), startOffset: start, endOffset: start + quote.length,
        exactQuote: quote, sourceTextDigest: digestClaim({ text: sourceText }) };
    };
    const scalar = value => value === null || ['string','boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);
    const claimProof = (domain, subjectId, field, operation, value, anchor) => anchor && anchor.messageId && subjectId && field
      && ['character','world'].includes(domain) && !/Ref$/.test(field) && ['set','clear'].includes(operation) && (operation === 'clear' || scalar(value))
      ? { domain, subjectId, field, operation, value: operation === 'clear' ? null : value,
          temporalRole: 'current_sequence', certainty: 'confirmed', epistemicStatus: 'observed', sourceOccurrence: anchor } : null;

    for (const row of array(snapshot.canonical)) attempt('canonical', () => {
      const record = row.record;
      if (!record || !row.key || record.memoryId !== row.ref?.memoryId || record.revision !== row.ref?.revision
        || record.sourceDigest !== row.ref?.sourceDigest) { note('canonical', 'record_ref_mismatch'); return; }
      const artifact = object(record.canonicalArtifact);
      if (!['libra.canonical_artifact.v4', 'libra.canonical_artifact.v5'].includes(artifact.schema)) {
        const text = string(record.text);
        const src = source('canonical', row.key, record.revision, { record, ref: row.ref }, row.originScope || frame.scopeKey, text ? 1 : 0);
        if (text) {
          const anchor = { coordinateSpace: 'record_text', start: 0, end: text.length };
          const node = meaning(src, 'source_excerpt', row.key + '#text', { text }, anchor,
            { text, semanticRole: 'canonical_legacy_excerpt', authority: 'source_only', recordKey: row.key });
          link(node, src.node, 'evidenced_by', basis(src, 'source_excerpt', row.key + '#text-basis', { text }, anchor));
        }
        note('canonical', 'typed_schema_unavailable'); return;
      }
      const duplicate = new Map();
      for (const fact of array(artifact.facts)) duplicate.set(fact.tempFactId, (duplicate.get(fact.tempFactId) || 0) + 1);
      const validFacts = array(artifact.facts).filter(fact => {
        const contract = object(snapshot.claimContracts?.[fact.claimKind]);
        return fact.tempFactId && duplicate.get(fact.tempFactId) === 1 && contract.field && contract.domain === fact.domain;
      });
      const src = source('canonical', row.key, record.revision, { record, ref: row.ref }, row.originScope || frame.scopeKey, validFacts.length ? 1 : 0);
      array(artifact.facts).forEach((fact, index) => {
        const contract = object(snapshot.claimContracts?.[fact.claimKind]);
        if (!fact.tempFactId || duplicate.get(fact.tempFactId) !== 1 || !contract.field || contract.domain !== fact.domain) {
          note('canonical', 'claim_schema_or_identity_ambiguous'); return;
        }
        const subjectId = row.entityRefs?.[fact.subjectTempRef] || '', targetIds = new Set();
        for (const ref of [fact.targetTempRef, typeof fact.values?.[contract.value] === 'string' && /Ref$/.test(contract.value) ? fact.values[contract.value] : '']) {
          if (ref && row.entityRefs?.[ref]) targetIds.add(row.entityRefs[ref]);
          else if (ref) note('canonical', 'target_mapping_unavailable');
        }
        const spans = array(fact.evidenceSpans), turns = spans.map(evidenceTurn);
        const temporalKnown = turns.length > 0 && turns.every(Number.isSafeInteger);
        const turn = temporalKnown ? Math.max(...turns) : null;
        // Each claim uses its own evidence time, never the batch's ending turn.
        const span = spans.length === 1 ? spans[0] : null;
        const role = span?.ref?.endsWith('-u') ? 'user' : 'assistant';
        const sourceRows = array(row.evidenceBatch).filter(value => value.turn === turn);
        const anchor = span && sourceRows.length === 1 ? occurrence(sourceRows[0], role, string(span.quote),
          record.scopeKey || frame.scopeKey, record.worldlineId || frame.worldlineId, Number(record.sessionEpoch || 0)) : null;
        const correspondenceProof = fact.temporalRole === 'current_sequence' && fact.certainty === 'confirmed'
          && !contract.refType && !contract.collection && !contract.profile && !/Ref$/.test(contract.value || '') && !targetIds.size
          ? claimProof(fact.domain, subjectId, contract.field, fact.effect || 'set', fact.values?.[contract.value], anchor) : null;
        const body = { fact, subjectId, targetIds: [...targetIds], field: contract.field, turn, correspondenceProof };
        const node = meaning(src, 'canonical_fact', row.key + '#facts/' + index, body, { index, typedMeaning: body },
          { text: string(fact.text), semanticRole: 'canonical_assertion', fact: clone(fact), subjectId, targetIds: [...targetIds], field: contract.field, turn, temporalKnown, correspondenceProof, recordKey: row.key });
        if (!array(fact.evidenceSpans).length) { note('canonical', 'claim_evidence_unavailable'); return; }
        const why = basis(src, 'canonical_claim', row.key + '#basis/' + index, body, { factIndex: index, evidenceSpans: fact.evidenceSpans });
        bases.set(why.id, { ...why, turn, temporalKnown });
        link(node, src.node, 'evidenced_by', why, {}, { turn });
        link(node, entity(subjectId), 'subject_of', why, {}, { turn });
        for (const targetId of targetIds) {
          link(node, entity(targetId), 'target_of', why, {}, { turn });
          if (!entity(targetId)) note('canonical', 'target_mapping_unavailable');
        }
        if (!entity(subjectId) && fact.domain !== 'narrative') note('canonical', 'subject_mapping_unavailable');
        canonicalFacts.set(JSON.stringify([record.memoryId, record.revision, fact.tempFactId]), { node, why, fact,
          subjectId, targetIds: [...targetIds], field: contract.field, sourceDigest: record.sourceDigest });
      });
    });

    const validSpan = (span, receipt) => span && ['user', 'assistant'].includes(span.role)
      && string(receipt?.[span.role]?.chatId) === string(span.messageId) && span.messageId
      && Number.isSafeInteger(span.startOffset) && Number.isSafeInteger(span.endOffset)
      && span.startOffset >= 0 && span.endOffset > span.startOffset
      && typeof span.exactQuote === 'string' && span.exactQuote.length === span.endOffset - span.startOffset
      && string(receipt?.[span.role]?.text).slice(span.startOffset, span.endOffset) === span.exactQuote;
    for (const row of array(snapshot.micro)) attempt('micro', () => {
      const record = row.record, receipt = row.receipt, head = row.head;
      if (row.status !== 'verified' || !record || !receipt || !head || record.schema !== 'libra.micro_memory.v1'
        || head.schema !== 'libra.micro_memory_head.v1' || head.scopeKey !== record.scopeKey || head.worldlineId !== record.worldlineId
        || Number(head.sessionEpoch) !== Number(record.sessionEpoch) || Number(head.turn) !== Number(record.turn)
        || !['verified', 'minimum_source_bound'].includes(record.analysisStatus)
        || record.sourceRevisionId !== receipt.revisionId || record.sourceDigest !== receipt.sourceDigest
        || record.scopeKey !== receipt.scopeKey || record.worldlineId !== receipt.worldlineId
        || Number(record.turn) !== Number(receipt.turn) || Number(record.sessionEpoch) !== Number(receipt.sessionEpoch)
        || record.receiptKey !== row.receiptKey || head.recordKey !== row.recordKey
        || head.sourceRevisionId !== record.sourceRevisionId || head.sourceDigest !== record.sourceDigest
        || head.analysisRevisionId !== record.analysisRevisionId || head.analysisStatus !== record.analysisStatus) {
        note('micro', row.reason || 'source_head_record_binding_unavailable'); return;
      }
      const claims = record.analysisStatus === 'verified' ? array(record.claims) : [];
      const spans = claims.length ? claims.map(claim => claim.evidence) : [record.excerpt];
      if (claims.length > 16 || !spans.length || spans.some(span => !validSpan(span, receipt))) { note('micro', 'exact_source_span_invalid'); return; }
      if (record.analysisStatus === 'minimum_source_bound' && (array(record.claims).length || spans[0].exactQuote.length > 500)) {
        note('micro', 'source_only_representation_invalid'); return;
      }
      if (record.analysisStatus === 'verified' && !claims.length) { note('micro', 'verified_claims_unavailable'); return; }
      const src = source('micro', row.recordKey, record.analysisRevisionId,
        { record, head, receipt, receiptKey: row.receiptKey, headKey: row.headKey }, record.scopeKey, 1);
      const recordTurn = Number.isSafeInteger(Number(record.turn)) ? Number(record.turn) : null;
      const recordSessionEpoch = Number.isSafeInteger(Number(record.sessionEpoch)) ? Number(record.sessionEpoch) : null;
      spans.forEach((span, index) => {
        const claim = claims[index] || null, intent = claim?.stateIntent;
        const actor = intent ? byName(intent.target?.entityName) : null;
        const logicalActor = actor && [...entityById].find(([, node]) => node.id === actor.id)?.[0];
        const anchor = occurrence({ turn: recordTurn, [span.role]: receipt[span.role] }, span.role, span.exactQuote,
          record.scopeKey, record.worldlineId, recordSessionEpoch);
        const correspondenceProof = claim?.temporalRole === 'current' && claim.certainty === 'confirmed' && claim.epistemicStatus === 'observed'
          && anchor?.startOffset === span.startOffset && anchor?.endOffset === span.endOffset
          ? claimProof(intent?.domain, logicalActor, intent?.field, intent?.operation, intent?.value, anchor) : null;
        const body = { claim, span, sourceRevisionId: record.sourceRevisionId, analysisRevisionId: record.analysisRevisionId, correspondenceProof };
        const node = meaning(src, claim ? 'micro_claim' : 'source_excerpt', row.recordKey + '#units/' + index, body,
          { index, role: span.role, messageId: span.messageId, startOffset: span.startOffset, endOffset: span.endOffset },
          { text: claim ? string(claim.text) : span.exactQuote, semanticRole: claim ? 'micro_candidate' : 'source_only',
            authority: claim ? 'source_verified_candidate' : 'source_only', sourceSpan: clone(span),
            turn: recordTurn, sessionEpoch: recordSessionEpoch, correspondenceProof,
            representationCoverage: claim ? 'producer_bounded_claim' : 'producer_bounded_excerpt' });
        const why = basis(src, 'micro_span', row.recordKey + '#span/' + index, body, { span, receiptKey: record.receiptKey });
        link(node, src.node, 'evidenced_by', why);
        for (const [role, name] of [['subject_of', claim?.actor], ['target_of', claim?.target], ['subject_of', claim?.stateIntent?.target?.entityName]]) {
          if (!name) continue; const target = byName(name);
          if (target) link(node, target, role, why); else note('micro', 'entity_name_ambiguous_or_unavailable');
        }
        // A quote can support several different claims. State evidence names the
        // owner's claim digest; a span alone cannot choose one claim occurrence.
        const claimDigest = claim && typeof digestClaim === 'function' ? string(digestClaim(claim)) : '';
        if (claimDigest) {
          const key = JSON.stringify([record.receiptKey, record.sourceRevisionId, record.sourceDigest,
            record.analysisRevisionId, claimDigest, span.role, span.messageId, span.startOffset, span.endOffset, span.exactQuote]);
          microSpans.set(key, microSpans.has(key) ? null : { node, why });
        }
      });
    });

    const state = snapshot.state;
    if (state?.view?.head?.scopeKey && state.view.head.scopeKey !== frame.scopeKey) throw new Error('LIBRA_GRAPH_STATE_SCOPE_INVALID');
    if (state?.view?.head?.schema === 'libra.continuity_state.v2') attempt('state', () => {
      const head = state.view.head, authority = object(state.view.authority);
      const src = source('state', state.key, state.revision, { head, authority });
      const corrections = new Map();
      for (const row of array(state.corrections?.records)) {
        if (row.status !== 'active' || row.scopeKey !== frame.scopeKey || row.worldlineId !== frame.worldlineId) continue;
        if (corrections.has(row.correctionId)) corrections.set(row.correctionId, null); else corrections.set(row.correctionId, row);
      }
      const correctionSources = new Map();
      const projectFields = (domain, row, values, evidence, clears = {}, correctionFields = {}, clearCorrections = {}) => {
        const fields = [...new Set([...Object.keys(object(values)), ...Object.keys(object(clears)), ...Object.keys(object(clearCorrections))])];
        for (const field of fields) {
          const isClear = !own(values, field) && (own(clears, field) || own(clearCorrections, field));
          if (own(values, field) && (own(clears, field) || own(clearCorrections, field))) { note('state', 'field_value_clear_conflict'); continue; }
          const proof = object(isClear ? clears[field] : evidence[field]), correction = object(isClear ? clearCorrections[field] : correctionFields[field]);
          const fieldValue = isClear ? null : values[field];
          const isCollection = Array.isArray(fieldValue) && fieldValue.length > 0;
          const items = isCollection ? fieldValue : [fieldValue];
          for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            const hasProvenance = Object.keys(proof).length > 0 || !!correction.correctionId;
            const body = { domain, entityId: string(row.id), field, value: items[itemIndex], availability: isClear ? 'clear' : 'value',
              fieldEvidence: proof, correction, authority, certainty: row.certainty || 'unknown',
              provenanceStatus: hasProvenance ? 'recorded' : 'unknown', domainStatus: head.domainStatus || {},
              headBasis: head.basis || null, headThroughTurn: head.throughTurn ?? null };
            const selector = { domain, entityId: string(row.id), field, itemIndex: isCollection ? itemIndex : null };
            const key = state.key + '#fields/' + JSON.stringify(selector);
            const role = correction.correctionId ? 'user_corrected' : !hasProvenance ? 'state_unprovenanced'
              : authority.current === true && authority.pending !== true ? 'state_current' : 'state_last_known';
            if (hasProvenance && correction.correctionId && !correctionSources.has(correction.correctionId)) check(2);
            const node = meaning(src, isCollection ? 'state_item' : 'state_field', key, body, selector,
              { semanticRole: role, ...body, text: JSON.stringify(items[itemIndex]) });
            if (!hasProvenance) { note('state', 'field_provenance_unknown'); continue; }
            if (correction.correctionId) {
              const record = corrections.get(correction.correctionId), nativeDomain = { character: 'characters', relationship: 'relationships' }[domain] || domain;
              const matching = record && array(record.compiledAfter?.patches).filter(patch => patch.domain === nativeDomain
                && (patch.entityId === row.id || domain === 'narrative')
                && (isClear ? array(patch.clear).includes(field) : own(patch.set, field) && JSON.stringify(patch.set[field]) === JSON.stringify(fieldValue)));
              if (!matching?.length) { note('state', 'correction_field_basis_unresolved'); continue; }
              let correctionSource = correctionSources.get(record.correctionId);
              if (!correctionSource) { correctionSource = source('state', state.correctionKey + '#' + record.correctionId,
                state.revision, record); correctionSources.set(record.correctionId, correctionSource); }
              const why = basis(correctionSource, 'state_correction', key + '#correction', { record, matching, selector }, selector);
              link(node, correctionSource.node, 'evidenced_by', why, { field, availability: body.availability });
              link(node, entity(row.id), 'subject_of', why, { field });
              if (/Ref$/.test(field)) link(node, entity(fieldValue), 'target_of', why, { field });
              continue; // The overridden canonical field evidence is not the current value's derivation.
            }
            const why = basis(src, 'state_field_evidence', key + '#evidence', { proof, selector }, selector);
            link(node, src.node, 'evidenced_by', why, { field, availability: body.availability });
            link(node, entity(domain === 'relationship' ? row.subjectId : row.id), 'subject_of', why, { field });
            if (domain === 'relationship') link(node, entity(row.targetId), 'target_of', why, { field, dimension: row.dimension });
            if (/Ref$/.test(field)) link(node, entity(fieldValue), 'target_of', why, { field });
            let linked = false;
            for (const assertionId of array(proof.assertionIds)) {
              const fact = canonicalFacts.get(JSON.stringify([proof.memoryId, proof.revision, assertionId]));
              const sameTarget = domain === 'relationship' ? fact?.subjectId === row.subjectId
                && fact.targetIds.includes(row.targetId) && fact.fact.dimension === row.dimension : fact?.subjectId === row.id;
              if (!fact || fact.sourceDigest !== proof.sourceDigest || !sameTarget || fact.field !== field) continue;
              link(node, fact.node, 'derived_from', why, { field }); linked = true;
            }
            if (proof.schema === 'libra.micro_state_field_evidence.v1' && proof.status === 'state_admitted') {
              const micro = microSpans.get(JSON.stringify([proof.receiptKey, proof.sourceRevisionId, proof.sourceDigest,
                proof.analysisRevisionId, proof.claimDigest, proof.role, proof.messageId, proof.startOffset, proof.endOffset, proof.exactQuote]));
              if (micro) { link(node, micro.node, 'derived_from', why, { field }); linked = true; }
            }
            if (!linked) note('state', 'field_basis_outside_page_or_unresolved');
          }
        }
      };
      for (const [domain, collection] of [['character', 'characters'], ['relationship', 'relationships'], ['world', 'world']]) {
        for (const row of array(head[collection])) projectFields(domain, row, row.state, object(row.fieldEvidence),
          object(row.clearedFieldEvidence), object(row.fieldCorrectionProvenance), object(row.clearedFieldCorrectionProvenance));
      }
      const narrative = object(head.narrative), fields = Object.fromEntries(Object.entries(narrative)
        .filter(([name]) => !['fieldEvidence', 'fieldCorrectionProvenance', 'clearedFieldCorrectionProvenance', 'clearedFieldEvidence'].includes(name)));
      projectFields('narrative', { id: 'narrative_current', certainty: 'unknown' }, fields, object(narrative.fieldEvidence),
        object(narrative.clearedFieldEvidence), object(narrative.fieldCorrectionProvenance), object(narrative.clearedFieldCorrectionProvenance));
    }); else note('state', 'state_view_unavailable');

    const lore = object(snapshot.lore), index = object(lore.index);
    for (const row of array(lore.entries)) attempt('lore', () => {
      if (!row.identity || typeof row.rendered !== 'string') { note('lore', 'entry_rendering_unavailable'); return; }
      const validPassages = array(row.passages).filter(passage => passage.coordinateSpace === 'rendered'
        && Number.isSafeInteger(passage.start) && Number.isSafeInteger(passage.end)
        && passage.start >= 0 && passage.end > passage.start && passage.end <= row.rendered.length);
      const activation = object(row.activation);
      const body = { entry: row.entry, rendered: row.rendered, activation, selectionBinding: lore.selectionBinding || {} };
      const src = source('lore', 'lore:' + row.identity, lore.revision, body, frame.scopeKey, validPassages.length ? 1 : 0);
      for (const [position, passage] of array(row.passages).entries()) {
        if (passage.coordinateSpace !== 'rendered' || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end)
          || passage.start < 0 || passage.end <= passage.start || passage.end > row.rendered.length) { note('lore', 'rendered_passage_locator_invalid'); continue; }
        const text = row.rendered.slice(passage.start, passage.end), selector = { coordinateSpace: 'rendered', start: passage.start, end: passage.end, position };
        const unitBody = { passage, text, activation };
        const node = meaning(src, 'lore_passage', 'lore:' + row.identity + '#passages/' + position, unitBody, selector,
          { text, semanticRole: 'background_setting', locator: clone(passage), activation: clone(activation),
            representationCoverage: { coordinateSpace: 'rendered', rawOffsetAvailable: false } });
        const why = basis(src, 'lore_passage', 'lore:' + row.identity + '#basis/' + position, unitBody, selector);
        link(node, src.node, 'evidenced_by', why);
        const native = array(index.entries).find(entry => entry.identity === row.identity);
        const nativePassage = array(native?.passages).find(p => p.start === passage.start && p.end === passage.end);
        for (const mention of array(nativePassage?.mentions)) {
          const approved = array(index.links).some(link => link.identity === row.identity && link.entityId === mention.entityId
            && link.via === 'name_reference' && ['reference', 'confirmed'].includes(link.resolution));
          if (approved) link(node, entity(mention.entityId), 'mentions', why);
          else if (mention.ambiguous) note('lore', 'ambiguous_or_removed_reference');
        }
      }
    });
    for (const [family, reasons] of Object.entries(object(snapshot.pending))) for (const reason of array(reasons)) note(family, string(reason) || 'reader_unavailable');
    for (const reason of array(index.status?.reasons)) if (index.status?.partial) note('lore', reason);
    return { schema: 'libra.memory_graph_projection.v1', nodes: [...nodes.values()], edges: [...edges.values()], bases: [...bases.values()], units,
      coverage: { scope: 'owner_reader_page', inventory: clone(snapshot.inventory || {}), identity: 'revision_bound', families,
        projectionComplete: Object.values(families).every(family => !family.reasons.length) },
      authority: 'descriptive_only', modelDispatchEligible: false, byteBounded: false, providerCalls: 0, documentEmbeddingCalls: 0,
      runtimeIntegrated: 'owner_reader_projection_only' };
  };
  return Object.freeze({ project });
};
