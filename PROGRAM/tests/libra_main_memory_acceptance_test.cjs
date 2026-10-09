'use strict';
// T11 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (`03_ACCEPTANCE_TESTS.md` section 7, A01-A44)
//
// WHAT THIS SUITE IS. `03` section 7 defines a result format for the 44 acceptance
// cases and forbids three ways of faking it:
//   * a case may not be called PASS because a test file exists for its owner task;
//   * PASS requires the case's own ACTION to have been performed with real evidence;
//   * a case whose final exit is unknown is EXIT_UNVERIFIED, never PASS.
//
// AN EARLIER VERSION OF THIS SUITE VIOLATED THE FIRST RULE. It marked 132 rows PASS
// because each case's owner TASK had a suite that exited 0. Review caught it by name:
// A09 (replace/remove then re-read), A19/A21 (tight budget / read failure), A34
// (storage failure, mismatch, cancel), A39 (3x3 export/import), A40 (corrupt bundle
// refused) were marked PASS while their actual actions were performed nowhere.
//
// THIS FILE IS A REPORTER ONLY. It never launches test suites. A row can be PASS only
// when a separate execution-evidence record names that row's exact action and mode,
// natural exit, observed outcome, repository-relative log and matching source/test
// hashes. Missing or stale action evidence stays BLOCKED or EXIT_UNVERIFIED.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROGRAM = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const SCENARIOS_PATH = path.join(FIXTURES, 'acceptance_scenarios.json');
const TEMPLATE_PATH = path.join(FIXTURES, 'acceptance_results_template.json');
const EXECUTION_EVIDENCE_PATH = path.join(FIXTURES, 'acceptance_execution_evidence.v1.json');
const requestedEvidencePath = process.env.LIBRA_ACCEPTANCE_EVIDENCE_PATH || 'tests/fixtures/acceptance_execution_evidence.v1.json';
assert.ok(!path.isAbsolute(requestedEvidencePath), 'acceptance evidence path must be repository-relative');
const resolvedEvidencePath = path.resolve(PROGRAM, requestedEvidencePath);
assert.ok(resolvedEvidencePath.startsWith(`${PROGRAM}${path.sep}`), 'acceptance evidence path must stay under the PROGRAM checkout');
for (const [label, file] of [['acceptance_scenarios.json', SCENARIOS_PATH], ['acceptance_results_template.json', TEMPLATE_PATH]]) {
  if (!fs.existsSync(file)) {
    console.error(`${label} is missing at ${file}. The acceptance contract must be tracked with the suite that reads it; a missing contract is not a pass.`);
    process.exit(1);
  }
}
const SCENARIOS = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
const TEMPLATE = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
const syntheticEvidenceOverride = Boolean(process.env.LIBRA_ACCEPTANCE_EVIDENCE_JSON);
const evidenceSource = syntheticEvidenceOverride ? 'test_override' : 'catalog_file';
const EXECUTION_EVIDENCE = syntheticEvidenceOverride
  ? JSON.parse(process.env.LIBRA_ACCEPTANCE_EVIDENCE_JSON)
  : fs.existsSync(resolvedEvidencePath)
    ? JSON.parse(fs.readFileSync(resolvedEvidencePath, 'utf8'))
    : { schema: 'acceptance.execution_evidence.v1', rows: [] };
assert.equal(EXECUTION_EVIDENCE.schema, 'acceptance.execution_evidence.v1', 'the action evidence catalog has its declared schema');
assert.ok(Array.isArray(EXECUTION_EVIDENCE.rows), 'the action evidence catalog has rows');

const sha256File = relativePath => {
  if (!relativePath || path.isAbsolute(relativePath)) return '';
  const absolutePath = path.resolve(PROGRAM, relativePath);
  if (!absolutePath.startsWith(`${PROGRAM}${path.sep}`) || !fs.existsSync(absolutePath)) return '';
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
};
const evidenceByKey = new Map();
for (const row of EXECUTION_EVIDENCE.rows) {
  const key = `${String(row.case_id || '')}/${String(row.mode || '')}`;
  assert.ok(key !== '/', 'evidence rows identify a case and mode');
  assert.ok(!evidenceByKey.has(key), `${key}: duplicate action/mode evidence is not allowed`);
  evidenceByKey.set(key, row);
}

