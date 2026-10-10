'use strict';

// The acceptance reporter must not promote one mode to an all-mode result and
// must reject stale source hashes, embedded stale stamps or missing markers.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROGRAM = path.join(__dirname, '..');
const hashFile = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(PROGRAM, relative))).digest('hex');
const tempEvidencePath = path.join(__dirname, 'fixtures', `.acceptance-evidence-log-${process.pid}.jsonl`);
const relativeEvidencePath = path.relative(PROGRAM, tempEvidencePath).split(path.sep).join('/');
const tempReportPath = path.join(__dirname, 'fixtures', `.acceptance-report-${process.pid}.json`);
const relativeReportPath = path.relative(PROGRAM, tempReportPath).split(path.sep).join('/');
const runReporter = evidenceRows => {
  const env = { ...process.env, LIBRA_ACCEPTANCE_REPORT_PATH: relativeReportPath };
  delete env.LIBRA_ACCEPTANCE_EVIDENCE_PATH;
  if (evidenceRows === undefined) delete env.LIBRA_ACCEPTANCE_EVIDENCE_JSON;
  else env.LIBRA_ACCEPTANCE_EVIDENCE_JSON = JSON.stringify({ schema: 'acceptance.execution_evidence.v1', rows: evidenceRows });
  try {
    const stdout = execFileSync(process.execPath, ['tests/libra_main_memory_acceptance_test.cjs'], {
      cwd: PROGRAM, stdio: 'pipe', env
    });
    return { summary: JSON.parse(String(stdout).trim()), report: JSON.parse(fs.readFileSync(tempReportPath, 'utf8')) };
  } finally {
    fs.rmSync(tempReportPath, { force: true });
  }
};

const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'acceptance_scenarios.json'), 'utf8'));
const action = scenarios.cases.find(row => row.id === 'A01').action;
const marker = { schema: 'acceptance.action_result.v1', case_id: 'A01', mode: 'plugin_only', action, assertion_result: true };
const base = {
  case_id: 'A01', mode: 'plugin_only', status: 'PASS', action,
  command: 'node tests/libra_main_memory_acceptance_reporter_test.cjs', exit_code: 0,
  observed: 'reporter fixture marker only', evidence_files: ['tests/fixtures/acceptance_reporter_sample.jsonl.fixture'],
  evidence_file_sha256: { 'tests/fixtures/acceptance_reporter_sample.jsonl.fixture': hashFile('tests/fixtures/acceptance_reporter_sample.jsonl.fixture') },
  source_file: 'plugins/LIBRA.js', source_sha256: hashFile('plugins/LIBRA.js'),
  test_file: 'tests/libra_main_memory_acceptance_reporter_test.cjs',
  test_sha256: hashFile('tests/libra_main_memory_acceptance_reporter_test.cjs'), evidence_marker: marker
};
const oneMode = runReporter([base]);
assert.equal(oneMode.summary.accounting.evidenceSource, 'test_override');
assert.equal(oneMode.summary.accounting.syntheticFixture, true, 'the action row is visibly synthetic and cannot be mistaken for product evidence');
assert.equal(oneMode.summary.accounting.byStatus.PASS, 1, 'only one exact mode is passed by the fixture');
assert.equal(oneMode.summary.acceptanceStatus, 'INCOMPLETE', 'one passing mode does not complete all three modes');
assert.equal(oneMode.summary.partiallyEvidencedCases.length, 1, 'the report exposes a partially evidenced case');
assert.equal(oneMode.summary.completeAllModeCases.length, 0, 'one mode is not an all-mode case pass');
const catalog = runReporter();
const a04l = catalog.report.rows.find(row => row.case_id === 'A04L' && row.mode === 'plugin_only');
assert.ok(a04l, 'the current catalog still reports its declared A04L cell');
assert.ok(['MATCHED', 'PARTIAL', 'ABSENT', 'MISMATCHED'].includes(a04l.embedded_stamp_status));
if (a04l.embedded_stamp_status === 'MISMATCHED') {
  assert.equal(a04l.status, 'EXIT_UNVERIFIED', 'a currently mismatched real A04L stamp is not promoted');
}
const a05 = catalog.report.rows.find(row => row.case_id === 'A05' && row.mode === 'mirror');
assert.equal(a05.embedded_stamp_status, 'ABSENT', 'nested test stamps are not attributed to the catalog test without a matching test_file');
const a05CurrentSource = a05.source_sha256 === hashFile(a05.source_file);
const a05CurrentTest = a05.test_sha256 === hashFile(a05.test_file);
assert.equal(a05.status, a05CurrentSource && a05CurrentTest ? 'PASS' : 'EXIT_UNVERIFIED',
  'the real A05 catalog row follows its current source and test hashes');
