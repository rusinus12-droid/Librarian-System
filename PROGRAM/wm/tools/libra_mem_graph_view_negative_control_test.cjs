'use strict';
// 변이 대조군 (A2): 메모리 그래프 보기 게이트가 실제로 결함을 잡는가.
//
//   M1: 그래프 보기에서 표/카드를 숨기지 않는다 → G3 이 무너져야 한다
//   M2: 그래프가 없어도 그린다 (렌더 중 구축) → G4 가 무너져야 한다
//   M3: 뷰 노드를 쓰지 않고 빈 배열을 그린다 → G5 가 무너져야 한다
//   M4: 그래프 보기를 목록 필터가 가로챈다 → G6 이 무너져야 한다
//   M5: 캔버스를 마크업에서 제거한다 → G1 이 무너져야 한다
//
// ⚠️ 소스 변이 게이트다. 잠금 + 원복 검증 + 기준선 건강 플래그를 쓴다. 회귀와 동시 실행 금지.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_GUI = path.join(ROOT, 'src', 'parts', '15-gui-and-exports.js');
const SRC_15B = path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js');
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, data) => {
  let last = null;
  for (let i = 0; i < 8; i += 1) {
    try { fs.writeFileSync(p, data, 'utf8'); return; }
    catch (e) { last = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); }
  }
  throw new Error('write_failed:' + p + ':' + String(last && last.message || last));
};

