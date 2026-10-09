'use strict';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');
const { hostData, evidence, choices } = require('./fixtures/libra_consumer_test_support.cjs');

// The real outer-scope functions are exercised in the complete plugin VM.
// Do not inject the memory-core's private asObject/asArray into that scope.
const expose = source => {
  const marker = '  const loadRisuContextSnapshot = async';
  assert.equal(source.split(marker).length, 2);
  return source.replace(marker, `  globalThis.__LIBRA_RECOVERY_L02__ = () => ({
    loadRisuContextSnapshot, loadSettings, reuseRisuSelectedLorebooks,
    renderIndependentActiveLorebooks, buildRisuHostRenderedLoreVariants,
    consumerSourceInventory, sealReferenceSourceSnapshot
  });\n${marker}`);
};

let harness, internals, data, providerReply;
const calls = [];
before(async () => {
  data = hostData();
  data.chat.note = 'HOST_METADATA_NOTE';
  data.chat.scriptstate = { '$scene': 'library' };
  harness = await createLibraVmHarness({ enable_gui: 'false', input_writer_enabled: 'true' }, {
    ...data.host,
    async runLLMModel(options) {
      calls.push(structuredClone(options));
      return { type: 'success', result: JSON.stringify(providerReply), finish_reason: 'stop' };
    }
  }, { transformSource: expose });
  internals = harness.context.__LIBRA_RECOVERY_L02__();
});
after(async () => { if (harness) await harness.cleanup(); });

test('receipt projection uses only frozen receipt dialogue while preserving current host metadata', async () => {
  const originalChat = JSON.stringify(data.chat);
  const requests = Object.freeze([
    Object.freeze({ role: 'user', content: 'RECEIPT_USER_ONLY', chatId: 'receipt-u' }),
    Object.freeze({ role: 'assistant', content: 'RECEIPT_ASSISTANT_ONLY', chatId: 'receipt-a' })
  ]);
  const snapshot = await internals.loadRisuContextSnapshot({ ...(await internals.loadSettings()), receiptDialogueSource: true }, requests);
  assert.equal(snapshot.chatInfo.chat.note, 'HOST_METADATA_NOTE');
  assert.equal(snapshot.chatInfo.chat.scriptstate.$scene, 'library');
  assert.deepEqual(Array.from(snapshot.chatInfo.chat.message, row => row.data), ['RECEIPT_USER_ONLY', 'RECEIPT_ASSISTANT_ONLY']);
  assert.deepEqual(Array.from(snapshot.chatInfo.chat.message, row => row.chatId), ['receipt-u', 'receipt-a']);
  assert.equal(snapshot.cbsContext.lastChar, 'RECEIPT_ASSISTANT_ONLY');
  assert.equal(JSON.stringify(data.chat), originalChat, 'host chat is not rewritten');
});

test('empty receipt projection never fills its dialogue from the host transcript', async () => {
  const snapshot = await internals.loadRisuContextSnapshot({ ...(await internals.loadSettings()), receiptDialogueSource: true }, []);
  assert.equal(snapshot.chatInfo.chat.message.length, 0);
  assert.equal(snapshot.cbsContext.lastChar, '');
  assert.equal(snapshot.chatInfo.chat.note, data.chat.note);
});

test('ordinary host context path still keeps its stored dialogue', async () => {
  const snapshot = await internals.loadRisuContextSnapshot(await internals.loadSettings(), []);
  assert.equal(snapshot.chatInfo.chat.message.length, data.chat.message.length);
  assert.equal(snapshot.cbsContext.lastChar, data.chat.message.at(-1).data);
});

test('CBS freshness inventory pins live host metadata independently of receipt rendering', async () => {
  const originalNote = data.chat.note;
  const originalBinding = data.chat.bindedPersona;
  const originalPersonas = data.db.personas;
  try {
    data.chat.note = '{{user}} should keep the door closed.';
    data.chat.bindedPersona = 'receipt-persona';
    data.db.personas = [{ id: 'receipt-persona', name: 'Current reader', personaPrompt: 'A reader' }];
    const snapshot = internals.sealReferenceSourceSnapshot(await internals.loadRisuContextSnapshot(
      { ...(await internals.loadSettings()), receiptDialogueSource: true },
      [{ role: 'user', content: 'RECEIPT_ONLY', chatId: 'receipt-only' }]
    ));
    const actualInventory = () => internals.consumerSourceInventory({
      character: data.character, chatInfo: { chat: data.chat }, db: data.db,
      persona: data.db.personas[0], candidates: snapshot.candidates
    });
    const originalDigest = snapshot.consumerSourceInventory.entries.author_note.digest;
    assert.equal(originalDigest, actualInventory().entries.author_note.digest);
    assert.equal(snapshot.cbsContext.lastUser, 'RECEIPT_ONLY', 'prompt rendering remains receipt-based');
    data.db.personas[0].name = 'Changed reader';
    assert.notEqual(originalDigest, actualInventory().entries.author_note.digest, 'live host CBS changes still invalidate consumption');
    assert.equal(snapshot.consumerSourceInventory.entries.author_note.digest, originalDigest, 'captured inventory is immutable data');
  } finally {
    data.chat.note = originalNote;
    data.chat.bindedPersona = originalBinding;
    data.db.personas = originalPersonas;
  }
});

