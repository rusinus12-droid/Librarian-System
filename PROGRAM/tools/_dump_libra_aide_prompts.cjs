'use strict';
// Dump the REAL AIDE stage prompts (sga_character_aide / sga_world_aide / sga_plot_aide).
//
// The 0.3.64 change document lists "AIDE 3단계 실제 모델 검증 — 미실시 (스키마 확인 완료)" as an open
// item. Verifying it against a real model needs the exact prompt the runtime composes, and that
// composer (`buildSgaAidePrompts`) is not on the public surface. This captures it the same way
// _dump_libra_modes_prompt.cjs captures the shadow composer: transformSource injects an accessor in
// memory only, and the plugin file on disk is never modified.
//
// TWO injections are required and both anchors are asserted unique (measured, not assumed): the
// composer lives inside the LibraMemoryCore IIFE, while the object tests reach through is the
// separate public surface. Injecting only into the core leaves the public accessor undefined.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_AIDE_PROMPT_OUT || '/tmp/libra_aide_prompt_dump.json';
const STAGES = ['sga_character_aide', 'sga_world_aide', 'sga_plot_aide'];

const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

const instrument = source => {
  const composerAnchor = '    const buildSgaAidePrompts = (stageId, evidencePacket, currentDraft, locks, settings, compiled, routeIdentity, narrativeDynamics = null, skillRoute = null) => {';
  const coreSurfaceAnchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  const publicSurfaceAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, anchor] of [['composer', composerAnchor], ['core surface', coreSurfaceAnchor], ['public surface', publicSurfaceAnchor]]) {
    if (source.split(anchor).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreSurfaceAnchor,
      '      _captureBuildSgaAidePrompts: (stageId, evidencePacket, currentDraft, locks, settings, compiled, routeIdentity, narrativeDynamics = null, skillRoute = null) => buildSgaAidePrompts(stageId, evidencePacket, currentDraft, locks, settings, compiled, routeIdentity, narrativeDynamics, skillRoute),\n' + coreSurfaceAnchor)
    .replace(publicSurfaceAnchor,
      '    _captureBuildSgaAidePrompts(stageId, evidencePacket = {}, currentDraft = \'\', locks = {}, settings = {}, compiled = {}, routeIdentity = {}, narrativeDynamics = null, skillRoute = null) { return safeClone(LibraMemoryCore._captureBuildSgaAidePrompts(stageId, evidencePacket, currentDraft, locks, settings, compiled, routeIdentity, narrativeDynamics, skillRoute)); },\n' + publicSurfaceAnchor);
};

const buildEvidencePacket = sourceRows => {
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
    response_context: { requestId: 'aide-capture', contextDigest: 'aide-capture' }
  };
};

(async () => {
  const f = await fixture({ transformSource: instrument });
  const out = { capturedAt: new Date().toISOString(), liveInput, stages: {} };
  try {
    const committed = await f.run();
    out.commit = { completed: committed?.completed ?? null, memoryPresent: Boolean(f.getMemory()) };

    const api = f.r.api;
    const settings = await api.getLibraMemorySettings();
    const sourceRows = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;
    const evidencePacket = buildEvidencePacket(sourceRows);

    // A realistic same-turn draft for the aides to patch, carried over from the shadow capture.
    const shadowRec = '/tmp/gemma_libra_sga_result.json';
    let currentDraft = '';
    if (fs.existsSync(shadowRec)) {
      try {
        const rec = JSON.parse(fs.readFileSync(shadowRec, 'utf8'));
        currentDraft = String(rec?.results?.sga_shadow?.attempts?.[0]?.draft || '');
      } catch (_) {}
    }
    out.currentDraftChars = currentDraft.length;

    out.composerExposed = typeof api._captureBuildSgaAidePrompts;
    for (const stageId of STAGES) {
      const row = { stageId };
      try {
        const compiled = await api.debugCompileSgaPrompt(stageId);
        row.compiled = { bodyChars: String(compiled?.body || '').length, profileChars: String(compiled?.profileBody || '').length };
        const prompts = await api._captureBuildSgaAidePrompts(
          stageId, evidencePacket, currentDraft, {}, settings, compiled, { presetName: 'default' }, null, {}
        );
        row.systemChars = String(prompts?.system || '').length;
        row.userChars = String(prompts?.user || '').length;
        row.system = String(prompts?.system || '');
        row.user = String(prompts?.user || '');
        // The contract the stage must satisfy, extracted from the prompt so the checker can assert
        // the model actually returned it (rather than the checker inventing its own schema).
        const m = /schema\s+\\\\?"([a-z0-9_.]+)"/i.exec(row.system) || /schema\s+"([a-z0-9_.]+)"/i.exec(row.system);
        row.declaredSchema = m ? m[1] : null;
      } catch (error) {
        row.error = `${error?.name}: ${String(error?.message || error).slice(0, 300)}`;
      }
      out.stages[stageId] = row;
    }

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    process.stdout.write(JSON.stringify({
      ok: true, out: OUT,
      commit: out.commit,
      currentDraftChars: out.currentDraftChars,
      composerExposed: out.composerExposed,
      stages: Object.fromEntries(Object.entries(out.stages).map(([k, v]) => [k, {
        systemChars: v.systemChars ?? null, userChars: v.userChars ?? null,
        declaredSchema: v.declaredSchema ?? null, error: v.error ?? null
      }]))
    }, null, 1) + '\n');
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
