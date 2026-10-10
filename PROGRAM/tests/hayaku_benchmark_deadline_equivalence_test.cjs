'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { loadRecipe } = require('../tools/hayaku_benchmark_recipe_v2.cjs');
const archive = path.join(__dirname, 'fixtures/hayaku-benchmark-recipe-v2');

function controlledFixture(version, clock) {
  const file = path.join(archive, `hayaku-runtime-${version}.cjs`);
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, require, __filename: file, __dirname: archive,
    Date: { now: () => clock.now },
    setTimeout(fn) { clock.now = clock.next; fn(); }
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return module.exports;
}

function controlledRuntimeFixture(version, publishedAt) {
  const file = path.join(archive, `hayaku-runtime-${version}.cjs`);
  const module = { exports: {} };
  const clock = { now: 0 }, timers = [];
  const schedule = (fn, delay) => {
    const timer = { fn, at: clock.now + delay, fired: false };
    timers.push(timer);
    if (delay === 10) {
      for (const pending of timers.filter(t => t !== timer && !t.fired && t.at <= 15001).sort((a, b) => a.at - b.at)) {
        clock.now = pending.at; pending.fired = true; pending.fn();
      }
      clock.now = 15001; timer.fired = true; fn();
    }
    return timer;
  };
  const syntheticFile = 'synthetic-publication-control';
  const sandbox = {
    module, exports: module.exports, __filename: file, __dirname: archive,
    require(name) { if (name === 'node:fs') return { ...fs, readFileSync(file, ...args) { return file === syntheticFile ? `setTimeout(() => { globalThis.HAYAKU = { api: 'synthetic' }; }, ${publishedAt});` : fs.readFileSync(file, ...args); } }; return require(name); },
    Date: { now: () => clock.now }, setTimeout: schedule,
    clearTimeout(t) { t.fired = true; }, setInterval() { throw Error('unexpected synthetic interval'); }, clearInterval() {},
    queueMicrotask, AbortController, AbortSignal, DOMException, URL, URLSearchParams,
    TextEncoder, TextDecoder, crypto: globalThis.crypto, structuredClone,
    performance, fetch, Headers, Request, Response, FormData, Blob, atob, btoa
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { fixture: module.exports, syntheticFile };
}

(async () => {
  const records = [];
  const record = (name, details) => records.push({ name, ok: true, ...details });
  for (const publishedAt of [14999, 15000, 15001, NaN, null]) {
    const outcomes = {};
    for (const version of ['v1', 'v2']) {
      const clock = { now: 0, next: 15001 };
      const fixture = controlledFixture(version, clock);
      const value = { api: 'same value' };
      try {
        const got = await fixture.waitFor(() => clock.now === 0 ? null : value, 'late poll', 15000, () => publishedAt);
        assert.equal(got, value);
        outcomes[version] = 'admitted';
      } catch (e) {
        assert.match(e.message, /Timed out waiting/);
        outcomes[version] = 'rejected';
      }
    }
    assert.equal(outcomes.v1, 'rejected', 'old observer deadline stays a failure');
    assert.equal(outcomes.v2, Number.isFinite(publishedAt) && publishedAt <= 15000 ? 'admitted' : 'rejected');
    record('delayed poll uses finite publication deadline', { publishedAt: Number.isNaN(publishedAt) ? 'NaN' : publishedAt, outcomes });
  }
  for (const version of ['v1', 'v2']) {
    const clock = { now: 0, next: 15001 };
    const fixture = controlledFixture(version, clock);
    await assert.rejects(fixture.waitFor(() => clock.now === 0 ? null : {}, 'unannotated', 15000), /Timed out/);
    const value = {};
    assert.equal(await fixture.waitFor(() => value, 'immediate', 15000), value);
    record('unannotated waits preserve old observer timeout', { version });
  }
  const a = loadRecipe().fixture;
  const b = loadRecipe({ fixtureVersion: 'v2' }).fixture;
  for (const p of [{}, { turn: 2, summary: 'BENCH_A0', packetType: 'current_snapshot' }]) {
    assert.equal(JSON.stringify(a.createValidPacket(p)), JSON.stringify(b.createValidPacket(p)));
    assert.equal(a.hiddenPacketMessage('visible', a.createValidPacket(p)), b.hiddenPacketMessage('visible', b.createValidPacket(p)));
  }
  record('all input helper output remains byte-identical');
  for (const publishedAt of [14999, 15000, 15001]) {
    for (const version of ['v1', 'v2']) {
      const { fixture, syntheticFile } = controlledRuntimeFixture(version, publishedAt);
      if (version === 'v1' || publishedAt > 15000) {
        await assert.rejects(fixture.createHayakuRuntime({ pluginSourceFile: syntheticFile }), /Timed out waiting for HAYAKU public API/);
      } else {
        const runtime = await fixture.createHayakuRuntime({ pluginSourceFile: syntheticFile });
        assert.equal(runtime.hayaku.api, 'synthetic');
        assert.equal(runtime.context.HAYAKU, runtime.hayaku);
        assert.equal(runtime.llmCalls.length, 0); assert.equal(runtime.fetchCalls.length, 0);
        assert.equal(typeof Object.getOwnPropertyDescriptor(runtime.context, 'HAYAKU').set, 'function');
        await runtime.dispose();
      }
      record('actual fixture setter records publication before delayed observation', { version, publishedAt, admitted: version === 'v2' && publishedAt <= 15000 });
    }
  }
  console.log(JSON.stringify({ schema: 'hayaku.fixture-deadline-controls.v1', records, assertions: records.length, failed: 0 }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
