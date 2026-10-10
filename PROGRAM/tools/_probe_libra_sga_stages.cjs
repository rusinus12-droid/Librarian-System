'use strict';
// Capture EVERY prompt the real SGA pipeline sends, including the AIDE patch stages.
//
// The previous run captured sga_shadow but answered the three AIDE stages with a fabricated patch,
// so they failed with `invalid_patch` and their real prompts were never recorded. SGA is a multi-stage
// pipeline (shadow -> character aide -> world aide -> plot aide), and a model must handle each stage,
// so each stage's prompt has to be measured rather than inferred from the shadow stage.
//
// To get a stage to run, the previous stage's answer must be VALID: an invalid shadow or patch makes
// the pipeline skip forward. So this answers each stage with the artifact its own contract demands,
// reading the contract out of the prompt itself where possible.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_SGA_STAGES_OUT || '/tmp/libra_sga_stages_dump.json';
const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

const instrument = source => {
  const coreAnchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreAnchor,
      '      _stageTrace: () => clone((Runtime.stageTrace || []).slice(-20)),\n' +
      '      _lastSga: () => clone(Runtime.lastSga || null),\n' +
      coreAnchor)
    .replace(publicAnchor,
      '    _stageTrace() { return LibraMemoryCore._stageTrace(); },\n' +
      '    _lastSga() { return LibraMemoryCore._lastSga(); },\n' +
      publicAnchor);
};

// A complete draft inside the working target, so the pipeline has no reason to short-circuit.
const longDraft = [
  '지호는 잠시 말이 없었다. 방금 전 돌려준 열쇠의 무게가 아직 손바닥에 남아 있는데, 같은 것을 다시 내달라는 요청은 그에게 예상 밖이었다.',
  '그는 민아의 눈을 천천히 살폈다. 서재의 낮은 등불이 두 사람 사이의 거리를 재듯 흔들렸다.',
  '"…알겠어. 잠깐이면 되니까." 지호는 주머니에서 열쇠를 다시 꺼냈다. 은빛 금속이 등불을 받아 짧게 반짝였다.',
  '그는 열쇠를 민아의 손바닥 위에 올려놓았다. 손끝이 스치는 순간, 민아의 손이 아주 작게 움츠러들었다가 이내 펴졌다.',
  '"다음 절차가 뭔지는 모르겠지만, 네가 필요한 거면 말해." 지호의 목소리는 낮았고, 그 안에는 체념과 협조가 반씩 섞여 있었다.',
  '"다만 이번이 마지막이야. 이 열쇠가 다시 내 손으로 돌아오는 순간, 오늘 이야기는 거기서 끝나는 거야."',
  '민아는 열쇠를 쥐었다. 서재의 공기가 무거웠고, 들은 사람이 하나뿐인 암호의 무게가 방 안을 채웠다.',
  '지호는 한 걸음 물러나 민아가 다음에 무엇을 할지 지켜보았다. 그는 더 묻지 않았다. 대신 창가로 시선을 돌려, 바깥의 어둠이 서재의 불빛을 삼키는 것을 바라보았다.',
  '민아는 열쇠를 소매 안쪽 깊숙이 넣고, 서가 사이를 향해 걸음을 옮겼다. 지호는 그 뒤를 따르지 않았다. 그는 문가에 서서, 민아가 공연실 쪽으로 가는지 서고 쪽으로 가는지만 조용히 확인했다.',
  '서재 밖 복도에서는 아무 소리도 들리지 않았다. 기록회의 심사는 아직 끝나지 않았고, 오늘의 약속이 이행된 뒤에도 남은 절차가 있다는 사실을 두 사람 모두 알고 있었다.'
].join('\n\n');