const a05Fixture = 'tests/fixtures/acceptance_reporter_a05_nested.jsonl.fixture';
assert.ok(fs.existsSync(path.join(PROGRAM, a05Fixture)), 'the synthetic A05 probe has a shippable fixture');
const a05Synthetic = {
  ...a05, status: 'PASS', observed: 'synthetic nested-hash attribution probe; no A05 action was run',
  source_sha256: hashFile(a05.source_file), test_sha256: hashFile(a05.test_file),
  evidence_files: [a05Fixture], evidence_file_sha256: { [a05Fixture]: hashFile(a05Fixture) }
};
const a05NestedHashProbe = runReporter([a05Synthetic]);
assert.equal(a05NestedHashProbe.summary.accounting.syntheticFixture, true);
assert.equal(a05NestedHashProbe.report.rows.find(row => row.case_id === 'A05' && row.mode === 'mirror').status, 'PASS',
  'nested hashes for different named tests do not invalidate a current-hash synthetic reporter row');
assert.equal(a05NestedHashProbe.report.rows.find(row => row.case_id === 'A05' && row.mode === 'mirror').embedded_stamp_status, 'ABSENT');
const absentFixture = 'tests/fixtures/acceptance_reporter_a05_absent.jsonl.fixture';
assert.equal(fs.existsSync(path.join(PROGRAM, absentFixture)), false);
const missingA05 = runReporter([{ ...a05Synthetic, evidence_files: [absentFixture],
  evidence_file_sha256: { [absentFixture]: a05Synthetic.evidence_file_sha256[a05Fixture] } }]);
assert.equal(missingA05.report.rows.find(row => row.case_id === 'A05' && row.mode === 'mirror').status, 'EXIT_UNVERIFIED',
  'a missing synthetic fixture cannot turn into acceptance evidence');
const wrongA05Hash = runReporter([{ ...a05Synthetic,
  evidence_file_sha256: { [a05Fixture]: '0'.repeat(64) } }]);
assert.equal(wrongA05Hash.report.rows.find(row => row.case_id === 'A05' && row.mode === 'mirror').status, 'EXIT_UNVERIFIED',
  'a synthetic fixture with an incorrect hash is rejected');
const actualHistoricalEvidencePresent = fs.existsSync(path.join(PROGRAM, a05.evidence_files[0]));
if (!actualHistoricalEvidencePresent) {
  const missingHistoricalA05 = runReporter([{ ...a05, status: 'PASS',
    source_sha256: hashFile(a05.source_file), test_sha256: hashFile(a05.test_file) }]);
  assert.equal(missingHistoricalA05.report.rows.find(row => row.case_id === 'A05' && row.mode === 'mirror').status,
    'EXIT_UNVERIFIED', 'missing actual historical evidence remains unverified');
}
const noStampRow = oneMode.report.rows.find(row => row.case_id === 'A01' && row.mode === 'plugin_only');
assert.equal(noStampRow.status, 'PASS', 'a hash-bound log without embedded stamps stays eligible under the existing exact checks');
assert.equal(noStampRow.embedded_stamp_status, 'ABSENT', 'a no-stamp log is explicitly distinguished from stamped evidence');

const staleHash = runReporter([{ ...base, source_sha256: '0'.repeat(64) }]);
assert.equal(staleHash.summary.accounting.byStatus.EXIT_UNVERIFIED, 1, 'source hash drift downgrades a PASS row');
assert.equal(staleHash.summary.accounting.byStatus.PASS || 0, 0, 'stale source has no PASS row');

const badMarker = runReporter([{ ...base, evidence_marker: { ...marker, assertion_result: false } }]);
assert.equal(badMarker.summary.accounting.byStatus.EXIT_UNVERIFIED, 1, 'missing action assertion marker downgrades a PASS row');
assert.equal(badMarker.summary.accounting.byStatus.PASS || 0, 0, 'missing marker has no PASS row');

