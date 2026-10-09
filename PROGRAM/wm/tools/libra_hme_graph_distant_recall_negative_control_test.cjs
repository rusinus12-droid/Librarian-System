'use strict';
// 변이 대조군 (B): 원거리 회수 게이트가 **실제로 결함을 잡는가**.
//
// 각 변이는 "그 기능이 없으면 이 주장이 FAIL 로 뒤집혀야 한다" 를 요구한다.
//   M1: 그래프 비활성 → A1(원거리 회수)·A3(허브 경유)·A4(회상 변경) 가 무너져야 한다
//   M2: 허브를 frontier 에서 제외 → A3 이 무너져야 한다 (2홉 불가)
//   M3: 허브를 visited 로 소진 → A3 이 무너져야 한다
//
// ⚠️ 변이는 **배포본 소스**에 적용하고 빌드는 하지 않는다 — VM 이 그 소스를 직접 읽으므로
//    빌드 산출물(dist)을 건드리면 원복 누락 위험이 커진다.
//    대신 dist 를 임시로 백업/복원한다(빌드 1회 필요).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_10C = path.join(ROOT, 'src', 'parts', '10c-hme-associative-graph.js');
const SRC_14 = path.join(ROOT, 'src', 'parts', '14-main-initialization.js');
const SRC_01H = path.join(ROOT, 'src', 'parts', '01h-projection-reset.js');

const NL = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const read = (p) => fs.readFileSync(p, 'utf8');
// Windows 에서 writeFileSync 가 `UNKNOWN: unknown error, open ...` 로 실패하는 경우가 있다
//   (파일 잠금·인덱서). 실패하면 **원복이 안 되고 변이 잔재가 남는다** — 실측으로 겪었다.
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
    // ⚠️ 값을 고정하는 지점이 **두 곳**이다 — 01h 숨은 기본값 + 14 마이그레이션.
    //    한 곳만 치면 다른 곳이 복원해 변이가 무효가 된다(실측: 01h 만 치면 MISS).
    name: 'M1: maxHops 를 1 로 (2홉 불가 — 허브 경유 죽음)',
    file: SRC_01H,
    apply: (s) => {
      const from = `        hmeGraphMaxHops: 2,`;
      const to = `        hmeGraphMaxHops: 1,`;
      if (!s.includes(from)) throw new Error('M1 anchor not found');
      return s.replace(from, to);
    },
    also: [{
      file: SRC_14,
      apply: (s) => {
        // 마이그레이션이 1 을 2 로 되돌리지 못하게 상한을 0 으로 낮춘다(값 자체는 1 유지).
        const n = NL(s);
        const from = `    if (!await hasRuntimeArgValue('hme_graph_max_hops') && Number(cfg.hmeGraphMaxHops || 0) <= 1) {`;
        const to = `    if (false && !await hasRuntimeArgValue('hme_graph_max_hops') && Number(cfg.hmeGraphMaxHops || 0) <= 1) {`;
        if (!s.includes(from)) throw new Error('M1b anchor not found');
        return s.replace(from, to);
      }
    }]
  },
  {
    // ⚠️ 실측: E1(mentions_entity) 의 layer 는 **'meaning'** 이다. 그래서
    //    `layer === 'meaning' || isHubNode` 에서 허브 분기를 없애도 meaning 분기가 살려
    //    변이가 MISS 였다. 진짜로 2홉을 죽이려면 **허브 도달 자체**를 끊어야 한다.
    // ⚠️ 실측 함정: 관계명을 `mentions_entity_disabled` 로 바꿔도 게이트가 통과했다 —
    //    판정이 `.includes('mentions_entity')` 라서 **substring 이 살아있다**.
    //    변이는 판정 문자열과 겹치지 않는 이름으로 바꿔야 유효하다.
    name: 'M2: 허브 엣지(E1)를 완전히 다른 관계명으로 (substring 회피)',
    file: SRC_10C,
    apply: (s) => {
      const from = "push(memory, entity, 'mentions_entity', 'meaning', weight,";
      const to = "push(memory, entity, 'zz_other_edge', 'meaning', weight,";
      if (!s.includes(from)) throw new Error('M2 anchor not found');
      return s.replace(from, to);
    }
  },
  {
    // ⚠️ 실측: `isHubNode = false` 변이는 MISS 였다 — E1(mentions_entity) 이 `meaning` layer 라서
    //    허브 분기가 없어도 meaning 분기가 허브를 frontier 에 넣는다. 즉 그 분기는 이 시나리오에서
    //    **부하를 지지 않는다.** 부하를 지는 곳은 meaning 엣지의 frontier 진입 그 자체다.
    name: 'M3: meaning 엣지의 frontier 진입 제거 (2홉 통로 자체를 끊는다)',
    file: SRC_10C,
    apply: (s) => {
      const line = "if (hop < preset.maxHops && preset.maxHops > 1 && (layer === 'meaning' || isHubNode)) {";
      if (!s.includes(line)) throw new Error('M3 anchor not found');
      return s.replace(line, "if (false) {");
    }
  }
];

