'use strict';

// Full-plugin, mock-host contract tests. Only the provider boundary and private
// function visibility are replaced; production context/guards/commits stay real.
// A change restoring auto listeners, trusting enabled metadata, ignoring source
// edits/cancellation, or analyzing more than one batch must fail these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sourcePath = process.env.LIA_MANUAL_SOURCE || path.join(__dirname, '../plugins/LIA_Persona_Linker.js');
const sourceSnapshot = fs.readFileSync(sourcePath, 'utf8');
const sourceSha256 = crypto.createHash('sha256').update(sourceSnapshot).digest('hex');
const minifiedMode = process.env.LIA_MANUAL_MIN === '1';
let compiledSource;
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const hashText = value => {
  const input = String(value || ''); let hash = 2166136261;
  for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${(hash >>> 0).toString(36)}-${input.length}`;
};
const stateItem = value => ({ key: 'ongoing-goal', category: 'goal', value, durability: 'persistent', confidence: 96, evidence: ['Explicit USER goal'] });
const delta = { summary: 'Mock five-turn analysis', liveState: [stateItem('Updated unresolved goal')], coreCandidates: [], ignoredTransient: [] };
const liveKey = key => /liaPersonaLinkerLivePersona|liaPersonaLinkerPersonaProof/.test(key);
const durableSnapshot = fixture => JSON.stringify([...fixture.values].filter(([key]) => liveKey(key)).sort(([a], [b]) => a.localeCompare(b)));
const personaSnapshot = fixture => JSON.stringify(fixture.db.personas);
const messages = count => Array.from({ length: count }, (_, index) => {
  const n = index + 1;
  return [{ role: 'user', is_user: true, chatId: `u${n}`, data: `User turn ${n}` }, { role: 'assistant', is_user: false, chatId: `a${n}`, data: `Assistant turn ${n}` }];
}).flat();

function expose(_fixtureSource) {
  if (compiledSource) return compiledSource;
  let source = sourceSnapshot;
  assert.ok(source.includes('      getLiveSyncCaptureState:'), 'full-plugin runtime exposure seam exists');
  assert.ok(source.includes('    globalThis[LIA_RUNTIME_INSTANCE_KEY] = {'), 'provider replacement seam exists');
  source = source.replace('    globalThis[LIA_RUNTIME_INSTANCE_KEY] = {', `
    callIndependentProvider = (...args) => api.__manualTestProvider(...args);
    const originalManualTestEmotionHook = handlePersonaEmotionAssetAfterRequest;
    handlePersonaEmotionAssetAfterRequest = (...args) => { api.__manualTestEmotionCalls(); return originalManualTestEmotionHook(...args); };
    globalThis[LIA_RUNTIME_INSTANCE_KEY] = {`);
  source = source.replace('      getLiveSyncCaptureState:', `
      auditManual: typeof runManualLivePersonaAnalysis === 'function' ? expected => runManualLivePersonaAnalysis(expected) : null,
      auditCancel: typeof cancelManualLivePersonaAnalysis === 'function' ? reason => cancelManualLivePersonaAnalysis(reason) : null,
      auditCheck: options => checkLivePersonaSync(options),
      auditContext: () => getContext(),
      auditRender: ctx => renderPreview(ctx, { skipCapture: true }),
      auditBindUi: ctx => bindPreviewTools(ctx),
      auditRefreshUi: () => refreshPreview({ skipCapture: true }),
      auditInterceptPersonaWrite: callback => {
        const original = writePersonaArrayMutation;
        writePersonaArrayMutation = async (...args) => { await callback(...args); return await original(...args); };
      },
      auditReadBinding: scope => readLivePersonaBindingByScopeKey(scope, true),
      auditPending: () => ({ scheduled: liveSyncScheduledChecks.size, requeued: liveSyncRequeueByScope.size, inFlight: liveSyncInFlightScopes.size, proof: personaProofPendingRequests.length }),
      getLiveSyncCaptureState:`);
  const instrumented = `globalThis.fetch = async () => { throw new Error('Network forbidden by offline manual-analysis test'); };\n${source}`;
  compiledSource = minifiedMode ? require(process.env.LIA_TEST_TERSER || 'terser').minify_sync(instrumented, { compress: { defaults: true, unsafe: false, drop_console: true, passes: 3 }, mangle: { toplevel: true, properties: false } }).code : instrumented;
  assert.ok(compiledSource, 'instrumented source compiled');
  return compiledSource;
}

async function fixture(options = {}) {
  const calls = [], hooks = new Map(), counters = { hostReads: 0, hostWrites: 0, storageReads: 0, storageWrites: 0, liveReads: 0, liveWrites: 0, nativeFetch: 0, emotionCalls: 0 };
  let respond = async () => JSON.stringify(delta);
  let boot;
  const f = await createFixture(options.mode || 'official', {
    transformSource: expose,
    configureApi(api, state) {
      const { values, db, liveChat } = state;
      liveChat.message = messages(options.turns ?? 5);
      const key = [...values.keys()].find(key => key.startsWith('liaPersonaLinkerLivePersonaScopeV2::'));
      const binding = JSON.parse(values.get(key));
      binding.enabled = options.enabled ?? true;
      binding.liveState = [stateItem('Existing unresolved goal')];
      if (options.prepare) options.prepare({ ...state, binding, api });
      values.set(key, JSON.stringify(binding));
      const indexKey = 'liaPersonaLinkerLivePersonaIndexV2';
      const index = JSON.parse(values.get(indexKey));
      index.entries[binding.scopeKey].digest = hashText(values.get(key));
      values.set(indexKey, JSON.stringify(index));
      if (options.legacyStore) {
        values.delete(key); values.delete(indexKey);
        values.set('liaPersonaLinkerLivePersonaSyncV1', JSON.stringify({ version: 6, bindings: { [binding.scopeKey]: binding } }));
      }
      boot = { personas: JSON.stringify(db.personas), chat: JSON.stringify(liveChat), durable: JSON.stringify([...values].filter(([key]) => liveKey(key)).sort(([a], [b]) => a.localeCompare(b))), scopeKey: binding.scopeKey, storageKey: key };
      for (const name of ['getDatabase', 'getCurrentCharacterIndex', 'getCurrentChatIndex', 'getCharacter', 'getCharacterFromIndex', 'getChat', 'getCurrentChat', 'getChatFromIndex']) {
        const original = api[name];
        api[name] = async (...args) => { counters.hostReads++; return await original(...args); };
      }
      for (const name of ['setDatabase', 'setChatToIndex']) {
        const original = api[name];
        api[name] = async (...args) => { counters.hostWrites++; return await original(...args); };
      }
      for (const name of ['getItem', 'setItem', 'removeItem', 'keys']) {
        const original = api.pluginStorage[name];
        api.pluginStorage[name] = async (...args) => {
          const write = name === 'setItem' || name === 'removeItem';
          counters[write ? 'storageWrites' : 'storageReads']++;
          if (liveKey(String(args[0] || ''))) counters[write ? 'liveWrites' : 'liveReads']++;
          return await original(...args);
        };
      }
      const register = api.addRisuReplacer;
      api.addRisuReplacer = async (name, handler) => { hooks.set(name, handler); return await register(name, handler); };
      api.nativeFetch = async () => { counters.nativeFetch++; throw new Error('Native network forbidden by offline manual-analysis test'); };
      api.__manualTestProvider = async (...args) => { calls.push(clone(args.slice(0, 3))); return await respond(...args); };
      api.__manualTestEmotionCalls = () => { counters.emotionCalls++; };
    },
  });
  return Object.assign(f, { calls, hooks, counters, boot,
    setProvider: value => { respond = value; },
    resetCounters: () => { for (const key of Object.keys(counters)) counters[key] = 0; },
    binding: () => JSON.parse(f.values.get(boot.storageKey)),
  });
}

async function withFixture(options, callback) {
  const f = await fixture(options);
  try { return await callback(f); }
  finally { await f.dispose(); assert.equal(f.counters.nativeFetch, 0, 'no native server/model/network calls'); }
}
function requireManual(f) {
  assert.equal(typeof f.runtime.auditManual, 'function', 'manual run entry must exist');
  assert.equal(typeof f.runtime.auditCancel, 'function', 'manual cancellation entry must exist');
}
async function noRetry(f, expectedCalls) {
  const pending = f.runtime.auditPending();
  assert.equal(pending.scheduled, 0, 'no automatic retry or catch-up timer');
  assert.equal(pending.requeued, 0, 'no queued automatic work');
  await sleep(760);
  assert.equal(f.calls.length, expectedCalls, 'no delayed retry or catch-up model call');
  assert.equal(f.runtime.auditPending().scheduled, 0);
}
async function startPending(f) {
  requireManual(f);
  f.resetCounters();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  f.setProvider(async () => { entered(); return await response; });
  const running = Promise.resolve(f.runtime.auditManual()).then(result => ({ result }), error => ({ error }));
  const enteredProvider = await Promise.race([started.then(() => true), running.then(outcome => ({ outcome })), sleep(2000).then(() => false)]);
  assert.equal(enteredProvider, true, `manual analysis must reach mock provider: ${JSON.stringify(enteredProvider)}`);
  return { running, release: () => release(JSON.stringify(delta)) };
}
function assertSkipped(outcome, message) {
  if (outcome.error) assert.match(String(outcome.error.code || outcome.error.message), /cancel|abort|stale|changed|superseded|scope|binding|persona|manual/i, message);
  else {
    assert.notEqual(outcome.result?.ok, true, message);
    assert.equal(outcome.result?.skipped === true || outcome.result?.cancelled === true || outcome.result?.stale === true, true, message);
    assert.ok(outcome.result.reason, `${message}: clear reason`);
  }
}

// Small DOM surface for the actual production renderer, binder and refresh path.
// Only the run/cancel/range/status controls are materialized; unrelated controls
// are absent rather than mocked handlers. Replacing root HTML replaces nodes.
function installManualDom(f) {
  if (process.env.LIA_MANUAL_JSDOM === '1') {
    const { JSDOM } = require(process.env.LIA_TEST_JSDOM || 'jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="dpg-status"></div><div id="dpg-preview-root"></div></body></html>');
    const handlers = new WeakMap(), proto = dom.window.EventTarget.prototype;
    const add = proto.addEventListener;
    proto.addEventListener = function (type, handler, ...rest) {
      let types = handlers.get(this); if (!types) handlers.set(this, types = new Map());
      const list = types.get(type) || []; list.push(handler); types.set(type, list);
      return add.call(this, type, handler, ...rest);
    };
    dom.window.HTMLElement.prototype.handlers = function (type = 'click') { return handlers.get(this)?.get(type) || []; };
    dom.window.HTMLElement.prototype.click = async function () {
      if (this.disabled) return;
      await Promise.all(this.handlers().map(handler => handler(new dom.window.MouseEvent('click'))));
    };
    f.context.document = dom.window.document;
    const root = dom.window.document.getElementById('dpg-preview-root');
    const oldDispose = f.dispose;
    f.dispose = async () => { try { await oldDispose(); } finally { dom.window.close(); } };
    return { get: id => dom.window.document.getElementById(id), root,
      async mount() { const ctx = await f.runtime.auditContext(); root.innerHTML = f.runtime.auditRender(ctx); f.runtime.auditBindUi(ctx); return ctx; },
    };
  }
  const nodes = new Map();
  const node = (id, text = '', disabled = false) => {
    const listeners = new Map();
    return { id, textContent: text, disabled, dataset: {}, style: {},
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      addEventListener(type, handler) { const entries = listeners.get(type) || []; entries.push(handler); listeners.set(type, entries); },
      handlers(type = 'click') { return listeners.get(type) || []; },
      async click() { if (this.disabled) return; await Promise.all(this.handlers().map(handler => handler({ target: this }))); },
    };
  };
  const root = node('dpg-preview-root');
  let html = '';
  Object.defineProperty(root, 'innerHTML', { get: () => html, set(value) {
    html = String(value);
    for (const id of ['dpg-live-run-now', 'dpg-live-cancel', 'dpg-live-range']) nodes.delete(id);
    for (const id of ['dpg-live-run-now', 'dpg-live-cancel', 'dpg-live-range']) {
      const match = new RegExp(`<[^>]+id="${id}"([^>]*)>([\\s\\S]*?)<\\/[^>]+>`).exec(html);
      if (match) nodes.set(id, node(id, match[2].replace(/<[^>]+>/g, ''), /\bdisabled\b/.test(match[1])));
    }
  } });
  nodes.set(root.id, root); nodes.set('dpg-status', node('dpg-status'));
  f.context.document = { getElementById: id => nodes.get(id) || null, querySelector: () => null, querySelectorAll: () => [],
    body: { contains: element => nodes.get(element?.id) === element },
  };
  return { get: id => nodes.get(id), root,
    async mount() { const ctx = await f.runtime.auditContext(); root.innerHTML = f.runtime.auditRender(ctx); f.runtime.auditBindUi(ctx); return ctx; },
  };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function reachedWithin(promise, operation, label) {
  const reached = await Promise.race([promise.then(() => true), operation.then(value => ({ premature: value })), sleep(2000).then(() => false)]);
  assert.equal(reached, true, `${label}: ${JSON.stringify(reached)}`);
}

const cases = [];
function test(name, run) { cases.push({ name, run }); }

for (const mode of ['official', 'script', 'fallback']) test(`automatic capture is not registered (${mode})`, () => withFixture({ mode }, async f => {
  assert.equal(f.registrations.chat, 0, 'manual mode must not register output chat listeners');
  assert.equal(f.registrations.script, 0, 'manual mode must not register output script listeners');
  assert.equal(f.outputListener, null);
  assert.equal(f.scriptOutputHandler, null);
  assert.equal(f.calls.length, 0);
}));

test('legacy enabled flag cannot authorize schedule, output, or check calls', () => withFixture({}, async f => {
  const personas = personaSnapshot(f), durable = durableSnapshot(f);
  f.resetCounters();
  assert.equal(f.runtime.debugScheduleLiveSync({ force: true, reason: 'ordinary_output' }), false, 'retired scheduler must return false');
  const output = await f.runtime.debugProcessChatOutput({ chat: f.liveChat, character: f.character, message: f.liveChat.message[9], messageIndex: 9, charIndex: 0, chatIndex: 0 });
  assert.equal(output.skipped, true); assert.equal(output.reason, 'manual_only');
  for (const options of [{}, { force: true }, { force: true, manual: true, manualAction: {}, reason: 'manual' }]) {
    const result = await f.runtime.auditCheck(options);
    assert.equal(result.skipped, true); assert.equal(result.reason, 'manual_only');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.counters.hostReads, 0); assert.equal(f.counters.liveReads, 0);
  assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
  await noRetry(f, 0);
}));

for (const enabled of [true, false]) test(`boot and UI reads preserve stored legacy state (enabled=${enabled})`, () => withFixture({ enabled, prepare({ binding, db }) {
  binding.displayNameVersion = 1; binding.livePersonaName = 'Source Persona_LIVE';
  db.personas[1].name = binding.livePersonaName;
  binding.lastError = 'Preserve legacy status'; binding.nextRetryAt = 12345;
} }, async f => {
  assert.equal(personaSnapshot(f), f.boot.personas, 'startup must not rename/repair Persona');
  assert.equal(durableSnapshot(f), f.boot.durable, 'startup must preserve exact stored bindings/state/ledgers');
  assert.equal(JSON.stringify(f.liveChat), f.boot.chat, 'startup must preserve chat binding');
  f.resetCounters();
  for (let i = 0; i < 3; i++) f.runtime.auditRender(await f.runtime.auditContext());
  assert.equal(personaSnapshot(f), f.boot.personas); assert.equal(durableSnapshot(f), f.boot.durable);
  assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0); assert.equal(f.calls.length, 0);
}));

test('legacy monolithic store is readable without migration or deletion on boot and UI reads', () => withFixture({ legacyStore: true }, async f => {
  assert.equal(durableSnapshot(f), f.boot.durable, 'startup preserves legacy store bytes and keys');
  assert.equal(personaSnapshot(f), f.boot.personas);
  f.resetCounters();
  const ctx = await f.runtime.auditContext();
  assert.equal(ctx.livePersonaBinding?.scopeKey, f.scopeKey, 'legacy binding remains readable');
  assert.equal(ctx.livePersonaBinding?.liveState[0]?.value, 'Existing unresolved goal');
  f.runtime.auditRender(ctx);
  assert.equal(durableSnapshot(f), f.boot.durable, 'UI reads do not migrate old store');
  assert.equal(f.counters.liveWrites, 0); assert.equal(f.counters.hostWrites, 0); assert.equal(f.calls.length, 0);
}));

test('copied-chat startup and UI reads do not inherit or fork the source live Persona', () => withFixture({ prepare({ db, liveChat, api }) {
  const parent = clone(liveChat);
  liveChat.id = 'copied-chat'; liveChat.chatId = 'copied-chat'; liveChat.copiedFromChatId = parent.id;
  db.characters[0].chats = [liveChat, parent];
  api.getChatFromIndex = async (_charIndex, chatIndex) => db.characters[0].chats[chatIndex];
} }, async f => {
  assert.equal(personaSnapshot(f), f.boot.personas, 'boot does not fork or add a Persona');
  assert.equal(durableSnapshot(f), f.boot.durable, 'boot does not inherit a scope or state');
  assert.equal(JSON.stringify(f.liveChat), f.boot.chat, 'copied chat binding stays unchanged');
  f.resetCounters();
  const ctx = await f.runtime.auditContext(); f.runtime.auditRender(ctx);
  assert.equal(ctx.livePersonaBinding, null, 'ordinary UI does not create a child binding');
  assert.equal(personaSnapshot(f), f.boot.personas); assert.equal(durableSnapshot(f), f.boot.durable);
  assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0); assert.equal(f.calls.length, 0);
}));

test('pending binding recovery metadata is preserved on boot and ordinary UI reads', () => withFixture({ prepare({ binding }) {
  binding.pendingBindingChange = { id: 'leave-explicit-recovery-to-user', state: 'pending', capturedAt: '2026-10-01T00:00:00.000Z' };
} }, async f => {
  assert.equal(durableSnapshot(f), f.boot.durable); assert.equal(personaSnapshot(f), f.boot.personas);
  f.resetCounters(); f.runtime.auditRender(await f.runtime.auditContext());
  assert.equal(durableSnapshot(f), f.boot.durable); assert.equal(personaSnapshot(f), f.boot.personas);
  assert.equal(f.counters.liveWrites, 0); assert.equal(f.counters.hostWrites, 0); assert.equal(f.calls.length, 0);
}));

test('ordinary before/after events are idle; separate emotion hook is retained', () => withFixture({}, async f => {
  const before = f.hooks.get('beforeRequest'), after = f.hooks.get('afterRequest');
  assert.equal(typeof after, 'function', 'emotion afterRequest hook remains registered');
  const input = [{ role: 'system', content: 'Base persona prompt' }, { role: 'user', content: 'ordinary request' }];
  if (before) assert.deepEqual(clone(await before(input, 'model')), input);
  assert.equal(await after('Ordinary narrative response', 'model'), 'Ordinary narrative response');
  await sleep(760);
  const personas = personaSnapshot(f), durable = durableSnapshot(f);
  f.resetCounters();
  for (let i = 0; i < 40; i++) {
    if (before) assert.deepEqual(clone(await before(input, 'model')), input);
    assert.equal(await after('Ordinary narrative response', 'model'), 'Ordinary narrative response');
    await f.runtime.debugProcessChatOutput({ messageIndex: 9, chat: f.liveChat, charIndex: 0, chatIndex: 0 });
  }
  assert.equal(f.counters.emotionCalls, 40, 'emotion hook continues to receive normal responses');
  assert.equal(f.calls.length, 0); assert.equal(f.counters.hostReads, 0, 'warm ordinary events do not cross host bridge');
  assert.equal(f.counters.storageReads, 0, 'warm ordinary events do not read plugin storage');
  assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.storageWrites, 0);
  assert.equal(f.runtime.auditPending().proof, 0, 'no Persona proof tracking on ordinary requests');
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
  await noRetry(f, 0);
  return { events: 40, counters: clone(f.counters) };
}));

for (const enabled of [true, false]) test(`one manual action commits next five and keeps source + prior state (enabled=${enabled})`, () => withFixture({ enabled, turns: 12 }, async f => {
  requireManual(f);
  const source = JSON.stringify(f.db.personas[0]), originalBinding = f.binding(), chatBinding = f.liveChat.bindedPersona;
  const result = await f.runtime.auditManual(await f.runtime.auditContext());
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(clone(result.range), [1, 5]);
  assert.equal(f.calls.length, 1);
  const userPrompt = f.calls[0][1];
  assert.match(userPrompt, /Base persona prompt/); assert.match(userPrompt, /Existing unresolved goal/);
  assert.match(userPrompt, /User turn 1\b/); assert.match(userPrompt, /Assistant turn 5\b/);
  assert.doesNotMatch(userPrompt, /(?:User|Assistant) turn (?:6|7|8|9|10|11|12)\b/);
  const saved = f.binding();
  assert.equal(saved.lastProcessedPairCount, 5); assert.equal(saved.anchorPairCount, originalBinding.anchorPairCount);
  assert.equal(saved.enabled, enabled, 'legacy enabled metadata is preserved, not required or toggled');
  assert.equal(saved.ledgers.length, 1); assert.equal(saved.ledgers[0].startPair, 1); assert.equal(saved.ledgers[0].endPair, 5);
  assert.equal(saved.liveState[0].value, 'Updated unresolved goal');
  assert.match(f.db.personas[1].personaPrompt, /Updated unresolved goal/);
  assert.equal(JSON.stringify(f.db.personas[0]), source, 'source Persona never overwritten');
  assert.equal(f.liveChat.bindedPersona, chatBinding); assert.equal(f.db.selectedPersona, 0);
  assert.ok(f.counters.hostWrites > 0); assert.ok(f.counters.liveWrites > 0);
  await noRetry(f, 1);
  const second = await f.runtime.auditManual();
  assert.equal(second.ok, true); assert.deepEqual(clone(second.range), [6, 10]);
  assert.equal(f.binding().lastProcessedPairCount, 10); assert.equal(f.binding().ledgers.length, 2);
  assert.equal(f.calls.length, 2); await noRetry(f, 2);
}));

for (const turns of [1, 2, 3, 4]) test(`insufficient ${turns} completed turns leaves all data untouched`, () => withFixture({ turns }, async f => {
  requireManual(f); const personas = personaSnapshot(f), durable = durableSnapshot(f); f.resetCounters();
  const result = await f.runtime.auditManual();
  assert.equal(result.skipped, true); assert.equal(result.reason, 'insufficient_turns');
  assert.equal(result.pending, turns); assert.equal(result.missing, 5 - turns);
  assert.equal(f.calls.length, 0); assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
  await noRetry(f, 0);
}));

test('immediate cancellation before first asynchronous read completes prevents provider entry', () => withFixture({}, async f => {
  requireManual(f); const personas = personaSnapshot(f), durable = durableSnapshot(f); f.resetCounters();
  const running = Promise.resolve(f.runtime.auditManual()).then(result => ({ result }), error => ({ error }));
  await f.runtime.auditCancel('cancel_during_admission');
  assertSkipped(await running, 'immediate cancellation');
  assert.equal(f.calls.length, 0); assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable); await noRetry(f, 0);
}));

test('duplicate click while provider pending cannot enqueue or commit twice', () => withFixture({}, async f => {
  const pending = await startPending(f);
  try {
    const second = await f.runtime.auditManual();
    assert.equal(second.skipped, true); assert.match(second.reason, /progress|flight|busy|running|duplicate/i);
    assert.equal(f.calls.length, 1); assert.equal(f.runtime.auditPending().requeued, 0);
  } finally { pending.release(); }
  const completed = await pending.running;
  assert.equal(completed.result?.ok, true, JSON.stringify(completed));
  assert.equal(f.binding().ledgers.length, 1); await noRetry(f, 1);
}));

const mutations = [
  ['cancel', async f => { await f.runtime.auditCancel('test_user_cancel'); }],
  ['active chat switch', async f => { f.api.getCurrentChatIndex = async () => 1; }],
  ['active character switch', async f => { f.api.getCurrentCharacterIndex = async () => 1; }],
  ['chat scope identity edit', async f => { f.liveChat.id = 'different-chat'; f.liveChat.chatId = 'different-chat'; }],
  ['pending batch message edit', async f => { f.liveChat.message[9].data += ' Edited during analysis'; }],
  ['live Persona prompt edit', async f => { f.db.personas[1].personaPrompt = 'User edited live Persona prompt'; }],
  ['source Persona prompt edit', async f => { f.db.personas[0].personaPrompt = 'User edited source Persona prompt'; }],
  ['selected Persona change', async f => { f.db.personas.push({ id: 'other-persona', name: 'Other', personaPrompt: 'Other prompt' }); f.db.selectedPersona = 2; }],
  ['chat binding edit', async f => { f.liveChat.bindedPersona = 'source-persona'; }],
  ['durable binding edit', async f => { const stored = f.binding(); stored.policy = 'auto'; f.values.set(f.boot.storageKey, JSON.stringify(stored)); }],
];
for (const [name, mutate] of mutations) test(`${name} before result discards without Persona or binding writes`, () => withFixture({}, async f => {
  const pending = await startPending(f);
  let personas, durable;
  try {
    await mutate(f); personas = personaSnapshot(f); durable = durableSnapshot(f);
  } finally { pending.release(); }
  assertSkipped(await pending.running, name);
  assert.equal(f.counters.hostWrites, 0, `${name}: no host commit`); assert.equal(f.counters.liveWrites, 0, `${name}: no durable binding commit`);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
  await noRetry(f, 1);
}));

test('earlier processed-message edit invalidates a later pending batch without rollback writes', () => withFixture({ turns: 10 }, async f => {
  requireManual(f); assert.equal((await f.runtime.auditManual()).ok, true);
  const pending = await startPending(f);
  const personas = personaSnapshot(f), durable = durableSnapshot(f);
  try { f.liveChat.message[1].data += ' Earlier processed evidence changed'; }
  finally { pending.release(); }
  assertSkipped(await pending.running, 'earlier processed-message edit');
  assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
  assert.equal(f.binding().lastProcessedPairCount, 5); await noRetry(f, 2);
}));

test('provider failure leaves stored state untouched and never schedules a retry', () => withFixture({}, async f => {
  requireManual(f); const personas = personaSnapshot(f), durable = durableSnapshot(f); f.resetCounters();
  f.setProvider(async () => { throw new Error('Offline mock provider failure'); });
  await assert.rejects(f.runtime.auditManual(), /Offline mock provider failure/);
  assert.equal(f.calls.length, 1); assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable); await noRetry(f, 1);
}));

test('actual UI run handler and DOM refresh keep duplicate clicks to one manual action', () => withFixture({ turns: 10 }, async f => {
  requireManual(f); const dom = installManualDom(f); await dom.mount();
  assert.match(dom.get('dpg-live-range').textContent, /TURN 1~5/);
  const run = dom.get('dpg-live-run-now');
  assert.equal(run.disabled, false); assert.equal(run.handlers().length, 1);
  const entered = deferred(), response = deferred();
  f.setProvider(async () => { entered.resolve(); return await response.promise; });
  const first = run.handlers()[0]();
  try {
    assert.equal(run.disabled, true); assert.equal(dom.get('dpg-live-cancel').disabled, false);
    await reachedWithin(entered.promise, first, 'actual UI click reaches provider');
    await run.handlers()[0](); // queued click already delivered before disabled state.
    assert.equal(f.calls.length, 1);
    await f.runtime.auditRefreshUi();
    const freshRun = dom.get('dpg-live-run-now');
    assert.notEqual(freshRun, run, 'actual refresh replaces the run node');
    assert.equal(freshRun.disabled, true, 'refreshed run remains disabled during action');
    assert.equal(dom.get('dpg-live-cancel').disabled, false);
    await freshRun.handlers()[0]();
    assert.equal(f.calls.length, 1, 'refreshed-DOM callback cannot authorize another action');
  } finally { response.resolve(JSON.stringify(delta)); }
  await first;
  assert.equal(f.binding().lastProcessedPairCount, 5); assert.equal(f.binding().ledgers.length, 1);
  assert.match(dom.get('dpg-status').textContent, /TURN 1~5/);
  assert.match(dom.get('dpg-live-range').textContent, /TURN 6~10/);
  assert.equal(dom.get('dpg-live-run-now').disabled, false);
  assert.equal(dom.get('dpg-live-cancel').disabled, true); await noRetry(f, 1);
}));

test('actual refreshed UI cancel handler discards an outstanding provider result', () => withFixture({}, async f => {
  requireManual(f); const dom = installManualDom(f); await dom.mount();
  const personas = personaSnapshot(f), durable = durableSnapshot(f); f.resetCounters();
  const entered = deferred(), response = deferred();
  f.setProvider(async () => { entered.resolve(); return await response.promise; });
  const running = dom.get('dpg-live-run-now').click();
  try {
    await reachedWithin(entered.promise, running, 'UI analysis provider pending');
    await f.runtime.auditRefreshUi();
    const cancel = dom.get('dpg-live-cancel');
    assert.equal(cancel.handlers().length, 1); assert.equal(cancel.disabled, false);
    await cancel.click(); assert.match(dom.get('dpg-status').textContent, /취소/);
  } finally { response.resolve(JSON.stringify(delta)); }
  await running;
  assert.match(dom.get('dpg-status').textContent, /취소/);
  assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
  assert.equal(dom.get('dpg-live-run-now').disabled, false); assert.equal(dom.get('dpg-live-cancel').disabled, true);
  await noRetry(f, 1);
}));

test('actual UI click explains insufficient turns and keeps data untouched', () => withFixture({ turns: 3 }, async f => {
  requireManual(f); const dom = installManualDom(f); await dom.mount();
  assert.match(dom.get('dpg-live-range').textContent, /3\/5턴/);
  assert.match(dom.get('dpg-live-range').textContent, /2턴/);
  const personas = personaSnapshot(f), durable = durableSnapshot(f); f.resetCounters();
  await dom.get('dpg-live-run-now').click();
  assert.match(dom.get('dpg-status').textContent, /3\/5턴/); assert.match(dom.get('dpg-status').textContent, /2턴/);
  assert.equal(f.calls.length, 0); assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
}));

for (const mutation of ['cancel', 'chat edit', 'binding edit']) test(`final host-write fence rejects ${mutation} after the earlier commit guard`, () => withFixture({}, async f => {
  requireManual(f);
  const gate = deferred(), entered = deferred();
  f.runtime.auditInterceptPersonaWrite(async operation => {
    assert.equal(operation, 'mutate'); entered.resolve(); await gate.promise;
  });
  f.resetCounters();
  const running = Promise.resolve(f.runtime.auditManual()).then(result => ({ result }), error => ({ error }));
  let personas, durable;
  try {
    await reachedWithin(entered.promise, running, 'manual action reaches real database write boundary');
    assert.equal(f.calls.length, 1); assert.equal(f.counters.hostWrites, 0);
    if (mutation === 'cancel') assert.equal(await f.runtime.auditCancel('cancel_at_final_fence'), true);
    if (mutation === 'chat edit') f.liveChat.message[9].data += ' changed at final fence';
    if (mutation === 'binding edit') { const binding = f.binding(); binding.policy = 'auto'; f.values.set(f.boot.storageKey, JSON.stringify(binding)); }
    personas = personaSnapshot(f); durable = durableSnapshot(f);
  } finally { gate.resolve(); }
  assertSkipped(await running, `final fence ${mutation}`);
  assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable); await noRetry(f, 1);
}));

test('final guard await cannot overwrite a concurrent unrelated Persona row edit', () => withFixture({ prepare({ db }) {
  db.personas.push({ id: 'unrelated-persona', name: 'Unrelated Persona', personaPrompt: 'Unrelated original prompt', note: 'original note' });
} }, async f => {
  requireManual(f); let guardExecuted = false;
  f.runtime.auditInterceptPersonaWrite(async (_operation, _snapshot, _nextPersonas, options) => {
    const realGuard = options.commitGuard;
    assert.equal(typeof realGuard, 'function', 'final write has a source guard');
    options.commitGuard = async () => {
      const verified = await realGuard();
      assert.equal(verified.ok, true, 'real final guard succeeds before unrelated host edit');
      // Replace rather than mutate the row object: host updates need not share
      // the old snapshot/next-write object references.
      f.db.personas[2] = { ...f.db.personas[2], note: 'Concurrent external edit must survive' };
      guardExecuted = true;
      return verified;
    };
  });
  const durable = durableSnapshot(f); f.resetCounters();
  const outcome = await Promise.resolve(f.runtime.auditManual()).then(result => ({ result }), error => ({ error }));
  assert.equal(guardExecuted, true, 'test reaches final guard await');
  assert.equal(f.counters.hostWrites, 0, 'fresh DB revalidation must reject after awaited guard');
  assert.notEqual(outcome.result?.ok, true, 'concurrent unrelated host edit invalidates prepared Persona array');
  if (outcome.error) assert.match(String(outcome.error.code || outcome.error.message), /CONFLICT|snapshot_changed/);
  assert.equal(f.db.personas[2].note, 'Concurrent external edit must survive');
  assert.equal(f.counters.liveWrites, 0); assert.equal(durableSnapshot(f), durable); await noRetry(f, 1);
}));

test('final guard stored-binding await cannot hide an active-chat switch', () => withFixture({}, async f => {
  requireManual(f); let changed=false;
  f.runtime.auditInterceptPersonaWrite(async (_operation,_snapshot,_nextPersonas,options) => {
    const realGuard=options.commitGuard, get=f.api.pluginStorage.getItem;
    let armed=false;
    f.api.pluginStorage.getItem=async key=>{
      const value=await get(key);
      if(armed && key===f.boot.storageKey){armed=false;changed=true;f.api.getCurrentChatIndex=async()=>1;}
      return value;
    };
    options.commitGuard=async()=>{armed=true;try{return await realGuard();}finally{armed=false;}};
  });
  const personas=personaSnapshot(f),durable=durableSnapshot(f);f.resetCounters();
  const outcome=await Promise.resolve(f.runtime.auditManual()).then(result=>({result}),error=>({error}));
  assert.equal(changed,true,'scope switch occurs during final storage read');
  assertSkipped(outcome,'active chat changed during final storage await');
  assert.equal(f.counters.hostWrites,0);assert.equal(f.counters.liveWrites,0);
  assert.equal(personaSnapshot(f),personas);assert.equal(durableSnapshot(f),durable);await noRetry(f,1);
}));

test('actual UI refuses a changed displayed range after an earlier conversation edit', () => withFixture({turns:10}, async f => {
  requireManual(f);assert.equal((await f.runtime.auditManual()).ok,true);
  const dom=installManualDom(f);await dom.mount();assert.match(dom.get('dpg-live-range').textContent,/TURN 6~10/);
  f.liveChat.message[1].data+=' user edited an already processed pair after rendering';
  const personas=personaSnapshot(f),durable=durableSnapshot(f);f.resetCounters();
  await dom.get('dpg-live-run-now').click();
  assert.equal(f.calls.length,1,'click cannot silently authorize a different range than the displayed 6~10');
  assert.equal(f.counters.hostWrites,0);assert.equal(f.counters.liveWrites,0);
  assert.equal(personaSnapshot(f),personas);assert.equal(durableSnapshot(f),durable);
  assert.match(dom.get('dpg-status').textContent,/바뀌어|변경|다시/);
}));

for (const mutation of ['chat switch','character switch','selection unavailable']) test(`post-guard DB await rejects ${mutation} before host write`, () => withFixture({}, async f => {
  requireManual(f);let changed=false;
  f.runtime.auditInterceptPersonaWrite(async (_operation,_snapshot,_nextPersonas,options)=>{
    const guard=options.commitGuard,get=f.api.getDatabase;let armed=false;
    options.commitGuard=async()=>{const result=await guard();armed=result.ok===true;return result;};
    f.api.getDatabase=async(...args)=>{
      const db=await get(...args);
      if(armed){armed=false;changed=true;
        if(mutation==='chat switch')f.api.getCurrentChatIndex=async()=>1;
        if(mutation==='character switch')f.api.getCurrentCharacterIndex=async()=>1;
        if(mutation==='selection unavailable')f.api.getCurrentChatIndex=async()=>null;
      }
      return db;
    };
  });
  const personas=personaSnapshot(f),durable=durableSnapshot(f);f.resetCounters();
  const outcome=await Promise.resolve(f.runtime.auditManual()).then(result=>({result}),error=>({error}));
  assert.equal(changed,true,'change occurs in the last database observation');
  assertSkipped(outcome,mutation);assert.equal(f.counters.hostWrites,0);assert.equal(f.counters.liveWrites,0);
  assert.equal(personaSnapshot(f),personas);assert.equal(durableSnapshot(f),durable);await noRetry(f,1);
}));

test('stale supplied UI context is rejected before model or writes', () => withFixture({}, async f => {
  requireManual(f); const expected = clone(await f.runtime.auditContext());
  f.liveChat.id = 'switched-ui-chat'; f.liveChat.chatId = 'switched-ui-chat';
  const personas = personaSnapshot(f), durable = durableSnapshot(f); f.resetCounters();
  const outcome = await Promise.resolve(f.runtime.auditManual(expected)).then(result => ({ result }), error => ({ error }));
  assertSkipped(outcome, 'stale supplied UI context');
  assert.equal(f.calls.length, 0); assert.equal(f.counters.hostWrites, 0); assert.equal(f.counters.liveWrites, 0);
  assert.equal(personaSnapshot(f), personas); assert.equal(durableSnapshot(f), durable);
}));

(async () => {
  console.log(JSON.stringify({ sourcePath, sourceSha256, executionMode: minifiedMode ? 'instrumented-min' : 'full', dom: process.env.LIA_MANUAL_JSDOM === '1' ? 'jsdom' : 'minimal-controls', fixture: 'full-plugin VM, mock provider boundary, no network' }));
  const selectedCases = process.env.LIA_MANUAL_FILTER ? cases.filter(item => item.name.includes(process.env.LIA_MANUAL_FILTER)) : cases;
  assert.ok(selectedCases.length, 'test filter selected at least one case');
  const rows = []; let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < selectedCases.length) {
      const index = next++, item = selectedCases[index];
      try { const detail = await item.run(); rows[index] = { name: item.name, passed: true, ...(detail ? { detail } : {}) }; }
      catch (error) { rows[index] = { name: item.name, passed: false, error: error.stack || String(error) }; process.exitCode = 1; }
      console.log(`${rows[index].passed ? 'PASS' : 'FAIL'}: ${item.name}${rows[index].passed ? '' : '\n' + rows[index].error}`);
    }
  }));
  console.log(JSON.stringify({ test: 'lia_manual_analysis_runtime', total: rows.length, passed: rows.filter(row => row.passed).length, failed: rows.filter(row => !row.passed).length, externalModelCalls: 0, rows }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
