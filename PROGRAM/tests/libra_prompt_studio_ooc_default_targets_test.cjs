'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const waitFor = async (read, timeoutMs = 5000) => {
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
const storage = {
  async getItem(key) { return store.has(key) ? store.get(key) : null; },
  async setItem(key, value) { store.set(key, value); return true; },
  async removeItem(key) { store.delete(key); return true; },
  async keys() { return [...store.keys()]; }
};
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getArgument() { return undefined; },
  async getArg() { return undefined; },
  async nativeFetch() { throw new Error('test host has no Librarian System server'); },
  async onUnload(handler) { unload = handler; return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async addRisuReplacer() { return true; },
  async addRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }
};
const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const context = vm.createContext({
  risuai: host,
  console: quietConsole,
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

  const freshTargets = api.debugPromptStudioOocTargets({});
  assert.ok(freshTargets.length >= 60, 'fresh state exposes the built-in Prompt Studio catalog');
  assert.deepEqual(
    [...new Set(freshTargets.map(item => item.domain))].sort(),
    ['input_writer', 'memory', 'planner', 'sga'],
    'fresh target catalog covers every Prompt Studio domain'
  );
  assert.ok(freshTargets.every(item => item.profileName === 'default'), 'fresh targets come from the built-in default profile');

  const target = freshTargets.find(item => item.domain === 'memory'
    && item.stageId === 'librarian'
    && item.sectionId === 'custom_addendum');
  assert.ok(target, 'fresh state exposes the default Ariadne custom-addendum target');
  assert.equal(target.readOnly, true, 'the built-in target is marked read-only');

  const first = api.debugPromptStudioOocMaterialize({}, target, '관계 변화는 천천히 축적한다.');
  assert.equal(first.ok, true, 'explicit save materializes a user profile');
  assert.equal(first.created, true, 'first save creates the managed profile');
  assert.equal(first.managed, true, 'default target uses the managed-profile path');
  assert.equal(first.profiles.activeMemoryProfile, first.profileName, 'saved managed profile is activated');
  assert.equal(first.profiles.memoryProfiles[first.profileName].stages.librarian.sections.custom_addendum.mode, 'append');
  assert.equal(first.profiles.memoryProfiles[first.profileName].stages.librarian.sections.custom_addendum.text, '관계 변화는 천천히 축적한다.');

  const second = api.debugPromptStudioOocMaterialize(first.profiles, target, '행동과 호칭 변화로 근거를 보여준다.', { merge: true });
  assert.equal(second.ok, true, 'managed profile can be updated');
  assert.equal(second.created, false, 'subsequent save updates the same profile');
  assert.equal(second.profiles.memoryProfiles[first.profileName].version, 2, 'managed profile version increments');
  assert.equal(
    second.profiles.memoryProfiles[first.profileName].stages.librarian.sections.custom_addendum.text,
    '관계 변화는 천천히 축적한다.\n\n행동과 호칭 변화로 근거를 보여준다.',
    'merge appends without replacing the previous custom instruction'
  );

  const refreshedTargets = api.debugPromptStudioOocTargets(second.profiles);
  assert.ok(refreshedTargets.some(item => item.profileName === first.profileName && item.profileIsActive), 'refreshed catalog exposes the active managed profile');
  assert.ok(refreshedTargets.some(item => item.profileName === 'default'), 'refreshed catalog retains the immutable built-in targets');

  if (unload) await unload();
  process.stdout.write('libra_prompt_studio_ooc_default_targets_test: PASS\n');
})().catch(async error => {
  if (unload) await unload().catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
