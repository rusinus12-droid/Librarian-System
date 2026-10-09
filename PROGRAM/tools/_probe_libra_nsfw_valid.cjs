'use strict';
// Does LIBRA ANALYZE a chat whose text is NSFW, and is the NSFW material preserved in memory?
//
// Earlier probes in this session produced false alarms about NSFW, caused by MY artifact errors, not by
// the content: entity names must appear inside their own evidence quotes (UNIFIED_ENTITY_NAME_UNBOUND),
// and containment requires both endpoints to be locations (UNIFIED_CONTAINMENT_KIND_INVALID). Those are
// the plugin working correctly. This probe uses a valid artifact, so the only variable left is the text.
//
// It checks what actually matters: does the pipeline complete, is memory committed, and does the stored
// memory still quote the intimate material rather than a sanitized version of it.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_NSFW_VALID_OUT || '/tmp/libra_nsfw_valid.json';

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
  // The intimate facts, each quoting the material verbatim so nothing is sanitized in storage.
  add('f1', 'relationship', 'mina', 'relationship', { value: '명시적으로 허락하고 경계를 확인했다' },
    '민아는 명시적으로 허락했고 두 사람은 경계를 확인했다.', 't1-a', 'value', { targetTempRef: 'jiho', dimension: 'trust' });
  add('f2', 'character', 'jiho', 'knowledge', { knowledge: ['민아가 원하는 것'] },
    '지호는 민아가 원하는 것을 들었다.', 't2-u', 'knowledge');
  add('f3', 'character', 'mina', 'location', { locationRef: 'study' }, '민아가 서재로 갔다.', 't4-u', 'locationRef');
  add('f4', 'world', 'hall', 'containment', { parentRef: 'study' }, '부엌은 서재와 이어져 있다.', 't3-u', 'parentRef');
  add('f5', 'narrative', 'mina', 'thread', { thread: { summary: '봉인 안의 심사 일정표', status: 'open' } },
    '봉인 안에서 심사 일정표가 나왔다.', 't5-a', 'threads');
  return { schema: 'libra.canonical_artifact.v4', entities, facts, stateBindings };
};

(async () => {
  const f = await fixture();
  const out = { capturedAt: new Date().toISOString() };
  try {
    f.chat.message = rows.map(r => ({ role: r.role, chatId: r.ref, id: r.ref, data: r.text, time: Date.now() }));
    f.chat.messages = f.chat.message;
    const api = f.r.api;
    f.control.artifact = buildArtifact();

    const result = await f.run();
    const memory = f.getMemory();
    const art = memory?.canonicalArtifact;
    const admission = memory?.artifactValidation?.admission || {};

    out.run = {
      completed: result?.completed ?? null,
      status: memory?.status || null,
      stateHead: f.getHead()?.schema || null,
      modelCalls: (f.control.calls || []).length
    };
    out.memory = {
      factsIn: 5, factsStored: (art?.facts || []).length,
      entitiesIn: 4, entitiesStored: (art?.entities || []).length,
      admissionStatus: admission.status || null,
      rejected: (admission.rejected || []).map(r => `${r.id}:${r.reason}`).slice(0, 8),
      stateBindingIssues: (memory?.artifactValidation?.stateBindingIssues || []).slice(0, 8)
    };

    // Is the intimate material preserved verbatim, or softened somewhere along the way?
    const storedText = JSON.stringify(art || {});
    out.contentPreservation = {
      quotesIntimateAction: /침대 쪽으로 밀었다/.test(storedText),
      quotesExplicitConsent: /계속해도 돼|이미 허락했다/.test(storedText),
      relationshipFactKept: /명시적으로 허락|경계를 확인/.test(storedText),
      // A sanitized result would contain vague wording instead of the scene's own words.
      looksSanitized: !/허락|경계/.test(storedText)
    };

    // What the model was actually asked, from the request the plugin made.
    const prompt = f.control.calls.length
      ? String((f.control.calls[0]?.[0]?.messages || []).map(m => String(m.content || '')).join('\n'))
      : '';
    out.promptCarriedScene = /침대 쪽으로 밀었다|허락했다/.test(prompt);
    out.promptAsksToAvoid = /(?:avoid explicit|do not depict|sanitize the|refuse)/i.test(prompt);
    out.promptNsfwGuidance = /NSFW GUIDANCE/i.test(prompt);

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
