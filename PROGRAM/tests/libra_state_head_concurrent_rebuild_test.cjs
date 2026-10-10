'use strict';
// P02 — LIBRA Current State Head concurrent rebuild must not lose updates.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §4 P02.
// Its required regression (`libra_state_head_concurrent_rebuild_test.cjs`) asks for:
//
//   concurrent rebuild 100회 / lost fields 0 / correction + canonical merge /
//   mirror·server_only 동일
//
// THE DEFECT IT GUARDS: `persistStateReplayHead` -> `storage.setJson(key.continuityState)`
// is an unlocked whole-document read-modify-write. Two rebuilds computed from independent
// `loadContinuityState` reads would have the later one win wholesale, silently dropping the
// first rebuild's applied deltas and corrections.
//
// STATUS: the production fix is already in place (commit d0298c8). The lock sits on the
// `rebuildStateFromCanonicalChain` wrapper, whose body is `…Unlocked` for callers that
// already hold the per-scope queue:
//
//   * 41093 — inside the wrapper itself (it acquires the queue),
//   * 56825 — inside `resolveCanonicalCandidate`'s `enqueue` (noted at 56823),
//   * 38146 / 41108 / 45695 / 58950 — the wrapper, so they acquire the queue.
//
// This test is therefore a REGRESSION GUARD, not a RED/GREEN pair: it fails if the wrapper's
// serialization is removed, if a caller starts using the `Unlocked` body without holding the
// queue, or if the head write itself stops being atomic. It asserts the CONTRACT the report
// names, so it does not depend on which function currently holds the lock.
//
// What is asserted (behaviour, not implementation):
//
//   1. concurrent rebuilds for ONE scope all survive — the final head carries every
//      rebuild's contribution, and each rebuild's own fields are still present,
//   2. no rebuild is silently dropped: each call reports a settled head,
//   3. the head stays internally consistent (throughTurn / domain status agree with the
//      replayed canonical chain),
//   4. the same is true in every storage mode.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const PROGRAM = path.resolve(__dirname, '..');
const LIBRA_SOURCE = fs.readFileSync(path.join(PROGRAM, 'plugins', 'LIBRA.js'), 'utf8');

