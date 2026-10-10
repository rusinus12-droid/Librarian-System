'use strict';

// One-shot, fail-closed Phase06 Input Writer adoption transform.
//
// Safety properties:
// - verifies the immutable external 2.3.0 checkpoint before doing any work;
// - accepts only that checkpoint or the explicitly audited P1-only target as input;
// - every textual anchor must occur exactly once;
// - writes a same-directory temporary file and runs `node --check` on it;
// - rechecks the target hash immediately before a same-volume atomic rename;
// - deliberately does not contain Gate W changes.
//
// Usage (from the repository root):
//   node MemorySuite/PROGRAM/tests/apply_libra_phase06_from_baseline.cjs --apply

// Do not add another accepted hash casually. Audit its complete diff against BASELINE_PATH first.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASELINE_PATH = String.raw`C:\Users\rusin\Downloads\LIBRA-2.3.0-Refactor-Complete-Workspace-20260902\LIBRA-2.3.0-Refactor-Workspace-20260902\WORKTREE\PROGRAM\plugins\LIBRA.js`;
const TARGET_PATH = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const BASELINE_SHA256 = '0400fa315280d9b144c345b294ef4d4d5657c085a9f11faf5ccb09d370ff2bbf';
const P1_ONLY_SHA256 = '59dfd63a9c0a411cfe8ea3ca43f8d7d35911437698e7b8cf3001400c717353b5';
const P1_GATE_W_SHA256 = '52479cca6e83ecca8475cabc3701bf61c48fff0749f6a2f596518ee1468d1f22';
const ACCEPTED_INPUT_HASHES = new Set([BASELINE_SHA256, P1_ONLY_SHA256, P1_GATE_W_SHA256]);

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const count = (source, needle) => {
  if (!needle) throw new Error('empty anchor');
  let total = 0;
  let cursor = 0;
  while ((cursor = source.indexOf(needle, cursor)) >= 0) {
    total += 1;
    cursor += needle.length;
  }
  return total;
};

const patchBlock = fn => {
  const raw = Function.prototype.toString.call(fn);
  const startMarker = '/*__PATCH__\n';
  const endMarker = '\n__PATCH__*/';
  const start = raw.indexOf(startMarker);
  const end = raw.lastIndexOf(endMarker);
  assert.ok(start >= 0 && end > start, 'malformed embedded patch block');
  return raw.slice(start + startMarker.length, end);
};

