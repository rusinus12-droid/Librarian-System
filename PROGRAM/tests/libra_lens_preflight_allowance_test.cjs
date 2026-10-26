'use strict';

const assert = require('assert');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

const sourcePath = path.join(__dirname, '../plugins/LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// 1. Static contract verification
assert(
  source.includes("const isMemoryTask=['canonical_memory','lens_analysis','micro_memory'].includes(taskKind);"),
  'LIBRA.js must treat canonical_memory, lens_analysis, and micro_memory as memory tasks'
);

assert(
  source.includes("const contextRemaining=isMemoryTask ? null :"),
  'LIBRA.js must not clamp contextRemaining for memory tasks'
);

// 2. Runtime behavioral test with large input and nominal context_window
async function test() {
  const hostFactory = require('./fixtures/libra_gui_memory_dom_host.cjs');
  const h = await hostFactory.create('LIBRA', 'Full', {
    args: { enable_gui: 'false' },
    host: {
      nativeFetch: async (url, init) => {
        return new Response(JSON.stringify({
          choices: [{
            message: { content: '{"items":[]}' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 14000, completion_tokens: 50, total_tokens: 14050 }
        }));
      }
    }
  });

  const mockFetch = async (url, init) => {
    return new h.context.Response(JSON.stringify({
      choices: [{
        message: { content: '{"items":[]}' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 14000, completion_tokens: 50, total_tokens: 14050 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  h.host.nativeFetch = mockFetch;
  h.context.fetch = mockFetch;
  if (h.context.risuai) h.context.risuai.nativeFetch = mockFetch;
  h.host.runLLMModel = async (...args) => ({ type: 'success', result: JSON.stringify({ items: [] }) });
  if (h.context.risuai) h.context.risuai.runLLMModel = h.host.runLLMModel;
  try {
    const settings = await h.api.getLibraProviderConfig();
    const deepseekPreset = {
      provider: 'custom',
      url: 'https://api.test.invalid/v1/chat/completions',
      model: 'deepseek-v4.1-flash:1017-cloud',
      key: 'test-key',
      context_window: 8192,
      max_tokens: 2048,
      stream: false,
      request_format: 'chat_completions'
    };

    // Save preset
    await h.api.saveLibraProviderConfig({
      defaultPresetName: 'deepseek-v4.1-flash:1017-cloud',
      providerPresets: {
        'deepseek-v4.1-flash:1017-cloud': deepseekPreset
      },
      stagePresetNames: {
        librarian: 'deepseek-v4.1-flash:1017-cloud'
      }
    });

    // Create a lens
    const lens = await h.api.createLens({
      name: '관계 분석',
      instruction: { goal: '인물 간의 관계를 분석한다.' },
      cadence: { mode: 'manual' },
      evidenceMode: 'strict',
      connection: { presetName: 'deepseek-v4.1-flash:1017-cloud' }
    });

    // Generate large turn texts (around 34,000 characters total, simulating user's report)
    const longTurnText = '마지아 베제와 레오파르트의 이야기. '.repeat(600); // ~18,000 chars
    const chat = await h.host.getChat();
    chat.message = [
      { role: 'user', chatId: 'u1', data: '안녕' },
      { role: 'assistant', chatId: 'a1', data: longTurnText },
      { role: 'user', chatId: 'u2', data: '계속해' },
      { role: 'assistant', chatId: 'a2', data: longTurnText }
    ];

    // Execute lens reanalysis for turns 1..2 (with ~36,000 characters input)
    // Prior to fix, this threw: "No output allowance; inspect this run preflight values. Source is preserved."
    const inventory = await h.api.listReanalysisRanges({ kind: 'lens', lensId: lens.lensId });
    const selection = { ...inventory, ranges: inventory.ranges.filter(row => row.start === 1 && row.end === 2) };
    const result = await h.api.reanalyzeSelectedRanges(selection);
    assert.equal(result.ok, true, 'Lens reanalysis must succeed without being blocked by preflight allowance: ' + result.reason);

    const diag = h.api.debugRuntimeForDisplay();
    const lastInv = diag.lastGenerationInvocation;
    assert.equal(lastInv.preflight.status, 'estimated_context_pressure');
    assert.equal(lastInv.preflight.contextRemaining, null);
    assert.equal(lastInv.preflight.effectiveOutputTokens, 2048);
    assert.equal(lastInv.preflight.effectiveOutputTokens, 2048);

    console.log('libra_lens_preflight_allowance_test: PASS');
  } finally {
    await h.close();
  }
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
