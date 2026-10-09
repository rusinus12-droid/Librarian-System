'use strict';
// Does LIBRA's memory-authoring pipeline handle a chat whose text is NSFW?
//
// The fixture's own 5 U+A chat completes (completed: 1). This runs the SAME pipeline with the same
// shape of artifact, changing only the source text to a mature scene, so the difference isolates the
// content rather than the setup. Reported facts are the plugin's own: completed, manifestStatus,
// stored facts, and the reason when it does not complete.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_NSFW_SOURCE_OUT || '/tmp/libra_nsfw_source.json';

// Mature content, not graphic: the point is whether the pipeline carries it, not how far it goes.
const rows = [
  { ref: 't1-u', role: 'user', text: '문을 잠그고 그를 침대 쪽으로 밀었다. 조명을 낮추고 셔츠 단추를 하나씩 풀었다.' },
  { ref: 't1-a', role: 'assistant', text: '지호는 숨을 삼켰다. "계속해도 돼?"라고 낮게 물었다. 허락을 받은 뒤에야 그는 민아의 허리를 감쌌다.' },
  { ref: 't2-u', role: 'user', text: '이미 허락했다고 말했어. 그의 귀에 입술을 대고 원하는 것을 말했다.' },
  { ref: 't2-a', role: 'assistant', text: '두 사람은 서로의 속도를 맞췄다. 멈춤과 재개, 확인과 침묵이 번갈아 이어졌다.' },
  { ref: 't3-u', role: 'user', text: '아침에 눈을 떴을 때 그는 옆에 없었다. 부엌에서 커피 내리는 소리가 들렸다.' },
  { ref: 't3-a', role: 'assistant', text: '민아는 시트의 온기를 손바닥으로 눌러 확인했다. 어제의 일은 이미 지나갔고, 오늘 확인할 것이 남아 있었다.' },
  { ref: 't4-u', role: 'user', text: '서재로 가서 어제 이야기한 절차를 확인하자.' },
  { ref: 't4-a', role: 'assistant', text: '서재의 서류함에는 어제와 같은 봉인이 그대로 있었다.' },
  { ref: 't5-u', role: 'user', text: '봉인을 뜯고 안을 확인해.' },
  { ref: 't5-a', role: 'assistant', text: '봉인 안에는 기록회의 심사 일정표가 들어 있었다.' }
];

const buildArtifact = () => {
  const q = ref => [{ ref, quote: rows.find(r => r.ref === ref).text }];
  const entities = [
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: q('t1-u') },
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: q('t1-a') },
    { tempId: 'study', name: '서재', type: 'world', kind: 'location', evidenceSpans: q('t4-a') },
    { tempId: 'seal', name: '봉인', type: 'world', kind: 'object', evidenceSpans: q('t4-a') }
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
  add('f4', 'world', 'seal', 'containment', { parentRef: 'study' }, '봉인은 서재에 있다.', 't4-a', 'parentRef');
  add('f5', 'narrative', 'mina', 'thread', { thread: { summary: '봉인 안의 심사 일정표', status: 'open' } },
    '봉인 안에서 심사 일정표가 나왔다.', 't5-a', 'threads');
  return { schema: 'libra.canonical_artifact.v4', entities, facts, stateBindings };
};

const run = async (label, sourceRows) => {
  // Same fixture, but with the chat text replaced and the artifact built from those rows.
  const f = await fixture({ snapshot: null });
  try {
    // Replace the chat the plugin reads.
    f.chat.message = sourceRows.map(r => ({
      role: r.role === 'user' ? 'user' : 'assistant', chatId: r.ref, id: r.ref, data: r.text, time: Date.now()
    }));
    f.chat.messages = f.chat.message;
    const api = f.r.api;
    f.control.artifact = buildArtifact();
    let result = null;
    let error = '';
    try { result = await f.run(); } catch (e) { error = `${e?.name}: ${String(e?.message || e).slice(0, 300)}`; }
    const memory = f.getMemory();
    return {
      label,
      completed: result?.completed ?? null,
      manifestStatus: result?.manifestStatus ?? null,
      error,
      memoryPresent: Boolean(memory),
      storedFacts: Number(memory?.facts?.length || 0),
      stateHead: f.getHead()?.schema || null,
      modelCalls: (f.control.calls || []).length
    };
  } finally {
    await f.r.cleanup();
  }
};

(async () => {
  const out = { capturedAt: new Date().toISOString() };
  out.nsfwScene = await run('nsfw scene text', rows);
  out.out = OUT;

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
