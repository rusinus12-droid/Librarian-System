'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load: loadGradia } = require('./gradia/host.cjs');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');

const PRESET_PATH = path.resolve(__dirname, '..', 'prompt', 'Leave_RisuAI_Preset.json');
const HTML_PATH = path.resolve(__dirname, '..', 'prompt', 'Leave_RisuAI_Preset.html');

// Minimal balanced-block evaluator for Leave's RisuAI CBS conditionals.
const evalLeaveCbs = (template, vars = {}) => {
  const getVar = name => String(vars[name] ?? '0');
  const evalCond = expr => {
    const trimmed = expr.trim();
    if (trimmed.startsWith('{{equal::')) {
      const m = /^\{\{equal::\{\{getglobalvar::([a-z0-9_]+)\}\}::([^}]*)\}\}$/.exec(trimmed);
      if (!m) throw new Error(`Unsupported equal cond: ${trimmed}`);
      return getVar(m[1]) === m[2];
    }
    if (trimmed.startsWith('{{notequal::')) {
      const m = /^\{\{notequal::\{\{getglobalvar::([a-z0-9_]+)\}\}::([^}]*)\}\}$/.exec(trimmed);
      if (!m) throw new Error(`Unsupported notequal cond: ${trimmed}`);
      return getVar(m[1]) !== m[2];
    }
    if (trimmed.startsWith('{{any::')) {
      const inner = trimmed.slice('{{any::'.length, -2);
      const parts = inner.split('::{{').map((p, idx) => (idx === 0 ? p : `{{${p}`));
      return parts.some(evalCond);
    }
    throw new Error(`Unsupported CBS cond: ${trimmed}`);
  };

  let out = String(template || '');
  const openRe = /\{\{#if(?:_pure)?\s+/g;
  while (true) {
    openRe.lastIndex = 0;
    const match = openRe.exec(out);
    if (!match) break;
    const tagStart = match.index;
    const condStart = tagStart + match[0].length;
    // Find the closing `}}` of the opening `{{#if ...}}` tag
    let depth = 1;
    let pos = condStart;
    while (pos < out.length && depth > 0) {
      if (out.startsWith('{{', pos)) { depth += 1; pos += 2; continue; }
      if (out.startsWith('}}', pos)) { depth -= 1; pos += 2; continue; }
      pos += 1;
    }
    assert.equal(depth, 0, `Unclosed {{#if condition near ${out.slice(tagStart, tagStart + 80)}`);
    const condExpr = out.slice(condStart, pos - 2);
    const bodyStart = pos;
    // Find matching `{{/if}}`
    let blockDepth = 1;
    let scan = bodyStart;
    let closeStart = -1;
    while (scan < out.length && blockDepth > 0) {
      const nextOpen = out.indexOf('{{#if', scan);
      const nextClose = out.indexOf('{{/if}}', scan);
      assert.ok(nextClose >= 0, `Missing {{/if}} for block at ${tagStart}`);
      if (nextOpen >= 0 && nextOpen < nextClose) {
        blockDepth += 1;
        scan = nextOpen + 5;
      } else {
        blockDepth -= 1;
        if (blockDepth === 0) closeStart = nextClose;
        scan = nextClose + '{{/if}}'.length;
      }
    }
    const innerBody = out.slice(bodyStart, closeStart);
    const replacement = evalCond(condExpr) ? evalLeaveCbs(innerBody, vars) : '';
    out = out.slice(0, tagStart) + replacement + out.slice(closeStart + '{{/if}}'.length);
  }
  return out;
};

test('Leave preset GRADIA compatibility mode emits clean bullets, reasoning restraint, and closing order without altering normal Leave mode', () => {
  const preset = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const block01 = preset.promptTemplate.find(p => String(p?.name || '').startsWith('01.'));
  const block09 = preset.promptTemplate.find(p => String(p?.name || '').startsWith('09.'));
  assert.ok(block01 && block09, 'Leave preset blocks 01 and 09 exist');
  assert.match(html, /GRADIA 호환 모드.*reasoning_effort/s, 'HTML guide documents GRADIA compatibility reasoning_effort tip');

  const compatVars = {
    toggle_gradia_compat_mode: '1',
    toggle_writing_mode: '1',
    toggle_pipeline_mode: '0',
    toggle_state_tracker: '0',
    toggle_memory_backend: '0',
    toggle_output_lang: '0',
    toggle_model_adapter: '0',
    toggle_next_turn_seed: '1'
  };
  const compat01 = evalLeaveCbs(block01.text, compatVars);
  const compat09 = evalLeaveCbs(block09.text, compatVars);

  assert.equal(/\n\s*-\s*\n/.test(compat01), false, 'compat 01 has no dangling empty bullet lines');
  assert.match(compat01, /NATIVE REASONING RESTRAINT:.*under 150 words/s);
  assert.match(compat01, /FOOTER ORDER OVERRIDE \(GRADIA COMPATIBILITY\): Leave HUD \(<statusdata>\) is OFF/);
  assert.match(compat01, /Finished In-World Prose → Character-Card Status Line.*→ \(optional\) External Memory Packet/);
  assert.match(compat01, /STRUCTURED MEMORY PACKET CONTRACT:/);

  assert.match(compat09, /4\. Clean Output & Closing Order \(HUD Auto-Off\):/);
  assert.match(compat09, /Finished In-World Prose.*→ Character-Card Status Line.*→ Trailing External State Packet/);
  assert.match(compat09, /5\. Native Reasoning Restraint \(Anti-Truncation\):.*under 150 words/s);
  assert.doesNotMatch(compat09, /MANDATORY ORDER \(DO NOT STOP ON PROSE\)/);

  const normalVars = { ...compatVars, toggle_gradia_compat_mode: '0', toggle_writing_mode: '0' };
  const normal01 = evalLeaveCbs(block01.text, normalVars);
  const normal09 = evalLeaveCbs(block09.text, normalVars);
  assert.equal(/\n\s*-\s*\n/.test(normal01), false, 'normal 01 has no dangling empty bullet lines');
  assert.match(normal01, /STATE HUD CARD:/);
  assert.match(normal01, /FOOTER ORDER OVERRIDE: Always close the turn in order — Prose → <statusdata> Leave HUD/);
  assert.match(normal09, /STEP 2 — LEAVE HUD/);
  assert.match(normal09, /STEP 3 — CHARACTER-CARD STATUS LINE/);
});

test('GRADIA final overlays include originating input, reasoning restraint, status/packet compatibility, and never substitute empty afterRequest output', async () => {
  const h = await loadGradia({ captureInternals: true });
  const recent = {
    latestUser: '잠든 그녀를 보며 탁자에 엎드려 잠을 청하기로 했다.',
    terminalVisibleScene: '아린이 침대에서 잠들어 있었다.'
  };
  const candidate = '그는 의자에 앉아 조용히 눈을 감았다.';

  const novelOverlay = h.plugin.debugBuildFinalOverlay(candidate, recent, {
    writingMode: 'novel',
    internalDraftLanguage: 'korean',
    nsfwMode: 'off'
  });
  assert.match(novelOverlay, /\[ORIGINATING USER REQUEST — SAME TURN \/ NOT AFTER THE CANDIDATE\]/);
  assert.ok(novelOverlay.includes(recent.latestUser));
  assert.match(novelOverlay, /NATIVE REASONING RESTRAINT:/);
  assert.match(novelOverlay, /\[CANDIDATE END — HARD RESPONSE BOUNDARY\]/);
  assert.match(novelOverlay, /required character-card status line or (?:trailing|active) continuity(?: plugin)? state packet/i);
  assert.ok(!novelOverlay.includes('output only the final Novel-mode fiction prose'));

  const rpOverlay = h.plugin.debugBuildFinalOverlay(candidate, recent, {
    writingMode: 'rp',
    internalDraftLanguage: 'korean',
    nsfwMode: 'off'
  });
  assert.match(rpOverlay, /\[ORIGINATING USER CONTRIBUTION — SAME TURN \/ ALREADY ENACTED \/ NOT AFTER THE CANDIDATE\]/);
  assert.ok(rpOverlay.includes(recent.latestUser));
  assert.match(rpOverlay, /NATIVE REASONING RESTRAINT:/);
  assert.match(rpOverlay, /\[CANDIDATE END — HARD RESPONSE BOUNDARY\]/);
  assert.match(rpOverlay, /required (?:character-)?card status line or trailing continuity (?:state )?packet/i);

  // Empty model response must remain empty rather than substituting packetless finalDraft.
  h.internals.Runtime.finalDraft = candidate;
  const emptyStr = await h.hooks.afterRequest('', 'model');
  const emptyObj = await h.hooks.afterRequest({ content: '', reasoning: 'thinking only' }, 'model');
  assert.equal(emptyStr, '');
  assert.equal(emptyObj.content, '');
});

test('HAYAKU bare-marker runtime skeleton, cache hash, canonical digest invariance, and legacy output handler concealment', async () => {
  const scriptHandlers = new Map();
  const runtime = await createHayakuRuntime({
    messages: [],
    autoRepair: false,
    afterRequestAutoRepair: false,
    backgroundAutoRepair: false,
    hostOverrides: {
      addRisuScriptHandler: async (mode, handler) => {
        scriptHandlers.set(String(mode || ''), handler);
        return true;
      },
      removeRisuScriptHandler: async () => true
    }
  });
  try {
    const t = runtime.hayaku._test;
    const settings = {
      memoryLanguage: 'source',
      requestLineage: {
        logicalTurnId: 'turn_1',
        parentTurnNodeId: '',
        requestNonce: 'nonce_1',
        identityVersion: 2,
        lineageSchema: 'hayaku.request_lineage.v2',
        turnOwnerKey: 'owner_1',
        generationAttemptId: 'attempt_1'
      }
    };

    const skeleton = t.buildPacketRuntimeSkeletonInstruction(settings);
    const seal = t.buildPacketTerminalCompletionSeal(settings);
    assert.ok(!skeleton.includes('<!--') && !skeleton.includes('-->'), 'runtime skeleton has no HTML comment markers');
    assert.ok(!seal.includes('<!--') && !seal.includes('-->'), 'terminal seal has no HTML comment markers');
    assert.ok(skeleton.includes('HAYAKU_STATE_PACKET_START') && skeleton.includes('HAYAKU_STATE_PACKET_END'));
    assert.ok(seal.includes('HAYAKU_STATE_PACKET_START') && seal.includes('HAYAKU_STATE_PACKET_END'));

    // Static cache contract remains stable.
    const staticA = t.packetCacheStaticContract(settings);
    const staticB = t.packetCacheStaticContract({ ...settings, requestLineage: { ...settings.requestLineage, requestNonce: 'nonce_2' } });
    assert.equal(staticA.hash, staticB.hash);

    // Canonical source digest is identical for HTML-comment and bare-marker packet envelopes.
    const packetJson = JSON.stringify(createValidPacket({ turn: 1, summary: '문이 열렸다.' }));
    const withComment = `본문입니다.\n\n<!-- HAYAKU_STATE_PACKET_START\n${packetJson}\nHAYAKU_STATE_PACKET_END -->`;
    const withBare = `본문입니다.\n\nHAYAKU_STATE_PACKET_START\n${packetJson}\nHAYAKU_STATE_PACKET_END`;
    const canonComment = runtime.hayaku._test.stripHayakuDisplayArtifacts(withComment);
    const canonBare = runtime.hayaku._test.stripHayakuDisplayArtifacts(withBare);
    assert.equal(canonComment.trim(), '본문입니다.');
    assert.equal(canonBare.trim(), '본문입니다.');

    // Registered legacy output handler conceals complete bare-marker packets without touching incomplete streams.
    const outputHandler = scriptHandlers.get('output');
    assert.equal(typeof outputHandler, 'function', 'HAYAKU registers output script handler');
    const concealed = await outputHandler(withBare, 'output');
    assert.match(concealed, /<!-- HAYAKU_STATE_PACKET_START[\s\S]*HAYAKU_STATE_PACKET_END -->/);
    const streamingPartial = '본문입니다.\n\nHAYAKU_STATE_PACKET_START\n{"meta":';
    const untouchedPartial = await outputHandler(streamingPartial, 'output');
    assert.equal(untouchedPartial, streamingPartial);
  } finally {
    await runtime.dispose();
  }
});
