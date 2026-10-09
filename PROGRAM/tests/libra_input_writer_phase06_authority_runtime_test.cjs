'use strict';

const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const ordered = (value, needles, label) => {
  let cursor = -1;
  for (const needle of needles) {
    const next = value.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `${label}: missing or out-of-order marker ${needle}`);
    cursor = next;
  }
};

const canonicalRow = (marker, memoryId, revision, turn) => ({
  memoryId,
  revision,
  turnRange: { start: turn, end: turn },
  selectedText: marker,
  text: marker
});

const packetFor = authority => ({
  terminal_scene: 'IW_TERMINAL_SCENE',
  live_tail_prompt: 'IW_LIVE_TAIL',
  continuity_state_prompt: 'IW_STATE_HEAD',
  narrative_prompt: 'IW_NARRATIVE_STATE',
  narrative_direction_prompt: 'IW_NARRATIVE_DIRECTION',
  continuity_state_authority: authority,
  canonical_priority: {
    schema: 'libra.planner_canonical_priority.v1',
    stateCurrent: authority.current === true,
    statePending: authority.pending === true,
    newerThanState: {
      memory: [canonicalRow('IW_CANONICAL_NEWER', 'mem-newer', 3, 30)],
      entity: [], world: [], narrative: []
    },
    historicalAtOrBeforeState: {
      memory: [canonicalRow('IW_CANONICAL_HISTORICAL', 'mem-old', 1, 10)],
      entity: [], world: [], narrative: []
    }
  },
  layers: { memory: [], entity: [], world: [], narrative: [] },
  author_note_prompt: 'IW_AUTHOR_NOTE',
  lore_prompt: 'IW_CREATIVE_LORE',
  story_arc_prompt: 'IW_STORY_ARC',
  bootstrap_reference_prompt: 'IW_BOOTSTRAP_REFERENCE'
});

(async () => {
  const llmCalls = [];
  const validChoices = JSON.stringify({
    schema: 'libra.input_writer_choices.v1', ok: true, mode: 'rp',
    choices: [
      { id: 'A', title: 'A', summary: 'first', perspective: '', input: 'candidate-a' },
      { id: 'B', title: 'B', summary: 'second', perspective: '', input: 'candidate-b' },
      { id: 'C', title: 'C', summary: 'third', perspective: '', input: 'candidate-c' }
    ]
  });
  const harness = await createLibraVmHarness({ enable_gui: 'false' }, {
    async runLLMModel(options) {
      llmCalls.push(structuredClone(options));
      return { type: 'success', result: validChoices };
    }
  });
  try {
    const beforeStorage = JSON.stringify([...harness.values.entries()]);
    const currentPreflight = {
      originalInput: 'IW_COMPOSER_INPUT',
      settings: { inputWriterMode: 'rp' },
      evidencePacket: packetFor({
        authority: 'current', current: true, pending: false,
        pendingDomains: [], sourceMode: 'exact_manifest'
      })
    };
    const current = await harness.api.debugBuildInputWriterPrompts(currentPreflight);
    assert.equal(current.mode, 'rp');
    ordered(current.user, [
      'IW_COMPOSER_INPUT',
      'IW_TERMINAL_SCENE',
      'IW_CANONICAL_NEWER',
      'IW_STATE_HEAD',
      'IW_NARRATIVE_STATE',
      'IW_CANONICAL_HISTORICAL',
      'IW_NARRATIVE_DIRECTION',
      'IW_CREATIVE_LORE'
    ], 'Input Writer factual authority');

    const currentStateOffset = current.user.indexOf('IW_STATE_HEAD');
    const currentStateHeading = current.user.slice(Math.max(0, currentStateOffset - 260), currentStateOffset);
    assert.match(currentStateHeading, /CURRENT[\s_-]*STATE|현재[\s_-]*상태/i,
      'an exact current Head must be visibly labelled as current');
    assert.doesNotMatch(currentStateHeading, /NON[-_ ]?AUTHORITATIVE|LAST[-_ ]?KNOWN|PENDING|미확정|비권위/i,
      'an exact current Head must not be labelled as pending/last-known');

    const pending = await harness.api.debugBuildInputWriterPrompts({
      originalInput: 'IW_COMPOSER_INPUT',
      settings: { inputWriterMode: 'author' },
      evidencePacket: packetFor({
        authority: 'last_known_pending', current: false, pending: true,
        pendingDomains: ['world'], sourceMode: 'partial_domain_head'
      })
    });
    const pendingStateOffset = pending.user.indexOf('IW_STATE_HEAD');
    assert.ok(pendingStateOffset >= 0, 'pending/partial State remains available as explicitly downgraded context');
    const pendingStateHeading = pending.user.slice(Math.max(0, pendingStateOffset - 320), pendingStateOffset);
    assert.match(pendingStateHeading, /NON[-_ ]?AUTHORITATIVE|LAST[-_ ]?KNOWN|PENDING|미확정|비권위/i,
      'pending/partial Head must be visibly downgraded before provider delivery');

    assert.equal(JSON.stringify([...harness.values.entries()]), beforeStorage,
      'prompt compilation must not mutate durable plugin storage');

    const generated = await harness.api.debugGenerateInputWriterChoices(currentPreflight);
    assert.equal(generated.ok, true);
    assert.equal(llmCalls.length, 1, 'one generation performs one physical provider call');
    const providerMessages = llmCalls[0].messages || [];
    assert.deepEqual(Array.from(providerMessages, message => message.role), ['system', 'user']);
    const providerUser = String(providerMessages.find(message => message.role === 'user')?.content || '');
    ordered(providerUser, [
      'IW_COMPOSER_INPUT', 'IW_TERMINAL_SCENE',
      'IW_CANONICAL_NEWER', 'IW_STATE_HEAD', 'IW_NARRATIVE_STATE',
      'IW_CANONICAL_HISTORICAL', 'IW_NARRATIVE_DIRECTION', 'IW_CREATIVE_LORE'
    ], 'physical provider payload authority');
  } finally {
    await harness.cleanup();
  }
  process.stdout.write('libra_input_writer_phase06_authority_runtime_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
