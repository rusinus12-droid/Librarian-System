'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

const flashbackPath = path.resolve(__dirname, '../plugins/Flashback_Memory.js');
const hayakuPath = path.resolve(__dirname, '../plugins/HAYAKU_Locator_Continuity.js');
const flashbackSource = fs.readFileSync(flashbackPath, 'utf8');
const hayakuSource = fs.readFileSync(hayakuPath, 'utf8');

const attachVisibilityDocument = context => {
  let state = 'visible';
  const listeners = new Map();
  const doc = {
    get visibilityState() { return state; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    }
  };
  context.document = doc;
  return {
    setVisibility(next) {
      state = next;
      for (const fn of [...(listeners.get('visibilitychange') || [])]) fn();
    },
    listenerCount(type = 'visibilitychange') {
      return listeners.get(type)?.size || 0;
    }
  };
};

test('Flashback pollFlashbackAttention avoids character cloning, backs off when idle, and pauses while hidden', async () => {
  const transformed = flashbackSource.replace(
    '_test: { maintenanceResultText,',
    '_test: { Runtime,startNativeCopyObserver,lightweightNativeCopyObserverIdentity,maintenanceResultText,'
  );
  const chat = {
    id: 'fb-attn-chat',
    chatId: 'fb-attn-chat',
    message: [
      { role: 'user', chatId: 'u1', data: 'Where is the key?' },
      { role: 'assistant', chatId: 'a1', data: 'Behind the clock.' }
    ]
  };
  const f = await createFixture({ source: transformed, pauseScheduledTimers: true, chat });
  try {
    const t = f.api._test;
    await t.stopFlashbackAttention();
    t.Runtime.nativeCopyObserver.running = false;

    const vis = attachVisibilityDocument(f.context);
    const delays = [];
    const origSetTimeout = f.context.setTimeout;
    f.context.setTimeout = (fn, delay, ...args) => {
      delays.push(delay);
      return origSetTimeout(fn, delay, ...args);
    };

    const reads = { character: 0, chat: 0 };
    for (const name of ['getCharacter', 'getChar', 'getCharacterFromIndex']) {
      if (typeof f.host[name] === 'function') {
        const real = f.host[name].bind(f.host);
        f.host[name] = async (...args) => { reads.character += 1; return real(...args); };
      }
    }
    const realChat = f.host.getChatFromIndex.bind(f.host);
    f.host.getChatFromIndex = async (...args) => { reads.chat += 1; return realChat(...args); };

    t.startFlashbackAttention();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.character, 0, 'pollFlashbackAttention never clones the full character');
    assert.equal(reads.chat, 1);

    // Three more unchanged polls -> quietChecks reaches 3 -> backs off from 10s to 30s
    await t.pollFlashbackAttention();
    await t.pollFlashbackAttention();
    await t.pollFlashbackAttention();
    assert.equal(reads.character, 0);
    assert.equal(reads.chat, 4);
    assert.ok(delays.includes(10000), 'initial polls use 10s interval');
    assert.equal(delays.at(-1), 30000, 'idle polls back off to 30s after 3 quiet checks');

    // Hidden tab: skips host reads and leaves no polling timer when visibilitychange is attached
    const chatBeforeHidden = reads.chat;
    vis.setVisibility('hidden');
    assert.equal(t.FlashbackAttention.pollTimer, null, 'hiding tab clears poll timer');
    await t.pollFlashbackAttention();
    assert.equal(reads.chat, chatBeforeHidden, 'hidden poll reads nothing from host');
    assert.ok(t.FlashbackAttention.hiddenSkips >= 1);

    // Becoming visible wakes polling immediately
    vis.setVisibility('visible');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(reads.chat > chatBeforeHidden, 'becoming visible resumes polling');

    await t.stopFlashbackAttention();
    assert.equal(vis.listenerCount('visibilitychange'), 0, 'stop removes visibilitychange listener');
  } finally {
    await f.dispose();
  }
});