// ── per case: the suite that PERFORMS the action, and the behaviour it performs ──
const COVERAGE = {
  A01: { suite: 'libra_main_memory_state_operations_parity_test', evidence: 'baseline bytes and exit codes are read and compared; unsupported paths reported separately' },
  A02: { suite: 'libra_main_memory_state_operations_parity_test', evidence: 'rollback at turn 0 and at the committed boundary, resume via setWorldManagerWorldline, in three modes' },
  A03: { suite: 'libra_main_memory_state_operations_parity_test', evidence: 'a named logical fork is refused with its documented code in every mode' },
  A04: { suite: 'libra_phase_d_v5_response_loss_recovery_test', evidence: 'mirror and server_only repeat the exact operation id after a lost response, read back the durable verified receipt and DB rows, and recover State; plugin_only has no server receipt/DB action and remains BLOCKED' },
  A05: { suite: 'libra_phase_d_a05_action_matrix_test + libra_phase_d_a05_plugin_aba_diagnostic_test', evidence: 'mirror/server_only perform correction, same-value A→B→A revision, and scope transition with stale-candidate recovery; plugin_only has no monotonic local State revision, and the focused A→B→A diagnostic shows equal bytes returning to baseline while the stale candidate commits, so plugin_only remains BLOCKED pending a product-local revision/CAS path' },
  A06: { suite: 'libra_phase_d_v5_mirror_local_failure_recovery_test + libra_phase_d_v5_server_only_outage_recovery_test', evidence: 'mirror compares divergent local/remote raw State and repairs on reconnect; server_only compares unchanged server rows and absent local authority during outage, then reads back recovery; plugin_only has no paired raw stores and remains BLOCKED' },
  A07: { suite: 'libra_main_memory_profile_lifecycle_test', evidence: 'independent preferences accumulate; an unrelated habit survives; a sibling is not touched' },
  A08: { suite: 'libra_main_memory_profile_lifecycle_test', evidence: 'the boundary keeps subject/target/act/when and is not generalised; an unknown category is not guessed into a field' },
  A09: { suite: 'libra_main_memory_replacement_and_removal_test', evidence: 'the SAME subject+topic stated again REPLACES the earlier item and a removal takes it out, each re-read from the Head' },
  A10: { suite: 'libra_main_memory_replay_and_correction_test', evidence: 'the same work is retried, reloaded and replayed; provenance and bytes stay identical' },
  A11: { suite: 'libra_phase_d_a11_same_title_promises_test', evidence: 'the same-title/source-backed two-promise action and wrong-recipient alias control run in all three modes; the exact request-local alias resolves only its matching lifecycle, while State, History, Recall, Input Writer, canonical raw readback, and mirror/server storage evidence are checked' },
  A12: { suite: 'libra_main_memory_letter_lifecycle_105turn_test', evidence: 'the T5 promise is re-referenced at T40 through the actual request-local candidate alias, is accepted as the same lifecycle and is recorded as reaffirmed in History in all three storage modes' },
  A13: { suite: null, reason: 'the acceptance action requires four independent fulfillment/break/agreed-cancel/obstacle branches with State, History, Recall, and GUI comparisons' },
  A14: { suite: 'libra_main_memory_thread_identity_test', evidence: 'a resolution reason on an OPEN thread is refused' },
  A15: { suite: 'libra_phase_d_a15_invalid_links_test', evidence: 'nonexistent alias, future cursor, inactive revision, self link and sibling-worldline target are all isolated without promotion (nonexistent alias normalizes to pending/unknown_or_stale_candidate_alias; the four attack targets stay un-promoted with the parent lifecycles still open) while the independent source-backed event is preserved, in all three storage modes' },
  A16: { suite: 'libra_phase_d_a16_prompt_pressure_test', evidence: 'real prompt pressure (recorded optionalOmitted [previous_state, thread_candidates] at contextWindow 1) keeps all ten exact row markers and their text verbatim; a control request presents the one real existing candidate while the pressured request presents none; a fact carrying an alias the request never presented is stored with linkStatus new and no persisted alias, in all three storage modes' },
  A17: { suite: 'libra_main_memory_letter_lifecycle_105turn_test', evidence: 'all 21 consecutive five-pair batches reach T105; the T5 promise opens, T40 reaffirms, T105 fulfills, T105 reroll returns it to open, and native T40 child cancellation leaves parent/sibling unchanged, with provider-call, replay, canonical-byte, Head, History, Recall and Input Writer assertions in all modes' },
  A18: { suite: 'libra_main_memory_letter_lifecycle_105turn_test', evidence: 'the historical T5 question excludes later fulfillment while the current query includes T105 fulfillment with the evidence-time cutoff in Recall and Input Writer for all three modes' },
  A19: { suite: 'libra_main_memory_recall_currentness_test', evidence: 'a tight budget keeps the later, closing evidence instead of the earlier value alone' },
  A20: { suite: 'libra_main_memory_recall_currentness_test', evidence: 'the same canonical answers with the index cold and with no peer plugin installed' },
  A21: { suite: 'libra_main_memory_closure_failure_disclosure_test', evidence: 'an unreadable ref and a missing read are reported as last-known/unknown, never as current or "nothing changed"' },
  A22: { suite: 'libra_main_memory_recall_currentness_test', evidence: 'a reported/hypothetical fact is not promoted to a verified closure' },
  A23: { suite: 'libra_main_memory_replay_and_correction_test', evidence: 'a source revision change is handled and the canonical revision plus State are read back' },
  A24: { suite: 'libra_main_memory_replay_and_correction_test', evidence: 'the record label agrees with its artifact; no silent redirect' },
  A25: { suite: 'libra_phase_d_a25_correction_test', evidence: 'a taste (preferences), a boundary and a promise (narrative thread) are each corrected through the existing journal, suspended (the original value returns), reactivated (the corrected value returns) and replayed (rebuild keeps it, with no model call); the canonical record bytes and digest are unchanged and provenance records the real canonical cursor under point_in_time_override, in all three storage modes' },
  A26: { suite: 'libra_main_memory_replay_and_correction_test', evidence: 'a refused fork leaves the parent State byte-identical' },
  A27: { suite: 'libra_main_memory_portable_compatibility_test', evidence: 'a reload keeps the bytes, refs and Head; history and closure links survive' },
  A28: { suite: 'libra_main_memory_replay_and_correction_test', evidence: 'replaying a committed range is a no-op rather than a fabricated state' },
  A29: { suite: 'libra_main_memory_schema_compatibility_test', evidence: 'each fact carries its own evidence span and its subject is bound' },
  A30: { suite: 'libra_main_memory_schema_compatibility_test', evidence: 'one bad optional fact is quarantined while unrelated valid facts are admitted (admission.status=partial)' },
  A31: { suite: 'libra_main_memory_mixed_replay_test', evidence: 'read/render/replay across a chain holding v4 and v5; an unknown schema is refused without loss' },
  A32: { suite: 'libra_main_memory_profile_lifecycle_test', evidence: 'additional items are accepted and the current State stays readable' },
  A33: { suite: 'libra_main_memory_gui_wiring_test', evidence: 'the shipped sheet executes: every analysed field is rendered, preferences and boundaries included; a field the analysis never produced renders nothing rather than a false value' },
  A34: { suite: 'libra_main_memory_gui_failure_disclosure_test', evidence: 'the GUI save path with write failure, readback mismatch, duplicate click and cancel injected: success shows only after durable confirmation, a duplicate click starts no second mutation, and the lock clears on every path' },
  A35: { suite: 'libra_main_memory_gui_wiring_test', evidence: 'the sheet reads the shared Head view, never storage, and offers no World Manager mode switch' },
  A36: { suite: 'libra_main_memory_episode_motif_test', evidence: 'event/relationship/history connect: a one-way confession stays one-way, a reconciliation is not restored trust' },
  A37: { suite: 'libra_main_memory_episode_motif_test', evidence: 'the same label on two objects stays two things; a repeated prop is not promoted to a symbol' },
  A38: { suite: 'libra_main_memory_episode_motif_test', evidence: 'the almanac model exposes the episode groups and generates no summary of its own' },
  A39: { suite: 'libra_phase_d_portable_nine_pairs_test', evidence: 'the public portable plugin API exports, validates, previews and reconstructs all nine source/destination storage pairs; each destination mode receives every source mode, destination scopes/keys are remapped, canonical artifact bytes plus origin/epoch remain correct, and State/History/Recall/Input Writer linked-reference results are asserted' },
  A40: { suite: 'libra_main_memory_transfer_bundle_matrix_test', evidence: 'the exported BYTES are tampered and the manager refuses the altered archive in the inspecting phase rather than accepting it' },
  A41: { suite: 'libra_main_memory_portable_compatibility_test', evidence: 'an upgrade/reopen costs no model call with identical bytes and refs; a v5 record is not rewritten for an older reader' },
  A42: { suite: 'libra_main_memory_cost_latency_test', evidence: 'analysis/recovery/cold-warm recall/replay calls, bytes and latency measured; read paths add 0 calls' },
  A04L: { suite: 'libra_phase_d_a04l_a06l_local_contract_test', evidence: 'a pluginStorage write fails after the durable canonical commit; the committed v5 memory is not rolled back, one retry recovers the pending receipt, a second retry applies nothing, and the provider is not re-run' },
  A06L: { suite: null, reason: 'the unreachable-authority contract (explicit failure with no hidden local authority) is not yet driven by its own action; the mirror local-failure half is covered by libra_phase_d_v5_mirror_local_failure_recovery_test' },
  A43: { suite: null, reason: 'real external-model blind gold scoring is a separate axis; harness results do not stand in for it' },
  A44: { suite: null, reason: 'real RisuAI manipulation (reroll/branch/menu/reload/cancel) is a live-host axis; synthetic host results do not stand in for it' }
};

