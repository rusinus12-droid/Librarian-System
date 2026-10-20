'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const promptKey = 'libra:v1:prompt-overrides';

const waitFor = async (read, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA debug API did not initialize');
};

const store = new Map();
let unload = null;
let promptWrites = 0;
let corruptNextPromptWrite = false;
let failNextPromptWrite = false;
const storage = {
  async getItem(key) { return store.has(key) ? store.get(key) : null; },
  async setItem(key, value) {
    if (key === promptKey) {
      promptWrites += 1;
      if (failNextPromptWrite) {
        failNextPromptWrite = false;
        throw new Error('simulated prompt storage failure');
      }
      if (corruptNextPromptWrite) {
        corruptNextPromptWrite = false;
        store.set(key, '{"schema":"corrupted.prompt.store","prompts":{}}');
        return true;
      }
    }
    store.set(key, value);
    return true;
  },
  async removeItem(key) { store.delete(key); return true; },
  async keys() { return [...store.keys()]; }
};
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getArgument() { return undefined; },
  async getArg() { return undefined; },
  async nativeFetch() { throw new Error('offline prompt transaction runtime test'); },
  async onUnload(handler) { unload = handler; return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async addRisuReplacer() { return true; },
  async addRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }
};
const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  AbortController,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone,
  performance: globalThis.performance,
  Blob: globalThis.Blob,
  atob: globalThis.atob,
  btoa: globalThis.btoa
});

