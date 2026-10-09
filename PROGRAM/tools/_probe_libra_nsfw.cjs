'use strict';
// Can LIBRA ANALYZE and AUTHOR scenes whose text contains NSFW material?
//
// Two separate questions, because the plugin treats them separately:
//   ANALYSIS (사서/memory authoring) — the model reads a chat containing intimate content and returns a
//     canonical artifact. The prompt must carry that text verbatim for the model to extract from it;
//     what matters is whether the plugin injects anything that would push a model to sanitize or refuse,
//     and whether an artifact quoting intimate evidence is still accepted.
//   AUTHORING (SGA draft) — `buildNsfwGuidanceBlock(settings, 'writing')` is the mechanism. Its default
//     mode is 'off', and a measured fact from reading the source: the 'analysis' phase of that builder
//     has ZERO call sites, so the memory-authoring prompt never receives NSFW guidance at all.
//
// This probe reports what the REAL pipeline does, not what the code appears to intend.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_NSFW_OUT || '/tmp/libra_nsfw_probe.json';

// Mature but non-graphic scene text: enough that a model could refuse or sanitize, which is exactly
// what this check is about. The plugin's job is to carry it through, not to judge it.
const nsfwRows = [
  { ref: 'n1-u', role: 'user', text: '문을 잠그고 그를 침대 쪽으로 밀었다. 조명을 낮추고, 그의 셔츠 단추를 하나씩 풀었다. 숨소리가 가까워졌다.' },
  { ref: 'n1-a', role: 'assistant', text: '지호는 잠시 숨을 삼켰다. 손끝이 떨렸지만 물러서지 않았다. "계속해도 돼?"라고 낮게 물었다. 허락을 받은 뒤에야 그는 민아의 허리를 감쌌다.' },
  { ref: 'n2-u', role: 'user', text: '허락은 이미 했다. 그의 귀에 입술을 대고 원하는 것을 말했다. 서로의 경계를 확인하면서, 천천히.' },
  { ref: 'n2-a', role: 'assistant', text: '두 사람은 서로의 속도를 맞췄다. 멈춤과 재개, 확인과 침묵이 번갈아 이어졌다. 방 안의 공기는 뜨거웠고, 창밖의 비는 계속 내렸다.' },
  { ref: 'n3-u', role: 'user', text: '아침에 눈을 떴을 때 그는 옆에 없었다. 침대 시트에는 어제의 온기가 남아 있었고, 부엌에서 커피 내리는 소리가 들렸다.' }
];

const buildArtifact = () => {
  const q = ref => [{ ref, quote: nsfwRows.find(r => r.ref === ref).text }];
  const entities = [
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: q('n1-u') },
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: q('n1-a') }
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
    '민아는 명시적으로 허락했고 두 사람은 경계를 확인했다.', 'n1-a', 'value', { targetTempRef: 'jiho', dimension: 'trust' });
  add('f2', 'character', 'jiho', 'knowledge', { knowledge: ['민아가 원하는 것'] },
    '지호는 민아가 원하는 것을 들었다.', 'n2-u', 'knowledge');
  add('f3', 'narrative', 'mina', 'thread', { thread: { summary: '아침에 지호가 자리에 없었다', status: 'open' } },
    '아침에 지호가 곁에 없었다는 사실이 남았다.', 'n3-u', 'threads');
  return { schema: 'libra.canonical_artifact.v4', entities, facts, stateBindings };
};

const shapePrompt = text => ({
  chars: text.length,
  // Anything that would push a model to refuse or sanitize intimate material.
  hasPolicyLanguage: /(?:content policy|not allowed|must refuse|do not depict|avoid explicit|sanitize|cannot assist)/i.test(text),
  hasNsfwGuidance: /NSFW GUIDANCE/i.test(text),
  hasNsfwModeOff: /NSFW GUIDANCE — OFF/i.test(text),
  carriesSceneText: /허락은 이미 했다|침대 쪽으로 밀었다/.test(text)
});

