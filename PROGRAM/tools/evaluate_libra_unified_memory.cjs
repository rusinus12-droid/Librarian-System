'use strict';
// N06-a: Unified Memory Engine Retrieval & Evidence Evaluation Benchmark Runner
// Runs standardized multi-family, distant window, entity/synonym, correction/stale,
// worldline/viewer, mandatory lore/absorption, vectorless fallback, and budget bound scenarios.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const createMemoryGraphIdentity = require('./libra_memory_graph_identity.cjs');
const createMemoryGraphPages = require('./libra_memory_graph_pages.cjs');
const createMemoryGraphIndex = require('./libra_memory_graph_index.cjs');
const createMemoryGraphLane = require('./libra_memory_graph_lane.cjs');
const createMemoryGraphQuery = require('./libra_memory_graph_query.cjs');
const createMemoryGraphCompiler = require('./libra_memory_graph_compiler.cjs');
const createMemoryGraphRollout = require('./libra_memory_graph_rollout.cjs');
const createMemoryGraphResources = require('./libra_memory_graph_resources.cjs');

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

const DEFAULT_CASES_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'libra_unified_memory_eval_cases_v1.json');

const loadCasesBundle = (filePath = DEFAULT_CASES_PATH) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.schema !== 'libra.unified_memory_eval_cases.v1' || !Array.isArray(parsed.cases)) {
    throw new Error('LIBRA_EVAL_CASES_INVALID');
  }
  return parsed;
};

const loadCases = (filePath = DEFAULT_CASES_PATH) => loadCasesBundle(filePath).cases;

const buildGraphFromCorpus = (caseDef, fingerprint = sha256) => {
  const corpus = caseDef.corpus || {};
  const queryDef = caseDef.query || {};
  const scopeKey = corpus.scopeKey || 'eval-scope';
  const worldlineId = queryDef.worldlineId || 'main';
  const restoreEpoch = 0;
  const cutoffTurn = Number.isSafeInteger(queryDef.asOfTurn) ? queryDef.asOfTurn : 100;
  const viewerId = String(queryDef.viewerId || 'owner_reader');

  const nodes = [];
  const units = [];
  const edges = [];
  const bases = [];

  const addSourceNode = (id, key) => {
    const node = {
      id,
      layer: 'source',
      kind: 'source',
      sourceId: id,
      bindingId: fingerprint('source:' + key),
      identityCoverage: null
    };
    nodes.push(node);
    return node;
  };

  const addUnitNode = (unitDef, family, index) => {
    const nodeId = unitDef.nodeId || `node_${family}_${index}`;
    const srcId = `src_${family}_${index}`;
    addSourceNode(srcId, unitDef.recordKey || nodeId);

    const node = {
      id: nodeId,
      sourceId: srcId,
      layer: 'meaning',
      kind: family,
      bindingId: fingerprint(`${nodeId}:${unitDef.text}`),
      identityCoverage: null
    };
    nodes.push(node);

    const basisId = `basis_${nodeId}`;
    bases.push({
      id: basisId,
      sourceId: srcId,
      kind: 'direct_evidence',
      anchor: nodeId,
      bindingId: fingerprint(`basis:${nodeId}`)
    });

    const semanticRole = family === 'canonical' ? 'canonical_assertion'
      : family === 'micro' ? 'micro_event'
      : family === 'state' ? 'state_current'
      : 'lore_rule';

    const bindingId = fingerprint(`${nodeId}:${unitDef.text}`);
    const unit = {
      nodeId,
      bindingId,
      family,
      kind: family,
      semanticRole,
      turn: Number.isSafeInteger(unitDef.turn) ? unitDef.turn : 1,
      text: String(unitDef.text || ''),
      recordKey: unitDef.recordKey || nodeId,
      mandatoryInclusion: Boolean(unitDef.mandatoryInclusion),
      lifecycleStatus: unitDef.lifecycleStatus || 'active',
      worldlineId: unitDef.worldlineId || worldlineId,
      viewerId: unitDef.viewerId || null,
      visibility: unitDef.visibility || 'public',
      subjectId: unitDef.subjectId || null,
      activation: { alwaysActive: Boolean(unitDef.mandatoryInclusion) },
      locator: unitDef.locator || null,
      correspondenceProof: unitDef.correspondenceProof ? JSON.parse(JSON.stringify(unitDef.correspondenceProof)) : null,
      score: 1.0
    };
    units.push(unit);
    return { node, unit };
  };

  // Add all four families
  (corpus.canonical || []).forEach((u, i) => addUnitNode(u, 'canonical', i));
  (corpus.micro || []).forEach((u, i) => addUnitNode(u, 'micro', i));
  (corpus.state || []).forEach((u, i) => addUnitNode(u, 'state', i));
  (corpus.lore || []).forEach((u, i) => addUnitNode(u, 'lore', i));

  for (const entity of corpus.entities || []) {
    nodes.push({ ...entity, layer: 'entity', kind: 'entity', validated: true, status: 'active',
      bindingId: fingerprint('entity:' + entity.id), identityCoverage: null });
  }
  // Only explicit fixture relationships may propagate activation.
  for (const [i, relation] of (corpus.edges || []).entries()) {
    const from = nodes.find(n => n.id === relation.from);
    const to = nodes.find(n => n.id === relation.to);
    if (from && to) {
      const edgeId = `edge_${from.id}_${to.id}`;
      edges.push({
        id: edgeId,
        from: from.id,
        to: to.id,
        predicate: relation.predicate || 'corroborates',
        basisId: `basis_${from.id}`,
        bindingId: fingerprint(`edge:${edgeId}`),
        identityCoverage: null
      });
    }
  }

  return {
    schema: 'libra.memory_graph_projection.v1',
    scopeKey,
    readerFrame: {
      owner: 'libra:plugin_only',
      scopeKey,
      worldlineId,
      restoreEpoch,
      view: {
        viewerId,
        temporalView: 'current_owner_page',
        cutoffTurn: Number.isSafeInteger(queryDef.asOfTurn) ? queryDef.asOfTurn : null
      }
    },
    coverage: {
      scope: 'owner_reader_page',
      inventory: {},
      identity: 'revision_bound',
      families: {
        canonical: { records: corpus.canonical?.length || 0, units: corpus.canonical?.length || 0, reasons: [] },
        micro: { records: corpus.micro?.length || 0, units: corpus.micro?.length || 0, reasons: [] },
        state: { records: corpus.state?.length || 0, units: corpus.state?.length || 0, reasons: [] },
        lore: { records: corpus.lore?.length || 0, units: corpus.lore?.length || 0, reasons: [] }
      }
    },
    nodes,
    edges,
    bases,
    units
  };
};

