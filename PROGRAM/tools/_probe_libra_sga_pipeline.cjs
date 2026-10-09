'use strict';
// Drive the REAL SGA pipeline end to end and capture what the model is actually asked for.
//
// WHY the previous attempt produced zero calls: the hook reads its mode from RUNTIME settings
// (`loadSettings()` -> `libra:v1:runtime-settings`), not from the memory settings that
// saveLibraMemorySettings() writes. Setting responseFamily there left injectionMode undefined, so the
// hook took no SGA branch at all. debugWriteRuntimeSettings() writes the record the hook actually
// reads — which is why this run can reach the pipeline.
//
// The live user turn must also arrive inside one of SGA_CURRENT_INPUT_TAGS; a plain last user message
// resolves to nothing and the plugin records `no_safe_current_user_input` (its own verdict, reported
// below).
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_SGA_LIVE_OUT || '/tmp/libra_sga_live_dump.json';
const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

const instrument = source => {
  const coreAnchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreAnchor,
      '      _peekInputResolution: () => clone(state.lastRecallInputResolution || null),\n' +
      '      _peekInjectionMeta: () => clone(Runtime.lastMemoryInjectionMeta || null),\n' +
      '      _lastInjection: () => String(Runtime.lastInjection || ""),\n' +
      '      _stageTrace: () => clone((Runtime.stageTrace || []).slice(-14)),\n' +
      '      _lastSga: () => clone(Runtime.lastSga || null),\n' +
      '      _lastSgaMeta: () => clone(Runtime.lastSgaInjectionMeta || null),\n' +
      coreAnchor)
    .replace(publicAnchor,
      '    _peekInputResolution() { return LibraMemoryCore._peekInputResolution(); },\n' +
      '    _peekInjectionMeta() { return LibraMemoryCore._peekInjectionMeta(); },\n' +
      '    _lastInjection() { return LibraMemoryCore._lastInjection(); },\n' +
      '    _stageTrace() { return LibraMemoryCore._stageTrace(); },\n' +
      '    _lastSga() { return LibraMemoryCore._lastSga(); },\n' +
      '    _lastSgaMeta() { return LibraMemoryCore._lastSgaMeta(); },\n' +
      publicAnchor);
};

const compliantDraft = '가'.repeat(3200);