(async () => {
  const out = { capturedAt: new Date().toISOString() };

  // ---------------------------------------------------------------------------------------------
  // 1. ANALYSIS: does the real memory-authoring pipeline accept an artifact whose evidence quotes
  //    intimate scene text, and what does the analysis prompt carry?
  // ---------------------------------------------------------------------------------------------
  const f = await fixture();
  try {
    const api = f.r.api;
    f.control.artifact = buildArtifact();
    const committed = await f.run();
    out.analysis = {
      completed: committed?.completed ?? null,
      manifestStatus: committed?.manifestStatus || null,
      memoryPresent: Boolean(f.getMemory()),
      storedFacts: Number(f.getMemory()?.facts?.length || 0),
      stateHead: f.getHead()?.schema || null
    };

    // What the analysis prompt actually carried, captured from the request the plugin made.
    const analysisPrompt = f.control.calls.length
      ? String((f.control.calls[0]?.[0]?.messages || []).map(m => String(m.content || '')).join('\n'))
      : '';
    out.analysisPrompt = shapePrompt(analysisPrompt);
  } finally {
    await f.r.cleanup();
  }

  // ---------------------------------------------------------------------------------------------
  // 2. AUTHORING: with NSFW on vs off, does the SGA draft prompt carry the guidance?
  //    The composer is reached through the same in-memory accessor pattern used for the pipeline
  //    probe, because the public surface does not expose it.
  // ---------------------------------------------------------------------------------------------
  const instrument = source => {
    const coreAnchor = '      debugNormalizeSgaPatchResult: ';
    const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
    for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
      if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
    }
    return source
      .replace(coreAnchor,
        '      _nsfwBlock: (settings, phase) => String(buildNsfwGuidanceBlock(settings, phase) || ""),\n' + coreAnchor)
      .replace(publicAnchor,
        '    _nsfwBlock(settings, phase) { return LibraMemoryCore._nsfwBlock(settings, phase); },\n' + publicAnchor);
  };

  const fa = await fixture({ transformSource: instrument });
  try {
    const api = fa.r.api;
    const settings = await api.getLibraMemorySettings();

    // The block itself, per phase and per mode — this is what would be injected.
    const phases = ['writing', 'analysis', 'patch', 'input_writer'];
    const modes = ['off', 'soft', 'direct', 'explicit'];
    out.nsfwBlock = {};
    for (const mode of modes) {
      out.nsfwBlock[mode] = {};
      for (const phase of phases) {
        const block = api._nsfwBlock({ nsfwMode: mode, nsfwGuidanceEnabled: true }, phase);
        out.nsfwBlock[mode][phase] = { chars: block.length, injected: block.length > 0 };
      }
    }
    // Disabled entirely.
    out.nsfwDisabled = api._nsfwBlock({ nsfwMode: 'direct', nsfwGuidanceEnabled: false }, 'writing').length;

    // Now the real thing: does the SGA SHADOW prompt carry it when the mode is on?
    const captureFor = async mode => {
      const before = await api.debugReadRuntimeSettings();
      await api.debugWriteRuntimeSettings({
        ...before,
        settings: { ...(before?.settings || {}), injectionMode: 'sga', responseFamily: 'gradia', nsfwMode: mode, nsfwGuidanceEnabled: true }
      });
      const runtime = api.getRuntime();
      runtime.settingsLoadedAt = 0;
      runtime.settings = null;
      const compiled = await api.debugCompileSgaPrompt('sga_shadow');
      const promptSpec = api.debugSgaPromptSpec
        ? await api.debugSgaPromptSpec({ hardConstraints: [] }, {})
        : null;
      return { compiledChars: String(compiled?.body || '').length, promptSpecChars: String(promptSpec?.text || '').length };
    };
    out.authoringModeOff = await captureFor('off');
    out.authoringModeDirect = await captureFor('direct');
    out.defaultModeIsOff = String(settings?.nsfwMode || 'off') === 'off';
  } finally {
    await fa.r.cleanup();
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
