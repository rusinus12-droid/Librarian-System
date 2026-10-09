'use strict';
// Dump the REAL SGA SHADOW and planner prompts, including the parts only the runtime adds.
//
// Why earlier captures were wrong:
//   - debugCompileSgaPrompt() returns only the editable SECTIONS. The JSON-artifact contract, the
//     evidence block, the commitment guard and the working target are composed later, inside
//     buildSgaShadowPrompts(), which the plugin does not expose.
//   - driving beforeRequest() from a test returns early with `no_safe_current_user_input`, because a
//     synthetic message list is not the shape RisuAI delivers.
//
// So this captures the composer itself. The plugin file on disk is NOT modified — the accessor is
// injected in memory only via transformSource, the same pattern libra_custom_prompt_pipeline_lock and
// code_review_findings_reachability use. The composer is then called with a realistic evidence packet
// and the compiled stage profile the runtime passes.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_MODES_PROMPT_OUT || '/tmp/libra_modes_prompt_dump.json';

const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

// Expose the composers in memory only. Anchors are asserted unique so a plugin edit that moves them
// fails loudly here instead of silently capturing the wrong thing.
//
// Two injections are needed, not one: buildSgaShadowPrompts lives in the LibraMemoryCore IIFE, while
// the object tests reach through (harness.api) is the separate public surface. Injecting only into
// the core leaves the public accessor undefined — measured, not assumed.
const instrument = source => {
  const composerAnchor = '    const buildSgaShadowPrompts = (evidencePacket, settings, compiled, routeIdentity, narrativeDynamics = null, skillRoute = null) =>';
  const coreSurfaceAnchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  const publicSurfaceAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, anchor] of [['composer', composerAnchor], ['core surface', coreSurfaceAnchor], ['public surface', publicSurfaceAnchor]]) {
    if (source.split(anchor).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreSurfaceAnchor,
      '      _captureBuildSgaShadowPrompts: (evidencePacket, settings, compiled, routeIdentity, narrativeDynamics = null, skillRoute = null) => buildSgaShadowPrompts(evidencePacket, settings, compiled, routeIdentity, narrativeDynamics, skillRoute),\n' +
      coreSurfaceAnchor)
    .replace(publicSurfaceAnchor,
      '    _captureBuildSgaShadowPrompts(evidencePacket = {}, settings = {}, compiled = {}, routeIdentity = {}, narrativeDynamics = null, skillRoute = null) { return safeClone(LibraMemoryCore._captureBuildSgaShadowPrompts(evidencePacket, settings, compiled, routeIdentity, narrativeDynamics, skillRoute)); },\n' +
      publicSurfaceAnchor);
};

const buildEvidencePacket = (sourceRows) => {
  const assistantRows = sourceRows.filter(r => /-a$/.test(r.ref));
  return {
    schema: 'libra.turn_recall_evidence.v1',
    route: 'unified',
    current_input: liveInput,
    terminal_scene: assistantRows.slice(-2).map(r => r.text).join('\n'),
    query_type: 'current_input',
    authority: [
      'current user input',
      'recent completed dialogue and resulting scene state',
      'older recalled canonical evidence'
    ],
    canonical_priority: {
      newerThanState: { rows: sourceRows.slice(-4), count: sourceRows.slice(-4).length },
      historicalAtOrBeforeState: { rows: sourceRows.slice(0, 6), count: sourceRows.slice(0, 6).length },
      newerCount: sourceRows.slice(-4).length
    },
    continuity_state_authority: { current: true, authority: 'current_head', pending: false },
    layers: sourceRows.map(row => ({ ref: row.ref, text: row.text, role: row.role || '' })),
    response_context: { requestId: 'prompt-capture', contextDigest: 'prompt-capture' }
  };
};

(async () => {
  const f = await fixture({ transformSource: instrument });
  const out = { capturedAt: new Date().toISOString(), liveInput };
  try {
    const committed = await f.run();
    out.commit = { completed: committed?.completed ?? null, memoryPresent: Boolean(f.getMemory()) };

    const api = f.r.api;
    const settings = await api.getLibraMemorySettings();
    const sourceRows = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;
    const evidencePacket = buildEvidencePacket(sourceRows);
    out.evidenceShape = {
      currentInputChars: evidencePacket.current_input.length,
      terminalSceneChars: evidencePacket.terminal_scene.length,
      layerCount: evidencePacket.layers.length
    };

    const compiled = await api.debugCompileSgaPrompt('sga_shadow');
    out.sgaCompiled = { keys: Object.keys(compiled || {}), bodyChars: String(compiled?.body || '').length };

    // 1. SGA SHADOW — the composer, with the same arguments the runtime uses.
    out.composerExposed = typeof api._captureBuildSgaShadowPrompts;
    if (typeof api._captureBuildSgaShadowPrompts === 'function') {
      try {
        const prompts = await api._captureBuildSgaShadowPrompts(
          evidencePacket, settings, compiled, { presetName: 'default' }, null, {}
        );
        out.sgaShadow = {
          system: String(prompts?.system || ''),
          user: String(prompts?.user || ''),
          minChars: prompts?.minChars ?? null,
          maxChars: prompts?.maxChars ?? null
        };
      } catch (error) {
        out.sgaShadowError = `${error?.name}: ${String(error?.message || error).slice(0, 300)}`;
      }
    }

    // 2. Planner — the diagnostic path, with a packet that carries a live input.
    out.plannerUser = String(await api.debugPlannerUserPrompt(evidencePacket) || '');
    const plannerCompiled = await api.debugCompilePlannerPrompt();
    out.plannerSystem = String(plannerCompiled?.body || '');
    out.plannerProfile = String(plannerCompiled?.profileBody || '');
    out.plannerUserHasRealInput = !/\[CURRENT USER INPUT — HIGHEST AUTHORITY\]\s*\n\(empty\)/.test(out.plannerUser);

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

    process.stdout.write(JSON.stringify({
      ok: true, out: OUT,
      commit: out.commit,
      evidenceShape: out.evidenceShape,
      composerExposed: out.composerExposed,
      sgaShadowError: out.sgaShadowError || '',
      sgaShadow: out.sgaShadow ? {
        systemChars: out.sgaShadow.system.length,
        userChars: out.sgaShadow.user.length,
        minChars: out.sgaShadow.minChars,
        maxChars: out.sgaShadow.maxChars,
        hasJsonContract: /libra\.sga_shadow/.test(out.sgaShadow.system),
        hasOutputContract: /OUTPUT CONTRACT/.test(out.sgaShadow.system),
        hasEvidenceBlock: /DO NOT QUOTE MERELY TO PROVE/.test(out.sgaShadow.user),
        hasWorkingTarget: /DRAFT WORKING TARGET/.test(out.sgaShadow.user)
      } : null,
      planner: {
        systemChars: out.plannerSystem.length,
        profileChars: out.plannerProfile.length,
        userChars: out.plannerUser.length,
        hasRealInput: out.plannerUserHasRealInput
      }
    }, null, 1) + '\n');
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
