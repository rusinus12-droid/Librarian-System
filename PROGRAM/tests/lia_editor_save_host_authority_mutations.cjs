'use strict';
// Mutation gate for `lia_editor_save_host_authority_test`. A passing suite proves nothing unless it FAILS
// on the defect it claims to close, so each mutation restores the exact pre-fix shape from the reviewer's
// finding and the REAL suite is run against it in a temp tree. The shipped plugin is never written.
//
//   M1 the shared Persona writer ignores explicit refusal (the editor paths' current enforcement point)
//   M2 the new-Persona path only looks the row up by id (pre-fix shape)
//   M3 the intended values are read off the live object instead of a pre-write deep copy
//
// Run: node Librarian-System/PROGRAM/tests/lia_editor_save_host_authority_mutations.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROGRAM = path.join(__dirname, '..');
const PLUGIN = path.join(PROGRAM, 'plugins', 'LIA_Persona_Linker.js');
const SUITE = 'tests/lia_editor_save_host_authority_test.cjs';
const ORIGINAL = fs.readFileSync(PLUGIN, 'utf8');

const MUTATIONS = [
  {
    id: 'M1', name: 'shared editor save writer ignores an explicit host refusal',
    apply: src => {
      const target = `    if (writeResult === false || writeResult?.ok === false || writeResult?.success === false) {
      throw personaDatabaseMutationError(operation, "database_write_rejected", "LIA_PERSONA_WRITE_REJECTED");
    }`;
      if (src.split(target).length - 1 !== 1) return src;
      return src.replace(target, `    if (false) {
      throw personaDatabaseMutationError(operation, "database_write_rejected", "LIA_PERSONA_WRITE_REJECTED");
    }`);
    },
    expect: /LIA_PERSONA_WRITE_REJECTED/,
    expectLine: /auditSaveNew\(\), error => error\.code === 'LIA_PERSONA_WRITE_REJECTED'/,
  },
  {
    id: 'M2', name: 'new-Persona save only checks the row id',
    apply: src => src.replace(`      const comparedFields = ['name', 'personaPrompt', 'note', 'icon', 'image', 'largePortrait'];
      const mismatched = comparedFields.find(field =>
        JSON.stringify(verified?.[field]) !== JSON.stringify(expected?.[field]));
      if (mismatched) {`, `      const mismatched = null;
      if (mismatched) {`),
    expect: /LIA_PERSONA_READBACK_MISMATCH|readback 검증에 실패/,
    expectLine: /auditSaveNew\(\), \/LIA_PERSONA_READBACK_MISMATCH:personaPrompt\//,
  },
  {
    id: 'M3', name: 'intended values read off the live object (post-write alias)',
    apply: src => src.replace(`      const intendedFields = { personaPrompt: updated.personaPrompt };
      if (explicitName) intendedFields.name = updated.name;
      const intendedCopy = JSON.parse(JSON.stringify(intendedFields));`,
      `      const intendedCopy = { get personaPrompt() { return updated.personaPrompt; }, get name() { return updated.name; } };`),
    expect: /LIA_PERSONA_READBACK_MISMATCH:name/,
    expectLine: /auditSaveCurrent\(\), \/LIA_PERSONA_READBACK_MISMATCH:name\//,
  },
];

const runSuite = (dir, suite) => {
  try {
    const out = execFileSync(process.execPath, [suite], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: out };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}${error.message || ''}` };
  }
};

// Which assertion inside the suite caught the mutation. A rejection-shape failure prints only
// "Missing expected rejection", so the message alone cannot identify the case — the stack line can, and
// the line is checked against the suite source to prove it is the intended check and not a neighbour.
const caughtAt = (output, suiteSource) => {
  const match = output.match(/lia_editor_save_host_authority_test\.cjs:(\d+):/);
  if (!match) return null;
  const line = suiteSource.split('\n')[Number(match[1]) - 1] || '';
  return line.trim();
};

(async () => {
  // The suite must pass on the shipped source first — otherwise every mutation result is meaningless.
  const control = runSuite(PROGRAM, SUITE);
  if (!control.ok) throw new Error(`the suite does not pass on the shipped source:\n${control.output}`);
  console.log(`  control: suite passes on shipped source (${control.output.trim().split('\n').pop()})`);

  let caught = 0;
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(ORIGINAL);
    if (mutated === ORIGINAL) throw new Error(`${mutation.id}: mutation did not apply — the source shape moved`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lia_mut_${mutation.id}_`));
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests', 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'LIA_Persona_Linker.js'), mutated);
    for (const relative of [SUITE, 'tests/fixtures/lia_native_runtime_fixture.cjs']) {
      fs.copyFileSync(path.join(PROGRAM, relative), path.join(dir, relative));
    }
    const result = runSuite(dir, path.join(dir, SUITE));
    fs.rmSync(dir, { recursive: true, force: true });
    if (result.ok) throw new Error(`${mutation.id} (${mutation.name}) was NOT caught — the suite passed on the defect`);
    const suiteSource = fs.readFileSync(path.join(PROGRAM, SUITE), 'utf8');
    const line = caughtAt(result.output, suiteSource);
    if (!line) throw new Error(`${mutation.id} (${mutation.name}) failed without a suite assertion:\n${result.output.split('\n').slice(0, 6).join('\n')}`);
    if (mutation.expectLine && !mutation.expectLine.test(line)) {
      throw new Error(`${mutation.id} (${mutation.name}) was caught by the WRONG assertion: "${line}"`);
    }
    const reason = (result.output.match(mutation.expect) || ['(assertion)'])[0];
    console.log(`  ${mutation.id} caught by "${line.slice(0, 74)}" → ${reason}`);
    caught += 1;
  }
  if (fs.readFileSync(PLUGIN, 'utf8') !== ORIGINAL) throw new Error('the shipped plugin was modified during mutation testing');
  console.log(`lia_editor_save_host_authority_mutations: PASS (${caught}/${MUTATIONS.length} caught, shipped byte-identical)`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
