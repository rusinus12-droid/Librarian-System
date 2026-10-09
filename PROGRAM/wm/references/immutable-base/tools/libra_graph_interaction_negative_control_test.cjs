'use strict';
// 변이 대조군 (C): 그래프 상호작용 게이트가 실제로 결함을 잡는가.
//
//   M1: hit test 가 좌표 변환을 빼먹는다 → C2 무너져야 한다
//   M2: 인물 클릭이 프로필을 안 연다 → C3 무너져야 한다
//   M3: 기억 클릭이 검색어를 안 채운다 → C4 무너져야 한다
//   M4: 로어 클릭이 없는 화면으로 이동한다 → C5 무너져야 한다
//   M5: 배선이 중복 바인딩된다 → C1 무너져야 한다
//   M6: 빈 곳 클릭이 동작한다 → C6 무너져야 한다
//
// ⚠️ 소스 변이 게이트다. 잠금 + 원복 검증 + 기준선 건강 플래그. 회귀와 동시 실행 금지.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
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
    name: 'M1: hit test 가 좌표 변환을 빼먹는다 → C2 위반',
    file: SRC_15B,
    apply: (s) => {
      const from = '            const wx = (clientX - rect.left - graphState.tx) / graphState.scale;';
      const to = '            const wx = clientX;';
      if (!s.includes(from)) throw new Error('M1 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M2: 인물 클릭이 프로필을 안 연다 → C3 위반',
    file: SRC_15B,
    apply: (s) => {
      const from = '            renderEntityProfile(idx);';
      const to = '            /* no-op */';
      if (!s.includes(from)) throw new Error('M2 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M3: 기억 클릭이 검색어를 안 채운다 → C4 위반',
    file: SRC_15B,
    apply: (s) => {
      const from = "            if (search) search.value = key;";
      const to = "            if (search) search.value = '';";
      if (!s.includes(from)) throw new Error('M3 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M4: 로어 클릭이 없는 화면으로 이동한다 → C5 위반',
    file: SRC_15B,
    apply: (s) => {
      const from = '            graphState.pinned = node.id;';
      const to = "            graphState.pinned = node.id;\n            switchTab('memory');";
      if (!s.includes(from)) throw new Error('M4 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M5: 배선이 중복 바인딩된다 → C1 위반',
    file: SRC_15B,
    apply: (s) => {
      const from = "            if (!cv || cv.dataset.bound === '1') return;";
      const to = "            if (!cv) return;";
      if (!s.includes(from)) throw new Error('M5 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    name: 'M6: 빈 곳 클릭이 동작한다 → C6 위반',
    file: SRC_15B,
    apply: (s) => {
      const from = '        const graphActivateNode = (TID, node) => {\n            if (!node) return;';
      const fromCrlf = from.replace(/\n/g, '\r\n');
      const useFrom = s.includes(from) ? from : fromCrlf;
      if (!s.includes(useFrom)) throw new Error('M6 anchor not found');
      const nl = useFrom.includes('\r\n') ? '\r\n' : '\n';
      return s.replace(useFrom, ['        const graphActivateNode = (TID, node) => {',
        "            if (!node) { switchTab('memory'); return; }"].join(nl));
    }
  }
];

function runGate() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_graph_interaction_test.cjs')], {
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

  const backups = new Map([[SRC_15B, read(SRC_15B)]]);
  const MUST_HAVE = [
    '            const wx = (clientX - rect.left - graphState.tx) / graphState.scale;',
    '            renderEntityProfile(idx);',
    "            if (search) search.value = key;"
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