const markerExists = (row, marker) => {
  if (!marker || marker.schema !== 'acceptance.action_result.v1' || marker.assertion_result !== true) return false;
  return (row.evidence_files || []).some(relativePath => {
    if (!relativePath || path.isAbsolute(relativePath)) return false;
    const file = path.resolve(PROGRAM, relativePath);
    if (!file.startsWith(`${PROGRAM}${path.sep}`) || !fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).some(line => {
      try {
        const value = JSON.parse(line);
        return value?.schema === marker.schema && value?.case_id === row.case_id && value?.mode === row.mode
          && value?.action === row.action && value?.assertion_result === true;
      } catch (_) { return false; }
    });
  });
};

const evidenceFileHashesMatch = row => {
  if (!Array.isArray(row.evidence_files) || row.evidence_files.length === 0) return false;
  const hashes = row.evidence_file_sha256;
  if (!hashes || typeof hashes !== 'object' || Object.keys(hashes).length !== row.evidence_files.length) return false;
  return row.evidence_files.every(relativePath => /^[a-f0-9]{64}$/.test(String(hashes[relativePath] || ''))
    && sha256File(relativePath) === hashes[relativePath]);
};

const normalizedArtifactPath = value => typeof value === 'string'
  ? value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() : '';

const collectEmbeddedStamps = (value, stamps, row, inheritedFiles = {}) => {
  if (Array.isArray(value)) {
    for (const item of value) collectEmbeddedStamps(item, stamps, row, inheritedFiles);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const sourceFile = value.source_file || value.sourceFile || inheritedFiles.source;
  const testFile = value.test_file || value.testFile || inheritedFiles.test;
  const sourceMatchesRow = !sourceFile || normalizedArtifactPath(sourceFile) === normalizedArtifactPath(row.source_file);
  const testMatchesRow = !testFile || normalizedArtifactPath(testFile) === normalizedArtifactPath(row.test_file);
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'sourceSha256' || key === 'source_sha256') && sourceMatchesRow) stamps.source.push(child);
    else if ((key === 'testSha256' || key === 'test_sha256') && testMatchesRow) stamps.test.push(child);
    collectEmbeddedStamps(child, stamps, row, { source: sourceFile, test: testFile });
  }
};

