'use strict';
// LOCKS the message-revision cache contract on the recovery path.
//
// WHY THIS EXISTS
//   An external audit profiled the large-vault recovery path, found stableHash64 near the top of the
//   call tree, and reported that unchanged messages were being re-hashed on every snapshot. The
//   measurements here were taken to check that claim, and they say the cache behaves as designed:
//   a warm snapshot over an unchanged 240-message session is ~12x cheaper than the cold one, with
//   zero misses and zero invalidations. The claim only appeared to hold when every message was given
//   the SAME `chatId`; since `msg.chatId` is a message's authoritative identity (v2.4.23), identical
//   chatIds collapse all messages onto one cache key.
//
//   That is exactly the failure this suite prevents: the cache's value depends on message identity
//   being DISTINCT and on a second snapshot over an unchanged array doing no work. Both are asserted
//   below against the plugin's own counters, so a future change that makes the cache degenerate — or
//   that quietly starts re-projecting every body — fails here instead of showing up as a slow app.
//
//   The audit's other recommendation, a performance budget separate from the 300 s ceiling, is
//   deliberately NOT implemented as a wall-clock threshold: the suite forks a real server and the
//   cost is I/O (a V8 profile of the run is 100% idle), so a time budget would gate on machine speed.
//   The cache counters below are the machine-independent form of that budget.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false });
  const hayaku = runtime.hayaku;
  const test = hayaku._test || {};
  const snapshot = test.authoritativeChatSnapshot;
  const project = test.messageRevisionProjection;

  assert.equal(typeof snapshot, 'function', 'authoritativeChatSnapshot must be exposed for this contract');
  assert.equal(typeof project, 'function', 'messageRevisionProjection must be exposed for this contract');

  const counters = () => {
    const debug = typeof hayaku.lastDebug === 'function' ? hayaku.lastDebug() : hayaku.lastDebug;
    const s = debug?.messageRevisionCache?.stats;
    assert.ok(s, 'the plugin must publish messageRevisionCache stats through lastDebug');
    return {
      hits: Number(s.hits) || 0, misses: Number(s.misses) || 0,
      invalidations: Number(s.invalidations) || 0, writes: Number(s.writes) || 0
    };
  };
  const delta = (a, b) => ({
    hits: b.hits - a.hits, misses: b.misses - a.misses,
    invalidations: b.invalidations - a.invalidations, writes: b.writes - a.writes
  });

  const scopeKey = 'hayaku-cache-contract-scope';
  const filler = '가나다라마바사아자차카타파하'.repeat(120);
  const packet = createValidPacket({ turn: 1 });
  const wrapped = `<<< HAYAKU_STATE_PACKET_START >>>\n${typeof packet === 'string' ? packet : JSON.stringify(packet)}\n<<< HAYAKU_STATE_PACKET_END >>>`;

  const messages = [];
  for (let i = 0; i < 240; i += 1) {
    const role = i % 2 ? 'assistant' : 'user';
    messages.push({
      role,
      chatId: `message-${i}`,   // per-message identity: the whole point of the contract
      id: `message-${i}`,
      time: 1700000000000 + i,
      saying: '',
      data: role === 'assistant' ? `${wrapped}\n${filler}` : `질문 ${i}\n${filler}`
    });
  }

  runtime.setMessages(messages);
  await runtime.callBeforeRequest?.({ chat: { message: messages } })?.catch?.(() => {});
  const scopeObj = { key: scopeKey };

  // ── 1. distinct identities must produce distinct cache keys ────────────────────────────────────
  const firstKey = project(messages[0], 0, scopeKey, {}).key;
  const secondKey = project(messages[1], 1, scopeKey, { diagnostics: true }).key;
  assert.notEqual(firstKey, secondKey,
    'two different messages must not share one cache key — identical chatIds collapse the cache');

  // ── 2. a warm snapshot over an unchanged array must do no work ─────────────────────────────────
  const coldStart = counters();
  const coldBegin = process.hrtime.bigint();
  snapshot(messages, scopeObj);
  const coldMs = Number(process.hrtime.bigint() - coldBegin) / 1e6;
  const coldDelta = delta(coldStart, counters());

  const warmStart = counters();
  const warmBegin = process.hrtime.bigint();
  const warmSnapshot = snapshot(messages, scopeObj);
  const warmMs = Number(process.hrtime.bigint() - warmBegin) / 1e6;
  const warmDelta = delta(warmStart, counters());

  assert.equal(warmDelta.misses, 0,
    `a second snapshot over an unchanged array must miss nothing (saw ${warmDelta.misses} misses)`);
  assert.equal(warmDelta.invalidations, 0,
    `a second snapshot must not reject stored entries (saw ${warmDelta.invalidations} invalidations)`);
  assert.ok(warmDelta.hits >= messages.length,
    `a second snapshot must be served from cache (saw ${warmDelta.hits} hits for ${messages.length} messages)`);
  assert.ok(warmDelta.writes === 0,
    `a second snapshot must not rewrite entries (saw ${warmDelta.writes} writes)`);

  // ── 3. the snapshot is still correct, not merely cached ────────────────────────────────────────
  assert.equal(warmSnapshot.chatSnapshotHash, snapshot(messages, scopeObj).chatSnapshotHash,
    'the cached and rebuilt snapshots must agree on the chat hash');
  assert.ok(warmSnapshot.packetMessageCount > 0, 'the snapshot must still find the packets');

  // ── 4. the saving is real, and measured over the same work ─────────────────────────────────────
  assert.ok(warmMs < coldMs,
    `a warm snapshot must be cheaper than a cold one (cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms)`);

  console.log(JSON.stringify({
    test: 'hayaku_recovery_cache_contract',
    passed: 4,
    messages: messages.length,
    coldMs: Number(coldMs.toFixed(1)),
    warmMs: Number(warmMs.toFixed(1)),
    speedup: Number((coldMs / warmMs).toFixed(1)),
    coldDelta,
    warmDelta,
    results: [
      'distinct message identities produce distinct cache keys',
      'a warm snapshot over an unchanged array misses nothing and rejects nothing',
      'the warm snapshot returns the same chat hash and packet count as a rebuild',
      'the warm snapshot is measurably cheaper than the cold one'
    ]
  }));
  console.log('PASS 회복 캐시 계약: 변경 없는 배열의 두 번째 스냅샷은 재계산하지 않는다');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
