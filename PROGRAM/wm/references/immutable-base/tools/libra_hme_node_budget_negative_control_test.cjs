'use strict';
// 변이 대조군 (B): 노드 예산 게이트가 실제로 결함을 잡는가.
//
//   M1: 종류별 reserve 를 없앤다 (전부 turn 정렬) → N1 무너져야 한다
//   M2: lore reserve 를 상한 없이 (무제한) → N2 무너져야 한다
//   M3: 뷰가 그래프 전량을 담는다 (화면 상한 제거) → N3 무너져야 한다
//   M4: 상한 아래에서도 절단한다 (maxNodes 축소) → N5 무너져야 한다
//
// ⚠️ 소스 변이 게이트다. 잠금 + 원복 검증 + 기준선 건강 플래그. 회귀와 동시 실행 금지.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_10C = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
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
    name: 'M1: 종류별 reserve 를 없앤다 (turn 정렬만) → N1 위반',
    file: SRC_10C,
    apply: (s) => {
      // reserve 를 0 으로 → entity/lore 가 turn 정렬에서 전부 밀려난다.
      const a = 'const entityReserve = Math.max(32, Math.floor(maxNodes * 0.08));';
      const b = 'const loreReserve = Math.max(48, Math.floor(maxNodes * 0.12));';
      if (!s.includes(a) || !s.includes(b)) throw new Error('M1 anchor not found');
      return s.replace(a, 'const entityReserve = 0;').replace(b, 'const loreReserve = 0;');
    }
  },
  {
    name: 'M2: lore reserve 를 무제한으로 → N2 위반',
    file: SRC_10C,
    apply: (s) => {
      const from = 'const loreReserve = Math.max(48, Math.floor(maxNodes * 0.12));';
      const to = 'const loreReserve = 100000;';
      if (!s.includes(from)) throw new Error('M2 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M3: 뷰가 그래프 전량을 담는다 (화면 상한 제거) → N3 위반',
    file: SRC_10C,
    apply: (s) => {
      const from = "            const chosen = [...pick('memory', 260), ...pick('entity', 48), ...pick('lore', 36)];";
      const to = "            const chosen = [...pick('memory', 100000), ...pick('entity', 100000), ...pick('lore', 100000)];";
      if (!s.includes(from)) throw new Error('M3 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M4: 상한 아래에서도 절단한다 → N5 위반',
    file: SRC_10C,
    apply: (s) => {
      // ⚠️ 실측 함정: 절단 조건만 무력화(`if (!Array.isArray(nodes)) return [];`)하면 MISS 였다 —
      //    reserve 가 그대로라 작은 그래프도 **전부 보존**된다(절단 경로를 타도 안 줄어든다).
      //    N5 가 재는 것은 "상한 아래에서 절단이 없다" 이므로 **상한 자체를 낮춰야** 부하를 진다.
      //    maxNodes 를 64 로 낮추면 208 노드 그래프가 잘려 N5 가 무너진다.
      const from = "            const maxNodes = Math.max(128, Number(preset.maxNodes || 1200) || 1200);";
      const to = "            const maxNodes = 64;";
      if (!s.includes(from)) throw new Error('M4 anchor not found');
      return s.replace(from, to);
    }
  }
];

function runGate() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_hme_node_budget_test.cjs')], {
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

  const backups = new Map([[SRC_10C, read(SRC_10C)]]);
  const MUST_HAVE = [
    'const entityReserve = Math.max(32, Math.floor(maxNodes * 0.08));',
    'const loreReserve = Math.max(48, Math.floor(maxNodes * 0.12));',
    "            const chosen = [...pick('memory', 260), ...pick('entity', 48), ...pick('lore', 36)];"
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