const createEngineSuite = (fingerprint = sha256) => {
  const pages = createMemoryGraphPages({ fingerprint });
  const index = createMemoryGraphIndex({ pages, fingerprint });
  const lane = createMemoryGraphLane({ index, pages });
  const query = createMemoryGraphQuery({ index, lane, pages, fingerprint });
  const compiler = createMemoryGraphCompiler({ fingerprint });
  const rollout = createMemoryGraphRollout({ index, lane, query, compiler, pages, fingerprint });
  const resources = createMemoryGraphResources({
    measure: pages.measure,
    encodedSize: pages.encodedSize,
    stageCost: pages.stageCost
  });
  return { pages, index, lane, query, compiler, rollout, resources };
};

const evaluateScenario = async (caseDef, suite = createEngineSuite()) => {
  const graph = buildGraphFromCorpus(caseDef);
  const seal = suite.rollout.sealRequestMode({
    mode: 'unified',
    requestId: `eval-${caseDef.id}-${Date.now().toString(36)}`,
    owner: graph.readerFrame.owner,
    scopeKey: graph.scopeKey,
    worldlineId: graph.readerFrame.worldlineId,
    restoreEpoch: graph.readerFrame.restoreEpoch
  });

  const queryDef = caseDef.query || {};
  const expected = caseDef.expected || {};
  const forbidden = caseDef.forbidden || {};
  const passCriteria = caseDef.passCriteria || {};

  // Reject unsupported declarations instead of silently awarding a pass.
  const allowedExpected = new Set(['goldNodeIds','requiredFamilies','deliveryOutcome','modelDispatchEligible',
    'suppressedMicroNodeIds','maxAdmittedUnits','hasDroppedUnits']);
  const allowedCriteria = new Set(['minGoldRecall','maxForbiddenFound','maxAdmittedUnits','maxCharactersStrict','mustAbsorbMicro']);
  for (const [group, value, allowed] of [['expected',expected,allowedExpected], ['passCriteria',passCriteria,allowedCriteria]]) {
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error('LIBRA_EVAL_UNSUPPORTED_CRITERION:' + group + '.' + key);
  }
  for (const key of ['goldNodeIds','requiredFamilies','suppressedMicroNodeIds']) {
    if (expected[key] !== undefined && (!Array.isArray(expected[key]) || expected[key].some(x => typeof x !== 'string' || !x))) throw new Error('LIBRA_EVAL_EXPECTATION_INVALID:' + key);
  }
  for (const key of ['hasDroppedUnits','modelDispatchEligible']) {
    if (expected[key] !== undefined && typeof expected[key] !== 'boolean') throw new Error('LIBRA_EVAL_EXPECTATION_INVALID:' + key);
  }
  if (expected.deliveryOutcome !== undefined && typeof expected.deliveryOutcome !== 'string') throw new Error('LIBRA_EVAL_EXPECTATION_INVALID:deliveryOutcome');
  for (const [key,value] of Object.entries(passCriteria)) {
    if (key === 'mustAbsorbMicro' ? typeof value !== 'boolean' : !Number.isFinite(value) || value < 0
      || (key === 'minGoldRecall' ? value > 1 : !Number.isSafeInteger(value))) throw new Error('LIBRA_EVAL_CRITERION_INVALID:' + key);
  }
  if (expected.maxAdmittedUnits !== undefined && (!Number.isSafeInteger(expected.maxAdmittedUnits) || expected.maxAdmittedUnits < 0)) throw new Error('LIBRA_EVAL_EXPECTATION_INVALID:maxAdmittedUnits');
  const queryInput = {
    queryText: queryDef.queryText || '', asOfTurn: queryDef.asOfTurn,
    viewerId: queryDef.viewerId || 'owner_reader', worldlineId: queryDef.worldlineId || 'main',
    excludedNodeIds: queryDef.excludedNodeIds || [],
    allowedPredecessorWorldlines: queryDef.allowedPredecessorWorldlines || [],
    entityIds: queryDef.entityIds || [], predicates: queryDef.predicates || [],
    queryVectors: queryDef.vectorlessMode ? {} : queryDef.queryVectors || {},
    semanticSpace: queryDef.vectorlessMode ? null : queryDef.semanticSpace || null,
    queryEmbedding: queryDef.vectorlessMode ? null : queryDef.queryEmbedding || null,
    documentRepresentations: queryDef.vectorlessMode ? {} : queryDef.documentRepresentations || {}
  };

  const consumerPolicy = queryDef.consumerPolicy || { consumer: 'classic', maxCharacters: 4096, maxUnits: 10 };
  const ownerVerifier = {
    currentGraph: async () => graph,
    assertPhysicalCurrentness: async () => true,
    verifyGradiaReceipt: async () => true
  };

  const resSession = suite.resources.open({});
  let unifiedResult;
  try {
    unifiedResult = await suite.rollout.executeUnifiedRequest({
      sealToken: seal,
      graph,
      queryInput,
      consumerPolicy,
      ownerVerifier,
      resources: resSession
    });
  } finally {
    resSession.close();
  }

  const admittedItems = unifiedResult.bundle?.items || [];
  const admittedNodeIds = new Set(admittedItems.map(item => item.nodeId));
  const renderedText = unifiedResult.packet?.renderedText || '';

  // 1. Gold Evidence Recall
  const goldNodeIds = expected.goldNodeIds || [];
  const goldFound = goldNodeIds.filter(id => admittedNodeIds.has(id));
  const goldRecall = goldNodeIds.length ? goldFound.length / goldNodeIds.length : 1.0;

  // 2. Forbidden Evidence Detection
  const forbiddenNodeIds = forbidden.forbiddenNodeIds || [];
  const forbiddenTokens = forbidden.forbiddenTokens || [];
  const leakedNodeIds = forbiddenNodeIds.filter(id => admittedNodeIds.has(id));
  const leakedTokens = forbiddenTokens.filter(tok => renderedText.includes(tok));
  const totalForbiddenLeaks = leakedNodeIds.length + leakedTokens.length;

  // 3. Suppressed Micro Check
  const expectedSuppressedMicro = expected.suppressedMicroNodeIds || [];
  const actualSuppressedMicro = unifiedResult.bundle?.suppressedMicroIds || [];
  const suppressedMicroPass = expectedSuppressedMicro.every(id => actualSuppressedMicro.includes(id));

  // 4. Budget & Character Check
  const maxAdmittedUnits = passCriteria.maxAdmittedUnits ?? expected.maxAdmittedUnits;
  const unitsBudgetPass = maxAdmittedUnits != null ? admittedItems.length <= maxAdmittedUnits : true;
  const maxCharactersStrict = passCriteria.maxCharactersStrict;
  const charBudgetPass = maxCharactersStrict != null ? renderedText.length <= maxCharactersStrict : true;

  // 5. Model Dispatch Eligibility Check
  const expectedDispatch = expected.modelDispatchEligible !== false;
  const dispatchPass = unifiedResult.modelDispatchEligible === expectedDispatch;

  // The control runs through the SAME engine, eligibility frame and compiler policy.
  // It disables semantic/entity/predicate seeds and graph expansion in the query kernel.
  const lexicalResources = suite.resources.open({});
  let lexicalResult;
  try {
    lexicalResult = await suite.rollout.executeUnifiedRequest({
      sealToken: suite.rollout.sealRequestMode({ mode: 'unified', requestId: 'ablation-' + caseDef.id,
        owner: graph.readerFrame.owner, scopeKey: graph.scopeKey, worldlineId: graph.readerFrame.worldlineId, restoreEpoch: 0 }),
      graph, queryInput: { ...queryInput, ablationMode: 'lexical_only' }, consumerPolicy, ownerVerifier, resources: lexicalResources
    });
  } finally { lexicalResources.close(); }
  const lexicalCandidates = (lexicalResult.bundle?.items || []).map(item => item.nodeId);
  const fullCandidates = admittedItems.map(item => item.nodeId);
  const overlapCount = fullCandidates.filter(id => lexicalCandidates.includes(id)).length;
  const ablationOverlap = fullCandidates.length ? overlapCount / fullCandidates.length : 1.0;
  const droppedUnits = unifiedResult.bundle?.budget?.droppedUnits || 0;
  const admittedFamilies = [...new Set(admittedItems.map(item => item.family))];
  const checks = {
    goldRecall: goldRecall >= (passCriteria.minGoldRecall ?? 1),
    forbiddenEvidence: totalForbiddenLeaks <= (passCriteria.maxForbiddenFound ?? 0),
    suppressedMicro: suppressedMicroPass,
    expectedUnits: expected.maxAdmittedUnits === undefined || admittedItems.length <= expected.maxAdmittedUnits,
    unitsBudget: unitsBudgetPass,
    characterBudget: charBudgetPass,
    dispatch: dispatchPass,
    deliveryOutcome: expected.deliveryOutcome === undefined || unifiedResult.deliveryOutcome === expected.deliveryOutcome,
    requiredFamilies: (expected.requiredFamilies || []).every(family => admittedFamilies.includes(family)),
    hasDroppedUnits: expected.hasDroppedUnits === undefined || (droppedUnits > 0) === expected.hasDroppedUnits,
    microAbsorption: !passCriteria.mustAbsorbMicro || expectedSuppressedMicro.length > 0 && suppressedMicroPass
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    caseId: caseDef.id,
    label: caseDef.label,
    category: caseDef.category,
    passed,
    checks,
    metrics: {
      goldNodeIds,
      goldFound,
      goldRecall,
      leakedNodeIds,
      leakedTokens,
      totalForbiddenLeaks,
      admittedUnits: admittedItems.length,
      admittedNodeIds: [...admittedNodeIds], admittedFamilies, droppedUnits,
      renderedCharacterLength: renderedText.length,
      suppressedMicroPass,
      modelDispatchEligible: unifiedResult.modelDispatchEligible,
      deliveryOutcome: unifiedResult.deliveryOutcome,
      ablation: {
        status: 'measured_synthetic_fixture', stage: 'admitted_bundle', mode: 'lexical_only',
        lexicalNodeIds: lexicalCandidates, fullNodeIds: fullCandidates,
        lexicalCandidateCount: lexicalCandidates.length,
        fullCandidateCount: fullCandidates.length,
        overlapRatio: ablationOverlap
      }
    }
  };
};

