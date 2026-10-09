'use strict';
// 변이 대조군 (A): 관계 그래프 게이트가 실제로 결함을 잡는가.
//
//   M1: 인물 중심 뷰가 기억 노드까지 담는다 → R3 무너져야 한다
//   M2: 관계 뷰가 그래프가 없어도 그린다 → R4 무너져야 한다
//   M3: 공용 렌더러가 메모리 화면을 깨뜨린다 (KPI 라벨 하드코딩) → R6 무너져야 한다
//   M4: 두 화면이 같은 대상 id 를 쓴다 → R7 무너져야 한다
//   M5: 관계 보기 토글 제거 → R1 무너져야 한다
//
// ⚠️ 소스 변이 게이트다. 잠금 + 원복 검증 + 기준선 건강 플래그. 회귀와 동시 실행 금지.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_GUI = path.join(ROOT, 'src', 'parts', '15-gui-and-exports.js');
const SRC_10J = path.join(ROOT, 'src', 'parts', '10j-memory-public-lore-schema-api.js');
const SRC_15B = path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js');
const SRC_15D = path.join(ROOT, 'src', 'parts', '15d-gui-events-finalize.js');
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
    name: 'M1: 인물 중심 뷰가 기억 노드까지 담는다 (R3 위반)',
    file: SRC_10J,
    apply: (s) => {
      const from = "                    const hubs = all.filter(n => String(n.nodeType || '') === 'entity').slice(0, 64);";
      const to = "                    const hubs = all.slice(0, 64);";
      if (!s.includes(from)) throw new Error('M1 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M2: 관계 뷰가 그래프 없어도 그린다 (R4 위반)',
    file: SRC_10J,
    apply: (s) => {
      // ⚠️ 두 줄 앵커는 CRLF 함정에 걸린다(10j 는 CRLF). **한 줄**만 바꾼다 —
      //    "없다" 반환을 성공으로 위장하면 R4 가 무너진다.
      const from = "                    if (!graph) return { ok: false, reason: 'no_graph_cached', scopeKey: key, nodes: [], edges: [] };";
      const to = "                    if (!graph) return { ok: true, reason: '', scopeKey: key, nodes: [{ id: 'forced', rowId: 'x', nodeType: 'entity', label: '강제', turn: 1 }], edges: [] };";
      if (!s.includes(from)) throw new Error('M2 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M3: 공용 렌더러가 메모리 화면 KPI 를 깨뜨린다 (R6 위반)',
    file: SRC_15B,
    apply: (s) => {
      // 메모리 KPI 에서 '로어' 라벨을 없앤다 — 공용화가 화면별 계약을 망가뜨린 상황.
      const from = "                    ['로어', types.lore || 0]";
      if (!s.includes(from)) throw new Error('M3 anchor not found');
      return s.replace(from, "                    ['기타', types.lore || 0]");
    }
  },
  {
    name: 'M4: 두 화면이 같은 대상 id 를 쓴다 (R7 위반)',
    file: SRC_15B,
    apply: (s) => {
      const from = "        const GRAPH_TARGET_REL = { host: '#rl-graph', cv: '#rl-graph-cv', kpi: '#rl-graph-kpi', paths: '#rl-graph-paths', card: '#rl', table: null };";
      const to = "        const GRAPH_TARGET_REL = { host: '#ml-graph', cv: '#ml-graph-cv', kpi: '#ml-graph-kpi', paths: '#ml-graph-paths', card: '#rl', table: null };";
      if (!s.includes(from)) throw new Error('M4 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M5: 관계 보기 토글을 마크업에서 제거한다 (R1 위반)',
    file: SRC_GUI,
    apply: (s) => {
      const from = '<button type="button" data-rel-view="graph">그래프</button>';
      if (!s.includes(from)) throw new Error('M5 anchor not found');
      return s.replace(from, '<span></span>');
    }
  }
];

function runGate() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_rel_graph_view_test.cjs')], {
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

  const files = [SRC_GUI, SRC_10J, SRC_15B, SRC_15D];
  const backups = new Map(files.map(f => [f, read(f)]));
  const MUST_HAVE = [
    '<button type="button" data-rel-view="graph">그래프</button>',
    "                    const hubs = all.filter(n => String(n.nodeType || '') === 'entity').slice(0, 64);",
    "        const GRAPH_TARGET_REL = { host: '#rl-graph', cv: '#rl-graph-cv', kpi: '#rl-graph-kpi', paths: '#rl-graph-paths', card: '#rl', table: null };"
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