const applyTransform = input => {
  const eol = input.includes('\r\n') ? '\r\n' : '\n';
  const adapt = value => value.replace(/\r?\n/g, eol);
  let source = input;
  const edits = [];

  const requireOnce = (needle, label) => {
    const hits = count(source, needle);
    assert.equal(hits, 1, `${label}: expected exactly one anchor, found ${hits}`);
  };
  const replaceOnce = (needle, replacement, label) => {
    requireOnce(needle, label);
    source = source.replace(needle, replacement);
    edits.push(label);
  };
  const insertAfter = (anchor, addition, label) => replaceOnce(anchor, `${anchor}${adapt(addition)}`, label);
  const replaceRange = (startMarker, endMarker, replacement, label) => {
    requireOnce(startMarker, `${label}: start`);
    requireOnce(endMarker, `${label}: end`);
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `${label}: end marker precedes start marker`);
    source = source.slice(0, start) + adapt(replacement) + source.slice(end);
    edits.push(label);
  };

  insertAfter(
    "  const INPUT_WRITER_RUN_SCHEMA = 'libra.input_writer_run.v1';",
    "\n  const INPUT_WRITER_DELIVERY_SNAPSHOT_SCHEMA = 'libra.input_writer_delivery_snapshot.v1';",
    'Phase06 delivery snapshot schema'
  );
  insertAfter(
    '    lastInputWriter: null,',
    '\n    inputWriterDeliveryCycles: new Map(),\n    lastInputWriterDelivery: null,',
    'Phase06 delivery runtime state'
  );

  const coreHelpers = patchBlock(function () {/*__PATCH__
    const buildReadOnlyInputWriterManifest = (contextValue, pairsValue, manifestValue) => {
      const context = asObject(contextValue);
      const pairs = asArray(pairsValue);
      const authorityManifest = clone(manifestValue || defaultManifest(context.scope, pairs.length));
      const manifest = clone(authorityManifest);
      manifest.memories = asObject(manifest.memories);
      const verifiedStarts = [];
      const rejected = [];
      for (const [slot, refValue] of Object.entries(manifest.memories)) {
        const ref = asObject(refValue);
        if (ref.status !== 'committed' || ref.inheritedSessionHistory === true || Number(ref.sessionEpoch || 0) < 0) continue;
        const startTurn = Math.max(0, Number(ref?.turnRange?.start || slot || 0));
        const batch = startTurn > 0 ? batchForStart(pairs, startTurn) : [];
        const actualDigest = batch.length === BATCH_SIZE ? sourceDigest(batch) : '';
        if (startTurn > 0 && actualDigest && actualDigest === string(ref.sourceDigest || '')) {
          verifiedStarts.push(startTurn);
          continue;
        }
        manifest.memories[slot] = {
          ...clone(ref),
          status: 'inactive',
          requestLocalInactive: true,
          requestLocalInactiveReason: actualDigest ? 'source_digest_mismatch' : 'source_batch_unavailable'
        };
        rejected.push({
          startTurn,
          key: string(ref.key || ''),
          memoryId: string(ref.memoryId || ''),
          revision: Number(ref.revision || 0),
          expectedSourceDigest: string(ref.sourceDigest || ''),
          actualSourceDigest: actualDigest
        });
      }
      manifest.branchGuard = normalizeBranchGuard({
        ...asObject(manifest.branchGuard),
        schema: BRANCH_GUARD_SCHEMA,
        status: BRANCH_GUARD_READY,
        batchSignatures: branchBatchSignaturesForPairs(pairs),
        verifiedStarts: [],
        observedTurns: pairs.length,
        completeBatches: completeBatchStarts(pairs).length
      });
      refreshCanonicalFrontiers(manifest, pairs.length);
      return {
        manifest,
        authorityManifest,
        verifiedStarts: verifiedStarts.sort((a, b) => a - b),
        rejected,
        requestLocalOnly: true,
        durableMutation: false
      };
    };

    const inputWriterManifestAuthorityProjection = manifestValue => {
      const manifest = asObject(manifestValue);
      const refs = listMemoryRefs(manifest).map(ref => ({
        key: string(ref?.key || ''),
        memoryId: string(ref?.memoryId || ''),
        revision: Number(ref?.revision || 0),
        status: string(ref?.status || ''),
        sessionEpoch: Number(ref?.sessionEpoch || 0),
        inheritedSessionHistory: ref?.inheritedSessionHistory === true,
        logicalWorldlineId: string(ref?.logicalWorldlineId || ''),
        worldlineId: string(ref?.worldlineId || ''),
        turnRange: clone(asObject(ref?.turnRange)),
        sourceDigest: string(ref?.sourceDigest || '')
      }));
      const guard = normalizeBranchGuard(manifest.branchGuard);
      return {
        schema: string(manifest.schema || ''),
        scopeKey: string(manifest.scopeKey || ''),
        characterId: string(manifest.characterId || ''),
        chatId: string(manifest.chatId || ''),
        frontiers: clone(asObject(manifest.frontiers)),
        branchGuard: {
          schema: string(guard.schema || ''),
          status: string(guard.status || ''),
          batchSignatures: asArray(guard.batchSignatures).map(string),
          verifiedStarts: asArray(guard.verifiedStarts).map(Number),
          observedTurns: Number(guard.observedTurns || 0),
          completeBatches: Number(guard.completeBatches || 0)
        },
        refs
      };
    };

    const inputWriterWorldlineProjection = metaValue => {
      const meta = asObject(metaValue);
      const activeWorldlineId = string(meta.activeWorldlineId || 'main');
      const row = asObject(asObject(meta.worldlines)[activeWorldlineId]);
      return {
        schema: string(meta.schema || ''),
        activeWorldlineId,
        revision: Number(meta.revision || 0),
        active: {
          id: string(row.id || activeWorldlineId),
          parentId: row.parentId == null ? null : string(row.parentId),
          forkTurn: Number(row.forkTurn || 0),
          cutoffTurn: row.cutoffTurn == null ? null : Number(row.cutoffTurn),
          active: row.active !== false
        }
      };
    };

    const inputWriterStateAuthorityProjection = responseStateValue => {
      const responseState = asObject(responseStateValue);
      const head = responseState.head ? clone(responseState.head) : null;
      const authority = clone(responseState.authority || head?.responseAuthority || null);
      const narrative = __libraCompletionUnwrapNarrative(head);
      return {
        authority,
        head,
        headDigest: digest(stableReferenceJson(head)),
        narrativeDigest: digest(stableReferenceJson(narrative))
      };
    };

    const inputWriterTranscriptProjection = pairsValue => {
      const pairs = asArray(pairsValue);
      return {
        pairCount: pairs.length,
        pairs: pairs.map(pair => ({
          turn: Number(pair?.turn || 0),
          userChatId: string(pair?.user?.chatId || ''),
          assistantChatId: string(pair?.assistant?.chatId || ''),
          digest: digest({ user: string(pair?.user?.text || ''), assistant: string(pair?.assistant?.text || '') })
        }))
      };
    };

    const inputWriterDeliverySnapshotBody = snapshotValue => {
      const body = clone(asObject(snapshotValue));
      delete body.sealDigest;
      return body;
    };

    const buildInputWriterDeliverySnapshot = async ({ context, pairs, manifest, stateManifest, responseState } = {}) => {
      const currentContext = context || await resolveContext();
      const completedPairs = pairs || buildPairs(currentContext.chat, currentContext?.scope?.scopeKey || '');
      const authorityManifest = manifest || await loadManifest(currentContext.scope, completedPairs.length);
      const requestManifest = stateManifest || buildReadOnlyInputWriterManifest(currentContext, completedPairs, authorityManifest).manifest;
      const currentResponseState = responseState || await loadContinuityStateForResponse(currentContext.scope, requestManifest).catch(() => null);
      const worldlineMeta = await loadStateWorldlineMeta(currentContext.scope).catch(() => stateWorldlineDefaultMeta(currentContext.scope));
      const worldline = inputWriterWorldlineProjection(worldlineMeta);
      const authorityProjection = inputWriterManifestAuthorityProjection(authorityManifest);
      const requestProjection = inputWriterManifestAuthorityProjection(requestManifest);
      const transcriptProjection = inputWriterTranscriptProjection(completedPairs);
      const stateAuthority = inputWriterStateAuthorityProjection(currentResponseState);
      const direction = await getPlannerNarrativeDirection({ scopeKey: string(currentContext?.scope?.scopeKey || '') }).catch(() => null);
      const directionProjection = direction ? {
        schema: string(direction.schema || ''), revision: Number(direction.revision || 0),
        goal: string(direction.goal || ''), completionConditions: asArray(direction.completionConditions).map(string),
        doNotForce: asArray(direction.doNotForce).map(string), softPreferences: asArray(direction.softPreferences).map(string),
        locked: direction.locked === true, source: string(direction.source || '')
      } : null;
      const currentRefs = listRecallMemoryRefs(requestManifest);
      const latestRef = currentRefs.slice().sort((left, right) => Number(right?.revision || 0) - Number(left?.revision || 0)
        || Number(right?.turnRange?.end || 0) - Number(left?.turnRange?.end || 0))[0] || null;
      const identity = {
        schema: 'libra.input_writer_authority_identity.v1',
        scopeKey: string(currentContext?.scope?.scopeKey || ''),
        characterId: string(currentContext?.scope?.characterId || ''),
        chatId: string(currentContext?.scope?.chatId || ''),
        worldlineId: string(worldline.activeWorldlineId || 'main'),
        logicalWorldlineId: string(latestRef?.logicalWorldlineId || latestRef?.worldlineId || worldline.activeWorldlineId || 'main'),
        worldlineMetaRevision: Number(worldline.revision || 0),
        memoryId: string(latestRef?.memoryId || ''),
        revision: Math.max(0, ...currentRefs.map(ref => Number(ref?.revision || 0))),
        canonicalRefsDigest: digest(stableReferenceJson(requestProjection.refs)),
        canonicalFrontierDigest: digest(stableReferenceJson(requestProjection.frontiers)),
        branchGuardDigest: digest(stableReferenceJson(requestProjection.branchGuard)),
        manifestDigest: digest(stableReferenceJson(authorityProjection)),
        chatHistoryDigest: digest(stableReferenceJson(transcriptProjection)),
        liveTailHash: digest(stableReferenceJson(transcriptProjection.pairs.slice(-5))),
        stateAuthorityDigest: digest(stableReferenceJson(stateAuthority.authority)),
        stateHeadDigest: string(stateAuthority.headDigest || ''),
        narrativeStateDigest: string(stateAuthority.narrativeDigest || ''),
        narrativeDirectionDigest: digest(stableReferenceJson(directionProjection))
      };
      const authorityDigest = digest(stableReferenceJson({ identity, authorityProjection, requestProjection, worldline, transcriptProjection, stateAuthority, directionProjection }));
      const snapshot = {
        schema: INPUT_WRITER_DELIVERY_SNAPSHOT_SCHEMA,
        at: Date.now(),
        scopeKey: identity.scopeKey,
        worldlineId: identity.worldlineId,
        logicalWorldlineId: identity.logicalWorldlineId,
        memoryId: identity.memoryId,
        revision: identity.revision,
        manifestDigest: identity.manifestDigest,
        authorityDigest,
        identity: { ...identity, authorityDigest },
        manifest: authorityProjection,
        requestManifest: requestProjection,
        worldline,
        transcript: transcriptProjection,
        stateAuthority,
        narrativeDirection: directionProjection,
        identityDigest: '',
        sealDigest: ''
      };
      snapshot.identityDigest = digest(stableReferenceJson(snapshot.identity));
      snapshot.sealDigest = digest(stableReferenceJson(inputWriterDeliverySnapshotBody(snapshot)));
      return snapshot;
    };

    const validateInputWriterDeliverySnapshot = async snapshotValue => {
      const expected = clone(asObject(snapshotValue));
      if (expected.schema !== INPUT_WRITER_DELIVERY_SNAPSHOT_SCHEMA || !string(expected.identityDigest || '') || !string(expected.sealDigest || '')) {
        return { ok: false, current: false, stale: true, reason: 'snapshot_missing_or_invalid' };
      }
      if (string(expected.sealDigest) !== digest(stableReferenceJson(inputWriterDeliverySnapshotBody(expected)))) {
        return { ok: false, current: false, stale: true, reason: 'snapshot_seal_mismatch' };
      }
      try {
        const context = await resolveContext();
        const pairs = buildPairs(context.chat, context?.scope?.scopeKey || '');
        const authorityManifest = await loadManifest(context.scope, pairs.length);
        const branchView = buildReadOnlyInputWriterManifest(context, pairs, authorityManifest);
        const responseState = await loadContinuityStateForResponse(context.scope, branchView.manifest).catch(() => null);
        const current = await buildInputWriterDeliverySnapshot({
          context, pairs, manifest: authorityManifest, stateManifest: branchView.manifest, responseState
        });
        const matches = string(current.identityDigest || '') === string(expected.identityDigest || '')
          && string(current.authorityDigest || '') === string(expected.authorityDigest || '')
          && string(current?.identity?.scopeKey || '') === string(expected?.identity?.scopeKey || '')
          && string(current?.identity?.worldlineId || '') === string(expected?.identity?.worldlineId || '');
        return matches
          ? { ok: true, current: true, stale: false, reason: '', expected: clone(expected.identity), actual: clone(current.identity) }
          : { ok: false, current: false, stale: true, reason: 'input_writer_authority_changed', expected: clone(expected.identity), actual: clone(current.identity) };
      } catch (error) {
        return { ok: false, current: false, stale: true, reason: compact(error?.message || error || 'snapshot_validation_failed', 500) };
      }
    };

__PATCH__*/});
  insertAfter(
    "    const prepareInputWriterEvidence = async (composerInput = '', options = {}) => {",
    '',
    'Phase06 preflight anchor audit'
  );
  // Undo the no-op audit edit from the edit list; the range replacement below owns this anchor.
  edits.pop();
  replaceOnce(
    "    const prepareInputWriterEvidence = async (composerInput = '', options = {}) => {",
    `${adapt(coreHelpers)}${eol}    const prepareInputWriterEvidence = async (composerInput = '', options = {}) => {`,
    'Phase06 read-only manifest and delivery snapshot helpers'
  );

  const preflight = patchBlock(function () {/*__PATCH__
    const prepareInputWriterEvidence = async (composerInput = '', options = {}) => {
      if (state.disposed) throw new Error('LIBRA runtime is disposed.');
      const runtimeSettings = options.settings || await loadSettings().catch(() => Runtime.settings || {});
      if (runtimeSettings?.inputWriterEnabled === false) throw new Error('Ariadne 인풋 작성기가 비활성화되어 있습니다.');
      const memorySettings = await loadMemorySettings();
      const context = await resolveContext();
      const completedPairs = buildPairs(context.chat, context?.scope?.scopeKey || '');
      const authorityManifest = await loadManifest(context.scope, completedPairs.length);
      const branchView = buildReadOnlyInputWriterManifest(context, completedPairs, authorityManifest);
      const manifest = branchView.manifest;
      const originalInput = string(composerInput || '');
      const continuationMode = !originalInput;
      const latestPair = completedPairs.at(-1) || null;
      const terminalText = string(latestPair?.assistant?.text || '');
      const queryText = originalInput || [
        '직전 장면에서 사용자가 지금 선택할 수 있는 다음 행동·대사·질문·관찰 선택지',
        terminalText ? compact(terminalText, 1200) : ''
      ].filter(Boolean).join('\n');
      const syntheticMessages = [];
      if (terminalText) syntheticMessages.push({ role: 'assistant', content: terminalText, chatId: string(latestPair?.assistant?.chatId || 'libra-input-writer-terminal') });
      syntheticMessages.push({ role: 'user', content: queryText, chatId: `libra-input-writer-${Date.now()}` });
      const queryBundle = buildQueryBundle(syntheticMessages, context, memorySettings, completedPairs);
      queryBundle.currentText = queryText;
      queryBundle.sparseText = [queryText, queryBundle.sceneText].filter(Boolean).join('\n');
      queryBundle.currentAnchors = extractQueryAnchors(queryText);
      queryBundle.queryType = classifyQueryType(queryText);
      queryBundle.inputSource = 'libra_input_writer';
      queryBundle.inputConfidence = continuationMode ? 'derived_from_terminal_scene' : 'exact_composer_input';
      queryBundle.inputTag = continuationMode ? 'input_writer_continue' : 'input_writer_expand';
      queryBundle.manifest = manifest;

      const previousRecall = state.lastRecall;
      const previousRuntimeRecall = Runtime.lastMemoryRecall;
      const previousViewer = Runtime.lastMemoryRecallViewer;
      let recallResult = null;
      try {
        recallResult = await recall(context, queryBundle, null);
      } finally {
        state.lastRecall = previousRecall;
        Runtime.lastMemoryRecall = previousRuntimeRecall;
        Runtime.lastMemoryRecallViewer = previousViewer;
      }

      const liveTail = buildLiveTailContext(completedPairs, manifest, runtimeSettings, 'planner');
      const responseState = await loadContinuityStateForResponse(context.scope, manifest).catch(() => null);
      const continuityState = responseState?.head || null;
      const narrativeState = __libraCompletionUnwrapNarrative(continuityState);
      const narrativeDirection = await getPlannerNarrativeDirection({ scopeKey: string(context?.scope?.scopeKey || '') }).catch(() => null);

      let materialSource = null;
      try {
        materialSource = await loadResponseMaterialSource({ messages: syntheticMessages, queryBundle, settings: runtimeSettings, liveTail });
      } catch (error) {
        warn('LIBRA Input Writer material source failed open', error);
      }
      let loreMaterial = null;
      if (materialSource && runtimeSettings?.inputWriterLoreEnabled !== false && runtimeSettings?.responseLoreEnabled !== false) {
        try {
          loreMaterial = await buildUnifiedResponseLoreMaterial({
            snapshot: materialSource,
            messages: syntheticMessages,
            queryBundle,
            storyArc: null,
            liveTail,
            recallResult,
            settings: runtimeSettings,
            consumers: ['input_writer']
          });
        } catch (error) {
          warn('LIBRA Input Writer lore failed open', error);
        }
      }
      const authorNote = materialSource
        ? buildResponseAuthorNoteDirective(materialSource, runtimeSettings, 'input_writer')
        : null;
      const bootstrap = runtimeSettings?.bootstrapReferencesEnabled !== false
        ? await buildBootstrapReferencePack({
            messages: syntheticMessages,
            context,
            queryBundle,
            manifest,
            settings: runtimeSettings,
            routeValue: 'planner',
            liveTail,
            sourceSnapshot: materialSource,
            includeLore: !loreMaterial?.available
          })
        : null;
      const packet = buildRecallEvidencePacket(
        recallResult || emptyRecallResultForQuery(context, queryBundle, memorySettings, null),
        queryBundle,
        'planner',
        null,
        liveTail,
        bootstrap,
        loreMaterial,
        authorNote,
        continuityState
      );
      packet.current_input = originalInput;
      packet.input_writer_query = queryText;
      packet.input_writer_mode = normalizeChoice(runtimeSettings?.inputWriterMode || DEFAULT_INPUT_WRITER_MODE, INPUT_WRITER_MODES, DEFAULT_INPUT_WRITER_MODE);
      packet.continuation_mode = continuationMode;
      packet.lore_prompt = string(loreMaterial?.stages?.input_writer?.promptBlock || '');
      packet.author_note_prompt = string(authorNote?.promptBlock || '');
      packet.terminal_scene = compact(terminalText || queryBundle.sceneText || '', 3200);
      packet.continuity_state = continuityState ? clone(continuityState) : null;
      packet.continuity_state_authority = clone(responseState?.authority || continuityState?.responseAuthority || null);
      packet.narrative_state = narrativeState ? clone(narrativeState) : null;
      packet.narrative_prompt = narrativeState ? narrativeStatePromptBlock(narrativeState, 'planner') : '';
      packet.narrative_direction = narrativeDirection ? clone(narrativeDirection) : null;
      packet.narrative_direction_prompt = narrativeDirection ? plannerNarrativeDirectionPromptBlock(narrativeDirection) : '';
      packet.story_arc = null;
      packet.story_arc_prompt = '';

      const deliverySnapshot = await buildInputWriterDeliverySnapshot({
        context,
        pairs: completedPairs,
        manifest: authorityManifest,
        stateManifest: manifest,
        responseState
      });
      return {
        schema: 'libra.input_writer_preflight.v1',
        at: Date.now(),
        scope: clone(context.scope),
        continuationMode,
        originalInput,
        queryText,
        queryHash: digest(queryText),
        recallMemoryCount: Number(recallResult?.memories?.length || 0),
        branchView: {
          requestLocalOnly: true,
          durableMutation: false,
          verifiedStarts: branchView.verifiedStarts.slice(),
          rejected: clone(branchView.rejected)
        },
        liveTail: liveTail ? { hash: string(liveTail.hash || ''), pairCount: Number(liveTail.pairCount || 0), startTurn: Number(liveTail.startTurn || 0), endTurn: Number(liveTail.endTurn || 0) } : null,
        narrativeState: narrativeState ? { digest: digest(stableReferenceJson(narrativeState)), authority: clone(responseState?.authority || null) } : null,
        narrativeDirection: narrativeDirection ? { digest: digest(stableReferenceJson(narrativeDirection)), revision: Number(narrativeDirection.revision || 0) } : null,
        lore: loreMaterial ? { materialHash: string(loreMaterial.materialHash || ''), selectedCount: Number(loreMaterial?.stages?.input_writer?.selectedCount || 0), promptChars: Number(loreMaterial?.stages?.input_writer?.promptChars || 0) } : null,
        authorNote: authorNote ? { hash: string(authorNote.hash || ''), source: string(authorNote.source || ''), promptChars: Number(authorNote.promptChars || 0) } : null,
        bootstrap: bootstrap ? { selectionHash: string(bootstrap.selectionHash || ''), itemCount: Number(bootstrap.itemCount || 0), loreIncluded: bootstrap.loreIncluded !== false } : null,
        evidencePacket: packet,
        deliverySnapshot,
        settings: clone(runtimeSettings)
      };
    };

__PATCH__*/});
  replaceRange(
    "    const prepareInputWriterEvidence = async (composerInput = '', options = {}) => {",
    '    const buildPlannerEvidencePacket =',
    preflight,
    'Phase06 read-only Input Writer preflight'
  );

  replaceOnce(
    '      buildLiveTailContext, buildBootstrapReferencePack, buildRecallEvidencePacket, prepareInputWriterEvidence,',
    '      buildLiveTailContext, buildBootstrapReferencePack, buildRecallEvidencePacket, prepareInputWriterEvidence,\n      buildReadOnlyInputWriterManifest, buildInputWriterDeliverySnapshot, validateInputWriterDeliverySnapshot,',
    'Phase06 core public helpers'
  );

  const promptCompiler = patchBlock(function () {/*__PATCH__
  const inputWriterMemoryEvidenceView = packet => ({
    memory: Array.isArray(packet?.layers?.memory) ? packet.layers.memory : [],
    entity: Array.isArray(packet?.layers?.entity) ? packet.layers.entity : [],
    world: Array.isArray(packet?.layers?.world) ? packet.layers.world : [],
    narrative: Array.isArray(packet?.layers?.narrative) ? packet.layers.narrative : []
  });

  const inputWriterCanonicalPriorityView = packetValue => {
    const packet = guiAsObject(packetValue);
    const priority = guiAsObject(packet.canonical_priority);
    const fallback = inputWriterMemoryEvidenceView(packet);
    const normalizeBucket = value => {
      const bucket = guiAsObject(value);
      return {
        memory: guiAsArray(bucket.memory),
        entity: guiAsArray(bucket.entity),
        world: guiAsArray(bucket.world),
        narrative: guiAsArray(bucket.narrative)
      };
    };
    const hasPriority = priority.schema === 'libra.planner_canonical_priority.v1';
    return {
      newer: hasPriority ? normalizeBucket(priority.newerThanState) : { memory: [], entity: [], world: [], narrative: [] },
      historical: hasPriority ? normalizeBucket(priority.historicalAtOrBeforeState) : fallback,
      authority: cloneJson(packet.continuity_state_authority || null)
    };
  };

  const buildInputWriterPrompts = async preflight => {
    const packet = preflight?.evidencePacket || {};
    const modeDef = inputWriterModeDefinition(preflight?.settings?.inputWriterMode || packet?.input_writer_mode);
    const compiled = await compileInputWriterPromptProfile(modeDef.mode);
    const original = text(preflight?.originalInput || '');
    const priority = inputWriterCanonicalPriorityView(packet);
    const stateAuthority = guiAsObject(packet?.continuity_state_authority || priority.authority);
    const stateCurrent = stateAuthority.current === true && stateAuthority.pending !== true;
    const common = [
      'LOCKED LIBRA INPUT WRITER CONTRACT:',
      'You generate candidate USER inputs. You do not write the assistant finished scene response, and nothing you propose is canon or enacted until the user explicitly selects and sends it.',
      'Factual authority order is exact: Composer Input; Terminal Scene; exact Live Tail; Canonical newer than the State boundary; Ariadne Current State Head; Narrative Current State; historical Canonical; user Narrative Direction; Current Chat Author Note; Unified Lore; Bootstrap references.',
      'A current State Head contains latest target-chain values, not event history. A pending, partial, or last-known State Head is context only and is NON-AUTHORITATIVE against newer Canonical evidence.',
      'Narrative Current State describes established state. Narrative Direction is a future creative preference and must never be converted into an accomplished fact.',
      'Unified Lore Material is canon/setting evidence, not proof that a current event happened. Do not use or reconstruct the retired Story Arc compatibility projection.',
      'Never expose LIBRA, memory, retrieval, lore search, Author Note, JSON, hidden analysis, or internal agents in a candidate.',
      modeDef.mode === 'rp'
        ? 'LOCKED RP BOUNDARY: candidates may contain only user-owned actions, dialogue, questions, attempts, observations, or waiting. They may not decide NPC/world response, external success, another person consent, hidden facts, aftermath, or a later scene.'
        : 'LOCKED NOVEL MODE SHAPE: the USER is author/director. Return exactly one user_focus, one npc_focus, and one offscreen_focus candidate. They are ready-to-send author directions rather than finished assistant prose; the later SGA may author the user persona as part of the full cast except where the direction explicitly fixes or reserves a choice.',
      original
        ? 'LOCKED SOURCE FIDELITY: preserve explicit actor, target, addressee, polarity, modality, completion state, named entities, fixed outcomes, prohibitions, and user boundaries. AI candidates are alternatives; the UI separately preserves the original.'
        : 'LOCKED BLANK CONTINUATION: no new user action has been chosen. Do not silently enact or canonize any proposed direction.',
      '',
      compiled.body,
      '',
      'LOCKED OUTPUT CONTRACT:',
      'Return exactly three materially distinct ready-to-send candidates. Do not recommend, rank, preselect, or mark one as best.',
      `Return one JSON object only: {"schema":"${INPUT_WRITER_CHOICES_SCHEMA}","ok":true,"mode":"${modeDef.mode}","choices":[{"id":"A","title":"","summary":"","perspective":"","input":""},{"id":"B","title":"","summary":"","perspective":"","input":""},{"id":"C","title":"","summary":"","perspective":"","input":""}]}`,
      modeDef.mode === 'rp' ? 'For RP mode, perspective may be an empty string.' : 'For author mode, perspectives must be user_focus, npc_focus, offscreen_focus exactly once each.',
      'No markdown fences or prose outside the JSON object.'
    ].join('\n');
    const stateHeading = stateCurrent
      ? '[ARIADNE CURRENT STATE HEAD — CURRENT TARGET-CHAIN VALUES / NOT EVENT HISTORY]'
      : '[ARIADNE LAST-KNOWN STATE HEAD — PENDING / NON-AUTHORITATIVE AGAINST NEWER CANONICAL]';
    const user = [
      '[INPUT WRITER MODE]',
      `${modeDef.mode} · ${modeDef.label}`,
      '',
      '[COMPOSER INPUT — HIGHEST AUTHORITY]',
      original || '(blank: propose continuation choices without enacting any of them)',
      '',
      '[LATEST TERMINAL SCENE]',
      text(packet?.terminal_scene || '') || '(none available)',
      '',
      packet?.live_tail_prompt ? '[LIVE TAIL — EXACT RECENT COMPLETED U+A]' : '',
      packet?.live_tail_prompt || '',
      packet?.live_tail_prompt ? '' : '',
      '[CANONICAL EVIDENCE NEWER THAN STATE — FACTUAL PRIORITY]',
      JSON.stringify(priority.newer, null, 2),
      '',
      packet?.continuity_state_prompt ? stateHeading : '',
      packet?.continuity_state_prompt || '',
      packet?.continuity_state_prompt ? '' : '',
      packet?.narrative_prompt ? '[WORLD MANAGER NARRATIVE — CURRENT ESTABLISHED STATE]' : '',
      packet?.narrative_prompt || '',
      packet?.narrative_prompt ? '' : '',
      '[HISTORICAL CANONICAL EVIDENCE — AT OR BEFORE STATE BOUNDARY]',
      JSON.stringify(priority.historical, null, 2),
      '',
      packet?.narrative_direction_prompt ? '[USER NARRATIVE DIRECTION — FUTURE PREFERENCE / NOT FACT]' : '',
      packet?.narrative_direction_prompt || '',
      packet?.narrative_direction_prompt ? '' : '',
      packet?.author_note_prompt ? '[CURRENT CHAT AUTHOR NOTE — PRIVATE USER DIRECTIVE / NOT EVENT EVIDENCE]' : '',
      packet?.author_note_prompt || '',
      packet?.author_note_prompt ? '' : '',
      packet?.lore_prompt ? '[UNIFIED LORE MATERIAL — CANON/SETTING ONLY]' : '',
      packet?.lore_prompt || '',
      packet?.lore_prompt ? '' : '',
      packet?.bootstrap_reference_prompt ? '[BOOTSTRAP REFERENCES — BACKGROUND ONLY]' : '',
      packet?.bootstrap_reference_prompt || '',
      '',
      'Generate the three candidate user inputs now.'
    ].filter(Boolean).join('\n');
    return { system: common, user, mode: modeDef.mode, provenance: cloneJson(compiled.provenance) };
  };

__PATCH__*/});
  replaceRange(
    '  const inputWriterMemoryEvidenceView =',
    '  const generateLibraInputWriterChoices =',
    promptCompiler,
    'Phase06 Input Writer authority prompt compiler'
  );

  const generation = patchBlock(function () {/*__PATCH__
  const nextInputWriterRunId = () => `input_writer_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const generateLibraInputWriterChoices = async preflight => {
    const startedAt = Date.now();
    const runId = nextInputWriterRunId();
    let pipelineRequestId = 0;
    let prompts = null;
    let result = null;
    let normalized = null;
    let retried = false;
    try {
      prompts = await buildInputWriterPrompts(preflight);
      const settings = { ...(await loadSettings()), ...guiAsObject(preflight?.settings) };
      pipelineRequestId = await updatePipelineWorkPanel(`${inputWriterModeDefinition(prompts.mode).label} 인풋 후보 3개를 작성하고 있습니다…`, 'input_writer_generating', {
        begin: true,
        source: 'input_writer',
        scopeKey: text(preflight?.scope?.scopeKey || ''),
        stagePlan: [INPUT_ASSIST_STAGE_ID],
        currentStage: INPUT_ASSIST_STAGE_ID
      });
      result = await callLLMWithPreset(settings, INPUT_ASSIST_STAGE_ID, prompts.system, prompts.user, {
        maxTokens: INPUT_WRITER_MAX_OUTPUT_TOKENS,
        temp: prompts.mode === 'author' ? 0.55 : 0.48,
        jsonMode: true,
        forceNoThinking: true,
        timeoutMs: DEFAULT_STAGE_TIMEOUT_MS
      });
      normalized = result?.ok ? normalizeInputWriterChoices(result.content || '', preflight?.originalInput || '', prompts.mode) : null;
      if (!normalized) {
        retried = true;
        await updatePipelineWorkPanel('인풋 후보 형식을 바로잡아 세 후보를 다시 완성하고 있습니다…', 'input_writer_correcting', {
          expectedRequestId: pipelineRequestId,
          source: 'input_writer', currentStage: INPUT_ASSIST_STAGE_ID
        });
        result = await callLLMWithPreset(settings, INPUT_ASSIST_STAGE_ID,
          `${prompts.system}\n\nCORRECTION: The prior output was malformed, duplicated, incomplete, or violated the exact three-choice contract. Return the exact JSON object with three valid distinct choices now.`,
          `${prompts.user}\n\nDo not explain the correction. Return JSON only.`, {
            maxTokens: Math.max(INPUT_WRITER_MAX_OUTPUT_TOKENS, 3800),
            temp: 0.25,
            jsonMode: true,
            forceNoThinking: true,
            timeoutMs: DEFAULT_STAGE_TIMEOUT_MS
          });
        normalized = result?.ok ? normalizeInputWriterChoices(result.content || '', preflight?.originalInput || '', prompts.mode) : null;
      }
      const record = {
        schema: INPUT_WRITER_RUN_SCHEMA,
        runId,
        at: Date.now(),
        startedAt,
        pipelineRequestId,
        scopeKey: text(preflight?.scope?.scopeKey || ''),
        ok: !!normalized,
        mode: prompts.mode,
        continuationMode: preflight?.continuationMode === true,
        originalInput: text(preflight?.originalInput || ''),
        inputHash: stableDraftHash(text(preflight?.originalInput || '')),
        choices: normalized?.choices || [],
        retried,
        provider: text(result?.provider || ''),
        presetName: text(result?.presetName || result?.profile || ''),
        model: text(result?.model || ''),
        elapsedMs: Number(result?.elapsedMs || (Date.now() - startedAt)),
        finishReason: text(result?.finishReason || ''),
        usage: safeClone(result?.usage || null),
        promptProvenance: safeClone(prompts.provenance || null),
        deliverySnapshot: safeClone(preflight?.deliverySnapshot || null),
        preflight: {
          queryHash: text(preflight?.queryHash || ''),
          recallMemoryCount: Number(preflight?.recallMemoryCount || 0),
          branchView: safeClone(preflight?.branchView || null),
          liveTail: safeClone(preflight?.liveTail || null),
          narrativeState: safeClone(preflight?.narrativeState || null),
          narrativeDirection: safeClone(preflight?.narrativeDirection || null),
          lore: safeClone(preflight?.lore || null),
          authorNote: safeClone(preflight?.authorNote || null),
          bootstrap: safeClone(preflight?.bootstrap || null)
        },
        reason: normalized ? '' : compact(result?.reason || 'input_writer_invalid_or_incomplete_choices', 700),
        rawResponse: compact(result?.content || result?.raw || '', 14000)
      };
      Runtime.lastInputWriter = safeClone(record);
      recordStageTrace({
        stage: 'input_writer',
        ok: record.ok,
        reason: record.reason,
        provider: record.provider,
        presetName: record.presetName,
        model: record.model,
        elapsedMs: record.elapsedMs,
        systemPrompt: prompts.system,
        userPrompt: prompts.user,
        rawResponse: result?.content || '',
        parsed: normalized || null
      });
      await finishPipelineWorkStatus(
        record.ok ? '인풋 후보 3개를 완성했습니다 · 사용할 후보를 선택하세요.' : '인풋 후보를 완성하지 못했습니다.',
        record.ok,
        record.ok ? 2200 : 5000,
        record.ok ? 'input_writer_completed' : 'input_writer_failed',
        pipelineRequestId
      );
      return record;
    } catch (error) {
      const failure = {
        schema: INPUT_WRITER_RUN_SCHEMA,
        runId,
        at: Date.now(),
        startedAt,
        pipelineRequestId: Math.max(0, Number(pipelineRequestId || error?.pipelineWorkRequestId || 0)),
        scopeKey: text(preflight?.scope?.scopeKey || ''),
        ok: false,
        mode: text(prompts?.mode || preflight?.settings?.inputWriterMode || DEFAULT_INPUT_WRITER_MODE),
        continuationMode: preflight?.continuationMode === true,
        originalInput: text(preflight?.originalInput || ''),
        inputHash: stableDraftHash(text(preflight?.originalInput || '')),
        choices: [],
        retried,
        elapsedMs: Date.now() - startedAt,
        deliverySnapshot: safeClone(preflight?.deliverySnapshot || null),
        failurePhase: result ? 'provider_validation' : (prompts ? 'provider_generation' : 'prompt_compilation'),
        recoverable: true,
        reason: compact(error?.message || error || 'input_writer_generation_failed', 900),
        rawResponse: compact(result?.content || result?.raw || '', 14000),
        preflight: {
          queryHash: text(preflight?.queryHash || ''),
          branchView: safeClone(preflight?.branchView || null),
          liveTail: safeClone(preflight?.liveTail || null),
          narrativeState: safeClone(preflight?.narrativeState || null),
          narrativeDirection: safeClone(preflight?.narrativeDirection || null)
        }
      };
      Runtime.lastInputWriter = safeClone(failure);
      try {
        await finishPipelineWorkStatus('인풋 작성 중 오류가 발생했습니다.', false, 5000, 'input_writer_failed', failure.pipelineRequestId);
      } catch (_) {}
      return failure;
    }
  };

__PATCH__*/});
  replaceRange(
    '  const generateLibraInputWriterChoices =',
    '  const notifyLibraInputWriterError =',
    generation,
    'Phase06 Input Writer generation run identity'
  );

  const delivery = patchBlock(function () {/*__PATCH__
  const dispatchLibraInputWriterDelivery = async (requestValue = {}, dependenciesValue = {}) => {
    const objectValue = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const request = objectValue(requestValue);
    const deps = objectValue(dependenciesValue);
    const action = text(request.action || '').trim().toLowerCase();
    const content = text(request.content || '').trim();
    const snapshot = request.snapshot || null;
    const cycleId = text(request.cycleId || '').trim() || `input_writer_delivery_${Date.now()}`;
    const cycles = deps.cycles instanceof Map
      ? deps.cycles
      : (Runtime.inputWriterDeliveryCycles instanceof Map
        ? Runtime.inputWriterDeliveryCycles
        : (Runtime.inputWriterDeliveryCycles = new Map()));
    const idempotencyKey = digest({ cycleId, contentHash: stableDraftHash(content) });
    const base = { ok: false, action, accepted: false, stale: false, duplicate: false, content, cycleId, idempotencyKey };
    const reportWarning = (code, error) => {
      try {
        if (typeof deps.warn === 'function') deps.warn(code, error);
        else if (typeof warn === 'function') warn(code, error);
      } catch (_) {}
    };
    const notifySettlement = receipt => {
      try { if (typeof deps.onAsyncSettlement === 'function') deps.onAsyncSettlement(safeClone(receipt)); } catch (_) {}
    };
    if (!content) return { ...base, reason: 'empty_content' };
    if (!['copy', 'insert', 'send'].includes(action)) return { ...base, reason: 'unsupported_action' };
    const cycleNow = Date.now();
    for (const [key, row] of cycles.entries()) {
      if (cycles.size <= 128) break;
      if (row?.state !== 'validating' && row?.state !== 'dispatching' && row?.state !== 'accepted_pending'
        && cycleNow - Number(row?.settledAt || row?.at || 0) > 10 * 60 * 1000) cycles.delete(key);
    }

    if (action === 'copy') {
      if (typeof deps.copyText !== 'function') return { ...base, reason: 'copy_unavailable' };
      try {
        const copiedValue = await deps.copyText(content, { cycleId, idempotencyKey });
        const copiedObject = objectValue(copiedValue);
        const copied = copiedValue === true || copiedObject.ok === true;
        return {
          ...base,
          ...safeClone(copiedObject),
          ok: copied,
          accepted: copied,
          manual: true,
          reason: copied ? '' : text(copiedObject.reason || copiedObject.error || 'copy_failed')
        };
      } catch (error) {
        reportWarning('libra_input_writer_copy_failed', error);
        return { ...base, manual: true, reason: compact(error?.message || error, 500) };
      }
    }

    const existing = cycles.get(cycleId);
    if (existing) {
      return {
        ...base,
        duplicate: true,
        reason: 'delivery_cycle_already_claimed',
        previous: safeClone(existing)
      };
    }
    const validating = { state: 'validating', action, cycleId, idempotencyKey, contentHash: stableDraftHash(content), at: Date.now() };
    cycles.set(cycleId, validating);
    if (typeof deps.validateSnapshot !== 'function') {
      if (cycles.get(cycleId) === validating) cycles.delete(cycleId);
      return { ...base, stale: true, reason: 'snapshot_validator_unavailable' };
    }
    let validation = null;
    try { validation = await deps.validateSnapshot(snapshot); }
    catch (error) { validation = { ok: false, current: false, stale: true, reason: compact(error?.message || error, 500) }; }
    if (!validation || validation.ok !== true || validation.current !== true || validation.stale === true) {
      if (cycles.get(cycleId) === validating) cycles.delete(cycleId);
      return {
        ...base,
        stale: true,
        reason: text(validation?.reason || 'input_writer_authority_stale'),
        validation: safeClone(validation || null)
      };
    }

    const claimed = { state: 'dispatching', action, cycleId, idempotencyKey, contentHash: stableDraftHash(content), at: Date.now() };
    cycles.set(cycleId, claimed);

    if (action === 'insert') {
      let nativeResult = null;
      if (typeof deps.insertText === 'function') {
        try { nativeResult = await deps.insertText(content, { cycleId, idempotencyKey, snapshot }); }
        catch (error) {
          const receipt = { ...base, reason: compact(error?.message || error, 500), native: true };
          cycles.set(cycleId, { ...claimed, state: 'rejected', receipt: safeClone(receipt) });
          reportWarning('libra_input_writer_insert_failed', error);
          return receipt;
        }
        const nativeObject = objectValue(nativeResult);
        const nativeOk = nativeResult === true || nativeObject.ok === true;
        if (nativeOk) {
          const receipt = { ...base, ...safeClone(nativeObject), ok: true, accepted: true, native: true, reason: '' };
          cycles.set(cycleId, { ...claimed, state: 'delivered', receipt: safeClone(receipt) });
          return receipt;
        }
        if (nativeObject.unavailable !== true) {
          const receipt = { ...base, ...safeClone(nativeObject), native: true, reason: text(nativeObject.reason || nativeObject.error || 'native_insert_rejected') };
          cycles.set(cycleId, { ...claimed, state: 'rejected', receipt: safeClone(receipt) });
          return receipt;
        }
      }
      cycles.delete(cycleId);
      if (typeof deps.insertTextFallback !== 'function') {
        return { ...base, unavailable: true, manualFallback: true, reason: 'native_insert_unavailable' };
      }
      try {
        const fallbackValue = await deps.insertTextFallback(content, { cycleId, idempotencyKey, snapshot });
        const fallback = objectValue(fallbackValue);
        return {
          ...base,
          ...safeClone(fallback),
          ok: fallback.ok === true,
          accepted: false,
          unavailable: fallback.unavailable !== false,
          manualFallback: true,
          reason: text(fallback.reason || fallback.error || (fallback.ok === true ? 'manual_copy_ready' : 'native_insert_unavailable'))
        };
      } catch (error) {
        reportWarning('libra_input_writer_insert_fallback_failed', error);
        return { ...base, unavailable: true, manualFallback: true, reason: compact(error?.message || error, 500) };
      }
    }

    if (typeof deps.sendChat !== 'function') {
      cycles.delete(cycleId);
      return { ...base, unavailable: true, reason: 'send_chat_unavailable' };
    }
    const deliveryMeta = { cycleId, idempotencyKey, snapshot, contentHash: stableDraftHash(content), readbackBasis: null };
    const settleSend = async (settlement, value, error = null) => {
      let readback = null;
      const readbackAttempted = typeof deps.readDeliveryReadback === 'function';
      if (readbackAttempted) {
        try { readback = await deps.readDeliveryReadback({ content, snapshot, cycleId, idempotencyKey, meta: deliveryMeta, settlement, value, error }); }
        catch (readbackError) {
          readback = { ambiguous: true, reason: compact(readbackError?.message || readbackError, 500) };
        }
      }
      const userMessagePresent = readback?.userMessagePresent === true;
      const assistantCompleted = readback?.assistantCompleted === true;
      const rejected = settlement === 'rejected' || settlement === 'failed' || value === false || !!error;
      const ambiguous = readback?.ambiguous === true || (!rejected && readbackAttempted && !userMessagePresent);
      const outcome = rejected
        ? (userMessagePresent ? 'user_delivered_response_failed' : (ambiguous ? 'ambiguous' : 'rejected'))
        : (ambiguous ? 'ambiguous' : 'delivered');
      const delivered = outcome === 'delivered';
      const receipt = {
        ...base,
        ok: delivered,
        accepted: true,
        pending: false,
        delivered,
        status: outcome,
        outcome,
        userMessagePresent,
        assistantCompleted,
        ambiguous: outcome === 'ambiguous',
        reason: error ? compact(error?.message || error, 500) : (value === false ? 'send_chat_resolved_false' : text(readback?.reason || '')),
        readback: safeClone(readback)
      };
      cycles.set(cycleId, { ...claimed, state: outcome, receipt: safeClone(receipt), settledAt: Date.now() });
      if (error || value === false) reportWarning('libra_input_writer_send_async_error', error || new Error('sendChat resolved false'));
      notifySettlement(receipt);
      return receipt;
    };

    let dispatchValue = null;
    try { dispatchValue = deps.sendChat(content, deliveryMeta); }
    catch (error) { return await settleSend('rejected', false, error); }
    if (dispatchValue && typeof dispatchValue.then === 'function') {
      Promise.resolve(dispatchValue)
        .then(value => settleSend(value === false ? 'rejected' : 'resolved', value, value === false ? new Error('sendChat resolved false') : null))
        .catch(error => settleSend('rejected', false, error))
        .catch(error => reportWarning('libra_input_writer_send_settlement_error', error));
      const pending = { ...base, ok: true, accepted: true, pending: true, status: 'accepted_pending', outcome: 'accepted_pending' };
      cycles.set(cycleId, { ...claimed, state: 'accepted_pending', receipt: safeClone(pending) });
      return pending;
    }
    return await settleSend(dispatchValue === false ? 'rejected' : 'resolved', dispatchValue, dispatchValue === false ? new Error('sendChat returned false') : null);
  };

  const inputWriterChatRows = chatValue => {
    const chat = guiAsObject(chatValue);
    const rows = Array.isArray(chat.message) ? chat.message : (Array.isArray(chat.messages) ? chat.messages : []);
    return rows.map((row, index) => {
      const roleRaw = text(row?.role || row?.type || '').trim().toLowerCase();
      const role = ['user', 'human'].includes(roleRaw) ? 'user' : (['assistant', 'char', 'bot', 'ai'].includes(roleRaw) ? 'assistant' : roleRaw);
      const content = text(row?.data ?? row?.content ?? row?.text ?? row?.message ?? '');
      return { index, role, content, chatId: text(row?.chatId || row?.id || row?.messageId || ''), signature: stableDraftHash(`${role}|${content}`) };
    });
  };

  const captureInputWriterDeliveryReadback = async contentValue => {
    const context = await LibraMemoryCore.resolveContext();
    const rows = inputWriterChatRows(context.chat);
    const content = text(contentValue || '').trim();
    return {
      scopeKey: text(context?.scope?.scopeKey || ''),
      rowCount: rows.length,
      exactUserCount: rows.filter(row => row.role === 'user' && row.content.trim() === content).length,
      signatures: rows.map(row => `${row.index}:${row.chatId}:${row.signature}`)
    };
  };

  const readInputWriterDeliveryReadback = async ({ content = '', meta = null } = {}) => {
    const basis = guiAsObject(meta?.readbackBasis);
    const context = await LibraMemoryCore.resolveContext();
    const currentScopeKey = text(context?.scope?.scopeKey || '');
    if (!basis.scopeKey || currentScopeKey !== text(basis.scopeKey)) {
      return { ambiguous: true, userMessagePresent: false, assistantCompleted: false, reason: 'delivery_scope_changed' };
    }
    const rows = inputWriterChatRows(context.chat);
    const body = text(content || '').trim();
    const exactUsers = rows.filter(row => row.role === 'user' && row.content.trim() === body);
    const userMessagePresent = exactUsers.length > Number(basis.exactUserCount || 0);
    const appendedUser = userMessagePresent ? exactUsers.at(-1) : null;
    const assistantCompleted = !!appendedUser && rows.some(row => row.index > appendedUser.index && row.role === 'assistant' && !!row.content.trim());
    return {
      ambiguous: false,
      userMessagePresent,
      assistantCompleted,
      beforeRows: Number(basis.rowCount || 0),
      afterRows: rows.length
    };
  };

  const insertLibraInputWriterIntoHostComposer = async bodyValue => {
    const body = text(bodyValue || '').trim();
    const candidates = ['setChatInput', 'setChatInputText', 'setInputText', 'setComposerText'];
    for (const method of candidates) {
      const api = getLiveApi([method]);
      if (typeof api?.[method] !== 'function') continue;
      try {
        const result = await api[method](body);
        return result === false
          ? { ok: false, unavailable: false, native: true, method, reason: 'native_insert_rejected' }
          : { ok: true, unavailable: false, native: true, method };
      } catch (error) {
        return { ok: false, unavailable: false, native: true, method, reason: compact(error?.message || error, 500) };
      }
    }
    return { ok: false, unavailable: true, native: false, reason: 'native_input_setter_unavailable', content: body };
  };

  const showLibraInputWriterDeliveryPicker = async ({ content = '', settings = null, deliverySnapshot = null, runId = '' } = {}) => {
    const source = text(content || '').trim();
    if (!source) return { action: 'cancelled', content: '' };
    if (typeof document === 'undefined') return { action: 'copy_required', content: source, deliverySnapshot: safeClone(deliverySnapshot) };
    const surface = await openLibraInputWriterSurface();
    return await new Promise(resolve => {
      let settled = false;
      let busy = false;
      let sourceText = source;
      let displayed = source;
      let translationView = 'source';
      const translations = { english: '', korean: '', japanese: '' };
      const cycleId = text(runId || '') || `input_writer_delivery_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
      const app = guiEl('div', { class: 'sga-input-confirm-app libra-input-writer-modal delivery' });
      Gui.app = app;
      const editor = guiEl('textarea', {
        class: 'sga-input-confirm-text editable', value: displayed, spellcheck: true,
        style: { width: '100%', resize: 'vertical' },
        'aria-label': '최종 전송 인풋 편집'
      });
      const count = guiEl('span', { class: 'sga-note', text: `${displayed.length.toLocaleString('ko-KR')}자` });
      const status = guiEl('div', { class: 'sga-input-confirm-status', text: '최종 문장을 수정하거나 번역한 뒤 입력창에 넣기, 복사, 또는 바로 전송을 선택하세요.' });
      const buttons = [];
      const capture = () => {
        displayed = text(editor.value || '');
        if (translationView === 'source') {
          sourceText = displayed;
          translations.english = ''; translations.korean = ''; translations.japanese = '';
        } else translations[translationView] = displayed;
        count.textContent = `${displayed.length.toLocaleString('ko-KR')}자`;
      };
      editor.addEventListener('input', capture);
      const setBusy = (next, message = '') => {
        busy = !!next;
        editor.disabled = busy;
        buttons.forEach(button => { button.disabled = busy; });
        if (message) { status.textContent = message; status.classList.remove('err'); }
      };
      const finish = async result => {
        if (settled || busy) return;
        settled = true;
        document.removeEventListener('keydown', keyHandler);
        await surface.restore();
        resolve(result);
      };
      const keyHandler = event => {
        if (event?.key === 'Escape') { event.preventDefault?.(); void finish({ action: 'cancelled', content: '' }); }
      };
      document.addEventListener('keydown', keyHandler);
      const languageDefs = [['english','영어'],['korean','한국어'],['japanese','일본어']];
      const languageButtons = languageDefs.map(([language,label]) => {
        const button = guiEl('button', { class: 'sga-btn ghost', type: 'button', text: `${label}로 번역`, onClick: async () => {
          if (busy) return;
          capture();
          if (translationView === language) {
            translationView = 'source'; displayed = sourceText; editor.value = displayed; count.textContent = `${displayed.length.toLocaleString('ko-KR')}자`; updateLabels(); return;
          }
          setBusy(true, `${label}로 번역하고 있습니다…`);
          try {
            let translated = translations[language];
            if (!translated) translated = text(await translateInputAssistReviewText(sourceText, settings || await loadSettings(), language)).trim();
            if (!translated) throw new Error('번역 결과가 비어 있습니다.');
            translations[language] = translated;
            translationView = language;
            displayed = translated;
            editor.value = displayed;
            count.textContent = `${displayed.length.toLocaleString('ko-KR')}자`;
            status.textContent = `${label} 번역본을 표시하고 있습니다. 현재 보이는 문장이 전달됩니다.`;
            updateLabels();
          } catch (error) {
            status.textContent = `번역 실패: ${compact(error?.message || error, 600)}`;
            status.classList.add('err');
          } finally { setBusy(false); }
        } });
        buttons.push(button);
        return [language, label, button];
      });
      const updateLabels = () => languageButtons.forEach(([language,label,button]) => { button.textContent = translationView === language ? '원문 보기' : `${label}로 번역`; });

      const dispatchAction = async action => {
        if (busy) return;
        capture();
        const body = displayed.trim();
        if (!body) return;
        setBusy(true, action === 'send' ? 'RisuAI 전송을 요청하고 있습니다…' : action === 'insert' ? 'RisuAI 입력창 연결을 확인하고 있습니다…' : '클립보드로 복사하고 있습니다…');
        const result = await dispatchLibraInputWriterDelivery({ action, content: body, snapshot: deliverySnapshot, cycleId }, {
          cycles: Runtime.inputWriterDeliveryCycles,
          validateSnapshot: snapshot => LibraMemoryCore.validateInputWriterDeliverySnapshot(snapshot),
          copyText: value => copyTextWithFallback(value),
          insertText: value => insertLibraInputWriterIntoHostComposer(value),
          insertTextFallback: async value => {
            const copied = await copyTextWithFallback(value);
            return { ...copied, unavailable: true, manualFallback: true, content: value, reason: copied.ok ? 'native_insert_unavailable_copied_for_manual_paste' : (copied.error || 'manual_copy_failed') };
          },
          sendChat: async (value, meta) => {
            meta.readbackBasis = await captureInputWriterDeliveryReadback(value);
            const sendApi = getLiveApi(['sendChat']);
            if (typeof sendApi?.sendChat !== 'function') throw new Error('현재 RisuAI에서 sendChat API를 사용할 수 없습니다. 복사 후 직접 전송을 사용하세요.');
            return sendApi.sendChat(value);
          },
          readDeliveryReadback: args => readInputWriterDeliveryReadback(args),
          warn: (code, error) => warn(code, error),
          onAsyncSettlement: receipt => {
            Runtime.lastInputWriterDelivery = safeClone(receipt);
            if (Runtime.lastInputWriter?.runId === runId) Runtime.lastInputWriter = { ...Runtime.lastInputWriter, deliverySettlement: safeClone(receipt) };
          }
        });
        Runtime.lastInputWriterDelivery = safeClone(result);
        if (result.stale === true) {
          status.textContent = '대화·월드라인·정본 또는 현재 상태가 후보 생성 뒤 바뀌었습니다. 자동 입력·전송은 차단했습니다. 문장을 복사하거나 후보를 새로 생성하세요.';
          status.classList.add('err');
          setBusy(false);
          try { editor.focus(); editor.select(); } catch (_) {}
          return;
        }
        if (result.duplicate === true) {
          status.textContent = '이 전달 사이클은 이미 처리되었습니다. 중복 입력·전송을 차단했습니다.';
          status.classList.add('err');
          setBusy(false);
          return;
        }
        if (action === 'copy' && result.accepted === true) {
          busy = false;
          await finish({ ...result, action: 'copy', translationLanguage: translationView === 'source' ? '' : translationView });
          return;
        }
        if (action === 'insert' && result.accepted === true) {
          busy = false;
          await finish({ ...result, action: 'insert', translationLanguage: translationView === 'source' ? '' : translationView });
          return;
        }
        if (action === 'send' && result.accepted === true) {
          busy = false;
          await finish({ ...result, action: result.pending === true ? 'send_pending' : 'send', translationLanguage: translationView === 'source' ? '' : translationView });
          return;
        }
        if (action === 'insert' && result.manualFallback === true && result.ok === true) {
          busy = false;
          await finish({ ...result, action: 'copy_for_insert', translationLanguage: translationView === 'source' ? '' : translationView });
          return;
        }
        status.textContent = `전달 실패: ${compact(result.reason || result.error || '호스트가 요청을 완료하지 못했습니다.', 600)}`;
        status.classList.toggle('err', result.ok !== true);
        setBusy(false);
        try { editor.focus(); editor.select(); } catch (_) {}
      };

      const cancelButton = guiEl('button', { class: 'sga-btn ghost', type: 'button', text: '취소', onClick: () => { void finish({ action: 'cancelled', content: '' }); } });
      const copyButton = guiEl('button', { class: 'sga-btn', type: 'button', text: '복사 후 직접 전송', onClick: () => { void dispatchAction('copy'); } });
      const insertButton = guiEl('button', { class: 'sga-btn', type: 'button', text: '입력창에 넣기', onClick: () => { void dispatchAction('insert'); } });
      const sendButton = guiEl('button', { class: 'sga-btn primary', type: 'button', text: '바로 전송', onClick: () => { void dispatchAction('send'); } });
      buttons.push(cancelButton, copyButton, insertButton, sendButton);
      app.appendChild(guiEl('div', { class: 'sga-input-confirm-head' }, [
        guiEl('div', {}, [guiEl('h2', { text: '최종 인풋 확인' }), guiEl('p', { text: '이 문장만 실제 사용자 입력으로 사용됩니다. 선택하지 않은 후보는 폐기됩니다.' })]), count
      ]));
      app.appendChild(guiEl('div', { class: 'sga-input-confirm-translation-row' }, languageButtons.map(item => item[2])));
      app.appendChild(editor);
      app.appendChild(guiEl('div', { class: 'sga-input-confirm-footer' }, [status, guiEl('div', { class: 'sga-actions' }, [cancelButton, copyButton, insertButton, sendButton]) ]));
      Gui.root.appendChild(app);
      forceTransparentGuiSurface();
    });
  };

__PATCH__*/});
  replaceRange(
    '  const showLibraInputWriterDeliveryPicker =',
    '  const runExplicitLibraInputWriter =',
    delivery,
    'Phase06 delivery coordinator and guarded GUI'
  );

  const explicitRun = patchBlock(function () {/*__PATCH__
  const runExplicitLibraInputWriter = async () => {
    if (Runtime.inputWriterBusy) { await notifyLibraInputWriterError('이미 Ariadne 인풋을 작성하고 있습니다.'); return false; }
    if (Runtime.inFlight) { await notifyLibraInputWriterError('현재 응답 파이프라인이 끝난 뒤 다시 시도하세요.'); return false; }
    Runtime.inputWriterBusy = true;
    let preflight = null;
    let run = null;
    try {
      const settings = await loadSettings();
      if (settings?.inputWriterEnabled === false) throw new Error('설정에서 Ariadne 인풋 작성기를 먼저 활성화하세요.');
      const composerInput = await showLibraInputWriterComposer();
      if (composerInput === null) return false;
      preflight = await LibraMemoryCore.prepareInputWriterEvidence(composerInput, { settings });
      run = await generateLibraInputWriterChoices(preflight);
      if (!run.ok) {
        const error = new Error(run.reason || '세 가지 인풋 후보를 만들지 못했습니다.');
        error.pipelineWorkRequestId = Number(run.pipelineRequestId || 0);
        error.inputWriterRunId = text(run.runId || '');
        throw error;
      }
      const picked = await showLibraInputWriterChoicePicker({
        original: text(composerInput || ''),
        run,
        onRegenerate: async () => {
          preflight = await LibraMemoryCore.prepareInputWriterEvidence(composerInput, { settings: await loadSettings() });
          run = await generateLibraInputWriterChoices(preflight);
          return run;
        }
      });
      const ownedRun = Runtime.lastInputWriter?.runId === run?.runId ? Runtime.lastInputWriter : run;
      if (picked.action === 'cancelled' || !text(picked.content).trim()) {
        Runtime.lastInputWriter = { ...ownedRun, cancelled: true, selectedAt: Date.now(), selectedInput: '', deliveryAction: 'cancelled' };
        return false;
      }
      const delivery = await showLibraInputWriterDeliveryPicker({
        content: picked.content,
        settings: await loadSettings(),
        deliverySnapshot: preflight?.deliverySnapshot || run?.deliverySnapshot || null,
        runId: text(run?.runId || '')
      });
      if (delivery.action === 'cancelled' || !text(delivery.content).trim()) {
        Runtime.lastInputWriter = { ...ownedRun, cancelled: true, selectedAt: Date.now(), selectedInput: '', deliveryAction: 'cancelled' };
        return false;
      }
      Runtime.lastInputWriter = {
        ...ownedRun,
        selectedAt: Date.now(),
        selectedAction: picked.action,
        selectedChoiceId: text(picked.choice?.id || ''),
        selectedInput: text(delivery.content),
        selectedInputHash: stableDraftHash(text(delivery.content)),
        deliveryAction: text(delivery.action || ''),
        deliveryCycleId: text(delivery.cycleId || ''),
        deliveryIdempotencyKey: text(delivery.idempotencyKey || ''),
        deliveryPending: delivery.pending === true,
        translationLanguage: text(delivery.translationLanguage || ''),
        cancelled: false
      };
      return true;
    } catch (error) {
      const runId = text(run?.runId || error?.inputWriterRunId || '');
      const owned = runId && Runtime.lastInputWriter?.runId === runId
        ? Runtime.lastInputWriter
        : (run?.runId === runId ? run : { schema: INPUT_WRITER_RUN_SCHEMA, runId });
      const failedPipelineRequestId = Math.max(0, Number(error?.pipelineWorkRequestId || owned?.pipelineRequestId || 0));
      Runtime.lastInputWriter = {
        ...owned,
        at: Date.now(),
        pipelineRequestId: failedPipelineRequestId,
        scopeKey: text(preflight?.scope?.scopeKey || owned?.scopeKey || ''),
        ok: false,
        failurePhase: text(owned?.failurePhase || 'input_writer_flow'),
        recoverable: true,
        reason: compact(error?.message || error, 900),
        deliverySnapshot: safeClone(preflight?.deliverySnapshot || owned?.deliverySnapshot || null)
      };
      await finishPipelineWorkStatus(
        '인풋 작성 중 오류가 발생했습니다.',
        false,
        5000,
        'input_writer_failed',
        failedPipelineRequestId
      );
      await notifyLibraInputWriterError(error);
      return false;
    } finally {
      Runtime.inputWriterBusy = false;
    }
  };

__PATCH__*/});
  replaceRange(
    '  const runExplicitLibraInputWriter =',
    '  const providerChoices =',
    explicitRun,
    'Phase06 Input Writer run and snapshot retention'
  );

  insertAfter(
    '    async debugBuildInputWriterPrompts(preflight = {}) { return safeClone(await buildInputWriterPrompts(preflight)); },',
    '\n    async debugGenerateInputWriterChoices(preflight = {}) { return safeClone(await generateLibraInputWriterChoices(preflight)); },\n    async debugValidateInputWriterDeliverySnapshot(snapshot = {}) { return safeClone(await LibraMemoryCore.validateInputWriterDeliverySnapshot(snapshot)); },',
    'Phase06 Input Writer debug APIs'
  );

  replaceOnce(
    "      Object.freeze({ id: 'authority', label: '권위·자료', text: 'Preserve the composer input as highest directive authority. Use the terminal scene and Live Tail as newest direct facts, canonical memory as historical evidence, lore as setting/identity canon, Story Arc as advisory continuity, and Author Note as a private creative directive below the composer input.' }),",
    "      Object.freeze({ id: 'authority', label: '권위·자료', text: 'Preserve the composer input as highest directive authority. Use terminal scene and exact Live Tail as newest facts, then canonical evidence newer than State, the Ariadne Current State Head, Narrative Current State, older canonical evidence, user Narrative Direction, Author Note, lore, and bootstrap references in that order. Pending or partial State is explicitly non-authoritative against newer canonical evidence.' }),",
    'Phase06 RP authority profile'
  );
  replaceOnce(
    "      Object.freeze({ id: 'memory_lore_usage', label: '기억·로어 사용', text: 'Use recalled history and lore only when they materially change a plausible current choice. Lore cannot prove that an event happened; Story Arc soft beats cannot authorize player behavior. Do not surface internal source names.' }),",
    "      Object.freeze({ id: 'memory_lore_usage', label: '기억·상태·로어 사용', text: 'Use recalled history, latest target-chain State values, and lore only when they materially change a plausible current choice. Narrative Direction is a future preference, not fact; lore cannot prove that an event happened. Do not surface internal source names.' }),",
    'Phase06 RP State and Narrative profile'
  );
  replaceOnce(
    "      Object.freeze({ id: 'authority', label: '권위·자료', text: 'Preserve composer input as highest directive authority. Use terminal scene and Live Tail as newest facts, canonical memory as historical evidence, lore as setting/identity canon, Story Arc as advisory continuity, and Author Note as a private creative directive below the composer input.' }),",
    "      Object.freeze({ id: 'authority', label: '권위·자료', text: 'Preserve composer input as highest directive authority. Use terminal scene and exact Live Tail as newest facts, then canonical evidence newer than State, the Ariadne Current State Head, Narrative Current State, older canonical evidence, user Narrative Direction, Author Note, lore, and bootstrap references in that order. Pending or partial State is explicitly non-authoritative against newer canonical evidence.' }),",
    'Phase06 author authority profile'
  );
  replaceOnce(
    "      Object.freeze({ id: 'memory_lore_usage', label: '기억·로어 사용', text: 'Use recalled history and lore to keep characterization, world rules, relationships, and setup/payoff obligations coherent. Lore is not evidence that a current event occurred, and Story Arc future beats remain optional.' }),",
    "      Object.freeze({ id: 'memory_lore_usage', label: '기억·상태·로어 사용', text: 'Use recalled history, latest target-chain State values, and lore to keep characterization, world rules, relationships, and setup/payoff obligations coherent. Narrative Direction remains an optional future preference; lore is not evidence that a current event occurred.' }),",
    'Phase06 author State and Narrative profile'
  );

  return { source, edits, eol };
};