function runGate() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_hme_graph_distant_recall_test.cjs')], {
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

function build() {
  execFileSync('npm.cmd', ['run', 'build'], { cwd: ROOT, stdio: 'pipe', shell: true });
}

(async () => {
  // 동시 실행 방지 — 여러 인스턴스가 같은 소스를 변이하면 원복이 서로를 덮어써
  // **손상된 소스가 남는다**(실측: M2 변이 잔재가 원복되지 않고 남았다).
  //   잠금 파일로 단일 실행을 보장하고, 시작 시 잔재를 검사한다.
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
  const backups = new Map();
  for (const f of [SRC_10C, SRC_14, SRC_01H]) backups.set(f, read(f));
  // 시작 시 변이 잔재 검사 — 이전 실행이 원복에 실패했으면 즉시 중단한다.
  const MUST_HAVE = [
    'if (hop < preset.maxHops && preset.maxHops > 1 && (layer === \'meaning\' || isHubNode)) {',
    'if (!isHubNode) visited.add(nextNode.id);',
    'hmeGraphMaxHops: 2,'
  ];
  for (const needle of MUST_HAVE) {
    const hit = [...backups.values()].some(v => v.includes(needle));
    if (!hit) {
      fs.unlinkSync(LOCK);
      console.log(JSON.stringify({ ok: false, reason: 'source_damaged', missing: needle }, null, 2));
      process.exit(1);
    }
  }

  // 기준선
  const base = runGate();
  results.push({ name: 'baseline', exit: base.exit, failed: base.failed || [] });

  for (const m of MUTATIONS) {
    const touched = [[m.file, backups.get(m.file), m.apply]];
    for (const a of (m.also || [])) touched.push([a.file, backups.get(a.file), a.apply]);
    try {
      for (const [file, original, apply] of touched) write(file, apply(original));
      build();
      const r = runGate();
      results.push({ name: m.name, exit: r.exit, failed: r.failed || [], caught: r.exit !== 0 });
    } catch (e) {
      results.push({ name: m.name, error: String(e.message).slice(0, 160) });
    } finally {
      for (const [file, original] of touched) write(file, original);
    }
  }
  // 원복 + 재빌드
  for (const [f, v] of backups) write(f, v);
  // 원복이 **실제로** 됐는지 확인한다 — 쓰기 실패가 조용히 넘어가면 변이 잔재가 남는다.
  const restoreMismatch = [...backups.entries()].filter(([f, v]) => read(f) !== v).map(([f]) => f);
  if (restoreMismatch.length) throw new Error('restore_failed:' + restoreMismatch.join(','));
  build();
  const restored = runGate();
  results.push({ name: 'restored', exit: restored.exit, failed: restored.failed || [] });

  const mutations = results.filter(r => r.name !== 'baseline' && r.name !== 'restored');
  const caught = mutations.filter(r => r.caught === true).length;
  try { fs.unlinkSync(LOCK); } catch (_) {}
  // 기준선이 실패하면 변이 판정을 신뢰할 수 없다(이전 실행과 겹쳤을 가능성 — 실측으로 겪었다).
  const baselineHealthy = base.exit === 0;
  const summary = {
    ok: baselineHealthy && restored.exit === 0 && caught === mutations.length && mutations.length > 0,
    caught, total: mutations.length, missed: mutations.filter(r => !r.caught).map(r => r.name),
    baselineHealthy,
    baselineWarning: baselineHealthy ? '' : '기준선이 실패했다 — 변이 판정을 신뢰할 수 없다. 단독으로 다시 돌려라.',
    baselineExit: base.exit, restoredExit: restored.exit, results
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
})();