const MUTATIONS = [
  {
    name: 'M1: 그래프 보기에서 카드/표를 숨기지 않는다 (G3 위반)',
    file: SRC_15B,
    apply: (s) => {
      const from = "                c.classList.add('hide');";
      const to = "                c.classList.remove('hide');";
      if (!s.includes(from)) throw new Error('M1 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M2: `view.ok` 를 무시하고 그린다 (G4 위반)',
    file: SRC_15B,
    apply: (s) => {
      // ⚠️ 실측 함정 2회:
      //   ① `if (false) {` 로 조기 반환을 없애도 MISS — 그 시점 `view.nodes` 가 빈 배열이라
      //      그리는 루프가 안 돌아 **여전히 안 그린다.**
      //   ② 조기 반환 블록을 "가짜 유효 뷰 주입" 으로 바꿔도 MISS — 그 블록은 **반환**하므로
      //      주입한 뷰가 아래로 흘러가지 않는다.
      //   G4 가 실제로 겨냥하는 계약은 `view.ok` 검사다. **그 검사 자체**를 무력화해야 부하를 진다.
      // `view.ok` 를 **무시**하고 진행한다 — 없는 그래프를 그리는 것이 G4 위반이다.
      //   노드도 하나 넣어야 그리는 루프가 실제로 돈다(빈 배열이면 아무것도 안 그려 MISS).
      const from = "            if (!view || view.ok !== true) {";
      const to = "            if (!view) {\r\n                view = { ok: true, nodes: [{ id: 'n_x', rowId: 'm_1', nodeType: 'memory', label: 'm_1', turn: 1 }], edges: [], stats: {} };\r\n            }\r\n            view.ok = true;\r\n            view.nodes = view.nodes && view.nodes.length ? view.nodes : [{ id: 'n_forced', rowId: 'm_1', nodeType: 'memory', label: '강제', turn: 1 }];\r\n            if (!view.ok) {";
      if (!s.includes(from)) throw new Error('M2 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M3: 뷰 노드를 쓰지 않고 빈 배열을 그린다 (G5 위반)',
    file: SRC_15B,
    apply: (s) => {
      const from = "            graphState.nodes = (view.nodes || []).map((n, i) => {";
      const to = "            graphState.nodes = ([]).map((n, i) => {";
      if (!s.includes(from)) throw new Error('M3 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M4: 그래프 보기를 목록 필터가 가로챈다 (G6 위반)',
    file: SRC_15B,
    apply: (s) => {
      const from = "            if (memViewState.view === 'graph') { renderMems(rows); return; }";
      const to = "            if (false) { renderMems(rows); return; }";
      if (!s.includes(from)) throw new Error('M4 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M5: 캔버스를 마크업에서 제거한다 (G1 위반)',
    file: SRC_GUI,
    apply: (s) => {
      const from = '<canvas id="ml-graph-cv"></canvas>';
      if (!s.includes(from)) throw new Error('M5 anchor not found');
      return s.replace(from, '<span></span>');
    }
  }
];

function runGate() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_mem_graph_view_test.cjs')], {
      stdio: 'pipe', env: { ...process.env, NODE_PATH: '' }
    });
    return { exit: 0 };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    let failed = [];
    try {
      const i = out.indexOf('{');
      const d = JSON.parse(out.slice(i, out.lastIndexOf('}') + 1));
      failed = (d.assertions || []).filter(a => !a.ok).map(a => a.name.split(':')[0]);
    } catch (_) {}
    return { exit: e.status == null ? 1 : e.status, failed };
  }
}

(async () => {
  const LOCK = path.join(ROOT, '.negctrl.lock');
  if (fs.existsSync(LOCK)) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 10 * 60 * 1000) {
      console.log(JSON.stringify({ ok: false, reason: 'another_run_active', lockAgeMs: age }, null, 2));
      process.exit(1);
    }
    fs.unlinkSync(LOCK);
  }
  write(LOCK, String(process.pid));

  const files = [SRC_GUI, SRC_15B];
  const backups = new Map(files.map(f => [f, read(f)]));
  const MUST_HAVE = [
    '<canvas id="ml-graph-cv"></canvas>',
    "            if (!view || view.ok !== true) {",
    "                c.classList.add('hide');"
  ];
  for (const needle of MUST_HAVE) {
    if (![...backups.values()].some(v => v.includes(needle))) {
      fs.unlinkSync(LOCK);
      console.log(JSON.stringify({ ok: false, reason: 'source_damaged', missing: needle }, null, 2));
      process.exit(1);
    }
  }

  const results = [];
  try {
    const build = () => execFileSync('npm.cmd', ['run', 'build'], { cwd: ROOT, stdio: 'pipe', shell: true });
    const base = runGate();
    results.push({ name: 'baseline', exit: base.exit, failed: base.failed || [] });

    for (const m of MUTATIONS) {
      const original = backups.get(m.file);
      try {
        write(m.file, m.apply(original));
        build();
        const r = runGate();
        results.push({ name: m.name, exit: r.exit, failed: r.failed || [], caught: r.exit !== 0 });
      } catch (e) {
        results.push({ name: m.name, error: String(e.message).slice(0, 160) });
      } finally {
        write(m.file, original);
      }
    }
    for (const [f, v] of backups) write(f, v);
    const mismatch = [...backups.entries()].filter(([f, v]) => read(f) !== v).map(([f]) => f);
    if (mismatch.length) throw new Error('restore_failed:' + mismatch.join(','));
    build();
    const restored = runGate();
    results.push({ name: 'restored', exit: restored.exit, failed: restored.failed || [] });

    const mutations = results.filter(r => r.name !== 'baseline' && r.name !== 'restored');
    const caught = mutations.filter(r => r.caught === true).length;
    const baselineHealthy = base.exit === 0;
    const summary = {
      ok: baselineHealthy && restored.exit === 0 && caught === mutations.length && mutations.length > 0,
      caught, total: mutations.length,
      missed: mutations.filter(r => !r.caught).map(r => r.name),
      baselineHealthy,
      baselineWarning: baselineHealthy ? '' : '기준선이 실패했다 — 변이 판정을 신뢰할 수 없다. 단독으로 다시 돌려라.',
      baselineExit: base.exit, restoredExit: restored.exit, results
    };
    try { fs.unlinkSync(LOCK); } catch (_) {}
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.ok ? 0 : 1);
  } finally {
    try { fs.unlinkSync(LOCK); } catch (_) {}
  }
})();
