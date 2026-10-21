'use strict';
// The NSFW mode must reach the ANALYSIS prompt, not only the writing stages.
//
// THE DEFECT, measured: buildNsfwGuidanceBlock(settings, phase) has always supported four phases, and
// the 'analysis' one reads differently on purpose — it converts the mode into evidence-aware portrayal
// criteria and warns against inventing an intimate event just because the mode is on. But it had ZERO
// call sites. Only 'writing' (SGA), 'patch' (AIDE) and 'input_writer' were wired, so the memory-authoring
// stage — the one that reads the raw scene text and decides what the facts are — ran with no NSFW
// guidance at all:
//
//     buildNsfwGuidanceBlock(..., 'analysis') call sites: 0
//     nsfw mentions near the librarian prompt builder: 0
//
// WHAT THIS SUITE LOCKS:
//   1. with the mode on, the REAL librarian request carries NSFW GUIDANCE;
//   2. with the mode off (the default), it does not — the block stays opt-in;
//   3. the guidance is the ANALYSIS wording, not the writing wording;
//   4. the evidence contract still outranks it and the exact source is unchanged;
//   5. the memory still commits with the mode on.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture } = require(path.resolve(__dirname, 'fixtures', 'libra_unified_runtime_fixture.cjs'));
const { classifyCall } = require('./fixtures/libra_provider_call_kinds.cjs');

const rows = [
  { ref: 't1-u', role: 'user', text: '민아가 문을 잠그고 지호를 침대 쪽으로 밀었다. 조명을 낮추고 그의 셔츠 단추를 하나씩 풀었다.' },
  { ref: 't1-a', role: 'assistant', text: '지호는 숨을 삼켰다. 민아에게 "계속해도 돼?"라고 낮게 물었다. 허락을 받은 뒤에야 그는 민아의 허리를 감쌌다.' },
  { ref: 't2-u', role: 'user', text: '민아는 이미 허락했다고 말했어. 지호의 귀에 입술을 대고 원하는 것을 말했다.' },
  { ref: 't2-a', role: 'assistant', text: '두 사람은 서로의 속도를 맞췄다. 멈춤과 재개, 확인과 침묵이 번갈아 이어졌다.' },
  { ref: 't3-u', role: 'user', text: '아침에 눈을 떴을 때 지호는 옆에 없었다. 민아는 부엌에서 커피 내리는 소리를 들었다.' },
  { ref: 't3-a', role: 'assistant', text: '민아는 시트의 온기를 손바닥으로 눌러 확인했다. 어제의 일은 이미 지나갔고, 오늘 확인할 것이 남아 있었다.' },
  { ref: 't4-u', role: 'user', text: '민아는 서재로 가서 어제 이야기한 절차를 확인하자고 했다.' },
  { ref: 't4-a', role: 'assistant', text: '서재의 서류함에는 어제와 같은 봉인이 그대로 있었다.' },
  { ref: 't5-u', role: 'user', text: '민아가 봉인을 뜯고 안을 확인해.' },
  { ref: 't5-a', role: 'assistant', text: '봉인 안에는 기록회의 심사 일정표가 들어 있었다.' }
];

// Entity names must appear inside their own evidence quotes, and containment needs two locations.
const buildArtifact = () => {
  const q = ref => [{ ref, quote: rows.find(r => r.ref === ref).text }];
  const entities = [
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: q('t1-u') },
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: q('t1-a') },
    { tempId: 'study', name: '서재', type: 'world', kind: 'location', evidenceSpans: q('t4-a') },
    { tempId: 'hall', name: '부엌', type: 'world', kind: 'location', evidenceSpans: q('t3-u') }
  ];
  const facts = [];
  const stateBindings = [];
  const add = (id, domain, subject, kind, values, text, ref, field = '', extra = {}) => {
    facts.push({
      tempFactId: id, domain, subjectTempRef: subject, claimKind: kind, values, text,
      temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: q(ref), ...extra
    });
    if (field) stateBindings.push({ factTempId: id, typedValueField: Object.keys(values)[0], stateDomain: domain, stateField: field });
  };
  add('f1', 'relationship', 'mina', 'relationship', { value: '명시적으로 허락하고 경계를 확인했다' },
    '민아는 명시적으로 허락했고 두 사람은 경계를 확인했다.', 't1-a', 'value', { targetTempRef: 'jiho', dimension: 'trust' });
  add('f2', 'character', 'jiho', 'knowledge', { knowledge: ['민아가 원하는 것'] },
    '지호는 민아가 원하는 것을 들었다.', 't2-u', 'knowledge');
  add('f3', 'character', 'mina', 'location', { locationRef: 'study' }, '민아가 서재로 갔다.', 't4-u', 'locationRef');
  add('f4', 'world', 'hall', 'containment', { parentRef: 'study' }, '부엌은 서재와 이어져 있다.', 't3-u', 'parentRef');
  return { schema: 'libra.canonical_artifact.v4', entities, facts, stateBindings };
};

