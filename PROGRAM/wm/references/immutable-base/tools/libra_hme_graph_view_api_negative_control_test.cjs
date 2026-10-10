'use strict';
// 변이 대조군 (A1): 그래프 뷰 API 게이트가 실제로 결함을 잡는가.
//
//   M1: 그래프가 없을 때 **만들어 버린다** → V5 가 무너져야 한다 (GUI 렌더 중 구축 = 렉)
//   M2: 뷰가 노드를 임의 생성한다 → V2 가 무너져야 한다
//   M3: 균일 절단으로 entity/lore 를 밀어낸다 → V3 이 무너져야 한다
//   M4: 엣지 끝점 노드를 담지 않는다 → V4 가 무너져야 한다
//
// ⚠️ 소스 변이 게이트다. 잠금 파일로 단일 실행을 보장하고, 시작 시 원복 잔재를 검사한다.
//    **회귀와 동시에 돌리지 마라.**
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_10J = path.join(ROOT, 'src', 'parts', '10j-memory-public-lore-schema-api.js');
const SRC_10C = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
const read = (p) => fs.readFileSync(p, 'utf8');
// Windows 에서 writeFileSync 가 `UNKNOWN: unknown error, open ...` 로 실패하는 경우가 있다
//   (파일 잠금·인덱서). 실패하면 **원복이 안 되고 변이 잔재가 남는다** — 실측으로 겪었다.
//   쓰기는 재시도하고, 실패하면 예외를 올려 조용히 넘어가지 않게 한다.
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
    name: 'M1: 그래프가 없으면 만들어 버린다 (V5 위반)',
    file: SRC_10J,
    apply: (s) => {
      // "없다고 알린다" 계약을 위반한다 — 대신 그래프를 만들어 반환한다(렌더 중 구축).
      //   구조를 깨지 않도록 **반환문 하나만** 바꾼다: 캐시에 그래프가 없을 때 빈 뷰 대신
      //   ok:true 로 돌려주면 V5(있으면 안 되는 성공)가 무너진다.
      const from = "                        return { ok: false, reason: 'no_graph_cached', scopeKey: key, nodes: [], edges: [] };";
      const to = "                        return { ok: true, reason: '', scopeKey: key, nodes: [{ id: 'built_now', rowId: 'x', nodeType: 'memory', label: '즉석구축', kind: 'memory', turn: 1 }], edges: [] };";
      if (!s.includes(from)) throw new Error('M1 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M2: 뷰가 노드를 임의 생성한다 (V2 위반)',
    file: SRC_10J,
    apply: (s) => {
      const from = '                    const viewNodes = hmeGraphSampleNodes(graph);';
      const to = '                    const viewNodes = [{ id: \'fake_1\', rowId: \'x\', nodeType: \'memory\', label: \'가짜\', kind: \'memory\', turn: 1 }];';
      if (!s.includes(from)) throw new Error('M2 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M3: 균일 절단으로 entity/lore 를 밀어낸다 (V3 위반)',
    file: SRC_10C,
    apply: (s) => {
      const from = "            const chosen = [...pick('memory', 260), ...pick('entity', 48), ...pick('lore', 36)];";
      const to = "            const chosen = all.slice(0, 260);";
      if (!s.includes(from)) throw new Error('M3 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M4: 엣지 끝점 노드를 담지 않는다 (V4 위반)',
    file: SRC_10C,
    apply: (s) => {
      // ⚠️ 실측 함정: `return [...].concat(hmeGraphEdges(graph))` 로 바꾸면 뒤따르는 `.filter(...)`
      //    가 그대로 적용돼 **엣지가 걸러져 변이가 무효**가 된다(MISS).
      //    필터 자체를 통과시키도록 **술어**를 바꾼다 — 끝점 검사를 무력화한다.
      const line = '.filter(e => ids.has(e.from) && ids.has(e.to))';
      if (!s.includes(line)) throw new Error('M4 anchor not found');
      return s.replace(line, '.filter(e => true)');
    }
  }
];

function runGate() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_hme_graph_view_api_test.cjs')], {
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

const build = () => execFileSync('npm.cmd', ['run', 'build'], { cwd: ROOT, stdio: 'pipe', shell: true });

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
  fs.writeFileSync(LOCK, String(process.pid));

  const results = [];
  const files = [SRC_10J, SRC_10C];
  const backups = new Map(files.map(f => [f, read(f)]));
  // 원복 잔재 검사
  const MUST_HAVE = [
    "const viewNodes = hmeGraphSampleNodes(graph);",
    "return { ok: false, reason: 'no_graph_cached', scopeKey: key, nodes: [], edges: [] };",
    "const chosen = [...pick('memory', 260), ...pick('entity', 48), ...pick('lore', 36)];"
  ];
  for (const needle of MUST_HAVE) {
    if (![...backups.values()].some(v => v.includes(needle))) {
      fs.unlinkSync(LOCK);
      console.log(JSON.stringify({ ok: false, reason: 'source_damaged', missing: needle }, null, 2));
      process.exit(1);
    }
  }

  try {
    const base = runGate();
    results.push({ name: 'baseline', exit: base.exit, failed: base.failed || [] });

    for (const m of MUTATIONS) {
      const original = backups.get(m.file);
      try {
        write(m.file, m.apply(original), 'utf8');
        build();
        const r = runGate();
        results.push({ name: m.name, exit: r.exit, failed: r.failed || [], caught: r.exit !== 0 });
      } catch (e) {
        results.push({ name: m.name, error: String(e.message).slice(0, 160) });
      } finally {
        write(m.file, original, 'utf8');
      }
    }
    for (const [f, v] of backups) write(f, v);
    // 원복이 **실제로** 됐는지 확인한다 — 쓰기 실패가 조용히 넘어가면 변이 잔재가 남는다.
    const restoreMismatch = [...backups.entries()].filter(([f, v]) => read(f) !== v).map(([f]) => f);
    if (restoreMismatch.length) throw new Error('restore_failed:' + restoreMismatch.join(','));
    build();
    const restored = runGate();
    results.push({ name: 'restored', exit: restored.exit, failed: restored.failed || [] });

    const mutations = results.filter(r => r.name !== 'baseline' && r.name !== 'restored');
    const caught = mutations.filter(r => r.caught === true).length;
    // ⚠️ 기준선이 실패했는데 변이가 "CAUGHT" 로 세어지면 **오염된 실행**이다.
    //    실측: 이전 프로세스의 빌드가 끝나기 전에 시작해 baseline 이 V5 로 실패했고,
    //    그 상태에서 M1 이 'CAUGHT' 로 집계됐다 — 변이가 아니라 오염의 결과였다.
    //    기준선이 실패하면 전체를 실패로 돌리고 원인을 밝힌다.
    const baselineHealthy = base.exit === 0;
    const summary = {
      ok: baselineHealthy && restored.exit === 0 && caught === mutations.length && mutations.length > 0,
      caught, total: mutations.length,
      missed: mutations.filter(r => !r.caught).map(r => r.name),
      baselineHealthy,
      baselineWarning: baselineHealthy ? '' : '기준선이 실패했다 — 이 실행의 변이 판정은 신뢰할 수 없다(이전 실행과 겹쳤을 가능성). 단독으로 다시 돌려라.',
      baselineExit: base.exit, restoredExit: restored.exit, results
    };
    try { fs.unlinkSync(LOCK); } catch (_) {}
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.ok ? 0 : 1);
  } finally {
    try { fs.unlinkSync(LOCK); } catch (_) {}
  }
})();
