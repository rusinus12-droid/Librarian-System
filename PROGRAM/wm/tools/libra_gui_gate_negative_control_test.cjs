'use strict';
// Gate: 새 GUI 게이트들이 "실제로 회귀를 잡는가" 를 음성 대조군으로 확인한다.
//
// 왜 필요한가: 게이트가 통과하는 것만 보면, 아무것도 검사하지 않는 게이트도
// 통과한다. 실제로 그런 일이 있었다 — 마크업에 id 가 있는지만 보던 검사는
// id 241/241 통과 상태에서 버튼 54개가 무반응인 것을 놓쳤다.
//
// 그래서 이 게이트는 일부러 결함을 주입하고, 해당 게이트가 그것을 잡는지 본다.
// 잡지 못하면(MISS) 그 게이트는 계약을 지키지 않는 것이다.
//
// 이 게이트가 단언하는 계약:
//   1) 세 게이트가 변이 전에 통과한다 (기준선)
//   2) 주입한 결함을 각 게이트가 실제로 잡는다 (CAUGHT)
//   3) 복원 후 다시 통과한다 (게이트가 상태를 오염시키지 않음)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
const assertions = [];

const runGate = (script) => {
  try { execFileSync(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, stdio: 'pipe' }); return true; }
  catch (_) { return false; }
};

const GATES = [
  ['gui-nav', 'tools/libra_gui_nav_path_test.cjs'],
  ['gui-runtime', 'tools/libra_gui_renderer_runtime_test.cjs'],
  ['gui-markup', 'tools/libra_gui_markup_balance_test.cjs'],
];

// ── 1. 기준선 ────────────────────────────────────────────────────────────
const baseline = GATES.map(([n, s]) => ({ n, ok: runGate(s) }));
assertions.push(assert('gates_pass_at_baseline', baseline.every(b => b.ok), { baseline }));

// ── 2. 음성 대조군 ───────────────────────────────────────────────────────
const CASES = [
  {
    label: 'nav: 없는 패널을 가리키는 사이드바 항목',
    script: 'tools/libra_gui_nav_path_test.cjs',
    file: path.join(PARTS, '15-gui-and-exports.js'),
    mutate: (s) => s.replace('data-tab="worldline" data-view-tab="worldline"', 'data-tab="no-such-panel" data-view-tab="no-such-panel"', 1)
  },
  {
    label: 'runtime: 시각 형식을 로케일 의존으로 회귀',
    script: 'tools/libra_gui_renderer_runtime_test.cjs',
    file: path.join(PARTS, '01f-lore-consolidation.js'),
    mutate: (s) => s.replace("const p2 = (v) => String(v).padStart(2, '0');",
      "const p2 = (v) => String(v).padStart(2, '0'); const _x = new Date(ms).toLocaleString('ko-KR');", 1)
  },
  {
    label: 'runtime: 계약 파일에서 GUI 스코프 esc 사용',
    script: 'tools/libra_gui_renderer_runtime_test.cjs',
    file: path.join(PARTS, '01f-lore-consolidation.js'),
    mutate: (s) => s.replace('${meta.map(text).join(\' · \')}', '${meta.map(esc).join(\' · \')}', 1)  // 참조 형태 — 실제 밟은 결함
  },
  {
    label: 'markup: 닫는 div 하나 제거',
    script: 'tools/libra_gui_markup_balance_test.cjs',
    file: path.join(PARTS, '15-gui-and-exports.js'),
    mutate: (s) => {
      const i = s.indexOf('<div id="tab-worldline" class="panel">');
      const first = s.slice(i, i + 400).indexOf('</div>');
      return s.slice(0, i + first) + s.slice(i + first + 6);
    }
  }
];

const results = [];
for (const c of CASES) {
  const original = fs.readFileSync(c.file, 'utf8');
  let caught = false, mutated = false;
  try {
    const broken = c.mutate(original);
    mutated = broken !== original;
    if (mutated) {
      fs.writeFileSync(c.file, broken, 'utf8');
      caught = !runGate(c.script);
    }
  } finally {
    fs.writeFileSync(c.file, original, 'utf8');
  }
  results.push({ label: c.label, mutated, caught });
}

assertions.push(assert('negative_controls_are_caught',
  results.every(r => r.mutated && r.caught),
  { results, note: '변이가 적용되지 않았거나(mutated=false) 게이트가 놓쳤다(caught=false)' }));

// ── 3. 복원 후 재통과 ────────────────────────────────────────────────────
const after = GATES.map(([n, s]) => ({ n, ok: runGate(s) }));
assertions.push(assert('gates_pass_after_restore', after.every(b => b.ok), { after }));

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