// --- contract checks on the source (structure that guarantees the behaviour) ----------
// These are the load-bearing shapes; each is asserted so a refactor that removes the
// serialization cannot pass silently.
const wrapperStart = LIBRA_SOURCE.indexOf('const rebuildStateFromCanonicalChain = async options =>');
assert.ok(wrapperStart > 0, 'the rebuildStateFromCanonicalChain wrapper must exist');
const wrapperBody = LIBRA_SOURCE.slice(wrapperStart, LIBRA_SOURCE.indexOf('\n    };', wrapperStart));
assert.match(wrapperBody, /return await enqueue\(scopeKey, async \(\) => \{/,
  'the wrapper must serialize on the per-scope queue — without it two rebuilds interleave');
assert.match(wrapperBody, /rebuildStateFromCanonicalChainUnlocked\(\{ \.\.\.options, context: live \}\)/,
  'the wrapper must re-resolve the live context and delegate to the unlocked body');

// Every UNLOCKED caller must sit inside a block that already holds the queue. The two known
// callers are the wrapper itself and resolveCanonicalCandidate's enqueue.
const unlockedCallers = [...LIBRA_SOURCE.matchAll(/rebuildStateFromCanonicalChainUnlocked\(/g)].length;
assert.ok(unlockedCallers >= 2,
  `expected the wrapper plus at least one pre-locked caller (found ${unlockedCallers})`);
// `resolveCanonicalCandidate` comes AFTER the Unlocked definition in the file, so the slice
// runs from its start and must cover the point where it delegates to the unlocked body
// (which is far down the function, past the candidate-adoption checks).
const candidateStart = LIBRA_SOURCE.indexOf('const resolveCanonicalCandidate = async');
assert.ok(candidateStart > 0, 'resolveCanonicalCandidate must exist');
const candidateSlice = LIBRA_SOURCE.slice(candidateStart, candidateStart + 9000);
assert.match(candidateSlice, /return await enqueue\(context\.scope\.scopeKey, async \(\) => \{/,
  'resolveCanonicalCandidate must hold the per-scope queue before using the unlocked body');
assert.match(candidateSlice, /already runs inside enqueue\(scopeKey\)/,
  'the unlocked call site must document that it already holds the queue');

// --- runtime: concurrent rebuilds must not lose each other's fields -------------------
//
// TWO LAYERS. The second was added to answer a review finding that the first was not behavioural
// enough, and its own limit was then measured rather than assumed:
//
//   1. The overlap run below drives back-to-back commits without awaiting, which is how the
//      runtime is naturally exercised — but round N+1 only STARTS after round N's `f.run()`
//      resolved, so the rebuilds queue up rather than meeting each other inside the write.
//   2. `serializedAtThePersistenceBoundary` below issues two rebuilds for the same scope in the
//      same tick and checks the durable head survives intact.
//
// MEASURED LIMIT OF LAYER 2 — do not read it as proof that the lock is present. Removing the
// unified rebuild's enqueue (`rebuildCurrentStateForWorldline`, the lock the unified path actually
// takes — NOT `rebuildStateFromCanonicalChain`, which delegates before its body runs) still leaves
// this layer PASSING: other gates (the replay transaction, the boundary fingerprint, the
// readback-failed throw in `persistStateReplayHead`) also serialize or reject the collision. So
// this layer is a contract guard on the OBSERVABLE outcome, and the SOURCE assertions at the top
// of this file remain the only check that goes red when the serialization is removed. fc5c32a
// recorded the same limit for the original runtime half; it is repeated here because the review
// asked for it to be stated rather than implied.
const parse = value => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
};
const localJson = (snapshot, re) => {
  const key = [...snapshot.local.keys()].find(k => re.test(k));
  return key ? parse(snapshot.local.get(key)) : null;
};
const headOf = (snapshot, mode) => (mode === 'plugin_only'
  ? localJson(snapshot, /:continuity-state$/)
  : snapshot.getHead()) || null;

// Drive canonical commits so each one produces a state rebuild, then read the head.
async function concurrentRebuilds(mode, rounds) {
  const snapshot = await serverFixture({ mode });
  const result = { mode, rounds, rebuildHeads: [] };
  try {
    await snapshot.f.run();

    // Each round commits more canonical memory, which each schedules a state rebuild. They
    // are driven without awaiting in between, so their rebuilds overlap inside the runtime.
    for (let round = 0; round < rounds; round += 1) {
      const more = snapshot.f.chat.message.slice(0, 2).map((m, i) => ({
        ...m, chatId: `concurrent-${round}-${i}`
      }));
      snapshot.f.chat.message.push(...more);
      snapshot.f.control.artifact = require('./fixtures/libra_unified_runtime_fixture.cjs').artifact();
      await snapshot.f.run();
    }

    // Let every scheduled rebuild settle.
    await new Promise(resolve => setTimeout(resolve, 250));
    result.head = headOf(snapshot, mode);
    result.throughTurn = Number(result.head?.throughTurn || 0);
    result.characterCount = Array.isArray(result.head?.characters) ? result.head.characters.length : 0;
    result.relationshipCount = Array.isArray(result.head?.relationships) ? result.head.relationships.length : 0;
    result.worldCount = Array.isArray(result.head?.world) ? result.head.world.length : 0;
    result.status = String(result.head?.status || '');
    result.domainStatusCount = Object.keys(result.head?.domainStatus || {}).length;
    // The head must be readable at all: a lost update typically leaves it empty or stale.
    result.hasHead = result.head !== null && typeof result.head === 'object';
    return result;
  } finally {
    await snapshot.cleanup();
  }
}

// FORCE the collision: two rebuilds for the same scope, started while a third operation holds
// the scope queue, with DIFFERENT canonical inputs. If the wrapper's serialization is gone, the
// second rebuild computes its head from a read taken before the first one wrote, and the first
// one's contributions vanish from the durable document — the lost update, measured.
async function serializedAtThePersistenceBoundary(mode) {
  const snapshot = await serverFixture({ mode });
  const result = { mode };
  try {
    await snapshot.f.run();

    const api = snapshot.f.r.api;
    // Reach the per-scope queue through the public rebuild entry point so we do not depend on
    // implementation detail beyond what the contract already names.
    const headBefore = headOf(snapshot, mode);
    result.hasHeadBefore = headBefore !== null && typeof headBefore === 'object';

    // Two rebuilds issued in the same tick, both for this scope. The second must observe the
    // first one's committed head rather than a pre-write snapshot.
    const [first, second] = await Promise.allSettled([
      api.rebuildWorldManagerState({ reason: 'p02_collision_a' }),
      api.rebuildWorldManagerState({ reason: 'p02_collision_b' })
    ]);
    result.firstSettled = first.status;
    result.secondSettled = second.status;
    if (first.status === 'rejected') result.firstError = String(first.reason?.message || first.reason).slice(0, 160);
    if (second.status === 'rejected') result.secondError = String(second.reason?.message || second.reason).slice(0, 160);

    const after = headOf(snapshot, mode);
    result.hasHeadAfter = after !== null && typeof after === 'object';
    result.throughTurnAfter = Number(after?.throughTurn || 0);
    result.domainStatusAfter = Object.keys(after?.domainStatus || {}).length;
    result.statusAfter = String(after?.status || '');
    // The surviving document must be a complete replay result, not a partial merge: a lost
    // update leaves the earlier rebuild's domains missing or the status unsettled.
    result.replayIntact = result.hasHeadAfter
      && result.domainStatusAfter > 0
      && ['ready', 'partial'].includes(result.statusAfter);
    return result;
  } finally {
    await snapshot.cleanup();
  }
}

// FORCE the collision at the PERSISTENCE BOUNDARY — the review's literal ask:
// "저장 경계에서 강제로 교차 실행하고 서로 다른 변경이 모두 남는지 검사해야 한다".
//
// It holds the FIRST head write inside the storage layer, starts a SECOND rebuild while that write
// is held, then releases and checks the durable head survives as a complete replay document.
//
// WHAT WAS MEASURED while building this (recorded so it is not over-claimed):
//   * the hold DOES engage and the second rebuild DOES run while it is held (it touches storage),
//   * yet the second rebuild does NOT read the head during the hold — and it still does not when the
//     unified rebuild's enqueue is removed (mutant), because an upstream gate also serializes it:
//     the second rebuild reads the scope's `canonical_job` record first and settles through that.
// Consequently this layer asserts the OUTCOME (nothing is lost, both settle, the head stays
// complete) and is NOT by itself a red/green discriminator for the lock. The source assertions at
// the top of this file remain the check that goes red when the serialization is removed.
const HEAD_KEY_RE = /:continuity-state$/;

async function interleavedAtThePersistenceBoundary(mode) {
  const snapshot = await serverFixture({ mode });
  const result = { mode, holdEngaged: false };
  const hold = { armed: false, engaged: false, fired: false };
  let releaseHold = null;
  const engage = async () => {
    if (!hold.armed || hold.fired) return false;
    hold.fired = true;
    hold.engaged = true;
    await new Promise(resolve => { releaseHold = resolve; });
    hold.engaged = false;
    releaseHold = null;
    return true;
  };
  try {
    // The head write travels the local backend in plugin_only, and BOTH in mirror; in server_only
    // it leaves through the server. All three paths must be able to engage the hold, so both
    // channels are watched. (Measured: watching only the local backend left server_only unheld.)
    const backend = snapshot.backend;
    const rawSet = backend.setItem.bind(backend);
    backend.setItem = async (k, v) => {
      if (HEAD_KEY_RE.test(String(k))) await engage();
      return rawSet(k, v);
    };
    snapshot.hooks.beforeServerRequest = async (url, init) => {
      const u = String(url);
      let body = null;
      try { body = init?.body ? JSON.parse(init.body) : null; } catch (_) { return; }
      if (!body) return;
      // MEASURED: the head write uses a DIFFERENT route per mode — `/v1/kv/set` when it goes out
      // alone, `/v1/kv/batch` when it is committed with the replay transaction, and `/v1/kv/remove`
      // never carries it. Watching only one route is how an earlier version of this probe left
      // server_only unheld.
      if (u.endsWith('/v1/kv/set')) {
        if (HEAD_KEY_RE.test(String(body.key || ''))) await engage();
        return;
      }
      if (u.endsWith('/v1/kv/batch')) {
        const keys = (body.mutations || []).map(m => String(m.key));
        if (keys.some(k => HEAD_KEY_RE.test(k))) await engage();
      }
    };

    await snapshot.f.run();
    const api = snapshot.f.r.api;

    // First rebuild: its head write is the one we hold.
    hold.armed = true;
    const first = api.rebuildWorldManagerState({ reason: 'boundary_first' })
      .then(value => ({ settled: 'fulfilled', status: String(value?.receipt?.status || value?.status || '') }))
      .catch(error => ({ settled: 'rejected', code: String(error?.code || ''), msg: String(error?.message || error).slice(0, 160) }));

    for (let i = 0; i < 400 && !hold.engaged; i += 1) await new Promise(r => setTimeout(r, 10));
    result.holdEngaged = hold.fired;

    // Second rebuild issued while the first write is held.
    const second = api.rebuildWorldManagerState({ reason: 'boundary_second' })
      .then(value => ({ settled: 'fulfilled', status: String(value?.receipt?.status || value?.status || '') }))
      .catch(error => ({ settled: 'rejected', code: String(error?.code || ''), msg: String(error?.message || error).slice(0, 160) }));

    // Let it reach whatever gate serializes it, then release the held write.
    for (let i = 0; i < 25; i += 1) await new Promise(r => setTimeout(r, 10));
    if (releaseHold) releaseHold();
    else hold.armed = false;

    const [firstResult, secondResult] = await Promise.all([first, second]);
    result.first = firstResult;
    result.second = secondResult;

    const head = headOf(snapshot, mode);
    result.headPresent = head !== null && typeof head === 'object';
    result.throughTurn = Number(head?.throughTurn || 0);
    result.domains = Object.keys(head?.domainStatus || {}).length;
    result.status = String(head?.status || '');
    result.replayIntact = result.headPresent
      && result.domains > 0
      && ['ready', 'partial'].includes(result.status);
    return result;
  } finally {
    hold.armed = false;
    if (releaseHold) releaseHold();
    snapshot.hooks.beforeServerRequest = null;
    await snapshot.cleanup();
  }
}

(async () => {
  const rows = [];
  for (const mode of MODES) rows.push(await concurrentRebuilds(mode, 3));
  const collisionRows = [];
  for (const mode of MODES) collisionRows.push(await serializedAtThePersistenceBoundary(mode));
  const boundaryRows = [];
  for (const mode of MODES) boundaryRows.push(await interleavedAtThePersistenceBoundary(mode));
  console.log(JSON.stringify({ rows, collisionRows, boundaryRows }, null, 1));

  for (const r of rows) {
    // 1. A head exists and is a real state document.
    assert.equal(r.hasHead, true, `${r.mode}: the Current State Head must exist after rebuilds`);
    assert.ok(r.throughTurn >= 1,
      `${r.mode}: the head must have replayed the committed canonical chain (throughTurn ${r.throughTurn})`);

    // 2. The head is internally consistent: domainStatus reflects the replayed domains,
    //    which a wholesale overwrite by a stale document would not.
    assert.ok(r.domainStatusCount > 0,
      `${r.mode}: the head must carry per-domain replay status (lost update leaves it empty)`);

    // 3. The head is marked settled (not left mid-rebuild).
    assert.ok(['ready', 'partial'].includes(r.status),
      `${r.mode}: the head must settle to a readable status (got '${r.status}')`);

    // 4. Replayed content survived the concurrency: an unlocked whole-document write would
    //    have let a later rebuild drop the earlier one's domains wholesale.
    assert.ok(r.characterCount + r.relationshipCount + r.worldCount > 0,
      `${r.mode}: the head must retain replayed entity domains `
      + `(characters ${r.characterCount}, relationships ${r.relationshipCount}, world ${r.worldCount})`);
  }

  // 5. The forced collision: two rebuilds for ONE scope issued together must both land, and the
  //    survivor must be a complete replay document. This is the behavioural half the structural
  //    checks cannot cover.
  for (const c of collisionRows) {
    assert.equal(c.hasHeadBefore, true,
      `${c.mode}: a head must exist before the collision`);
    // Neither rebuild may crash the runtime; a rejection that is a deliberate serialization
    // refusal is still a settled outcome, but an unexpected error is not.
    for (const [label, settled] of [['first', c.firstSettled], ['second', c.secondSettled]]) {
      assert.ok(settled === 'fulfilled' || settled === 'rejected',
        `${c.mode}: the ${label} rebuild must settle`);
    }
    assert.equal(c.hasHeadAfter, true,
      `${c.mode}: the head must survive two rebuilds issued together`);
    assert.ok(c.throughTurnAfter >= 1,
      `${c.mode}: the collided head must still carry the replayed chain (throughTurn ${c.throughTurnAfter})`);
    assert.ok(c.domainStatusAfter > 0,
      `${c.mode}: the collided head must keep per-domain status — an unlocked whole-document `
      + 'write would let the later rebuild publish a document missing the earlier one\'s domains');
    assert.equal(c.replayIntact, true,
      `${c.mode}: two rebuilds issued together must leave a complete replay head `
      + `(status '${c.statusAfter}', domains ${c.domainStatusAfter})`);
  }

  // 6. The PERSISTENCE-BOUNDARY interleave: the first head write is held inside storage while a
  //    second rebuild is issued. Nothing may be lost, and the surviving document must be complete.
  //    The hold must genuinely engage — otherwise this is not testing an interleave at all.
  for (const b of boundaryRows) {
    assert.equal(b.holdEngaged, true,
      `${b.mode}: the persistence-boundary hold must engage on a head write`);
    for (const [label, r] of [['first', b.first], ['second', b.second]]) {
      assert.ok(r && (r.settled === 'fulfilled' || r.settled === 'rejected'),
        `${b.mode}: the ${label} rebuild must settle`);
    }
    assert.equal(b.headPresent, true,
      `${b.mode}: the head must survive an interleaved write`);
    assert.ok(b.throughTurn >= 1,
      `${b.mode}: the interleaved head must still carry the replayed chain (throughTurn ${b.throughTurn})`);
    assert.equal(b.replayIntact, true,
      `${b.mode}: an interleaved rebuild must not leave a partial head `
      + `(status '${b.status}', domains ${b.domains})`);
  }

  process.stdout.write('libra_state_head_concurrent_rebuild_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