test('native character lore without a receipt-source contract remains available to Input Writer', async () => {
  const originalLore = data.character.globalLore;
  try {
    data.character.globalLore = [{ id: 'native-rule-without-receipt', key: 'door', comment: 'Native door rule',
      content: 'NATIVE_LORE_WITHOUT_RECEIPT: the library closes at sunset.', alwaysActive: true, mode: 'normal' }];
    const beforeCalls = calls.length;
    const prepared = await harness.api.prepareInputWriterEvidence('Ask when the library closes.');
    assert.match(prepared.evidencePacket.lore_prompt, /NATIVE_LORE_WITHOUT_RECEIPT/);
    assert.equal(calls.length, beforeCalls, 'native reference preparation makes no model call');
    assert.equal((await harness.api.debugValidateInputWriterDeliverySnapshot(prepared.deliverySnapshot)).current, true);
  } finally { data.character.globalLore = originalLore; }
});

const openText = 'The copper door opens only for the river keeper.';
const closedText = 'The copper door stays closed to every visitor.';
const candidate = {
  id: 'lore-cbs-door', label: 'Door rule', sourceType: 'character',
  content: `{{#when::{{getglobalvar::door}}::is::1}}${openText}{{:else}}${closedText}{{/when}}`
};
const unknownContext = () => Object.freeze({
  globalVarsAvailable: false, globalVars: Object.freeze({}), chatVars: {}, defaultVars: {},
  messages: [], enabledModules: new Set(), characterName: 'Librarian', userName: 'Visitor'
});

test('CBS host-proven rendered lore contributes its actual selected count', () => {
  const context = unknownContext();
  const result = internals.reuseRisuSelectedLorebooks([{ role: 'system', content: openText }], [candidate], context);
  assert.equal(result.selectedCount, 1);
  assert.equal(result.activeLore[0].content, openText);
  assert.equal(result.activeLore[0].cbsRender.hostProven, true);
  assert.equal(context.globalVarsAvailable, false);
  assert.deepEqual(Object.keys(context.globalVars), [], 'assumed values never enter original host context');
});

test('missing globals without an exact rendered host match select no lore', () => {
  const context = unknownContext();
  const result = internals.reuseRisuSelectedLorebooks([{ role: 'system', content: 'Unrelated host setting' }], [candidate], context);
  assert.equal(result.selectedCount, 0);
  assert.equal(result.activeLore.length, 0);
  const independent = internals.renderIndependentActiveLorebooks([candidate], [], context);
  assert.equal(independent.activeLore.length, 0);
  assert.equal(independent.dropped[0].reason, 'global_toggle_unavailable');
});

test('ambiguous host proof containing both mutually exclusive CBS branches selects neither', () => {
  const result = internals.reuseRisuSelectedLorebooks([{ role: 'system', content: `${openText}\n${closedText}` }], [candidate], unknownContext());
  assert.equal(result.selectedCount, 0);
  assert.equal(result.activeLore.length, 0);
});

test('CBS variants with no nonempty selected branch do not invent lore', () => {
  const emptyCandidate = { ...candidate, content: '{{#if {{equal::{{getglobalvar::door}}::1}}}}{{/if}}' };
  const result = internals.reuseRisuSelectedLorebooks([{ role: 'system', content: openText }], [emptyCandidate], unknownContext());
  assert.equal(result.selectedCount, 0);
});

test('CBS bounded variants do not authorize excluded removable host blocks', () => {
  const result = internals.reuseRisuSelectedLorebooks([{ role: 'system', content: openText, removable: true }], [candidate], unknownContext());
  assert.equal(result.selectedCount, 0);
});

test('Input Writer polish completes with one choice and reports one completed choice', async () => {
  providerReply = choices('rp');
  providerReply.choices = [providerReply.choices[0]];
  const beforeCalls = calls.length;
  const result = await harness.api.debugGenerateInputWriterChoices({
    originalInput: 'Ask why the door is closed.', settings: { inputWriterMode: 'rp' },
    writerOptions: { task: 'polish' }, evidencePacket: evidence()
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.choiceTarget, 1);
  assert.equal(result.choices.length, 1);
  assert.equal(calls.length - beforeCalls, 1);
  const status = harness.api.getPipelineWorkStatus();
  assert.match(status.message, /1개/);
  assert.doesNotMatch(status.message, /3개/);
});

test('Input Writer alternatives with two accepted choices remain visibly 2/3 partial', async () => {
  providerReply = choices('rp');
  providerReply.choices = providerReply.choices.slice(0, 2);
  const result = await harness.api.debugGenerateInputWriterChoices({ originalInput: 'Ask about the door.', settings: { inputWriterMode: 'rp' }, evidencePacket: evidence() });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.choiceTarget, 3);
  assert.match(harness.api.getPipelineWorkStatus().message, /2\/3개/);
});

test('Input Writer zero-choice output is rejected without invented replacement choices', async () => {
  providerReply = choices('rp');
  providerReply.choices = [];
  const result = await harness.api.debugGenerateInputWriterChoices({ originalInput: 'Ask about the door.', settings: { inputWriterMode: 'rp' }, evidencePacket: evidence() });
  assert.equal(result.ok, false);
  assert.equal(result.usable, false);
  assert.equal(result.choices.length, 0);
});
