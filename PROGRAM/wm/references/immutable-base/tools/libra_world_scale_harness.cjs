'use strict';
// 스케일 하네스 — 97턴 원본을 **손대지 않고** 턴을 늘려 노드 분기·주입 예산을 잰다.
//
// 왜 별도 파일인가: `libra_97_test_harness.cjs` 는 이미 97턴 37단언 게이트로 확립돼 있다.
//   거기에 확대용 mock 을 섞으면 기존 게이트의 의미가 바뀐다. 대신 원본을 **실행 시점에
//   변형**해 넣는다(소스 파일은 그대로).
//
// 확대가 바꾸는 것 (그리고 바꾸지 않는 것):
//   바꾼다  — TURN_COUNT(기본 300) · mock 의 world 패킷에 주기적 `dimensionalShifts`
//   안 바꾼다 — 출하 프롬프트·파이프라인·정본 코드. 실행되는 제품은 동일하다.
//
// ★ 원본 97턴 하네스에서 노드가 1개였던 진짜 이유:
//   mock 이 `dimensionalShifts` 를 **한 번도 내지 않아서**다(노드 생성 경로 `05k:200` 의
//   두 번째 조건 `allowDimensionalShift` 가 영원히 false). 실모델은 낸다(`e14f8a7` 실측).
//   그래서 "노드 분기가 실제로 도는가"는 97턴으로는 **판정 불가**였다 —
//   이 하네스가 그 판정을 가능하게 한다.
//
// 측정: 노드 수 · 계층 깊이 · 활성 위치 수(멀티노드) · 규칙 팩트 수 · 주입 텍스트 길이/토큰
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'tools', 'libra_97_test_harness.cjs');
const OUT_DIR = path.join(ROOT, 'test-output');
const TURNS = Math.max(5, Number(process.env.LIBRA_SCALE_TURNS || 300) || 300);
const SHIFT_EVERY = Math.max(2, Number(process.env.LIBRA_SCALE_SHIFT_EVERY || 20) || 20);
const RUN_ID = `scale-${TURNS}t-every${SHIFT_EVERY}-${Date.now()}`;
// ★ 하네스는 `__dirname` 기준으로 `../dist` 를 연다. 임시 폴더에 복사해 돌리면
//   `AppData/Local/dist/...` 를 찾다 죽는다(실측). **tools/ 안에** 변형본을 만들어 제자리 실행한다.
const WORK = path.join(ROOT, 'tools', `.libra_scale_${Date.now()}.cjs`);

let src = fs.readFileSync(SOURCE, 'utf8');
const before = src.length;

// ── ① mock 의 world 패킷에 주기적 dimensionalShifts 를 넣는다 ──
//   makeCanonicalPacket 은 turn 을 프롬프트에서 읽는다 — 그 turn 을 기준으로 주기 판정한다.
// ★ 앵커 교정 (실측으로 원인 확정):
//   종전 앵커는 `makeCanonicalPacket` 의 `packet.world` **정의부**였는데, mock 의
//   `afterrequest-analysis-bundle` 이 world 를 **필드별로 하나씩 복사**한다(하네스 279-292):
//     world: { tech: packet.world.tech, summary: …, rules: packet.world.rules, custom: {} }
//   → `packet.world` 에 넣은 dimensionalShifts 는 **복사 목록에 없어 버려진다**.
//   계측 실측: `p5k=1`(05k 는 매 턴 실행), `rec=true`(커밋 정상), `entityResult.world` 존재,
//   그러나 `shifts=-1`(없음). 즉 하네스가 05k 를 안 태운 게 아니라 **mock 이 안 냈다**.
//   → 주입 지점을 **복사 목록 안**(`custom: {}` 앞)으로 옮긴다.
// ★ 앵커 교정 (실측): 종전 앵커는 `structuredSnapshotFromPacket` 의 world 였는데,
//   실제 소비 경로는 mockLLMCall 의 `entityExtraction.world` 다(#3 에서 확정).
//   종전 앵커에 주입하면 노드가 1개로 고정됐다(실측).
const ANCHOR = `        world: packet.world,
        conflicts: [],`;