const main = () => {
  const apply = process.argv.includes('--apply');
  const verify = process.argv.includes('--verify');
  if (!apply && !verify) {
    process.stderr.write('Refusing to transform without --verify or --apply. No files were changed.\n');
    process.exitCode = 2;
    return;
  }
  const baselineBuffer = fs.readFileSync(BASELINE_PATH);
  const baselineHash = sha256(baselineBuffer);
  assert.equal(baselineHash, BASELINE_SHA256, `external baseline hash mismatch: ${baselineHash}`);
  const inputBuffer = fs.readFileSync(TARGET_PATH);
  const inputHash = sha256(inputBuffer);
  assert.ok(ACCEPTED_INPUT_HASHES.has(inputHash), `target is not the audited baseline/P1 input: ${inputHash}`);
  const transformed = applyTransform(inputBuffer.toString('utf8'));
  const outputBuffer = Buffer.from(transformed.source, 'utf8');
  const outputHash = sha256(outputBuffer);
  assert.notEqual(outputHash, inputHash, 'transform produced no change');
  assert.equal(count(transformed.source, 'const buildReadOnlyInputWriterManifest ='), 1);
  assert.equal(count(transformed.source, 'const buildInputWriterDeliverySnapshot ='), 1);
  assert.equal(count(transformed.source, 'const validateInputWriterDeliverySnapshot ='), 1);
  assert.equal(count(transformed.source, 'reconcileCanonicalBranchBeforeRecall(context, {\n        pairs: completedPairs,\n        reason: \'input_writer_preflight\''), 0);
  assert.equal(count(transformed.source, 'ensureStoryArcForResponse(context, manifest)'), 0);

  const tempPath = `${TARGET_PATH}.phase06-${process.pid}-${Date.now()}.tmp.js`;
  try {
    fs.writeFileSync(tempPath, outputBuffer, { flag: 'wx' });
    const syntax = spawnSync(process.execPath, ['--check', tempPath], { encoding: 'utf8', windowsHide: true });
    assert.equal(syntax.status, 0, `node --check failed:\n${syntax.stdout || ''}${syntax.stderr || ''}`);
    const immediateHash = sha256(fs.readFileSync(TARGET_PATH));
    assert.equal(immediateHash, inputHash, `target changed during transform; refusing replacement (${immediateHash})`);
    if (!apply) {
      process.stdout.write(JSON.stringify({
        ok: true,
        dryRun: true,
        inputHash,
        outputHash,
        preservedP1: inputHash === P1_ONLY_SHA256 || inputHash === P1_GATE_W_SHA256,
        preservedGateW: inputHash === P1_GATE_W_SHA256,
        gateWAddedByTransform: false,
        edits: transformed.edits
      }, null, 2) + '\n');
      return;
    }
    fs.renameSync(tempPath, TARGET_PATH);
    const readbackHash = sha256(fs.readFileSync(TARGET_PATH));
    assert.equal(readbackHash, outputHash, 'atomic replacement readback hash mismatch');
    process.stdout.write(JSON.stringify({
      ok: true,
      inputHash,
      outputHash,
      preservedP1: inputHash === P1_ONLY_SHA256 || inputHash === P1_GATE_W_SHA256,
      preservedGateW: inputHash === P1_GATE_W_SHA256,
      gateWAddedByTransform: false,
      edits: transformed.edits
    }, null, 2) + '\n');
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
};

module.exports = Object.freeze({ applyTransform, ACCEPTED_INPUT_HASHES, BASELINE_PATH, TARGET_PATH });
if (require.main === module) main();
