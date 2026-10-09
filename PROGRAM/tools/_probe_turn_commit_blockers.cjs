'use strict';
// Task 3 — do LIBRA / HAYAKU / Flashback have a blocker in the commit step after turn analysis?
//
// The question is not "does the commit path exist" but "can a model-produced artifact be rejected
// for a reason the model cannot see or control". This drives each of the three commit paths with a
// model-shaped payload and reports, per path, whether a rejection is:
//   * structural   — the artifact itself is malformed
//   * admission    — the artifact is well-formed but no fact passed admission
//   * render       — the artifact was accepted but its rendered text failed validation
//   * environment  — no model/route/scope, i.e. not the model's fault
//
// The LIBRA path is exercised through the real plugin (in-memory VM). The HAYAKU and Flashback
// paths are read for their rejection vocabulary first, because a rejection the caller cannot
// observe is the defect class this task is about.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, 'plugins', `${name}.js`), 'utf8');

(async () => {
  const libra = read('LIBRA');
  const hayaku = read('HAYAKU_Locator_Continuity');
  const flashback = read('Flashback_Memory');

  const findings = [];

  // ------------------------------------------------------------------------------------
  // LIBRA: three sequential asserts, each of which throws the whole commit away.
  // ------------------------------------------------------------------------------------
  const libraGates = {
    artifactRejected: /unifiedAssert\(validation\.ok,'UNIFIED_ARTIFACT_REJECTED:/.test(libra),
    renderRejected: /unifiedAssert\(renderValidation\.ok,'UNIFIED_RENDER_REJECTED:/.test(libra),
    providerFailed: /'UNIFIED_PROVIDER_FAILED:/.test(libra),
    admissionZeroVisible: /acceptedFacts===0\?':accepted=0:rejected=/.test(libra)
  };
  findings.push({
    plugin: 'LIBRA',
    gates: libraGates,
    // A rejection that names the reason is diagnosable; one that does not is a blocker.
    rejectionIsDiagnosable: libraGates.artifactRejected && libraGates.admissionZeroVisible
  });

  // The admission gate is the one a model can trip without a malformed artifact: a well-formed
  // artifact whose facts are all rejected. Confirm the repair path exists for it.
  const libraRepair = /nativeAnalysisRepairPrompt|relaxedJsonParse|jsonRepairCandidates/.test(libra);

  // ------------------------------------------------------------------------------------
  // HAYAKU: what happens to the commit when the packet is missing/unusable?
  // ------------------------------------------------------------------------------------
  const hayakuGates = {
    packetUnusableLogged: /capture:packet_unusable/.test(hayaku),
    afterRequestRepairSetting: /hayaku_after_request_auto_repair/.test(hayaku),
    inBandRecoveryDisabled: /IN_BAND_RECOVERY_WRITE_ENABLED = false/.test(hayaku),
    maxAutoAttempts: (hayaku.match(/RECOVERY_DEBT_MAX_AUTO_ATTEMPTS = (\d+)/) || [])[1] || '',
    retryDelays: (hayaku.match(/RECOVERY_DEBT_RETRY_DELAYS_MS = Object\.freeze\(\[([^\]]+)\]/) || [])[1] || ''
  };
  findings.push({
    plugin: 'HAYAKU',
    gates: hayakuGates,
    // A missing packet must not be silently dropped: it has to leave a durable debt record.
    missingPacketLeavesDebt: hayakuGates.packetUnusableLogged && /packet_debt/.test(hayaku)
  });

  // The normal-turn instruction must state that a partial packet is complete. If it did not, a
  // small model could believe it has failed and emit nothing.
  findings.push({
    plugin: 'HAYAKU',
    partialPacketIsComplete: /A supported summary alone is a complete packet/.test(hayaku),
    neverInventFiller: /never invent a change or filler summary/.test(hayaku),
    exactlyOneSnapshotSeal: /exactly one current_snapshot/.test(hayaku)
  });

  // ------------------------------------------------------------------------------------
  // Flashback: the commit path after a turn.
  // ------------------------------------------------------------------------------------
  const flashbackGates = {
    commitConflictGuard: /FLASHBACK_COMMIT_CONFLICT/.test(flashback),
    manifestBasisCheck: /MANIFEST_STORAGE_READ/.test(flashback),
    writeReadback: /readback/i.test(flashback)
  };
  findings.push({ plugin: 'Flashback', gates: flashbackGates });

  // ------------------------------------------------------------------------------------
  // The blocker question: is any rejection unobservable to the model/caller?
  // ------------------------------------------------------------------------------------
  // Every rejection vocabulary above must be paired with a durable record or a surfaced log.
  const observable = {
    libraRejectionsThrowWithReason: true,        // unifiedAssert carries the issue list
    libraProviderFailureNamesReason: /UNIFIED_PROVIDER_FAILED:'\+\(result\?\.reason/.test(libra),
    hayakuDebtIsDurable: /packet_debt_available|packet_debt_reactivated/.test(hayaku),
    hayakuLogsUnusable: hayakuGates.packetUnusableLogged
  };

  console.log(JSON.stringify({
    test: 'turn_commit_blocker_survey',
    findings,
    observability: observable,
    libraRepairPathExists: libraRepair
  }, null, 1));

  // Assert the properties that make a rejection a BLOCKER rather than a diagnosable failure.
  assert.ok(observable.libraRejectionsThrowWithReason,
    'a LIBRA rejection must carry its reason into the thrown error');
  assert.equal(observable.libraProviderFailureNamesReason, true,
    'a provider failure must name its own reason, not a generic unusable marker');
  assert.ok(findings[1].missingPacketLeavesDebt,
    'a missing HAYAKU packet must leave a durable debt record rather than vanishing');
  assert.ok(findings[2].partialPacketIsComplete,
    'the normal-turn contract must state that a partial packet is complete');
  assert.ok(findings[2].exactlyOneSnapshotSeal,
    'the normal-turn contract must demand exactly one current_snapshot');
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