test('Flashback nativeCopyObserver skips when off, uses 5m character TTL, backs off to 30s, and skips redundant followups', async () => {
  const transformed = flashbackSource.replace(
    '_test: { maintenanceResultText,',
    '_test: { Runtime,startNativeCopyObserver,lightweightNativeCopyObserverIdentity,NATIVE_COPY_OBSERVER_CHARACTER_ID_TTL_MS,maintenanceResultText,'
  );
  const emptyChat = { id: 'empty-chat', chatId: 'empty-chat', message: [], messages: [] };
  const f = await createFixture({ source: transformed, pauseScheduledTimers: true, chat: emptyChat });
  try {
    const t = f.api._test;
    const o = t.Runtime.nativeCopyObserver;
    o.running = false;

    assert.equal(t.NATIVE_COPY_OBSERVER_CHARACTER_ID_TTL_MS, 300000, 'character ID TTL is 5 minutes');

    const scheduled = [];
    const origSetTimeout = f.context.setTimeout;
    f.context.setTimeout = (fn, delay, ...args) => {
      const handle = { fixturePausedTimer: true, delay, fn, args };
      scheduled.push(handle);
      origSetTimeout(() => {}, delay);
      return handle;
    };
    const runObserverTimer = async () => {
      const prev = o.timer;
      assert.ok(prev && typeof prev.fn === 'function', 'observer timer is armed');
      prev.fn(...(prev.args || []));
      const deadline = Date.now() + 2000;
      while (o.timer === prev && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.notEqual(o.timer, prev, 'observer rearmed next timer');
      return o.timer;
    };

    const reads = { character: 0, chat: 0 };
    const realChar = f.host.getCharacter.bind(f.host);
    f.host.getCharacter = async (...args) => { reads.character += 1; return realChar(...args); };
    const realChat = f.host.getChatFromIndex.bind(f.host);
    f.host.getChatFromIndex = async (...args) => { reads.chat += 1; return realChat(...args); };

    // 1. Character ID is cached across >30s and <5m
    o.characterId = null;
    await t.lightweightNativeCopyObserverIdentity();
    assert.equal(reads.character, 1);
    o.characterId.at = Date.now() - 60000;
    await t.lightweightNativeCopyObserverIdentity();
    assert.equal(reads.character, 1, 'still cached after 60s');

    // 2. Empty chat does not schedule 2500ms followup probes; quiet checks back off to 30s
    o.lastIdentity = '';
    o.quietChecks = 0;
    scheduled.length = 0;
    assert.equal(t.startNativeCopyObserver(), true);
    assert.equal(o.timer.delay, 250);
    await runObserverTimer();
    assert.equal(scheduled.some(entry => entry.delay === 2500), false, '0-message chat skips followup probe');
    assert.equal(o.timer.delay, 1800);
    for (let i = 0; i < 3; i += 1) {
      await runObserverTimer();
    }
    assert.equal(o.timer.delay, 30000, 'idle observer backs off to 30s after 3 quiet checks');

    // 3. Disabled mode skips host reads completely
    await f.api.saveSettings({ ...await f.api.loadSettings(), mode: 'off' });
    const readsBeforeOff = { ...reads };
    await runObserverTimer();
    assert.deepEqual(reads, readsBeforeOff, 'off mode makes zero host reads');
    assert.equal(o.timer.delay, 30000, 'off mode waits 30s');
    o.running = false;
  } finally {
    await f.dispose();
  }
});

test('HAYAKU pollHayakuAttention pauses when hidden or disabled and backs off to 30s when idle', async () => {
  const scheduledDelays = [];
  let docVis = null;
  const r = await createHayakuRuntime({
    messages: [{ role: 'user', chatId: 'u1', data: 'Hi' }, { role: 'assistant', chatId: 'a1', data: 'Hello' }],
    transformSource: src => src.replace(
      'startHayakuAttention, stopHayakuAttention,',
      'pollHayakuAttention, startHayakuAttention, stopHayakuAttention,'
    )
  });
  try {
    const t = r.hayaku._test;
    await t.stopHayakuAttention();
    docVis = attachVisibilityDocument(r.context);

    const origSetTimeout = r.context.setTimeout;
    r.context.setTimeout = (fn, delay, ...args) => {
      scheduledDelays.push(delay);
      return { unref() {} };
    };

    let indexReads = 0;
    const origCharIdx = r.host.getCurrentCharacterIndex.bind(r.host);
    const origChatIdx = r.host.getCurrentChatIndex.bind(r.host);
    r.host.getCurrentCharacterIndex = async (...args) => { indexReads += 1; return origCharIdx(...args); };
    r.host.getCurrentChatIndex = async (...args) => { indexReads += 1; return origChatIdx(...args); };

    t.startHayakuAttention();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(indexReads, 2, 'initial poll reads character & chat index');
    assert.equal(scheduledDelays.at(-1), 10000);

    // 3 unchanged checks -> backs off to 30s
    await t.pollHayakuAttention();
    await t.pollHayakuAttention();
    await t.pollHayakuAttention();
    assert.equal(scheduledDelays.at(-1), 30000, 'backs off to 30s after 3 quiet checks');

    // Hidden -> skips host reads and clears timer
    const readsBeforeHidden = indexReads;
    docVis.setVisibility('hidden');
    await t.pollHayakuAttention();
    assert.equal(indexReads, readsBeforeHidden, 'hidden poll skips host reads');
    assert.ok(t.HayakuAttention.hiddenSkips >= 1);

    // Visible again -> resumes immediately
    docVis.setVisibility('visible');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(indexReads > readsBeforeHidden, 'visible event wakes HAYAKU polling');

    // Disabled -> skips host reads and waits 30s
    const current = await r.hayaku.settingsControl.current();
    await r.hayaku.settingsControl.apply({ ...current, hayaku_enabled: false });
    const readsBeforeDisabled = indexReads;
    await t.pollHayakuAttention();
    assert.equal(indexReads, readsBeforeDisabled, 'disabled HAYAKU skips index polling');
    assert.equal(scheduledDelays.at(-1), 30000);

    await t.stopHayakuAttention();
    assert.equal(docVis.listenerCount('visibilitychange'), 0, 'stop removes visibilitychange listener');
    r.context.setTimeout = origSetTimeout;
  } finally {
    await r.dispose();
  }
});

test('Neither plugin installs a document-wide MutationObserver for portable backup UI', () => {
  const fbBlock = flashbackSource.slice(
    flashbackSource.indexOf('LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: Flashback START'),
    flashbackSource.indexOf('LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: Flashback END')
  );
  const hyBlock = hayakuSource.slice(
    hayakuSource.indexOf('LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: Hayaku START'),
    hayakuSource.indexOf('LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: Hayaku END')
  );
  assert.equal(fbBlock.includes('MutationObserver'), false);
  assert.equal(hyBlock.includes('MutationObserver'), false);
});