const captureRun = async mode => {
  const f = await fixture();
  try {
    // The mode must be in place before the request starts (the boundary digest is captured then).
    // Save through the product settings path: it persists the runtime keys and invalidates the
    // cached settings, so the next request reads the new mode. (getRuntime() is a redacted clone,
    // so clearing its cache fields never reached the live runtime.)
    const api = f.r.api;
    await api.saveLibraProviderConfig({ nsfwMode: mode, nsfwGuidanceEnabled: true });
    const record = await api.debugReadRuntimeSettings();
    assert.equal(record?.settings?.nsfw_mode, mode, 'the NSFW mode is persisted');
    assert.equal(String(record?.settings?.nsfw_guidance_enabled), 'true', 'NSFW guidance injection is persisted as enabled');

    f.chat.message = rows.map(r => ({ role: r.role, chatId: r.ref, id: r.ref, data: r.text, time: Date.now() }));
    f.chat.messages = f.chat.message;
    f.control.artifact = buildArtifact();

    const result = await f.run();
    // Micro also reads the scene. Observe the canonical producer, independent
    // of when those separate requests run.
    const canonicalCalls = f.control.calls.filter(call => classifyCall(call) === 'canonical');
    assert.equal(canonicalCalls.length, 1, 'one canonical analysis request is submitted');
    const prompt = String((canonicalCalls[0]?.[0]?.messages || []).map(m => String(m.content || '')).join('\n'));
    const memory = f.getMemory();
    return {
      mode,
      completed: result?.completed ?? null,
      memoryCommitted: Boolean(memory),
      factsStored: (memory?.canonicalArtifact?.facts || []).length,
      promptChars: prompt.length,
      hasNsfwGuidance: /NSFW GUIDANCE/i.test(prompt),
      // The analysis wording, which is what makes this the right phase, not the writing one.
      usesAnalysisWording: /evidence-aware portrayal criteria/i.test(prompt),
      usesWritingWording: /Apply this mode to the actual prose only/i.test(prompt),
      modeLine: (prompt.match(/NSFW GUIDANCE — (\w+):/) || [])[1] || null,
      // The contract must still outrank it, and the scene text must still be carried verbatim.
      hasEvidenceContract: /exact source quotation|EXACT FIVE U\+A|evidence/i.test(prompt),
      carriesSceneText: /침대 쪽으로 밀었다|허락했다/.test(prompt),
      asksToAvoidNsfw: /(?:avoid explicit|do not depict|sanitize the|must refuse)/i.test(prompt)
    };
  } finally {
    await f.r.cleanup();
  }
};

(async () => {
  const report = {};

  // 1+3+4+5. Mode ON.
  report.direct = await captureRun('direct');
  assert.equal(report.direct.hasNsfwGuidance, true,
    `with the mode on, the analysis prompt must carry NSFW guidance (${JSON.stringify(report.direct)})`);
  assert.equal(report.direct.usesAnalysisWording, true,
    'the analysis phase wording must be used, not the writing wording');
  assert.equal(report.direct.usesWritingWording, false, 'the writing wording must not appear');
  assert.equal(report.direct.modeLine, 'DIRECT', `the mode line must name the active mode (got ${report.direct.modeLine})`);
  assert.equal(report.direct.hasEvidenceContract, true, 'the evidence contract must still be present');
  assert.equal(report.direct.carriesSceneText, true, 'the real scene text must still reach the prompt');
  assert.equal(report.direct.asksToAvoidNsfw, false, 'the analysis prompt must not ask the model to avoid the material');
  assert.equal(report.direct.completed, 1, 'the run must still commit with the mode on');
  assert.equal(report.direct.memoryCommitted, true, 'memory must still be committed');

  // 2. Mode OFF (the default) — the block stays opt-in.
  report.off = await captureRun('off');
  assert.equal(report.off.hasNsfwGuidance, false,
    'with the mode off the analysis prompt must carry no NSFW guidance');
  assert.equal(report.off.completed, 1, 'the run must still commit with the mode off');

  console.log(JSON.stringify({ suite: 'libra_analysis_nsfw_guidance', ...report }, null, 1));
  console.log('libra_analysis_nsfw_guidance_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_analysis_nsfw_guidance_test: FAIL');
  process.exitCode = 1;
});
