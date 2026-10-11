'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const source = fs.readFileSync(requestedPlugin ? path.resolve(requestedPlugin) : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const between = (a,b) => {
  const i=source.indexOf(a); assert.ok(i>=0, `missing ${a}`);
  const j=source.indexOf(b,i+a.length); assert.ok(j>i, `missing ${b}`);
  return source.slice(i,j);
};

assert.match(source, /var __LIBRA_NARRATIVE_STATE_SCHEMA = 'libra\.narrative_state\.v1'/);
assert.match(source, /const STATE_OBSERVATION_SCHEMA = 'libra\.state_observation\.v2'/);
assert.match(source,/const STAGE_ORDER = Object\.freeze\(\[LIBRARIAN_STAGE_ID\]\)/);
const memory=between('const executeUnifiedStage = async','const buildUnifiedStateCandidate =');
assert.match(memory,/LIBRARIAN_STAGE_ID/);assert.match(memory,/finalArtifact/);
const contract=between('const unifiedPromptContract =','const executeUnifiedStage =');
assert.match(contract,/thread/);assert.match(contract,/Resolved threads remain history/);
assert.match(contract,/Keep intentions and unresolved goals distinct from observed outcomes/);
const observer=between('const callStateObserver = async','const callStateVerifier = async');assert.match(observer,/retiredAnalyzerError/);assert.doesNotMatch(observer,/callProviderWithOperationBudget/);
const update = between('const applyVerifiedStateObservation =', 'const runStateTrackingAfterCommit = async');
assert.match(update, /narrative/);
assert.match(update, /reviewedThroughCanonical/);
assert.match(update, /changedThroughCanonical/);

const rebuild = between('const rebuildStateFromCanonicalChainUnlocked = async', 'const rebuildStateAfterCanonicalTransfer = async');
assert.match(rebuild, /STATE_PIPELINE_DOMAIN_HEAD_KEYS/,
  'canonical rebuild must advance each independent Current State domain');
assert.match(rebuild, /runStateTrackingAfterCommit\(\{[\s\S]*basisManifest/,
  'missing durable observations must be rebuilt through the independent State pipeline');
assert.match(rebuild, /persistStateReplayHead\(\{[\s\S]*correctionJournal/,
  'canonical rebuild must persist the Current Head through the correction-aware replay seam');

const stateRun = between('const runStateTrackingAfterCommit = async', 'const processBatch = async');
assert.match(stateRun,/runUnifiedStateAfterCommit/);
assert.match(stateRun,/normalObserverDispatch:0/);
assert.match(stateRun, /Promise\.allSettled|\.catch\s*\(/,
  'Narrative failure must not block other state domains or canonical commit');

assert.match(source, /text: '현재까지 실제로 성립한 이야기'/);
const narrativeUi=between('const buildWorldManagerNarrativePanel =','const stateTrackingSettingsForGui =');
assert.match(narrativeUi,/buildWorldManagerNarrativeCurrentPanel/);
assert.doesNotMatch(narrativeUi,/buildLibraHubTabs|buildWorldManagerHistoryCorrectionsPanel/,'Narrative details must be unified without diagnostics');
assert.match(source, /async getWorldManagerNarrative\(\)/);
assert.match(source, /async addWorldManagerNarrativeCorrection/);
assert.match(source, /async rebuildWorldManagerNarrative/);

const response = between('const getUnifiedResponseContext=async', 'let latestRecallPublicationOwner =');
assert.match(response,/loadContinuityStateForResponse/,'public context reads the current durable State');
assert.match(response,/narrative_state:__libraCompletionUnwrapNarrative\(head\)/,'public context carries Current Narrative');
assert.match(response,/attachUnifiedResponseContext/,'the supplied State is sealed as a request-local context');
assert.doesNotMatch(response, /applyVerifiedStateObservation|updateContinuityStateAfterCommit|storage\.setJson\([^)]*continuityState/,
  'read-only public Narrative consumption never mutates Current State');

console.log('libra_world_manager_narrative_v1_contract_test: PASS');