if (!src.includes(ANCHOR)) {
  console.error('[scale] world 패킷 앵커를 찾지 못했다 — 원본이 바뀌었는지 확인하라');
  process.exit(2);
}
const SHIFT_BLOCK = `        world: {
          ...packet.world,
          ...((packet.meta.turn % ${SHIFT_EVERY} === 0) ? {
            dimensionalShifts: [{
              from: '루멘 아카데미',
              to: '그림자 영역 ' + Math.floor(packet.meta.turn / ${SHIFT_EVERY}),
              type: 'portal'
            }]
          } : {})
        },
        conflicts: [],`;
src = src.replace(ANCHOR, SHIFT_BLOCK);

// ── ② 확대 측정을 결과에 싣는다 (원본 단언은 그대로 둔다) ──
//   세계 그래프 요약에 깊이·활성 위치 수를 더한다 — 원본 summary.worldGraph 옆에 붙인다.
const WG_ANCHOR = `      worldSummaryChars: worldGraphNodes.reduce((sum, node) => sum + String(node?.meta?.worldSummary || node?.meta?.worldMetadata?.summary || '').length, 0)`;
if (!src.includes(WG_ANCHOR)) {
  console.error('[scale] worldGraph 요약 앵커를 찾지 못했다');
  process.exit(2);
}
src = src.replace(WG_ANCHOR, WG_ANCHOR + `,
      // ── 스케일 확대 측정 ──
      maxDepth: (() => {
        const byId = new Map(worldGraphNodes.map(n => [String(n?.id || ''), n]));
        const depthOf = (node) => {
          let d = 0, cur = String(node?.parent || ''), guard = 0;
          while (cur && byId.has(cur) && guard++ < 200) { d += 1; cur = String(byId.get(cur)?.parent || ''); }
          return d;
        };
        return worldGraphNodes.reduce((max, n) => Math.max(max, depthOf(n)), 0);
      })(),
      activeNodeCount: Array.isArray(worldGraphRecord.activeNodes) ? worldGraphRecord.activeNodes.length : 0,
      activePathCount: Array.isArray(worldGraphRecord.activePath) ? worldGraphRecord.activePath.length : 0,
      parentedNodes: worldGraphNodes.filter(n => String(n?.parent || '')).length,
      worldSummaries: worldGraphNodes.map(n => String(n?.meta?.worldSummary || '').trim()).filter(Boolean).slice(0, 8)`);

