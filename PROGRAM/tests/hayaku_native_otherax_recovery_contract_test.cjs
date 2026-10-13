'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const hayaku = fs.readFileSync(path.join(root, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8').replace(/\r\n/g, '\n');
const retrace = fs.readFileSync(path.join(root, 'plugins', 'RETRACE.js'), 'utf8');

const requireText = (source, text, label) => {
  assert.ok(source.includes(text), `${label}: missing ${JSON.stringify(text)}`);
};
const forbidText = (source, text, label) => {
  assert.ok(!source.includes(text), `${label}: unexpected ${JSON.stringify(text)}`);
};
const section = (source, start, end, label) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${label}: section markers not found`);
  return source.slice(from, to);
};

const version=hayaku.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1];
assert.ok(version, 'HAYAKU semantic version');
requireText(hayaku, `const PLUGIN_VERSION = '${version}';`, 'HAYAKU header/runtime version parity');
requireText(hayaku, "? '채팅 범위 미확인'", 'compact unavailable-chat status text');
requireText(hayaku, 'data-hayaku-viewer-panel="recovery"', 'canonical Recovery destination');
requireText(hayaku, 'data-recovery-view="missing"', 'canonical missing-turn subview');
requireText(hayaku, 'id="runHayakuNativeRepair" class="btn btn--primary"', 'manual repair action uses the canonical button component');
requireText(hayaku, 'id="runHayakuNativeColdStart" class="btn btn--primary"', 'Cold Start action uses the canonical button component');
requireText(retrace, releaseText('//@version {retrace}'), 'RE:TRACE version');
requireText(retrace, releaseText("const PLUGIN_VERSION = '{retrace}';"), 'RE:TRACE runtime version');

// Long-chat optimization must be exact and per-message rather than a sampled
// transcript probe. Existing hashes and durable ledger schema stay unchanged.
requireText(hayaku, 'const messageRevisionProjection = (message, index = -1, scopeKeyInput = \'\', options = {}) => {', 'message revision cache');
requireText(hayaku, 'const authoritativeChatSnapshot =', 'exact owner snapshot');
requireText(hayaku, 'const invalidateMessageRevisionCache = (scopeKeyInput = \'\', options = {}) => {', 'targeted cache invalidation');
requireText(hayaku, 'finalizeMessageRevisionScopeObservation(scope?.key || \'\', seenRevisionKeys);', 'rollback pruning');
requireText(hayaku, 'const topologyHash = compact(turnTopologySnapshotHash(snapshot), 96);', 'exact topology gate');
requireText(hayaku, "reason: 'topology_unchanged'", 'unchanged topology short circuit');
requireText(hayaku, "const STORAGE_LEDGER_VERSION = 'hayaku_storage_ledger_v2';", 'ledger format invariant');
requireText(hayaku, "const stableHash64 = (value = '') => {", 'stableHash64 invariant');
forbidText(hayaku, 'worldlineObserverTextProbe', 'sampled observer fingerprint is retired');

// Main RP output always authors one current packet. Legacy recovery packet read
// compatibility remains, but response-level in-band recovery writing is disabled.
requireText(hayaku, 'const IN_BAND_RECOVERY_WRITE_ENABLED = false;', 'in-band recovery switch');
const regularRuntime=section(hayaku,'const buildPacketRuntimeSkeletonInstruction =','const packetCoreRecallRows =','regular packet runtime');
requireText(regularRuntime,"packet_type:'current_snapshot'",'runtime metadata current-only');
forbidText(regularRuntime,"packet_type:'recovery_snapshot'",'regular runtime never requests in-band recovery');
requireText(hayaku, 'Emit exactly one current_snapshot packet; never omit it', 'current-only prompt');
requireText(hayaku, "IN_BAND_RECOVERY_WRITE_ENABLED && pending?.recoveryRequired === true", 'capture contract compatibility gate');
requireText(hayaku, "const afterRequestRecovery = kind === 'after_request_recovery';", 'afterRequest recovery kind discriminator');
requireText(hayaku, "const packetType = afterRequestRecovery ? 'current_snapshot' : incremental ? 'recovery_snapshot' : 'cold_start_snapshot';", 'internal recovery packet type');

// Native repair/cold-start must use only the official RisuAI Other Ax requester.
const nativeTransport = section(hayaku, 'const runNativeOtherAx = async (messages, options = {}) => {', 'const HAYAKU_AUXILIARY_PROBE_SCHEMA', 'native Other Ax transport');
requireText(hayaku, "add(API, 'captured_startup_api');", 'startup API retention');
requireText(hayaku, "for (const alias of RISU_API_ALIASES) push(globalThis[alias]);", 'OFF THE SCREEN API alias parity');
requireText(nativeTransport, 'api.runLLMModel({', 'official LLM requester');
requireText(nativeTransport, "mode: 'otherAx'", 'Other Ax mode');
requireText(nativeTransport, 'allowPlugins', 'plugin-provider setting reaches the host call');
requireText(nativeTransport, 'enqueueNativeOtherAxCall', 'serialized physical-call queue');
requireText(hayaku, "readArg('risuai_aux_allow_plugins', '')", 'shared auxiliary plugin-model argument');
const runCall = section(nativeTransport, 'response = await api.runLLMModel({', '});\n        } catch', 'runLLMModel call');
forbidText(runCall, 'staticModel:', 'HAYAKU must not select a model');
forbidText(nativeTransport, 'nativeFetch(', 'HAYAKU must not own provider transport');
forbidText(nativeTransport, 'apiKey', 'HAYAKU must not own API keys');
const auxiliaryProbe = section(hayaku, "const HAYAKU_AUXILIARY_PROBE_SCHEMA = 'hayaku.otherax_call_probe.v1';", 'const nativeMessageRole = message => {', 'auxiliary model call probe');
requireText(auxiliaryProbe, 'await runNativeOtherAx([', 'probe reuses native Other Ax transport');
requireText(auxiliaryProbe, 'writesCanonicalMemory: false', 'probe canonical memory write denial');
requireText(auxiliaryProbe, 'writesPacketLedger: false', 'probe packet ledger write denial');
forbidText(auxiliaryProbe, 'setTimeout(', 'probe must not synthesize a timeout');
forbidText(auxiliaryProbe, 'for (', 'probe must not retry provider calls');
requireText(hayaku, "reason: 'auxiliary_probe_in_progress'", 'probe and recovery overlap guard');
requireText(hayaku, "outcome: 'auxiliary_probe_in_progress'", 'probe and afterRequest overlap guard');
requireText(hayaku, "const HAYAKU_AUXILIARY_PROBE_SCHEMA = 'hayaku.otherax_call_probe.v1';", 'session-only auxiliary probe backend contract');
requireText(hayaku, 'id="ax-test"', 'the canonical Settings page retains the one-call probe control');
requireText(hayaku, "root.querySelector?.('#ax-test')?.addEventListener('click', async event =>", 'the canonical probe control remains bound to the existing backend');
forbidText(hayaku, 'id="testHayakuAuxiliaryModel"', 'retired pre-mockup auxiliary probe button selector');
requireText(hayaku, 'nativeOtherAxCallProbeV1: true', 'probe capability');

const nativeWorker = section(hayaku, 'const executeNativeAnalysisAttempt = async (kind, chunk, context = {}) => {', 'const nativeRepairRunSnapshot = () => ({', 'native analysis worker');
requireText(nativeWorker, "{ mode: 'primary', system: prompts.primary }", 'primary attempt');
requireText(nativeWorker, "{ mode: 'repair', system: '' }", 'diagnostic repair attempt');
requireText(nativeWorker, 'nativeAnalysisRepairPromptWithFailure(prompts.repair', 'repair receives concrete failure report');
requireText(nativeWorker, 'const extraCalls=(context.extraCalls ?? (await loadSettings()).recoveryExtraCalls)===1 ? 1 : 0;', 'explicit-only additional attempt');
requireText(nativeWorker, 'maxRequests:1+extraCalls', 'one shared physical-call cap');
requireText(nativeWorker, 'validateNativeRepairEnvelopeShape(candidate)', 'strict recovery transport envelope');
requireText(nativeWorker, 'prepareNativePacketRecords(shape.packet,kind,chunk,context,candidate)', 'source-grounded item admission receives the actual envelope');
const itemAdmission=section(hayaku,'const admitHayakuPacketRecords =','const prepareNativePacketRecords =','shared item admission');
requireText(itemAdmission,'validateNativeRepairGrounding(', 'item evidence is verified');
requireText(itemAdmission,"kind === 'regular' && context.groundingMode === 'optional_items'",'native envelopes retain mandatory coverage');
requireText(nativeWorker, 'validateNativeRepairCoverage(normalized.packet', 'source coverage validation');
requireText(nativeWorker, "nativeRepairTransportFailure(error)", 'no duplicate provider call on transport failure');
requireText(nativeWorker, "llm?.completionEnvelope?.state!=='complete'", 'known terminal required for structural repair');
forbidText(nativeWorker, 'raw_evidence_fallback', 'automatic repair must not synthesize raw fallback packets');

requireText(hayaku, 'const scanCurrentChatForNativeRecoveryDebts = async (options = {}) => {', 'native missing-turn scan');
requireText(hayaku, "const RECOVERY_EVIDENCE_MANIFEST_SCHEMA = 'hayaku.recovery_evidence_manifest.v1';", 'lossless recovery evidence manifest');
requireText(hayaku, 'const readVerifiedRecoveryEvidence = async', 'verified evidence readback');
forbidText(hayaku, '.slice(0, RECOVERY_VAULT_MAX_TURN_CHARS)', 'Recovery Vault canonical evidence must not truncate');
requireText(hayaku, "reason: 'evidence_over_request_budget'", 'oversized evidence routes to Failed Recovery without LLM');
// The approved failure-detail destination keeps source, raw response,
// diagnostics, candidate and history as five internal panels. These read-only
// evidence fields belong to its diagnostic panel, not a retired top-level page.
requireText(hayaku, 'data-subpanel="dx" data-group="hayakuFailureDetail" hidden><pre id="hayakuFailedRecoveryGroundingStatus"', 'failure grounding diagnostics remain in the diagnostic detail tab');
requireText(hayaku, 'id="hayakuFailedRecoveryEvidenceStatus"', 'failure evidence completeness remains readable');
requireText(hayaku, 'id="hayakuFailedRecoveryRequestStatus"', 'failure request budget remains readable');
requireText(hayaku, '|chunkKeys|', 'Portable Backup recovery sidecar dependency discovery');
requireText(hayaku, 'const recoveryCoverageProjection = ({ snapshot = {}, ledger = {}, activeRecords = [], checkedAt = now() } = {}) => {', 'owner-native recovery coverage');
requireText(hayaku, "schema: 'hayaku.recovery_coverage.v1'", 'recovery coverage schema');
requireText(hayaku, "debt?.coverage?.mode !== 'cold_start'", 'Cold Start and Packet Debt separation');
requireText(hayaku, 'nativeRecoveryStatus({ includeDebts: true, refreshDebts: true })', 'No-LLM status refresh scan');
for (const id of [
  'hayakuNativeCoverageSummary', 'hayakuNativeMissingTurns', 'hayakuNativeColdStartTurns',
  'hayakuNativeRepairableTurns', 'hayakuNativeBackoffTurns', 'hayakuNativeExhaustedTurns',
  'hayakuNativeLeasedTurns', 'hayakuNativeSuppressedTurns'
]) requireText(hayaku, `id="${id}"`, `recovery coverage UI ${id}`);
requireText(hayaku, 'const runNativeRepairSweep = async (options = {}) => {', 'native repair sweep');
requireText(hayaku, "reason: 'background_repair_confirmation_required'", 'background repair confirmation gate');
requireText(hayaku, 'const repairCurrentPacketInsideAfterRequest = async', 'afterRequest current packet repair');
requireText(hayaku, "maxPhysicalCalls: 1", 'afterRequest and background one-call cap');
requireText(hayaku, "mode: 'otherAx'", 'afterRequest recovery retains Other Ax transport');
requireText(hayaku, "outcome: 'candidate_returned_pending_commit'", 'afterRequest success waits for committed chat output');
requireText(hayaku, "pending.afterRequestRepair.outcome = 'committed_chat_output_verified';", 'chat output commit readback');
requireText(hayaku, 'const updateRecoveryJournalBackgroundDecision = async', 'durable Recovery Journal decision state');
requireText(hayaku, 'const requestRecoveryJournalBackgroundConfirmation = async', 'Recovery Journal confirmation scheduling');
requireText(hayaku, 'const resolveRecoveryJournalBackgroundConfirmationOnce = async', 'confirmation resolution');
requireText(hayaku, '패킷이 누락됐습니다. 자동 복구를 시도하시겠습니까?', 'user confirmation text');
requireText(hayaku, 'id="hayakuRecoveryConfirmationChoices"', 'confirmation controls');
requireText(hayaku, 'hayaku_after_request_auto_repair', 'independent afterRequest setting');
requireText(hayaku, 'hayaku_background_auto_repair', 'independent background setting');
requireText(hayaku, 'recoveryVaultEnabled: true', 'Recovery Journal preservation always enabled');
const legacyScheduler = section(hayaku, 'const scheduleNativeRepairSweep = (reason = \'event\'', 'const requestRecoveryJournalBackgroundConfirmation = async', 'legacy timer scheduler');
forbidText(legacyScheduler, 'setTimeout(', 'legacy scheduler must not start background model work');
requireText(hayaku, 'const startNativeColdStart = async (options = {}) => {', 'native cold start');
requireText(hayaku, 'const cancelNativeColdStart = () => {', 'cold-start cancellation');
requireText(hayaku, 'nativeColdStartChunkReusable', 'cold-start checkpoint reuse');
requireText(hayaku, 'nativeColdStartEvidenceCompatibility', 'cold-start source revalidation');
requireText(hayaku, 'const runNativeTargetedRegeneration = async (options = {}) => {', 'native targeted regeneration');
requireText(hayaku, 'replacementRecordIds', 'targeted replacement propagation');
requireText(hayaku, 'nativeTargetedRegeneration: true', 'targeted regeneration capability');
requireText(hayaku, 'nativeLegacyCheckpointTakeover: true', 'legacy checkpoint takeover capability');
requireText(hayaku, 'const readLegacyRetraceAutoRepairArtifact = async', 'legacy auto-repair takeover');
requireText(hayaku, "kind: 'assistant_only'", 'assistant-only cold-start evidence');
requireText(hayaku, 'systemContextText', 'system context cold-start support');
requireText(hayaku, 'promptContractHash', 'checkpoint prompt contract identity');
requireText(hayaku, "reason: 'candidate_worker_version_mismatch'", 'native candidate worker identity gate');
requireText(hayaku, "reason: 'candidate_prompt_contract_mismatch'", 'native candidate prompt identity gate');
requireText(hayaku, "reason: 'legacy_incremental_prompt_contract_mismatch'", 'legacy incremental prompt identity gate');
requireText(hayaku, 'adoptBridgeIncrementalRecoveryCapsule(capsule)', 'repair canonical adoption');
requireText(hayaku, 'adoptBridgeColdStartCapsule(capsule)', 'cold-start canonical adoption');
requireText(hayaku, 'adoption?.verified !== true || adoption?.durable !== true', 'durable adoption requirement');
requireText(hayaku, 'nativeOtherAxRepair: true', 'native repair capability');
requireText(hayaku, 'nativeColdStart: true', 'native cold-start capability');
requireText(hayaku, "repairOwner: 'hayaku'", 'HAYAKU repair ownership');
requireText(hayaku, 'inBandRecoveryWrite: false', 'in-band write retirement capability');
requireText(hayaku, 'const MEMORY_SESSION_BRIDGE_HAYAKU_ALLOWED_ACTIONS = new Set([', 'fixed HAYAKU IPC action allowlist');
requireText(hayaku, 'recoveryMutationIpc: false', 'recovery mutation IPC retirement capability');
requireText(hayaku, 'recoveryDebtLeaseIpc: false', 'recovery debt lease IPC retirement capability');
requireText(hayaku, 'legacyCapsuleAdoptionIpc: false', 'legacy adoption IPC retirement capability');
const hayakuIpc = section(hayaku, 'const registerMemoryBridgeIpc = async (allowRetry = true) => {', '\n  const expectedCapturePacketTypes = pending => (', 'HAYAKU IPC handler');
for (const retired of [
  "'adopt_cold_start'", "'adopt_incremental_recovery'", "'sync_analysis_capsules'",
  "'inspect_recovery_debts'", "'acquire_recovery_debt_lease'", "'release_recovery_debt_lease'",
  "'native_repair_sweep'", "'native_cold_start_start'", "'native_cold_start_cancel'",
  "'memory_suite_set_mode'"
]) forbidText(hayakuIpc, retired, `HAYAKU retired recovery IPC action: ${retired}`);
forbidText(hayakuIpc, 'syncBridgeAnalysisCapsules', 'HAYAKU inspect remains read-only');

// RE:TRACE no longer negotiates or initiates HAYAKU analysis. It keeps only
// owner presence, passive legacy migration/readback, viewer and handoff paths.
for (const retired of [
  'HAYAKU_COLD_START_PROMPT', 'HAYAKU_INCREMENTAL_RECOVERY_PROMPT',
  'analyzeBridgeEvidenceChunk', 'normalizeColdStartPacket', 'normalizeIncrementalRecoveryPacket',
  'bridgeHayakuPromptSet', 'retrace_hayaku_auto_repair', 'hayakuAutoRepairEnabled',
  'hayakuNativeRecoveryCapabilities', 'delegateHayakuNativeRepair', 'delegateHayakuNativeColdStart',
  'native_repair_sweep', 'native_cold_start_start', 'callProfile', 'DIRECT_PROVIDER_REGISTRY',
  'data-tab="coldstart"', 'data-tab="provider"', 'regenerateHayakuRecord',
  'requestImmediateHayakuColdStartAdoption', 'requestImmediateHayakuIncrementalRecoveryAdoption',
  "'adopt_cold_start'", "'adopt_incremental_recovery'", "'sync_analysis_capsules'"
]) forbidText(retrace, retired, `RE:TRACE HAYAKU analysis executor retired: ${retired}`);
requireText(retrace, 'probeLiveHayakuOwner', 'RE:TRACE authenticated HAYAKU owner probe remains');
requireText(retrace, 'readPendingColdStartCapsule', 'RE:TRACE legacy cold-start capsule reader remains');
requireText(retrace, 'HAYAKU exclusively owns Cold Start, missing-turn repair, targeted regeneration, Other Ax calls, worldline validation, and durable adoption.', 'RE:TRACE legacy capsule viewer remains passive');
requireText(retrace, 'purgeLegacyProviderCredentials', 'RE:TRACE exact-key legacy credential purge remains');
requireText(retrace, 'performPendingNextSessionHandoff', 'RE:TRACE handoff remains present');
requireText(retrace, 'sourceMutationAllowed: false', 'source-immutable handoff remains present');

console.log('PASS hayaku_native_otherax_recovery_contract_test');
