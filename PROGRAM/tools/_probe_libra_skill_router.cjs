'use strict';
// Does LIBRA's skill router actually route, and does the routed skill change the prompt?
//
// The question is effectiveness, not existence: a router that always returns the same set, or whose
// output never reaches the prompt, is decoration. This drives the real router with several different
// evidence packets and reports what it selects, what it rejects, and whether the selected guidance
// ends up inside the composed SGA prompt.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_SKILLS_OUT || '/tmp/libra_skill_router.json';
const sourceRows = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;

const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

const packet = (extra = {}) => {
  const assistantRows = sourceRows.filter(r => /-a$/.test(r.ref));
  return {
    schema: 'libra.turn_recall_evidence.v1',
    route: 'unified',
    current_input: liveInput,
    terminal_scene: assistantRows.slice(-2).map(r => r.text).join('\n'),
    query_type: 'current_input',
    layers: sourceRows.map(row => ({ ref: row.ref, text: row.text, role: row.role || '' })),
    canonical_priority: { newerThanState: { rows: [], count: 0 }, historicalAtOrBeforeState: { rows: [], count: 0 }, newerCount: 0 },
    continuity_state_authority: { current: true, authority: 'current_head', pending: false },
    response_context: { requestId: 'skill-probe', contextDigest: 'skill-probe' },
    ...extra
  };
};

// Prompts that should pull different skills, if the router reads the content at all.
const scenarios = [
  { label: 'baseline (key handover)', current: liveInput },
  { label: 'combat', current: '준호가 주먹을 날렸고 지호가 막아섰다. 둘이 서로를 밀치며 싸웠다.' },
  { label: 'intimate', current: '문을 잠그고 서로에게 다가갔다. 숨소리가 가까워지고 옷깃이 풀렸다.' },
  { label: 'investigation', current: '단서를 찾아 서재의 서류를 하나씩 확인하고 기록했다.' },
  { label: 'negotiation', current: '기록회와 조건을 협상했다. 대가와 양보 범위를 정했다.' }
];

const instrument = source => {
  const coreAnchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreAnchor,
      '      _captureSgaShadowFor: (evidencePacket, settings, compiled, routeIdentity, narrativeDynamics, skillRoute) => buildSgaShadowPrompts(evidencePacket, settings, compiled, routeIdentity, narrativeDynamics, skillRoute),\n' +
      coreAnchor)
    .replace(publicAnchor,
      '    _captureSgaShadowFor(evidencePacket, settings, compiled, routeIdentity, narrativeDynamics, skillRoute) { return safeClone(LibraMemoryCore._captureSgaShadowFor(evidencePacket, settings, compiled, routeIdentity, narrativeDynamics, skillRoute)); },\n' +
      publicAnchor);
};

(async () => {
  const out = { capturedAt: new Date().toISOString() };
  const f = await fixture({ transformSource: instrument });
  try {
    await f.run();
    const api = f.r.api;
    const settings = await api.getLibraMemorySettings();

    // 1. What skills exist to be routed?
    // SIGNATURE: debugSgaSkillRouter(stageId, evidence, draft, settings). Passing settings first — as
    // an earlier version of this probe did — makes the router look disabled (enabled:false) and every
    // selection empty, because the stage id it receives is an object. The order below is the measured one.
    const catalog = await (async () => { try { return await api.debugSgaSkillRouter('sga_shadow', packet(), liveInput, settings); } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; } })();
    out.routerReturnShape = catalog && !catalog.error
      ? { keys: Object.keys(catalog).slice(0, 14), sample: JSON.stringify(catalog).slice(0, 700) }
      : { error: catalog?.error };

    // 2. Route for each scenario and see whether the selection differs.
    out.perScenario = {};
    const compiled = await api.debugCompileSgaPrompt('sga_shadow');
    for (const scene of scenarios) {
      const ev = packet({ current_input: scene.current });
      let route = null;
      let routeError = '';
      try { route = await api.debugSgaSkillRouter('sga_shadow', ev, scene.current, settings); }
      catch (error) { routeError = `${error?.name}: ${String(error?.message || error).slice(0, 200)}`; }

      // Which skills were selected, and is the guidance non-empty?
      const selected = route?.selected || route?.skills || route?.routes || route;
      const selectedIds = Array.isArray(selected)
        ? selected.map(s => s?.id || s?.skillId || s?.name || String(s)).slice(0, 12)
        : (selected && typeof selected === 'object' ? Object.keys(selected).slice(0, 12) : []);

      // Does the selected guidance reach the composed prompt, and does the prompt grow?
      let promptChars = 0;
      let guidanceChars = 0;
      let guidanceInPrompt = false;
      try {
        const prompts = await api._captureSgaShadowFor(ev, settings, compiled, { presetName: 'default' }, null, route);
        promptChars = String(prompts?.system || '').length;
        guidanceChars = Number(route?.guidanceChars ?? String(route?.guidance || '').length) || 0;
        guidanceInPrompt = guidanceChars > 0 && String(prompts?.system || '').includes(String(route?.guidance || '').slice(0, 60));
      } catch (error) {
        promptChars = -1;
        guidanceChars = -1;
      }

      out.perScenario[scene.label] = {
        routeError,
        selectedCount: selectedIds.length,
        selectedIds,
        guidanceChars,
        promptChars,
        guidanceInPrompt,
        routeKeys: route && typeof route === 'object' ? Object.keys(route).slice(0, 12) : []
      };
    }

    // 3. Is the selection actually DIFFERENT per scene, or the same set every time?
    const signature = label => JSON.stringify(out.perScenario[label]?.selectedIds || []);
    out.selectionDiffers = new Set(scenarios.map(s => signature(s.label))).size;
    out.totalScenarios = scenarios.length;

    // 4. The guidance renderer itself: does it produce text for a route?
    const guidance = await (async () => {
      try {
        const first = await api.debugSgaSkillRouter('sga_shadow', packet(), liveInput, settings);
        return await api.debugSgaSkillGuidance(first || {}, 'sga_shadow', 'draft', settings);
      } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; }
    })();
    out.guidanceRenderer = guidance && !guidance.error
      ? { type: typeof guidance, chars: String(typeof guidance === 'string' ? guidance : JSON.stringify(guidance)).length, sample: String(typeof guidance === 'string' ? guidance : JSON.stringify(guidance)).slice(0, 500) }
      : { error: guidance?.error };

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