const runEvaluationSuite = async (options = {}) => {
  const cases = options.cases || loadCases(options.casesPath);
  const suite = createEngineSuite();
  const startedAt = Date.now();
  const results = [];

  for (const caseDef of cases) {
    const outcome = await evaluateScenario(caseDef, suite);
    results.push(outcome);
  }

  const passedCount = results.filter(r => r.passed).length;
  const avgRecall = results.reduce((acc, r) => acc + r.metrics.goldRecall, 0) / (results.length || 1);
  const totalLeaks = results.reduce((acc, r) => acc + r.metrics.totalForbiddenLeaks, 0);

  return {
    schema: 'libra.unified_memory_evaluation_result.v1',
    evaluationVersion: 2,
    evidenceScope: 'synthetic_kernel_fixtures_not_native_owner_or_production_acceptance',
    timestamp: new Date().toISOString(),
    wallMs: Date.now() - startedAt,
    totalCases: results.length,
    passedCases: passedCount,
    failedCases: results.length - passedCount,
    allPassed: passedCount === results.length,
    summaryMetrics: {
      averageGoldRecall: avgRecall,
      totalForbiddenLeaks: totalLeaks,
      allDispatchEligibleAsExpected: results.every(r => r.checks.dispatch)
    },
    results
  };
};

if (require.main === module) {
  (async () => {
    try {
      const suiteResult = await runEvaluationSuite();
      console.log(JSON.stringify(suiteResult, null, 2));
      if (!suiteResult.allPassed) {
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  loadCasesBundle,
  loadCases,
  loadEvalCases: loadCases,
  buildGraphFromCorpus,
  createEngineSuite,
  evaluateScenario,
  runEvaluationSuite
};