const bindLog = (lines, template = base) => {
  fs.writeFileSync(tempEvidencePath, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return { ...template, evidence_files: [relativeEvidencePath],
    evidence_file_sha256: { [relativeEvidencePath]: hashFile(relativeEvidencePath) } };
};
try {
  const a05FixtureRows = fs.readFileSync(path.join(PROGRAM, a05Fixture), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const tamperableA05 = bindLog(a05FixtureRows, a05Synthetic);
  fs.appendFileSync(tempEvidencePath, '\n');
  const tamperedA05 = runReporter([tamperableA05]);
  assert.equal(tamperedA05.report.rows.find(row => row.case_id === 'A05' && row.mode === 'mirror').status,
    'EXIT_UNVERIFIED', 'tampered synthetic fixture bytes cannot pass');
  const currentLogRow = bindLog([marker, { sourceSha256: base.source_sha256, testSha256: base.test_sha256 }]);
  const currentStampedLog = runReporter([currentLogRow]);
  const currentLogReportRow = currentStampedLog.report.rows.find(row => row.case_id === 'A01' && row.mode === 'plugin_only');
  assert.equal(currentStampedLog.summary.accounting.byStatus.PASS, 1, 'matching embedded source/test stamps preserve a PASS row');
  assert.equal(currentLogReportRow.embedded_stamp_status, 'MATCHED', 'matching embedded stamps are reported as matched');

  const a04lAction = scenarios.cases.find(row => row.id === 'A04L').action;
  const a04lMarker = { ...marker, case_id: 'A04L', action: a04lAction };
  const a04lTestFile = 'tests/libra_phase_d_a04l_a06l_local_contract_test.cjs';
  const a04lSourceHash = hashFile('plugins/LIBRA.js');
  const a04lTestHash = hashFile(a04lTestFile);
  const hypotheticalA04LRow = bindLog([a04lMarker, { sourceSha256: a04lSourceHash, testSha256: a04lTestHash }], {
    ...base, case_id: 'A04L', mode: 'plugin_only', action: a04lAction,
    command: `node ${a04lTestFile}`, observed: 'synthetic A04L row with current source and test stamps',
    source_sha256: a04lSourceHash, test_file: a04lTestFile, test_sha256: a04lTestHash,
    evidence_marker: a04lMarker
  });
  const hypotheticalA04L = runReporter([hypotheticalA04LRow]);
  const hypotheticalA04LReportRow = hypotheticalA04L.report.rows.find(row => row.case_id === 'A04L' && row.mode === 'plugin_only');
  assert.equal(hypotheticalA04LReportRow.status, 'PASS', 'a properly rebound A04L catalog claim remains valid');
  assert.equal(hypotheticalA04LReportRow.embedded_stamp_status, 'MATCHED');

  const staleEmbeddedRow = bindLog([marker, { sourceSha256: 'd267c3de443913a73548b62e2fa755bfb2fb293ba83c6dbc78c9a3be150463d2', testSha256: base.test_sha256 }]);
  const staleEmbedded = runReporter([staleEmbeddedRow]);
  const staleEmbeddedReportRow = staleEmbedded.report.rows.find(row => row.case_id === 'A01' && row.mode === 'plugin_only');
  assert.equal(staleEmbedded.summary.accounting.byStatus.EXIT_UNVERIFIED, 1, 'a fresh log hash cannot hide a stale embedded source stamp');
  assert.equal(staleEmbedded.summary.accounting.byStatus.PASS || 0, 0, 'a stale embedded source stamp has no PASS row');
  assert.equal(staleEmbeddedReportRow.embedded_stamp_status, 'MISMATCHED', 'the attribution reason is machine-readable');

  const logBound = bindLog([marker]);
  const currentLog = runReporter([logBound]);
  assert.equal(currentLog.summary.accounting.byStatus.PASS, 1, 'a current log hash and marker preserve a PASS row');
  fs.appendFileSync(tempEvidencePath, '\n');
  const tamperedLog = runReporter([logBound]);
  assert.equal(tamperedLog.summary.accounting.byStatus.EXIT_UNVERIFIED, 1, 'log byte drift downgrades a PASS row');
  assert.equal(tamperedLog.summary.accounting.byStatus.PASS || 0, 0, 'a tampered log has no PASS row');

} finally {
  fs.rmSync(tempEvidencePath, { force: true });
}

console.log(JSON.stringify({ test: 'libra_main_memory_acceptance_reporter', passed: 1,
  oneModeDoesNotPassCase: true, staleSourceHashDowngraded: true, embeddedCurrentStampsPreserved: true,
  staleEmbeddedSourceDowngraded: true, noStampLogDistinguished: true, realA04LObservationConditional: true,
  hypotheticalA04LReboundPasses: true, nestedHashesRemainScoped: true, missingMarkerDowngraded: true,
  evidenceHashBound: true, tamperedLogDowngraded: true,
  shippableSyntheticA05Fixture: true, missingSyntheticFixtureRejected: true,
  wrongSyntheticFixtureHashRejected: true, tamperedSyntheticFixtureRejected: true,
  actualHistoricalEvidencePresent,
  boundary: 'temporary inline report inputs and a temporary marker log; no product suite is executed' }));
