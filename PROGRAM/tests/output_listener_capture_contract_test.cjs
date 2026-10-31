'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'plugins');
const libra = fs.readFileSync(path.join(root, 'LIBRA.js'), 'utf8');
const hayaku = fs.readFileSync(path.join(root, 'HAYAKU_Locator_Continuity.js'), 'utf8');
const flashback = fs.readFileSync(path.join(root, 'Flashback_Memory.js'), 'utf8');
const lia = fs.readFileSync(path.join(root, 'LIA_Persona_Linker.js'), 'utf8');

const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

// RisuAI 2026.8.240 official committed-output listener must be the preferred
// capture source in the three automatic output-sensitive plugins.
for (const [name, source] of [['LIBRA', libra], ['HAYAKU', hayaku], ['Flashback', flashback]]) {
  assert.match(source, /addRisuChatListener/,
    `${name}: official RisuAI chat output listener is present`);
  assert.match(source, /messageIndex\s*<\s*0/,
    `${name}: deleted/replaced output slot (-1) is guarded`);
  assert.match(source, /risu_chat_output/,
    `${name}: official committed-output provenance is recorded`);
}

// Listener callbacks themselves must not await storage, embedding, packet or
// LLM work because RisuAI awaits output listeners sequentially.
const libraRegister = between(libra, 'const registerOutputListener = async () => {', 'await registerOutputListener();');
assert.match(libraRegister, /addRisuChatListener\('output', handler\)/);
assert.match(libraRegister, /Promise\.resolve\(\)\.then\(\(\) => LibraMemoryCore\.captureCommittedOutputEvent\(event\)\)/);
assert.match(libraRegister, /state\.captureBackend = LIBRA_CAPTURE_BACKENDS\.CHAT_OUTPUT_V3;[\s\S]*?return true;[\s\S]*?const legacyApi/,
  'LIBRA returns after official registration before entering legacy fallback');
assert.match(libraRegister, /addRisuScriptHandler\('output', handler\)/,
  'LIBRA retains one fallback detector for pre-2026.8.240 hosts');

const hayakuAdapter = between(hayaku, 'const addChatOutputListener = async handler => {', 'const removeChatOutputListener = async () => {');
assert.match(hayakuAdapter, /Promise\.resolve\(\)\.then\(\(\) => handler\(event,\{observedAt,pairWitness\}\)\)/);
assert.match(hayakuAdapter, /await current\.addRisuChatListener\('output', wrapped\)/);