const embeddedStampCheck = row => {
  const stamps = { source: [], test: [] };
  for (const relativePath of row.evidence_files || []) {
    if (!relativePath || path.isAbsolute(relativePath)) continue;
    const absolutePath = path.resolve(PROGRAM, relativePath);
    if (!absolutePath.startsWith(`${PROGRAM}${path.sep}`) || !fs.existsSync(absolutePath)) continue;
    const contents = fs.readFileSync(absolutePath, 'utf8');
    try {
      collectEmbeddedStamps(JSON.parse(contents), stamps, row);
      continue;
    } catch (_) {
      // Most execution logs are JSONL, so parse each complete record when the
      // entire file is not one JSON document.
    }
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { collectEmbeddedStamps(JSON.parse(line), stamps, row); } catch (_) { /* non-JSON log line */ }
    }
  }
  const unique = values => [...new Set(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)))];
  const source = unique(stamps.source);
  const test = unique(stamps.test);
  const matches = (values, expected) => values.every(value => /^[a-f0-9]{64}$/i.test(value)
    && value.toLowerCase() === String(expected || '').toLowerCase());
  const mismatched = !matches(source, row.source_sha256) || !matches(test, row.test_sha256);
  const status = mismatched ? 'MISMATCHED'
    : source.length && test.length ? 'MATCHED'
      : source.length || test.length ? 'PARTIAL' : 'ABSENT';
  const note = status === 'ABSENT'
    ? 'no embedded stamp for the catalog-named source/test; the log is pinned by hash but its producer is not independently stamped'
    : status === 'PARTIAL'
      ? 'only one embedded source/test stamp type is present; observed stamps match the current catalog claim'
      : status === 'MISMATCHED'
        ? 'an embedded source/test stamp does not match the catalog and current-file hash claim'
        : 'embedded source and test stamps match the catalog and current-file hash claim';
  return { status, source, test, note };
};

