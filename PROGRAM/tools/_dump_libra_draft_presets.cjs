'use strict';
// Capture the SGA DRAFT prompt at each length preset, by RUNNING the plugin's own builder.
//
// "경량 초안" and "중량 초안" are the same stage at different length presets: the plugin's own
// SIMPLE_LENGTH_CHOICES defines compact 1,000-2,000, standard 3,000-5,000, detailed 5,000-7,000,
// extended 8,000+. The prompt is built by buildSgaShadowPrompts(evidencePacket, settings, ...), so the
// settings are what change between presets — the builder is asked once per preset.
//
// The plugin on disk is not modified: the builder is exposed through the same measured instrumentation
// anchor the existing dump tools use, injected into the source string before evaluation.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_DRAFT_PRESET_OUT || '/tmp/libra_draft_preset_prompts.json';

const instrument = source => {
  // Two surfaces, both required (measured): the core IIFE holds the builder, and harness.api is a
  // separate public object. Exposing on the core alone leaves the accessor unreachable, which looked
  // like "the builder is not available" even though it was injected.
  const coreAnchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core anchor', coreAnchor], ['public anchor', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} must be unique`);
  }
  return source
    .replace(coreAnchor,
      '      _captureBuildSgaShadowPrompts: (...args) => buildSgaShadowPrompts(...args),\n' + coreAnchor)
    .replace(publicAnchor,
      "    _captureBuildSgaShadowPrompts(...args) { return LibraMemoryCore._captureBuildSgaShadowPrompts(...args); },\n" + publicAnchor);
};

(async () => {
  const out = { capturedAt: new Date().toISOString(), presets: {} };
  const f = await fixture({ transformSource: instrument });
  try {
    await f.run();
    const api = f.r.api;
    if (typeof api._captureBuildSgaShadowPrompts !== 'function') {
      throw new Error('_captureBuildSgaShadowPrompts is not available on the public surface');
    }

    const base = await api.getLibraMemorySettings();
    const sourceRows = require(path.join(__dirname, '..', 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;
    const assistantRows = sourceRows.filter(r => /-a$/.test(r.ref));
    const evidencePacket = {
      schema: 'libra.turn_recall_evidence.v1',
      route: 'unified',
      current_input: '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?',
      terminal_scene: assistantRows.slice(-2).map(r => r.text).join('\n'),
      query_type: 'current_input',
      layers: sourceRows.map(row => ({ ref: row.ref, text: row.text, role: row.role || '' })),
      canonical_priority: { newerThanState: { rows: [], count: 0 }, historicalAtOrBeforeState: { rows: [], count: 0 }, newerCount: 0 },
      continuity_state_authority: { current: true, authority: 'current_head', pending: false },
      response_context: { requestId: 'preset-capture', contextDigest: 'preset-capture' }
    };

    for (const [id, min, max] of [['compact', 1000, 2000], ['detailed', 5000, 7000]]) {
      const settings = { ...base, targetDraftMinChars: min, targetDraftMaxChars: max };
      try {
        const prompts = api._captureBuildSgaShadowPrompts(evidencePacket, settings, null, null, null, null);
        out.presets[id] = {
          requestedMin: min,
          requestedMax: max,
          minChars: prompts?.minChars,
          maxChars: prompts?.maxChars,
          system: String(prompts?.system || ''),
          user: String(prompts?.user || '')
        };
      } catch (error) {
        out.presets[id] = { error: `${error?.name}: ${String(error?.message || error).slice(0, 300)}` };
      }
    }
  } catch (error) {
    out.error = `${error?.name}: ${String(error?.message || error).slice(0, 400)}`;
  } finally {
    await f.cleanup?.();
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  process.stdout.write(JSON.stringify({
    out: OUT,
    error: out.error || null,
    presets: Object.fromEntries(Object.entries(out.presets).map(([key, value]) => [key, value?.error
      ? { error: value.error }
      : { minChars: value.minChars, maxChars: value.maxChars, systemChars: value.system.length, userChars: value.user.length }]))
  }, null, 1) + '\n');
  process.exit(0);
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
