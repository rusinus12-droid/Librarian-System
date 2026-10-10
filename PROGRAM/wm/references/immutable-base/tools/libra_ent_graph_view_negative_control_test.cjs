'use strict';
// 변이 대조군 (A): 인물 그래프 게이트가 실제로 결함을 잡는가.
//
//   M1: 인물당 기억 상한을 무시한다 (전부 담는다) → P3 무너져야 한다
//   M2: 인물 뷰가 그래프 없어도 그린다 → P4 무너져야 한다
//   M3: 인물 보기가 목록을 숨기지 않는다 → P5 무너져야 한다 (표/목록 겹침)
//   M4: 인물 화면이 메모리 화면 id 를 쓴다 → P7 무너져야 한다
//   M5: 인물 보기 토글 제거 → P1 무너져야 한다
//
// ⚠️ 소스 변이 게이트다. 잠금 + 원복 검증 + 기준선 건강 플래그. 회귀와 동시 실행 금지.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_GUI = path.join(ROOT, 'src', 'parts', '15-gui-and-exports.js');
const SRC_10J = path.join(ROOT, 'src', 'parts', '10j-memory-public-lore-schema-api.js');
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
    name: 'M1: 인물당 기억 상한을 무시한다 → P3 위반',
    file: SRC_10J,
    apply: (s) => {
      const from = "                        if (n >= memPerEntity) continue;";
      const to = "                        if (n >= 100000) continue;";
      if (!s.includes(from)) throw new Error('M1 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M2: 인물 뷰가 그래프 없어도 그린다 → P4 위반',
    file: SRC_10J,
    apply: (s) => {
      // getHmeCharacterGraphView 의 "없다" 반환을 성공으로 위장 (한 줄).
      const from = "                    if (!graph) return { ok: false, reason: 'no_graph_cached', scopeKey: key, nodes: [], edges: [] };\n                    const memPerEntity =";
      const fromCrlf = from.replace(/\n/g, '\r\n');
      const useFrom = s.includes(from) ? from : fromCrlf;
      if (!s.includes(useFrom)) throw new Error('M2 anchor not found');
      const nl = useFrom.includes('\r\n') ? '\r\n' : '\n';
      const to = ["                    if (!graph) return { ok: true, reason: '', scopeKey: key, nodes: [{ id: 'forced', rowId: 'x', nodeType: 'entity', label: '강제', turn: 1 }], edges: [] };",
                  "                    const memPerEntity ="].join(nl);
      return s.replace(useFrom, to);
    }
  },
  {
    // ⚠️ 실측 함정: "목록을 숨기지 않는다" 변이는 MISS 였다 — P5 는 `renderEntGraph()` 를
    //    **직접** 부르므로 목록 숨김과 무관하다. P5 가 겨냥하는 것은 "인물 뷰가 실제로 그려지는가" 다.
    //    그래서 인물 뷰가 **노드를 안 담게** 만들어야 부하를 진다.
    name: 'M3: 인물 뷰가 노드를 담지 않는다 → P5 위반',
    file: SRC_10J,
    apply: (s) => {
      const from = "                        nodes: Array.from(chosenIds).map(id => {";
      const to = "                        nodes: [].map(id => {";
      if (!s.includes(from)) throw new Error('M3 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M4: 인물 화면이 메모리 화면 id 를 쓴다 → P7 위반',
    file: SRC_15B,
    apply: (s) => {
      const from = "        const GRAPH_TARGET_ENT = { host: '#el-graph', cv: '#el-graph-cv', kpi: '#el-graph-kpi', paths: '#el-graph-paths', card: '#el', table: null };";
      const to = "        const GRAPH_TARGET_ENT = { host: '#ml-graph', cv: '#ml-graph-cv', kpi: '#ml-graph-kpi', paths: '#ml-graph-paths', card: '#el', table: null };";
      if (!s.includes(from)) throw new Error('M4 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M5: 인물 보기 토글을 마크업에서 제거한다 → P1 위반',
    file: SRC_GUI,
    apply: (s) => {
      const from = '<button type="button" data-ent-view="graph">그래프</button>';
      if (!s.includes(from)) throw new Error('M5 anchor not found');
      return s.replace(from, '<span></span>');
    }
  }
];

function runGate() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_ent_graph_view_test.cjs')], {
      stdio: 'pipe', env: { ...process.env, NODE_PATH: '' }
    });
    return { exit: 0 };
  } catch (e) {
    const outS = String(e.stdout || '') + String(e.stderr || '');
    let failed = [];
    try {
      const i = outS.indexOf('{');
      const d = JSON.parse(outS.slice(i, outS.lastIndexOf('}') + 1));
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

  const files = [SRC_GUI, SRC_10J, SRC_15B];
  const backups = new Map(files.map(f => [f, read(f)]));
  const MUST_HAVE = [
    '<button type="button" data-ent-view="graph">그래프</button>',
    "                        if (n >= memPerEntity) continue;",
    "        const GRAPH_TARGET_ENT = { host: '#el-graph', cv: '#el-graph-cv', kpi: '#el-graph-kpi', paths: '#el-graph-paths', card: '#el', table: null };"
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
