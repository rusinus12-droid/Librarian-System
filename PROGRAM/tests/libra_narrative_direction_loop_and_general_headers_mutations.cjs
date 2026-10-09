'use strict';
// MUTATION GATE for libra_narrative_direction_loop_and_general_headers_test.cjs.
//
// Each mutant restores one of the reported defects. If the assertion is real, the suite must fail on
// each; a mutant that leaves the suite green proves the assertion measures nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROGRAM = path.resolve(__dirname, '..');
const PLUGIN = path.join(PROGRAM, 'plugins', 'LIBRA.js');
const MAX_BUFFER = 64 * 1024 * 1024;

const MUTANTS = [
  {
    id: 'M1-empty-scope-reschedules-render',
    why: 'restores the render -> load -> render loop: the empty-scope path asks for another render',
    from: "      if (Gui.narrativeDirectionError!=='현재 채팅 scope를 확인하지 못했습니다.') {\n        Gui.narrativeDirectionError='현재 채팅 scope를 확인하지 못했습니다.';\n      }\n      return;",
    to: "      Gui.narrativeDirectionError='현재 채팅 scope를 확인하지 못했습니다.'; queueGuiNavigationRender(); return;"
  },
  {
    id: 'M2-general-panel-repeats-the-header',
    why: 'restores the duplicate title card the user reported',
    from: "  const buildGeneralSettingsPanel = () => guiEl('div', { class: 'sga-flow-section' }, [",
    to: "  const buildGeneralSettingsPanel = () => guiEl('div', { class: 'sga-flow-section' }, [\n    guiEl('section', { class: 'sga-card wide libra-reader-intro' }, [guiEl('span', { class: 'libra-article-eyebrow', text: 'INTERFACE · DIAGNOSTICS' }), guiEl('h2', { text: '일반 · 진단' })]),"
  },
  {
    id: 'M3-diagnostic-room-shrunk-back',
    why: 'shrinks the reading room back to the cramped sizing the user complained about',
    from: ".libra-diag-list{display:grid;gap:4px;max-height:62vh;overflow:auto}",
    to: ".libra-diag-list{display:grid;gap:4px;max-height:46vh;overflow:auto}"
  },
  {
    id: 'M4-detail-column-narrowed',
    why: 'narrows the detail column back, so long values wrap and read worse',
    from: "grid-template-columns:minmax(0,1fr) minmax(320px,520px)",
    to: "grid-template-columns:minmax(0,1fr) minmax(280px,420px)"
  }
];

const copyProgram = tag => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `nar-${tag}-`));
  const sandbox = path.join(root, 'PROGRAM');
  fs.cpSync(PROGRAM, sandbox, { recursive: true, filter: source => !source.includes('.ultralight-dist') });
  return { root, sandbox };
};
const runSuite = sandbox => {
  const run = spawnSync(process.execPath, [path.join(sandbox, 'tests', 'libra_narrative_direction_loop_and_general_headers_test.cjs')],
    { cwd: sandbox, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 300000 });
  return { passed: run.status === 0, output: `${run.stdout || ''}${run.stderr || ''}` };
};

const original = fs.readFileSync(PLUGIN, 'utf8');
const results = [];

{
  const { root, sandbox } = copyProgram('control');
  try {
    const control = runSuite(sandbox);
    results.push({ id: 'control-unmutated', observed: control.passed ? 'pass' : 'fail', detected: control.passed });
    if (!control.passed) {
      console.error(JSON.stringify({ results, tail: control.output.slice(-800) }, null, 1));
      throw new Error('the control run must pass against the unmutated plugin');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const mutant of MUTANTS) {
  const occurrences = original.split(mutant.from).length - 1;
  if (occurrences !== 1) { results.push({ id: mutant.id, observed: `site appeared ${occurrences}x`, detected: false }); continue; }
  const { root, sandbox } = copyProgram(mutant.id);
  try {
    fs.writeFileSync(path.join(sandbox, 'plugins', 'LIBRA.js'), original.replace(mutant.from, mutant.to));
    const outcome = runSuite(sandbox);
    results.push({
      id: mutant.id, why: mutant.why, observed: outcome.passed ? 'pass' : 'fail', detected: outcome.passed === false,
      failureExcerpt: outcome.passed ? '' : outcome.output.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const byteIdentical = fs.readFileSync(PLUGIN, 'utf8') === original;
const undetected = results.filter(entry => entry.detected !== true);
console.log(JSON.stringify({ results, undetected: undetected.map(e => e.id), byteIdentical }, null, 1));
assert.strictEqual(byteIdentical, true, 'the repository plugin is unchanged');
assert.strictEqual(undetected.length, 0, `every mutant must be detected: ${undetected.map(e => e.id).join(', ')}`);
console.log(`libra_narrative_direction_loop_and_general_headers_mutations: PASS (${MUTANTS.length} mutants detected, control passed)`);