const flashbackRegister = between(flashback, 'const registerCaptureBackendOnce = async', 'const afterRequest = async');
assert.match(flashbackRegister, /Promise\.resolve\(\)\.then\(async \(\) => \{/);
assert.match(flashbackRegister, /const result = await processRisuChatOutputEvent\(event\)/);
assert.match(flashbackRegister, /result\?\.captured[\s\S]*?result\?\.duplicates/,
  'Flashback marks the official output backend healthy only after a captured or proven-duplicate result');
assert.match(flashbackRegister, /await live\.addRisuChatListener\('output', handler\)/);
assert.match(flashbackRegister, /addRisuScriptHandler\('output', processLegacyScriptOutputCapture\)/,
  'Flashback keeps a script-output legacy backend');
assert.match(flashbackRegister, /FLASHBACK_CAPTURE_BACKENDS\.AFTER_REQUEST_RECONCILE/,
  'Flashback keeps afterRequest live-chat reconciliation as final fallback');

// LIBRA: one logical U+A is revisioned across auto-continue. Five-turn work may
// start from a committed revision, but commit must re-check the exact original
// chat and revision so a superseded partial T5 cannot become canonical.
const libraCapture = between(libra, 'const captureCommittedOutputEvent = async eventValue => {', 'const scheduleScan = (options = {}) => {');
assert.match(libraCapture, /outputTurnRevisions\.get\(turnKey\)/);
assert.match(libraCapture, /revision\s*=\s*Math\.max\(0,\s*Number\(previous\?\.revision\s*\|\|\s*0\)\s*\|\|\s*0\)\s*\+\s*1/);
assert.match(libraCapture, /contentHash/);
assert.match(libra, /const outputRevisionStillCurrent =/);
assert.match(libra, /output_revision_superseded/);
assert.match(libra, /getCharacterFromIndex/);
assert.match(libra, /getChatFromIndex/);
assert.match(libra, /captureSource \|\| ''\) === 'risu_chat_output'[\s\S]*?refreshBoundOutputContext\(capturedContext\)/,
  'LIBRA refreshes the exact originating chat before scheduled boundary analysis so post-output IGP drift is included');

// HAYAKU: official output revisions have the highest packet capture priority.
// The exact-identity finalized binding monitor runs after durable capture, so
// a completed response becomes active without requiring another user request.
assert.match(hayaku, /captureSource === 'risu_chat_output' \? 4/);
const hayakuCapture = between(hayaku, 'const processRisuChatOutputEvent = async (eventValue,observation={}) => {', 'const install = async');
assert.match(hayakuCapture, /chatOutputTurnRevisions\.get\(logicalKey\)/);
assert.match(hayakuCapture, /persistCapturedPackets\(pending, candidate\.packets, 'risu_chat_output'/);
assert.match(hayakuCapture, /scheduleFinalizedBindingMonitor\(pending,[\s\S]*?packetGroupComplete:/);
assert.doesNotMatch(hayakuCapture, /deferToBeforeRequest:\s*true/);
assert.match(hayaku, /Memory\.captureBackend !== HAYAKU_CAPTURE_BACKENDS\.CHAT_OUTPUT_V3\) scheduleFinalizedCaptureMonitor/,
  'HAYAKU long finalization polling is fallback-only');

// Flashback: each committed output revision is durable hash-first/provisional,
// never remotely embedded while it may still be superseded. The next live-chat
// reconciliation finalizes the latest revision and only then upgrades vectors.
const flashbackCapture = between(flashback, 'const processRisuChatOutputEvent = async eventValue => {', 'const processLegacyScriptOutputCapture = content =>');
assert.match(flashbackCapture, /chatOutputTurnRevisions\.get\(turnKey\)/);
assert.match(flashbackCapture, /provisional:\s*true,\s*captureSource:\s*'risu_chat_output'/);
assert.match(flashbackCapture, /remoteEmbeddingQueued:\s*false/);
const flashbackSave = between(flashback, 'const saveFinalizedChatCapture = async', 'const finalizedCaptureReconciliation = (');
// 2026-10-31: provisional captures are embedded early (still excluded from recall
// until confirmed); hosts without live confirmation otherwise never embedded them.
assert.match(flashbackSave, /remoteUpgradeQueued = schedulePendingEmbeddingWork\(scope\.scopeKey, \{ reason: provisional \? 'provisional_capture' : 'finalized_capture' \}\)/,
  'provisional and finalized captures both queue embedding work');
const flashbackAfter = between(flashback, 'const afterRequest = async', 'const registerRequestHooksOnce = async');
assert.match(flashbackAfter, /if \(Runtime\.captureBackend !== FLASHBACK_CAPTURE_BACKENDS\.AFTER_REQUEST_RECONCILE\)[\s\S]*?return content;/,
  'afterRequest only captures when the selected fallback backend owns capture');


// LiA is manual-only. Its actual selected five-pair action must still guard
// source revisions and serialized Persona mutation; the official output listener
// only offers a consent notice and never starts automatic Persona work. The
// image-AI emotion-asset afterRequest hook was retired (no replacer remains).
const liaCaptureRegistration=between(lia,'async function registerLiveSyncCaptureBackend() {','async function unregisterUiRegistration(');
assert.match(liaCaptureRegistration,/liveSyncCaptureBackend = LIVE_SYNC_CAPTURE_BACKENDS\.NONE/);
assert.match(liaCaptureRegistration,/liveSyncCaptureFallbackReason = "manual_only_notification"/);
assert.doesNotMatch(liaCaptureRegistration,/addRisuScriptHandler|addRisuReplacer|runManualLivePersonaAnalysis|runLiaMockupAction/);
assert.match(liaCaptureRegistration,/liveSyncOutputListener=event=>\{void maybeNotifyLiaUpdate\(event\)/);
assert.equal((liaCaptureRegistration.match(/addRisuChatListener\(/g)||[]).length,1);
assert.match(liaCaptureRegistration,/addRisuChatListener\("output",liveSyncOutputListener\)/);
const liaNotice=between(lia,'async function maybeNotifyLiaUpdate(event) {','async function initializePersonaProofExperience(');
const noticeAt=liaNotice.indexOf('const approved=await showLiaUpdateNotice(');
const approvalGate=liaNotice.indexOf('if(!approved||pluginUnloaded)');
const actionAt=liaNotice.indexOf("runLiaMockupAction('update-five'");
assert(noticeAt>=0&&approvalGate>noticeAt&&actionAt>approvalGate,'manual update runs only after explicit consent');
assert.equal((liaNotice.match(/runLiaMockupAction\(/g)||[]).length,1);
assert.match(liaNotice,/liaExpectedUpdateMatches\(fresh,expected\)/,'consented range is rechecked before the guarded manual action');
assert.match(lia,/removeRisuChatListener\("output", liveSyncOutputListener\)/);
const liaManual=between(lia,'async function runManualLivePersonaAnalysis(expectedCtx = null) {','\n  function ');
assert.match(liaManual,/livePersonaBatchRevisionSnapshot\(runtimeCtx, batch\)/);
assert.match(liaManual,/verifyLivePersonaBatchStillCurrent\(sourceRevision\)/);
assert.match(liaManual,/commitGuard: guard, commitSelectionGuard, commitFence/);
assert.match(liaManual,/LIVE_SYNC_SOURCE_SUPERSEDED_CODE/);
assert.doesNotMatch(lia,/handlePersonaEmotionAssetAfterRequest|addRisuReplacer\(\s*["']afterRequest/);
assert.doesNotMatch(lia,/LIVE_SYNC_POLL_MS|liveSyncTimer/);

// Unload/hot-reload must detach the new listener so reinstall cannot double capture.
assert.match(libra, /removeRisuChatListener/);
assert.match(hayaku, /removeRisuChatListener/);
assert.match(flashback, /removeRisuChatListener/);
assert.match(lia, /removeRisuChatListener/);
assert.match(lia, /removeRisuScriptHandler/);

process.stdout.write('output_listener_capture_contract_test: PASS\n');