(async () => {
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);

  const baseline = await api.debugWritePromptOverrides({
    activeMemoryProfile: '기존 프리셋',
    memoryProfiles: {
      '기존 프리셋': {
        name: '기존 프리셋', version: 3,
        stages: { ariadne: { sections: { custom_addendum: { mode: 'append', text: '기존 지침' } } } }
      }
    },
    state: { state_entity_admission: { customPrompt: '이름과 직접 증거를 특히 확인한다.' } }
  });
  assert.equal(baseline.ok, true);
  const baselineRaw = store.get(promptKey);
  const baselineHash = baseline.semanticHash;

  await assert.rejects(
    api.debugWritePromptOverrides({activeMemoryProfile:'의미 검증 실패 프리셋',memoryProfiles:{'의미 검증 실패 프리셋':{name:'의미 검증 실패 프리셋',version:1,stages:{librarian:{sections:{ custom_addendum: { mode: 'append', text: '커스텀 validator가 거부해야 한다.' } }}}}}}, {
      expectedSemanticHash: baselineHash,
      validationErrorCode: 'PROMPT_TEST_CUSTOM_READBACK_REJECTED',
      validateReadback: () => ({
        ok: false,
        code: 'PROMPT_TEST_CUSTOM_READBACK_REJECTED',
        reason: 'simulated semantic target mismatch'
      })
    }),
    error => error?.code === 'PROMPT_OVERRIDES_TRANSACTION_ROLLED_BACK'
      && error?.validationCode === 'PROMPT_TEST_CUSTOM_READBACK_REJECTED'
  );
  assert.equal(store.get(promptKey), baselineRaw,
    'a caller-specific semantic readback failure restores the exact prior prompt store');

  corruptNextPromptWrite = true;
  await assert.rejects(
    api.debugWritePromptOverrides({activeMemoryProfile:'깨질 프리셋',memoryProfiles:{'깨질 프리셋':{name:'깨질 프리셋',version:1,stages:{librarian:{sections:{ custom_addendum: { mode: 'append', text: '손상 예정' } }}}}}}),
    error => error?.code === 'PROMPT_OVERRIDES_TRANSACTION_ROLLED_BACK'
  );
  assert.equal(store.get(promptKey), baselineRaw, 'corrupted write restores the exact prior durable record');
  const afterRollback = await api.debugReadPromptOverrides();
  assert.equal(afterRollback.semanticHash, baselineHash);
  assert.equal(afterRollback.prompts.activeMemoryProfile, '기존 프리셋');
  assert.equal(afterRollback.prompts.state.state_entity_admission.customPrompt, '이름과 직접 증거를 특히 확인한다.');

  const defaultTarget = api.debugPromptStudioOocTargets(afterRollback.prompts).find(item => (
    item.domain === 'memory'
    && item.profileName === 'default'
    && item.stageId === 'librarian'
    && item.sectionId === 'custom_addendum'
  ));
  assert.ok(defaultTarget);
  const first = await api.debugPersistPromptStudioOoc(
    defaultTarget,
    '관계 변화는 행동과 호칭의 누적 근거로 천천히 드러낸다.',
    { expectedBasisHash: defaultTarget.targetBasisHash }
  );
  assert.equal(first.ok, true);
  assert.equal(first.wrote, true);
  assert.equal(first.applied.created, true);
  assert.equal(first.applied.profileVersion, 1);
  assert.equal(first.profiles.activeMemoryProfile, first.applied.profileName);
  assert.equal(
    first.profiles.memoryProfiles[first.applied.profileName].stages.librarian.sections.custom_addendum.text,
    '관계 변화는 행동과 호칭의 누적 근거로 천천히 드러낸다.'
  );

  const activeTarget = api.debugPromptStudioOocTargets(first.prompts).find(item => (
    item.domain === 'memory'
    && item.profileName === first.applied.profileName
    && item.stageId === 'librarian'
    && item.sectionId === 'custom_addendum'
  ));
  assert.ok(activeTarget);
  const writesBeforeDuplicate = promptWrites;
  const duplicate = await api.debugPersistPromptStudioOoc(
    activeTarget,
    '관계 변화는 행동과 호칭의 누적 근거로 천천히 드러낸다.',
    { merge: true, expectedBasisHash: activeTarget.targetBasisHash }
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.wrote, false, 'identical explicit save is a no-write idempotent success');
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.applied.profileVersion, 1, 'idempotent save does not bump the managed profile version');
  assert.equal(promptWrites, writesBeforeDuplicate, 'idempotent save does not touch pluginStorage');
  assert.equal(
    duplicate.profiles.memoryProfiles[first.applied.profileName].stages.librarian.sections.custom_addendum.text,
    '관계 변화는 행동과 호칭의 누적 근거로 천천히 드러낸다.',
    'identical merge does not duplicate the paragraph'
  );

  const staleTarget = activeTarget;
  const externallyChanged = await api.debugWritePromptOverrides({
    ...duplicate.prompts,
    memoryProfiles: {
      ...duplicate.prompts.memoryProfiles,
      [first.applied.profileName]: {
        ...duplicate.prompts.memoryProfiles[first.applied.profileName],
        version: 2,
        stages: {
          ...duplicate.prompts.memoryProfiles[first.applied.profileName].stages,
          librarian: {
            sections: {
              ...duplicate.prompts.memoryProfiles[first.applied.profileName].stages.librarian.sections,
              custom_addendum: { mode: 'append', text: '외부에서 먼저 바뀐 지침' }
            }
          }
        }
      }
    }
  });
  assert.equal(externallyChanged.ok, true);
  await assert.rejects(
    api.debugPersistPromptStudioOoc(staleTarget, '낡은 미리보기의 저장', {
      merge: true,
      expectedBasisHash: staleTarget.targetBasisHash
    }),
    error => error?.code === 'PROMPT_STUDIO_OOC_TARGET_STALE'
  );
  const afterStale = await api.debugReadPromptOverrides();
  assert.equal(
    afterStale.prompts.memoryProfiles[first.applied.profileName].stages.librarian.sections.custom_addendum.text,
    '외부에서 먼저 바뀐 지침',
    'stale preview never overwrites a newer profile revision'
  );

  const latestTarget = api.debugPromptStudioOocTargets(afterStale.prompts).find(item => (
    item.domain === 'memory'
    && item.profileName === first.applied.profileName
    && item.stageId === 'librarian'
    && item.sectionId === 'custom_addendum'
  ));
  const rawBeforeFailure = store.get(promptKey);
  failNextPromptWrite = true;
  await assert.rejects(
    api.debugPersistPromptStudioOoc(latestTarget, '저장 실패 시 보존되어야 할 새 지침', {
      merge: true,
      expectedBasisHash: latestTarget.targetBasisHash
    }),
    error => error?.code === 'PROMPT_OVERRIDES_TRANSACTION_ROLLED_BACK'
  );
  assert.equal(store.get(promptKey), rawBeforeFailure, 'failed OOC save restores the exact prior profile store');
  const afterFailure = await api.debugReadPromptOverrides();
  assert.equal(
    afterFailure.prompts.memoryProfiles[first.applied.profileName].stages.librarian.sections.custom_addendum.text,
    '외부에서 먼저 바뀐 지침'
  );

  store.set(promptKey, JSON.stringify({
    active_memory_profile: '레거시 기억 프리셋',
    memory_profiles: {
      '레거시 기억 프리셋': {
        name: '레거시 기억 프리셋', version: 9,
        stages: { ariadne: { sections: { custom_addendum: { mode: 'append', text: '레거시 프로필 지침' } } } }
      }
    },
    state: {
      state_character_observer: { custom_prompt: '레거시 상태 관찰 지침' }
    }
  }));
  const legacyRead = await api.debugReadPromptOverrides();
  assert.equal(legacyRead.prompts.activeMemoryProfile, '레거시 기억 프리셋');
  assert.equal(legacyRead.prompts.memoryProfiles['레거시 기억 프리셋'].version, 9);
  assert.equal(
    legacyRead.prompts.memoryProfiles['레거시 기억 프리셋'].stages.ariadne.sections.custom_addendum.text,
    '레거시 프로필 지침'
  );
  assert.equal(legacyRead.prompts.state.state_character_observer.customPrompt, '레거시 상태 관찰 지침');
  const migrated = await api.debugWritePromptOverrides(legacyRead.prompts, {
    expectedSemanticHash: legacyRead.semanticHash
  });
  assert.equal(migrated.ok, true);
  const migratedEnvelope = JSON.parse(store.get(promptKey));
  assert.equal(migratedEnvelope.schema, 'libra.prompt_overrides_store.v4');
  assert.equal(migratedEnvelope.semanticHash, legacyRead.semanticHash,
    'unversioned/snake-case prompt profiles migrate into the v4 envelope without semantic loss');

  const conversationStart = source.indexOf('const runPromptStudioOocTurn = async message =>');
  const previewStart = source.indexOf('const compilePromptStudioOocPreview = async () =>', conversationStart);
  const applyStart = source.indexOf('const applyPromptStudioOocPreview = async', previewStart);
  const clearStart = source.indexOf('const clearPromptStudioOocConversation =', applyStart);
  assert.ok(conversationStart > 0 && previewStart > conversationStart && applyStart > previewStart && clearStart > applyStart);
  assert.doesNotMatch(source.slice(conversationStart, previewStart), /writePromptOverrides\s*\(|saveGuiState\s*\(|\.setItem\s*\(/,
    'OOC conversation performs no configuration write');
  assert.doesNotMatch(source.slice(previewStart, applyStart), /writePromptOverrides\s*\(|saveGuiState\s*\(|\.setItem\s*\(/,
    'OOC preview performs no configuration write');
  assert.match(source.slice(applyStart, clearStart), /persistPromptStudioOocMaterialized\s*\(/,
    'only explicit Apply enters the durable prompt transaction');
  assert.doesNotMatch(source.slice(applyStart, clearStart), /saveGuiState\s*\(/,
    'OOC Apply no longer saves unrelated GUI configuration');

  const memoryCoreStart = source.indexOf('const LibraMemoryCore = (() => {');
  const memoryCoreEnd = source.indexOf('const beforeRequest = async (messages, type) =>', memoryCoreStart);
  assert.ok(memoryCoreStart > 0 && memoryCoreEnd > memoryCoreStart);
  assert.doesNotMatch(source.slice(memoryCoreStart, memoryCoreEnd), /promptStudioOoc/i,
    'ephemeral OOC conversation state is not reachable from Canonical, State, or Recall evidence code');
  const rawBuilderRefs = [...source.matchAll(/Gui\.promptStudioOocBuilder/g)].map(match => match.index);
  const ensureBuilderStart = source.indexOf('const ensurePromptStudioOocBuilderState = () =>');
  const ensureBuilderEnd = source.indexOf('const promptStudioOocMessages =', ensureBuilderStart);
  assert.equal(rawBuilderRefs.length, 4, 'the raw OOC conversation store has one encapsulated GUI owner');
  assert.ok(rawBuilderRefs.every(index => index > ensureBuilderStart && index < ensureBuilderEnd),
    'the OOC conversation store is confined to its ephemeral GUI state accessor');

  const exportStart = source.indexOf('const promptStudioExportPayload =');
  const importStart = source.indexOf('const importPromptStudioJson = async', exportStart);
  const importEnd = source.indexOf('const easyPromptConfigKey =', importStart);
  assert.ok(exportStart > 0 && importStart > exportStart && importEnd > importStart);
  assert.match(source.slice(exportStart, importStart), /PROMPT_PROFILE_EXPORT_SCHEMA[\s\S]*scope: 'all'[\s\S]*scope: 'selected'/,
    'Prompt Studio exposes both full-backup and selected-profile export payloads');
  assert.match(source.slice(importStart, importEnd), /payload\.scope\s*===\s*'selected'[\s\S]*payload\.scope\s*===\s*'all'[\s\S]*payload\?\.promptOverrides/,
    'Prompt Studio imports selected, full-backup, and legacy prompt payloads');
  // Prompt Studio saves only the prompt overrides (other unsaved settings stay pending), through
  // the same CAS/readback settings transaction.
  assert.match(source.slice(importStart, importEnd), /await savePromptProfilesOnly\(\)/,
    'Prompt Studio import durably saves the normalized profile state');
  const promptOnly = source.slice(source.indexOf('const savePromptProfilesOnly = async'), source.indexOf('const saveSettingsRoom = async'));
  assert.match(promptOnly, /persistStructuredSettingsState\(\{\s*prompts: guiPromptsToStored\(state\.prompts, state\.promptProfiles\)[\s\S]*expectedBasisHash/,
    'the prompt-only save is a basis-checked settings transaction');

  if (unload) await unload();
  process.stdout.write('libra_prompt_persistence_transaction_runtime_test: PASS\n');
})().catch(async error => {
  if (unload) await unload().catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