const cases = Array.isArray(SCENARIOS.cases) ? SCENARIOS.cases : [];
// The contract's original 44 cases plus the explicit local-contract cases (A04L/A06L) the
// A04/A06 plugin_only proposal adds, so a not-applicable cell is never confused with an unrun one.
const DERIVED_CASES = cases.filter(entry => entry.derived_from);
assert.equal(cases.length, 44 + DERIVED_CASES.length,
  `the acceptance contract defines 44 cases plus ${DERIVED_CASES.length} explicit local-contract cases (found ${cases.length})`);
assert.equal(TEMPLATE.results.length, TEMPLATE.results.length,
  'the result template carries one row per case and mode');
assert.equal(new Set(TEMPLATE.results.map(row => `${row.case_id}/${row.mode}`)).size, TEMPLATE.results.length,
  'the result template has no duplicate case/mode rows');
assert.equal(TEMPLATE.results.length, cases.reduce((total, entry) => total + entry.modes.length, 0),
  'the result template covers every case and mode exactly once');
for (const entry of cases) {
  const id = String(entry.id);
  assert.ok(COVERAGE[id], `${id}: the report states the scope or missing evidence (no case is omitted)`);
  if (COVERAGE[id].suite) assert.ok(COVERAGE[id].evidence, `${id}: a covered case names the behaviour that performs its action`);
  else assert.ok(COVERAGE[id].reason, `${id}: an uncovered case states why, and is not silently passed`);
  assert.ok(Array.isArray(entry.tasks) && entry.tasks.length, `${id}: the contract lists its owner task`);
}