(async () => {
  const f = await fixture({ transformSource: instrument });
  const out = { capturedAt: new Date().toISOString(), liveInput, calls: [] };
  try {
    const api = f.r.api;

    // The mode must be in place BEFORE any request starts: assertUnifiedResponseBoundary() compares the
    // settings digest captured when the request began against the settings digest right now, and calls
    // it UNIFIED_RESPONSE_AUTHORITY_CHANGED if they differ. Writing the mode after a commit therefore
    // fails the boundary check and the hook fail-opens with zero calls — measured, not assumed.
    const beforeRecord = await api.debugReadRuntimeSettings();
    const beforeInner = beforeRecord?.settings || {};
    out.runtimeBefore = { innerKeyCount: Object.keys(beforeInner).length, injection_mode: beforeInner.injection_mode };
    const writeResult = await api.debugWriteRuntimeSettings({
      ...beforeRecord,
      settings: { ...beforeInner, injectionMode: 'sga', responseFamily: 'gradia' }
    });
    const reread = await api.debugReadRuntimeSettings();
    const afterInner = reread?.settings || {};
    out.runtimeReread = {
      writeOk: writeResult?.ok === true,
      injection_mode: afterInner.injection_mode,
      response_family: afterInner.response_family,
      gradia_writing_mode: afterInner.gradia_writing_mode
    };
    out.resolveModeState = api.debugResolveResponseModeState({ responseFamily: 'gradia', injectionMode: 'sga' });

    // loadSettings() caches in Runtime.settings; the hook calls it without `force`, so the cache must be
    // dropped for the new mode to take effect.
    const runtime = api.getRuntime();
    out.cacheBefore = { injectionMode: runtime?.settings?.injectionMode, loadedAt: runtime?.settingsLoadedAt };
    runtime.settingsLoadedAt = 0;
    runtime.settings = null;

    // NOW commit, with the mode already stored, so request and boundary share one settings digest.
    const committed = await f.run();
    out.commit = { completed: committed?.completed ?? null };
    out.cacheAfterCommit = { injectionMode: api.getRuntime()?.settings?.injectionMode };

    f.control.onCall = args => {
      const messages = args[0]?.messages || [];
      const system = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n');
      const user = messages.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n\n');
      const combined = `${system}\n${user}`;
      const kind = /libra\.sga_shadow/.test(combined) ? 'sga_shadow'
        : /libra\.sga_length_correction/.test(combined) ? 'length_correction'
        : /libra\.sga_patch/.test(combined) ? 'sga_patch'
        : /libra\.sga_private_analysis/.test(combined) ? 'private_analysis'
        : /libra\.canonical_artifact\.v4/.test(combined) ? 'memory_authoring'
        : /REACTION PLANNING|reaction brief/i.test(combined) ? 'planner'
        : 'other';
      out.calls.push({ kind, systemChars: system.length, userChars: user.length, system, user });

      if (kind === 'sga_shadow') return JSON.stringify({
        schema: 'libra.sga_shadow.v2', ok: true, continuity_locks: [], user_agency_locks: [],
        do_not_reveal: [],
        scene_design: { purpose: 'p', primary_tension: 't', beats: [], ending_boundary: 'e' },
        draft: compliantDraft
      });
      if (kind === 'length_correction') return JSON.stringify({ schema: 'libra.sga_length_correction.v2', ok: true, draft: compliantDraft });
      if (kind === 'sga_patch') return JSON.stringify({
        schema: 'libra.sga_patch.v2', stage: 'sga_character_aide', ok: true, analysis: '',
        continuity_locks: [], user_agency_locks: [], do_not_reveal: [], edits: [], binding: {}, edit_links: []
      });
      if (kind === 'memory_authoring') return JSON.stringify({ schema: 'libra.canonical_artifact.v4', entities: [], facts: [], stateBindings: [] });
      return JSON.stringify({ schema: 'libra.sga_private_analysis.v2', ok: true, summary: '', constraints: [], risks: [], directives: [] });
    };

    const messages = [
      ...(f.chat.messages || []).map(m => ({ role: m.role, content: String(m.data || '') })),
      { role: 'user', content: `<Current Input>\n${liveInput}\n</Current Input>` }
    ];

    let hookError = '';
    try { await f.control.hooks.beforeRequest(messages, 'model'); } catch (error) { hookError = `${error?.name}: ${String(error?.message || error).slice(0, 300)}`; }
    f.control.onCall = null;

    out.hookError = hookError;
    out.inputResolution = api._peekInputResolution();
    out.injectionMeta = api._peekInjectionMeta();
    out.injectionChars = api._lastInjection().length;
    out.lastSga = api._lastSga();
    out.lastSgaMeta = api._lastSgaMeta();
    out.stageTrace = api._stageTrace().map(row => ({
      stage: row?.stage, ok: row?.ok, reason: row?.reason,
      systemPromptChars: String(row?.systemPrompt || '').length,
      userPromptChars: String(row?.userPrompt || '').length
    }));

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    process.stdout.write(JSON.stringify({
      ok: true, out: OUT,
      runtimeBefore: out.runtimeBefore, runtimeWritten: out.runtimeWritten, runtimeReread: out.runtimeReread,
      resolveModeState: out.resolveModeState,
      hookError: out.hookError,
      inputSource: out.inputResolution?.inputSource,
      skipReason: out.inputResolution?.skipReason || '',
      injectedChars: out.injectionChars,
      lastSgaOk: out.lastSga?.ok, lastSgaStatus: out.lastSga?.status,
      lastSgaDraftChars: String(out.lastSga?.draft || '').length,
      callKinds: out.calls.map(c => `${c.kind}(${c.systemChars}/${c.userChars})`),
      stageTrace: out.stageTrace
    }, null, 1) + '\n');
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