(async () => {
  const f = await fixture({ transformSource: instrument });
  const out = { capturedAt: new Date().toISOString(), liveInput, calls: [], rejected: [] };
  try {
    const api = f.r.api;

    // Mode first: the boundary digest is captured when a request starts, so changing the mode later
    // fails with UNIFIED_RESPONSE_AUTHORITY_CHANGED and the hook fail-opens with zero calls.
    const beforeRecord = await api.debugReadRuntimeSettings();
    const beforeInner = beforeRecord?.settings || {};
    await api.debugWriteRuntimeSettings({
      ...beforeRecord,
      settings: { ...beforeInner, injectionMode: 'sga', responseFamily: 'gradia' }
    });
    const runtime = api.getRuntime();
    runtime.settingsLoadedAt = 0;
    runtime.settings = null;

    await f.run();

    f.control.onCall = args => {
      const messages = args[0]?.messages || [];
      const system = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n');
      const user = messages.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n\n');
      const combined = `${system}\n${user}`;
      const kind = /libra\.sga_shadow/.test(combined) ? 'sga_shadow'
        : /libra\.sga_length_correction/.test(combined) ? 'length_correction'
        : /libra\.sga_response_engine/.test(combined) ? 'response_engine'
        : /libra\.sga_private_analysis/.test(combined) ? 'private_analysis'
        : /libra\.sga_patch/.test(combined) ? `sga_patch:${/character_aide|Character AIDE/i.test(combined) ? 'character' : /world_aide|World AIDE/i.test(combined) ? 'world' : /plot_aide|Plot AIDE/i.test(combined) ? 'plot' : 'unknown'}`
        : /libra\.canonical_artifact\.v4/.test(combined) ? 'memory_authoring'
        : 'other';
      out.calls.push({ kind, systemChars: system.length, userChars: user.length, system, user });

      // Answer each stage with the artifact its own contract requires, so the next stage actually runs.
      if (kind === 'sga_shadow') return JSON.stringify({
        schema: 'libra.sga_shadow.v2', ok: true,
        continuity_locks: [], user_agency_locks: [], do_not_reveal: [],
        scene_design: { purpose: '열쇠 재요청에 대한 지호의 반응', primary_tension: '신뢰와 조건의 충돌', beats: ['멈칫', '조건 제시', '열쇠 전달'], ending_boundary: '민아가 서재를 떠나기 전' },
        draft: longDraft
      });
      if (kind.startsWith('sga_patch')) {
        // The patch contract requires a stage id, an empty-or-filled edits array, and a binding.
        const stage = kind.split(':')[1] || 'character';
        const stageId = stage === 'character' ? 'sga_character_aide' : stage === 'world' ? 'sga_world_aide' : stage === 'plot' ? 'sga_plot_aide' : 'sga_character_aide';
        return JSON.stringify({
          schema: 'libra.sga_patch.v2', stage: stageId, ok: true, analysis: 'no changes required',
          continuity_locks: [], user_agency_locks: [], do_not_reveal: [],
          edits: [], binding: { basis: 'sga_shadow', stage: stageId, digest: 'capture' }, edit_links: []
        });
      }
      if (kind === 'length_correction') return JSON.stringify({ schema: 'libra.sga_length_correction.v2', ok: true, draft: longDraft });
      if (kind === 'response_engine') return JSON.stringify({ schema: 'libra.sga_response_engine.v2', ok: true, draft: longDraft });
      if (kind === 'private_analysis') return JSON.stringify({ schema: 'libra.sga_private_analysis.v2', ok: true, summary: '', constraints: [], risks: [], directives: [] });
      if (kind === 'memory_authoring') return JSON.stringify({ schema: 'libra.canonical_artifact.v4', entities: [], facts: [], stateBindings: [] });
      return '';
    };

    const messages = [
      ...(f.chat.messages || []).map(m => ({ role: m.role, content: String(m.data || '') })),
      { role: 'user', content: `<Current Input>\n${liveInput}\n</Current Input>` }
    ];
    let hookError = '';
    try { await f.control.hooks.beforeRequest(messages, 'model'); } catch (error) { hookError = `${error?.name}: ${String(error?.message || error).slice(0, 300)}`; }
    f.control.onCall = null;

    out.hookError = hookError;
    out.lastSga = api._lastSga();
    out.stageTrace = api._stageTrace().map(row => ({ stage: row?.stage, ok: row?.ok, reason: row?.reason }));

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    process.stdout.write(JSON.stringify({
      ok: true, out: OUT,
      hookError,
      lastSgaStatus: out.lastSga?.status,
      lastSgaDraftChars: String(out.lastSga?.draft || '').length,
      callKinds: out.calls.map(c => `${c.kind}(${c.systemChars}/${c.userChars})`),
      stageTrace: out.stageTrace
    }, null, 1) + '\n');
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