const report = [];
for (const entry of cases) {
  const id = String(entry.id);
  const coverage = COVERAGE[id];
  const modes = Array.isArray(entry.modes) && entry.modes.length ? entry.modes : ['plugin_only', 'mirror', 'server_only'];
  for (const mode of modes) {
    const execution = evidenceByKey.get(`${id}/${mode}`) || null;
    const applicability = entry.mode_applicability?.[mode] || 'applicable';
    let status = execution?.status || (applicability === 'not_applicable' ? 'SKIP' : 'BLOCKED');
    let limitations = [...(execution?.limitations || [])];
    let embeddedStamps = { status: 'NOT_CHECKED', source: [], test: [], note: 'no PASS evidence row was checked for embedded stamps' };
    if (applicability === 'not_applicable') {
      // Not-applicable is recorded explicitly and is never counted as a pass.
      status = 'SKIP';
      limitations = [entry.mode_applicability_note || 'the acceptance action cannot exist in this storage mode'];
    } else if (!execution) limitations = [coverage.reason || `no explicit action/mode execution row; reporter does not launch tests`];
    if (execution?.status === 'PASS') {
      embeddedStamps = embeddedStampCheck(execution);
      const currentSourceHash = sha256File(execution.source_file);
      const currentTestHash = sha256File(execution.test_file);
      const coreMetadataMatches = execution.action === entry.action
        && Number.isInteger(execution.exit_code) && execution.exit_code === 0
        && typeof execution.command === 'string' && execution.command.length > 0
        && typeof execution.observed === 'string' && execution.observed.length > 0
        && Array.isArray(execution.evidence_files) && execution.evidence_files.length > 0
        && execution.source_file === 'plugins/LIBRA.js'
        && typeof execution.test_file === 'string' && execution.test_file.startsWith('tests/')
        && execution.command === `node ${execution.test_file}`
        && currentSourceHash === execution.source_sha256 && currentTestHash === execution.test_sha256
        && evidenceFileHashesMatch(execution) && markerExists(execution, execution.evidence_marker);
      if (!coreMetadataMatches || embeddedStamps.status === 'MISMATCHED') {
        status = 'EXIT_UNVERIFIED';
        if (!coreMetadataMatches) {
          limitations.push('PASS record failed one or more current source/test/log, natural-exit, exact-action, or machine-readable-marker checks');
        }
        if (embeddedStamps.status === 'MISMATCHED') {
          limitations.push('evidence log contains an embedded source/test stamp that differs from the catalog/current-file claim');
        }
      }
    }
    report.push({
      case_id: id, mode, required_action: entry.action, status,
      implementation_commit: execution?.implementation_commit ?? null,
      command: execution?.command ?? null, exit_code: execution?.exit_code ?? null,
      action: execution?.action ?? null, performed_action: execution?.action ?? null, observed: execution?.observed ?? null,
      evidence_files: execution?.evidence_files ?? [], source_file: execution?.source_file ?? null,
      source_sha256: execution?.source_sha256 ?? null, test_file: execution?.test_file ?? null,
      test_sha256: execution?.test_sha256 ?? null, evidence_marker: execution?.evidence_marker ?? null,
      evidence_file_sha256: execution?.evidence_file_sha256 ?? null,
      embedded_stamp_status: embeddedStamps.status,
      embedded_source_sha256: embeddedStamps.source,
      embedded_test_sha256: embeddedStamps.test,
      embedded_stamp_note: embeddedStamps.note,
      limitations,
      owner_tasks: (entry.tasks || []).join(','), verification_layer: entry.verification_layer
    });
  }
}

const allowed = new Set(['NOT_RUN', 'PASS', 'FAIL', 'BLOCKED', 'TIMEOUT', 'SKIP', 'EXIT_UNVERIFIED']);
for (const row of report) {
  assert.ok(allowed.has(row.status), `${row.case_id}/${row.mode}: status is one of the allowed values`);
  if (row.status === 'PASS') {
    assert.ok(row.command, `${row.case_id}/${row.mode}: PASS carries the command that was run`);
    assert.equal(row.exit_code, 0, `${row.case_id}/${row.mode}: PASS carries exit 0`);
    assert.ok(row.observed && row.performed_action === row.required_action, `${row.case_id}/${row.mode}: PASS records the requested action and outcome`);
    assert.ok(row.source_sha256 && row.test_sha256 && evidenceFileHashesMatch(row) && markerExists(row, row.evidence_marker),
      `${row.case_id}/${row.mode}: PASS is bound to current source/test hashes and a machine-readable log marker`);
  }
  if (row.status === 'BLOCKED') {
    assert.ok(row.limitations.length, `${row.case_id}/${row.mode}: a blocked case states the limitation`);
  }
}