// ── ②-b dist 계측: 05k 경로가 실제로 실행되는지 본다 ──
//   왜 필요한가: mock 은 dimensionalShifts 를 내고(실측 확인) sanitizeExtractionPayload 도
//   보존하는데(실측 확인) 노드는 1개다. 남은 가설은 "그 함수가 아예 실행되지 않는다"뿐이다.
//
//   계측 대상은 **하네스 소스가 아니라 dist** 다. dist 를 직접 고치면 커밋 위험이 있으므로
//   이 하네스가 읽는 dist 경로를 변형본 전용으로 바꿔치기한다.
//     `const DIST = path.join(ROOT, 'dist', ...)` → 임시 계측본
//   원본 `dist/` 는 **손대지 않는다**.
const DIST_LINE = src.match(/const DIST = path\.join\(ROOT, 'dist', '[^']+'\);/);
if (!DIST_LINE) { console.error('[scale] DIST 상수 앵커 없음'); process.exit(2); }
const DIST_FILE = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
let distSrc = fs.readFileSync(DIST_FILE, 'utf8');

const WPM = "const worldPayloadForMutation = (entityResult?.world && typeof entityResult.world === 'object' && !Array.isArray(entityResult.world)) ? entityResult.world : {};";
const GUARD = "const guardNarrativeAnalysisResult = (result = null, sourceMode = '', operation = '') => {";
if (!distSrc.includes(WPM) || !distSrc.includes(GUARD)) {
  console.error('[scale] dist 에서 계측 앵커를 찾지 못했다');
  process.exit(2);
}
// ① guard 호출 시 world/shifts/success
// ★ 계측 채널 교정 (실측 결함): dist 는 하네스와 **다른 vm realm** 에서 돈다.
//   `globalThis.__LIBRA_SCALE_TRACE__` 에 쓰면 하네스의 `context.__LIBRA_SCALE_TRACE__` 와
//   **다른 객체**라 항상 빈 값이 나온다(실측: p5k_entries=0 · guard=0 · cond=0 인데
//   05k 는 매 턴 실행됐다). 하네스가 **소유한 채널**인 console 을 쓴다 — 로그로 수집된다.
distSrc = distSrc.replace(GUARD, GUARD + `
            try {
                console.error('[SCALE_TRACE] ' + JSON.stringify({
                    t: 'guard',
                    operation: String(operation || ''),
                    sourceMode: String(sourceMode || ''),
                    hasWorld: !!(result && typeof result === 'object' && result.world && Object.keys(result.world).length > 0),
                    hasShifts: (result && result.world && Array.isArray(result.world.dimensionalShifts)) ? result.world.dimensionalShifts.length : 0,
                    success: result ? result.success : undefined
                }));
            } catch (_) {}`);
// ② 05k 가 실제로 본 world 값
distSrc = distSrc.replace(WPM, WPM + `
        try {
            console.error('[SCALE_TRACE] ' + JSON.stringify({
                t: 'mutation',
                keys: Object.keys(worldPayloadForMutation || {}).slice(0, 24),
                shifts: (worldPayloadForMutation && Array.isArray(worldPayloadForMutation.dimensionalShifts)) ? worldPayloadForMutation.dimensionalShifts.length : 0
            }));
        } catch (_) {}`);
// ②-b 05k 함수 진입 (그 함수가 도는지 자체를 본다)
const P5K = "const processNarrativeTurnState = async (char, chat, lore, userMsg, aiResponse, m_id = null, options = {}) => {";
if (distSrc.includes(P5K)) {
  distSrc = distSrc.replace(P5K, P5K + `
        try { console.error('[SCALE_TRACE] ' + JSON.stringify({ t: 'p5k' })); } catch (_) {}`);
} else {
  console.error('[scale] 05k 함수 앵커 없음');
  process.exit(2);
}

// ②-c 노드 생성 조건 판정 (왜 안 만드는지)
const COND = "if (turnChannel.channel === 'scene' && profile?.global && worldMutationPolicy.allowDimensionalShift) {";
if (distSrc.includes(COND)) {
  distSrc = distSrc.replace(COND, `
            try {
                console.error('[SCALE_TRACE] ' + JSON.stringify({
                    t: 'cond',
                    channel: String(turnChannel && turnChannel.channel || ''),
                    hasGlobal: !!(profile && profile.global),
                    allowShift: !!(worldMutationPolicy && worldMutationPolicy.allowDimensionalShift),
                    shiftCount: Array.isArray(explicitShifts) ? explicitShifts.length : 0
                }));
            } catch (_) {}
            ` + COND);
} else {
  console.error('[scale] 노드 조건 앵커 없음');
  process.exit(2);
}

// ③ 노드 생성 시도 (성공/실패 이유)
const CREATE = "const createResult = HierarchicalWorldManager.createNode({";
if (distSrc.includes(CREATE)) {
  distSrc = distSrc.replace(CREATE, `
                    try { console.error('[SCALE_TRACE] ' + JSON.stringify({ t: 'create', name: String(targetName || '') })); } catch (_) {}
                    const createResult = HierarchicalWorldManager.createNode({`);
}

const DIST_TMP = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', `libra_scale_dist_${Date.now()}.js`);
fs.writeFileSync(DIST_TMP, distSrc, 'utf8');
// 하네스가 그 임시 dist 를 읽도록 상수를 바꾼다
src = src.replace(DIST_LINE[0], `const DIST = '${DIST_TMP.replace(/\\/g, '/')}';`);
console.log('[scale] dist 계측본 사용:', DIST_TMP);

// (무효 계측 블록 제거 — guard/WPM 계측은 dist 계측본에서 한다)

// ── ③ 주입 텍스트 길이를 재려면 프롬프트를 한 번 더 만든다 ──
//   formatForPrompt 는 08a 가 노출한다. 결과 JSON 에 남긴다.
const EXPORT_ANCHOR = `  const exports = context.__LIBRA_EXPORTS__;`;
if (!src.includes(EXPORT_ANCHOR)) {
  console.error('[scale] exports 앵커를 찾지 못했다');
  process.exit(2);
}
src = src.replace(EXPORT_ANCHOR, `  const exports = context.__LIBRA_EXPORTS__;
  // ── 스케일 확대: 세계 주입 텍스트 길이 측정 ──
  const __scaleWorldPrompt = () => {
    try { return String(context.HierarchicalWorldManager?.formatForPrompt?.() || ''); } catch (_) { return ''; }
  };`);

// 결과 저장 직전에 주입 길이를 싣는다
const SAVE_ANCHOR = `results.stages.live97 = {`;
if (!src.includes(SAVE_ANCHOR)) {
  console.error('[scale] live97 앵커를 찾지 못했다');
  process.exit(2);
}
src = src.replace(SAVE_ANCHOR, `  // ── 스케일 확대: 세계 주입 텍스트 실측 ──
  try {
    const __wp = __scaleWorldPrompt();
    const __active = (() => { try { return context.HierarchicalWorldManager?.getActiveNodes?.() || []; } catch (_) { return []; } })();
    results.scaleWorldInjection = {
      chars: __wp.length,
      tokensSimple: Math.ceil(__wp.length / 2),
      tokensDense: Math.ceil(__wp.length / 1.6),
      activeNodeCount: __active.length,
      sample: __wp.slice(0, 1200)
    };
  } catch (error) {
    results.scaleWorldInjection = { error: String(error?.message || error).slice(0, 200) };
  }
  results.scaleConfig = { turns: TURN_COUNT, shiftEvery: ${SHIFT_EVERY}, runId: '${RUN_ID}' };
  results.stages.live97 = {`);

fs.writeFileSync(WORK, src, 'utf8');
// 변형이 실제로 들어갔는지 확인한다 — 앵커가 어긋나면 조용히 원본이 돌아간다.
const patched = src.includes('dimensionalShifts') && src.includes('scaleWorldInjection') && src.includes('maxDepth:');
if (!patched) {
  console.error('[scale] 변형이 적용되지 않았다 — 앵커를 확인하라');
  process.exit(2);
}
console.log(`[scale] 턴 ${TURNS} · ${SHIFT_EVERY}턴마다 차원 이동 · 원본 ${before} → 변형 ${src.length} 자 (패치 확인 OK)`);

// ── 실행 ──
const env = { ...process.env, LIBRA_TURNS: String(TURNS), NODE_PATH: '' };
let stdout = '';
let exitCode = 0;
try {
  stdout = execFileSync(process.execPath, ['--expose-gc', WORK], {
    cwd: ROOT, encoding: 'utf8', env, timeout: 1700000, maxBuffer: 64 * 1024 * 1024
  });
} catch (error) {
  exitCode = Number(error?.status || 1);
  stdout = String(error?.stdout || '') + String(error?.stderr || '');
}
console.log(`[scale] 실행 exit=${exitCode}`);

// ── 결과 읽기 (하네스가 test-output 에 쓰는 최신 파일) ──
const files = fs.readdirSync(OUT_DIR).filter(x => /libra-97/.test(x)).sort();
const latest = files[files.length - 1];
const report = JSON.parse(fs.readFileSync(path.join(OUT_DIR, latest), 'utf8'));
const wg = report?.finalLore?.worldGraph || report?.stages?.live97?.lore?.worldGraph || {};
const inj = report.scaleWorldInjection || {};

const out = {
  turns: TURNS,
  shiftEvery: SHIFT_EVERY,
  harness_exit: exitCode,
  harness_ok: report.ok === true,
  assertions: { total: (report.assertions || []).length, failed: (report.assertions || []).filter(a => !a.ok).map(a => a.name) },
  worldGraph: {
    present: wg.present,
    nodeCount: wg.nodeCount,
    maxDepth: wg.maxDepth,
    parentedNodes: wg.parentedNodes,
    activePathCount: wg.activePathCount,
    activeNodeCount: wg.activeNodeCount,
    ruleFactCount: wg.ruleFactCount,
    worldSummaryChars: wg.worldSummaryChars,
    worldSummaries: wg.worldSummaries
  },
  injection: {
    chars: inj.chars,
    tokensSimple: inj.tokensSimple,
    tokensDense: inj.tokensDense,
    activeNodeCount: inj.activeNodeCount
  },
  trace: report.scaleTrace || null,
  expectations: {
    nodes_created: Number(wg.nodeCount || 0) > 1,
    expected_nodes_at_least: Math.floor(TURNS / SHIFT_EVERY),
    hierarchy_depth: Number(wg.maxDepth || 0) >= 1
  }
};
const outPath = path.join(OUT_DIR, `libra-scale-${RUN_ID}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
// ── 스케일 계측 집계 (하네스 소스가 아니라 **여기**에서 한다) ──
//   계측은 dist(다른 vm realm)에서 console.error('[SCALE_TRACE] …') 로 나오고,
//   하네스가 test-output 에 쓴 로그 파일의 logs[] 에 남는다. report 가 그것이다.
//   ★ 템플릿 안에 두면 하네스 소스에 심겨 "report is not defined" 로 죽는다(실측).
try {
  const readTraceLines = () => {
    const lines = [];
    try {
      for (const l of (report?.logs || [])) {
        const m = String(l?.msg ?? '');
        if (m.includes('[SCALE_TRACE]')) lines.push(m);
      }
    } catch (_) {}
    return lines;
  };
  const parseTrace = (line) => { try { return JSON.parse(String(line).slice(String(line).indexOf('{'))); } catch (_) { return null; } };
  const events = readTraceLines().map(parseTrace).filter(Boolean);
  const guardCalls = events.filter(e => e.t === 'guard');
  const mutations = events.filter(e => e.t === 'mutation');
  const conds = events.filter(e => e.t === 'cond');
  const creates = events.filter(e => e.t === 'create');
  out.trace = {
    source: events.length ? 'report.logs' : 'none',
    events: events.length,
    guard_calls: guardCalls.length,
    guard_blocked: guardCalls.filter(g => g.success === false).length,
    guard_with_world: guardCalls.filter(g => g.hasWorld).length,
    guard_with_shifts: guardCalls.filter(g => g.hasShifts > 0).length,
    mutation_calls: mutations.length,
    mutation_with_shifts: mutations.filter(m => m.shifts > 0).length,
    mutation_keys_sample: mutations.slice(0, 3).map(m => m.keys),
    p5k_entries: events.filter(e => e.t === 'p5k').length,
    cond_checks: conds.length,
    cond_sample: conds.slice(0, 4),
    create_attempts: creates.length,
    create_names: creates.map(c => c.name).slice(0, 6),
    guard_sample: guardCalls.slice(0, 4)
  };
} catch (traceError) {
  out.trace = { error: String(traceError && traceError.message || traceError).slice(0, 200) };
}

// ★ 작업 파일을 **보존**한다 (실측 결함): 종전에는 `fs.unlinkSync(WORK)` 로 끝나자마자 지워
//   "변이가 실제로 실행됐는가"를 **사후에 확인할 수 없었다**(세션에서 판정이 막혔다).
//   변형 하네스·계측 dist 를 test-output 에 복사해 실행 증거를 남긴다.
out.artifacts = {
  report: path.join(OUT_DIR, latest),
  workHarness: path.join(OUT_DIR, 'libra-scale-work-' + RUN_ID + '.cjs'),
  instrumentedDist: path.join(OUT_DIR, 'libra-scale-dist-' + RUN_ID + '.js')
};
try {
  fs.copyFileSync(WORK, out.artifacts.workHarness);
  if (String(DIST_TMP || '') && fs.existsSync(DIST_TMP)) fs.copyFileSync(DIST_TMP, out.artifacts.instrumentedDist);
} catch (copyError) {
  console.error('[scale] 보존 실패:', String(copyError && copyError.message || copyError));
}
// 보존본을 남긴 **뒤** 원본 작업 파일을 지운다.
try { fs.unlinkSync(WORK); } catch (_) {}
try { if (String(DIST_TMP || '')) fs.unlinkSync(DIST_TMP); } catch (_) {}
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(outPath);
console.log(JSON.stringify(out, null, 2));
