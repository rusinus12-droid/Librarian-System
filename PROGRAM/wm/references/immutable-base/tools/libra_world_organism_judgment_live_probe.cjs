'use strict';
// 실모델 실측: 번들 LLM 이 "세포들의 움직임이 세계를 바꿨는가"를 판정하는가.
//
// 3단계의 핵심 검증 — 하드코딩 임계 대신 LLM 판단을 쓴다면,
// 실제로 판정이 나오는지 그리고 **오작동(false positive)이 없는지**를 본다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
const injected = code.slice(0, idx) + '\n    globalThis.__p = { WorldStateTracker, CharacterStateTracker };\n' + code.slice(idx);

const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';

// 실제 번들과 같은 형태의 입력 3종
const CASES = [
  {
    label: '집단 이동 (세계가 변해야 함)',
    characters: [
      { name: '아리엘', logs: 'T10: location=왕도 | 건강\nT11: location=왕도 | 건강\nT12: location=왕도 | 건강' },
      { name: '카일', logs: 'T10: location=왕도 | 건강\nT11: location=왕도 | 건강\nT12: location=왕도 | 건강' },
      { name: '미르', logs: 'T10: location=왕도 | 건강\nT11: location=왕도 | 건강\nT12: location=왕도 | 건강' }
    ],
    world: { logs: 'T10: World=world_main, Notes=none\nT11: World=world_main, Notes=none\nT12: World=world_main, Notes=세 사람이 함께 왕도를 떠나 검은 탑으로 향했다' }
  },
  {
    label: '개인 사건 (세계는 안 변해야 함)',
    characters: [
      { name: '아리엘', logs: 'T10: location=왕도 | 건강\nT11: location=왕도 | 부상\nT12: location=왕도 | 부상' },
      { name: '카일', logs: 'T10: location=왕도 | 건강\nT11: location=왕도 | 건강\nT12: location=왕도 | 건강' }
    ],
    world: { logs: 'T10: World=world_main, Notes=none\nT11: World=world_main, Notes=아리엘이 부상당했다\nT12: World=world_main, Notes=none' }
  },
  {
    label: '아무 일 없음 (절대 안 변해야 함)',
    characters: [{ name: '아리엘', logs: 'T10: location=왕도 | 건강\nT11: location=왕도 | 건강\nT12: location=왕도 | 건강' }],
    world: { logs: 'T10: World=world_main, Notes=none\nT11: World=world_main, Notes=none\nT12: World=world_main, Notes=none' }
  }
];

(async () => {
  // 실제 제품의 번들 system 을 꺼낸다 (소스에서 추출)
  const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/09d-section-character-world-state.js'), 'utf8');
  const bs = SRC.indexOf('You are LIBRA State Consolidation Bundler');
  const be = SRC.indexOf("].join('\\n')", bs);
  const rawSystem = SRC.slice(bs, be);
  // JS 문자열 리터럴들을 이어붙여 실제 프롬프트를 복원한다.
  const system = rawSystem
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith("'") && line.endsWith("',"))
    .map(line => {
      let v = line.slice(1, -2);            // 앞 ' 뒤 ',
      v = v.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      return v;
    })
    .join('\n');

  const out = { model: MODEL, system_chars: system.length, system_head: system.slice(0, 400), cases: [] };

  for (const c of CASES) {
    const body = {
      model: MODEL, stream: false, think: false,
      options: { temperature: 0.2, num_predict: 4000 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ turn: 13, characters: c.characters, world: c.world }, null, 2) }
      ]
    };
    const r = { label: c.label };
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(240000)
      });
      const data = await res.json();
      const content = String(data?.message?.content || '');
      r.raw_chars = content.length;
      r.done_reason = data?.done_reason || null;
      let parsed = null;
      try { parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim()); } catch { /* 원문에서 찾는다 */ }
      const world = parsed?.world || null;
      r.parsed = !!parsed;
      if (world) {
        r.charactersChangeWorld = world.charactersChangeWorld === true;
        r.criticalReason = world.criticalReason || null;
        r.criticalEntities = world.criticalEntities || null;
        r.worldSummary = String(world.summary || '').slice(0, 160);
      } else {
        // 파싱 실패해도 원문에서 찾는다 ("0건" 을 거짓 보고하지 않기 위해 — 스킬 규칙)
        const m = content.match(/"charactersChangeWorld"\s*:\s*(true|false)/);
        r.charactersChangeWorld_raw = m ? m[1] === 'true' : null;
        r.head = content.slice(0, 300);
      }
      r.verdict = r.charactersChangeWorld === true ? 'WORLD CHANGED'
        : (r.charactersChangeWorld === false ? 'no change' : '(판정 없음)');
    } catch (e) { r.error = String(e?.message || e).slice(0, 160); }
    out.cases.push(r);
    console.error(`[${c.label}] 완료`);
  }

  out.summary = {
    expected: { '집단 이동 (세계가 변해야 함)': true, '개인 사건 (세계는 안 변해야 함)': false, '아무 일 없음 (절대 안 변해야 함)': false },
    got: Object.fromEntries(out.cases.map(c => [c.label, c.charactersChangeWorld ?? c.charactersChangeWorld_raw ?? null])),
    correct: out.cases.filter(c => {
      const exp = out.summary_expected?.[c.label];
      return false;
    }).length
  };
  // 정확도 계산 (요약 자기참조 제거)
  const expected = { '집단 이동 (세계가 변해야 함)': true, '개인 사건 (세계는 안 변해야 함)': false, '아무 일 없음 (절대 안 변해야 함)': false };
  delete out.summary.summary_expected;
  out.summary = {
    expected,
    got: Object.fromEntries(out.cases.map(c => [c.label, c.charactersChangeWorld ?? c.charactersChangeWorld_raw ?? null])),
    matches: out.cases.filter(c => (c.charactersChangeWorld ?? c.charactersChangeWorld_raw) === expected[c.label]).length,
    total: out.cases.length
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