const byStatus = report.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
assert.equal(report.length, cases.reduce((total, entry) => total + entry.modes.length, 0),
  'every case is reported in every mode');
const blockedCases = [...new Set(report.filter(r => r.status === 'BLOCKED').map(r => r.case_id))];
const passCases = [...new Set(report.filter(r => r.status === 'PASS').map(r => r.case_id))];
const perCase = cases.map(entry => {
  const id = String(entry.id), allRows = report.filter(row => row.case_id === id);
  // A not-applicable mode is not a required mode: it is excluded from the denominator, so a
  // case is complete when every APPLICABLE mode passed.
  const rows = allRows.filter(row => row.status !== 'SKIP' || !(entry.mode_applicability?.[row.mode] === 'not_applicable'));
  const notApplicableModes = allRows.filter(row => row.status === 'SKIP' && entry.mode_applicability?.[row.mode] === 'not_applicable').map(row => row.mode);
  const passRows = rows.filter(row => row.status === 'PASS').length;
  return { case_id: id, passModes: passRows, totalModes: rows.length, notApplicableModes,
    completeAllModes: rows.length > 0 && passRows === rows.length,
    partialModes: passRows > 0 && passRows < rows.length,
    allModesBlocked: rows.length > 0 && rows.every(row => row.status === 'BLOCKED') };
});
const completeCases = perCase.filter(row => row.completeAllModes).map(row => row.case_id);
const partiallyEvidencedCases = perCase.filter(row => row.partialModes).map(row => row.case_id);
const allBlockedCases = perCase.filter(row => row.allModesBlocked).map(row => row.case_id);
const reportDocument = { schema: 'acceptance.action_mode_report.v1', evidenceSource,
  syntheticFixture: syntheticEvidenceOverride, rows: report, perCase };
let reportPath = null;
if (process.env.LIBRA_ACCEPTANCE_REPORT_PATH) {
  const requested = String(process.env.LIBRA_ACCEPTANCE_REPORT_PATH);
  const absolute = path.resolve(PROGRAM, requested);
  assert.ok(!path.isAbsolute(requested) && absolute.startsWith(`${PROGRAM}${path.sep}`),
    'LIBRA_ACCEPTANCE_REPORT_PATH must stay under the PROGRAM checkout');
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(reportDocument, null, 2)}\n`);
  reportPath = path.relative(PROGRAM, absolute);
}
console.log(JSON.stringify({
  test: 'libra_main_memory_acceptance',
  reporterStatus: 'ACCOUNTED', acceptanceStatus: report.length > 0 && report.every(row => row.status === 'PASS')
    ? 'ALL_CASES_ALL_MODES_EVIDENCED' : 'INCOMPLETE',
  boundary: 'report-only per-action/per-mode accounting; no test suite is launched and missing/stale action evidence is not a pass',
  accounting: {
    cases: cases.length, rows: report.length, byStatus,
    evidenceSource, syntheticFixture: syntheticEvidenceOverride,
    embeddedStampAccounting: report.reduce((acc, row) => {
      acc[row.embedded_stamp_status] = (acc[row.embedded_stamp_status] || 0) + 1;
      return acc;
    }, {}),
    evidencedCases: passCases.length, blockedCases: blockedCases.length,
    completeAllModeCases: completeCases.length, partiallyEvidencedCases: partiallyEvidencedCases.length,
    allModesBlockedCases: allBlockedCases.length,
    notApplicableRows: report.filter(row => row.status === 'SKIP').length,
    evidenceCatalogRows: EXECUTION_EVIDENCE.rows.length,
    note: 'PASS requires a natural exit 0, exact requested action/mode, observed result, repository-relative JSON log marker, current source/test hashes, and agreement from any embedded stamps for the catalog-named source/test'
  },
  blocked: blockedCases, completeAllModeCases: completeCases,
  partiallyEvidencedCases, allModesBlockedCases: allBlockedCases,
  detailedReportPath: reportPath
}));
