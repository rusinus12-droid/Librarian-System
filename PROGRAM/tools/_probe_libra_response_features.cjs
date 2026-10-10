'use strict';
// LIBRA's response-improvement subsystems: are they effective, and do they actually apply?
//
// Three candidates, each with a different default:
//   skill router        — default ON,  already verified: selects 1-2 of 18 per scene and its guidance
//                         reaches the real SGA prompt.
//   narrative dynamics  — default OFF ('off' preset). Does turning it on change the prompt at all?
//   response lore       — default ON.  Does recall actually select material, or is the block empty?
//
// "Effective" here means: turning the feature on changes what the model receives, in the direction the
// feature claims. A feature that renders the same prompt on and off is decoration.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_RESPONSE_FEATURES_OUT || '/tmp/libra_response_features.json';
const sourceRows = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;

const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

const evidencePacket = () => {
  const assistantRows = sourceRows.filter(r => /-a$/.test(r.ref));
  return {
    schema: 'libra.turn_recall_evidence.v1',
    route: 'unified',
    current_input: liveInput,
    terminal_scene: assistantRows.slice(-2).map(r => r.text).join('\n'),
    query_type: 'current_input',
    layers: sourceRows.map(row => ({ ref: row.ref, text: row.text, role: row.role || '' })),
    canonical_priority: {
      newerThanState: { rows: sourceRows.slice(-4), count: 4 },
      historicalAtOrBeforeState: { rows: sourceRows.slice(0, 6), count: 6 },
      newerCount: 4
    },
    continuity_state_authority: { current: true, authority: 'current_head', pending: false },
    response_context: { requestId: 'features', contextDigest: 'features' }
  };
};

const instrument = source => {
  const coreAnchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreAnchor,
      '      _buildDynamics: (ctx, ev, st) => clone(buildSgaNarrativeDynamicsPlan(ctx, ev, st)),\n' +
      '      _buildDynamicsPrompt: value => String(buildSgaNarrativeDynamicsPrompt(value) || ""),\n' +
      '      _shadowWith: (ev, st, compiled, route, dyn, skills) => buildSgaShadowPrompts(ev, st, compiled, route, dyn, skills),\n' +
      coreAnchor)
    .replace(publicAnchor,
      '    _buildDynamics(ctx, ev, st) { return LibraMemoryCore._buildDynamics(ctx, ev, st); },\n' +
      '    _buildDynamicsPrompt(value) { return LibraMemoryCore._buildDynamicsPrompt(value); },\n' +
      '    _shadowWith(ev, st, compiled, route, dyn, skills) { return safeClone(LibraMemoryCore._shadowWith(ev, st, compiled, route, dyn, skills)); },\n' +
      publicAnchor);
};

(async () => {
  const out = { capturedAt: new Date().toISOString() };
  const f = await fixture({ transformSource: instrument });
  try {
    await f.run();
    const api = f.r.api;
    const settings = await api.getLibraMemorySettings();

    // ---------------------------------------------------------------------------------------------
    // 1. NARRATIVE DYNAMICS — default off; does turning it on change the composed prompt?
    // ---------------------------------------------------------------------------------------------
    const compiled = await api.debugCompileSgaPrompt('sga_shadow');
    const routeIdentity = { presetName: 'default' };
    const ev = evidencePacket();

    const perPreset = {};
    for (const preset of ['off', 'subtle', 'cinematic', 'psychological', 'nonlinear']) {
      const withPreset = { ...settings, sgaNarrativeDynamicsPreset: preset, sga_narrative_dynamics_preset: preset };
      let plan = null;
      let planError = '';
      try { plan = await api._buildDynamics({ chat: f.chat, scope: { scopeKey: 'features' } }, ev, withPreset); }
      catch (error) { planError = `${error?.name}: ${String(error?.message || error).slice(0, 200)}`; }
      const planPrompt = plan ? api._buildDynamicsPrompt(plan) : '';
      let promptChars = -1;
      try {
        const prompts = await api._shadowWith(ev, withPreset, compiled, routeIdentity, plan, {});
        promptChars = String(prompts?.system || '').length;
      } catch (_) {}
      perPreset[preset] = {
        planError,
        planKeys: plan ? Object.keys(plan).slice(0, 10) : [],
        planActive: plan?.active === true || plan?.enabled === true,
        planModes: plan?.modes || plan?.selectedModes || [],
        planPromptChars: planPrompt.length,
        promptChars
      };
    }
    out.narrativeDynamics = perPreset;
    out.narrativeDynamicsChangesPrompt =
      new Set(Object.values(perPreset).map(v => v.promptChars)).size > 1;

    // ---------------------------------------------------------------------------------------------
    // 2. RESPONSE LORE — the recall material block. Is there material, and does the budget matter?
    // ---------------------------------------------------------------------------------------------
    const lorePerBudget = {};
    for (const maxChars of [12000, 2000, 500]) {
      const withBudget = { ...settings, responseLoreMaxChars: maxChars, response_lore_max_chars: maxChars };
      let prompts = null;
      let error = '';
      try { prompts = await api._shadowWith(ev, withBudget, compiled, routeIdentity, null, {}); }
      catch (e) { error = `${e?.name}: ${String(e?.message || e).slice(0, 200)}`; }
      const systemText = String(prompts?.system || '');
      const userText = String(prompts?.user || '');
      lorePerBudget[maxChars] = {
        error,
        systemChars: systemText.length,
        userChars: userText.length,
        hasLoreMaterialHeader: /LORE MATERIAL|READ-ONLY LIBRA RECALL|Unified Lore Material/i.test(systemText + userText)
      };
    }
    out.responseLore = lorePerBudget;
    out.responseLoreBudgetMatters =
      new Set(Object.values(lorePerBudget).map(v => v.userChars + v.systemChars)).size > 1;

    // ---------------------------------------------------------------------------------------------
    // 3. Does the lore actually carry the scene's own content, or is the block generic?
    // ---------------------------------------------------------------------------------------------
    const full = await api._shadowWith(ev, settings, compiled, routeIdentity, null, {});
    const fullText = `${full?.system || ''}\n${full?.user || ''}`;
    out.loreContent = {
      carriesTurnText: /열쇠|민아|지호|서재|도서관/.test(fullText),
      carriesCanonEvidence: /READ-ONLY LIBRA RECALL|LORE MATERIAL/.test(fullText),
      totalChars: fullText.length
    };

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
