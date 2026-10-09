'use strict';

// A04L / A06L: the explicit LOCAL contracts the A04/A06 plugin_only proposal asks for, kept
// separate from A04/A06's server fault actions so a not-applicable mode is never confused with
// an unrun one, and so a local result is never substituted for a server-side pass.
//
//   A04L  a pluginStorage write fails AFTER the durable canonical commit, then the same work is
//         retried: the committed canon must not be rolled back and nothing may be applied twice.
//   A06L  the authority is unreachable: the product must fail explicitly and must not promote
//         its local replica to authority.
//
// The fixture is the same one A04/A06 use, so this measures the shipped path, not a mock.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const SCENARIOS = require('./fixtures/acceptance_scenarios.json').cases;
const A04L_ACTION = SCENARIOS.find(row => row.id === 'A04L').action;
const A06L_ACTION = SCENARIOS.find(row => row.id === 'A06L').action;

const clone = value => JSON.parse(JSON.stringify(value));

const BOUNDARY_QUOTE = '민아는 지호에게 오늘 편지를 열지 말라고 했다.';
const OPEN_THREAD_QUOTE = '오늘 열쇠를 반환하겠다는 약속은 아직 이행되지 않았다.';
const OPEN_THREAD_SOURCE = `서재에서 준호가 열쇠를 지호에게 건넸고, 지호가 그것을 민아에게 돌려주었다. ${OPEN_THREAD_QUOTE} 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.`;


const parse = value => { try { return JSON.parse(value); } catch (_) { return {}; } };

const PROFILE_QUOTE = '민아는 민트차를 좋아한다고 말했다.';
const appendProfileEvidence = (chat, ref) => {
  const row = chat.message.find(message => message.chatId === ref);
  assert.ok(row, `v5 source message exists: ${ref}`);
  const suffix = `${PROFILE_QUOTE} ${BOUNDARY_QUOTE}`;
  if (!String(row.data || '').includes(PROFILE_QUOTE)) row.data = `${row.data || ''} ${suffix}`.trim();
};

const v5MeaningArtifact = ({ offset = 0, resolved = false, alias = '' } = {}) => {
  const value = artifact();
  value.schema = 'libra.canonical_artifact.v5';
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
      if (!resolved && span.ref === `t${5 + offset}-a`) span.quote = OPEN_THREAD_SOURCE;
    }
  }
  const mina = value.entities.find(entity => entity.tempId === 'mina');
  const add = (tempFactId, claimKind, values, text, evidenceSpans, extra = {}) => value.facts.push({
    tempFactId,
    domain: 'character',
    subjectTempRef: mina.tempId,
    claimKind,
    values,
    text,
    temporalRole: extra.temporalRole || 'current_sequence',
    certainty: extra.certainty || 'confirmed',
    evidenceSpans,
    ...extra
  });
  add('phase_d_preference', 'character_preference', {
    preferences: [{ content: '민트차를 좋아한다', topic: '민트차', kind: 'preference' }]
  }, '민아는 민트차를 좋아한다고 말했다.', [{ ref: `t${4 + offset}-a`, quote: PROFILE_QUOTE }]);
  add('phase_d_boundary', 'character_boundary', {
    boundaries: [{
      content: '민아는 지호에게 오늘 편지를 열지 말라고 했다',
      topic: '편지 열기', kind: 'boundary',
      scope: { subjectRef: 'mina', targetRef: 'jiho', act: '편지 열기', when: '오늘' }
    }]
  }, '민아는 지호에게 오늘 편지를 열지 말라고 했다', [{ ref: `t${4 + offset}-a`, quote: BOUNDARY_QUOTE }]);
  const thread = value.facts.find(fact => fact.tempFactId === 'f12');
  thread.values.thread = {
    summary: '오늘 열쇠 반환 약속',
    status: resolved ? 'resolved' : 'open',
    kind: 'promise',
    participants: [
      { role: 'owner', personTempRef: 'jiho' },
      { role: 'target', personTempRef: 'mina' }
    ],
    ...(resolved ? { link: 'resolve', resolution: 'fulfilled', ...(alias ? { linkCandidateAlias: alias } : {}) } : {})
  };
  thread.text = resolved ? '오늘 열쇠 반환 약속이 이행되었다.' : '오늘 열쇠 반환 약속은 아직 이행되지 않았다.';
  if (!resolved) {
    for (const span of thread.evidenceSpans || []) if (span.ref === `t${5 + offset}-a`) span.quote = OPEN_THREAD_SOURCE;
  }
  return value;
};

const localJson = (snapshot, pattern) => {
  const key = [...snapshot.local.keys()].find(candidate => pattern.test(candidate));
  return key ? parse(snapshot.local.get(key)) : null;
};
const headOf = snapshot => localJson(snapshot, /:continuity-state$/) || snapshot.getHead() || null;
const memoryOf = (snapshot, start = 1) => {
  const manifest = snapshot.getManifest() || localJson(snapshot, /:manifest$/);
  const ref = manifest?.memories?.[String(start)];
  if (ref) {
    const serverRow = snapshot.storedRows().find(row => row.key === ref.key);
    if (serverRow) return serverRow.value;
    return parse(snapshot.local.get(ref.key));
  }
  return localJson(snapshot, /:memory:1:/);
};

const wrapPluginStateWriteAfterCommit = snapshot => {
  const storage = snapshot.f.r.context.risuai.pluginStorage;
  const original = storage.setItem;
  const observation = { injected: false };
  storage.setItem = async (key, raw, ...rest) => {
    const value = parse(raw);
    const result = await original.call(storage, key, raw, ...rest);
    if (!observation.injected && value.schema === 'libra.continuity_state.v2') {
      observation.injected = true;
      throw new Error('phase_d_v5_response_lost_after_commit');
    }
    return result;
  };
  return { observation, restore: () => { storage.setItem = original; } };
};



(async () => {
  const results = {};

  // ── A04L: local write fails after the durable commit, then one idempotent retry ──────────
  {
    const snapshot = await serverFixture({ mode: 'plugin_only' });
    try {
      const f = snapshot.f;
      const firstArtifact = v5MeaningArtifact({ resolved: false });
      let secondArtifact = null;
      f.control.artifact = firstArtifact;
      f.control.onCall = args => {
        const callIndex = f.control.calls.length - 1;
        if (callIndex === 0) return { type: 'success', result: JSON.stringify(firstArtifact) };
        const content = clone(secondArtifact);
        const userPrompt = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
        const match = userPrompt.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
        const candidates = match ? JSON.parse(match[1]) : [];
        const candidate = candidates.find(row => row.summary === '오늘 열쇠 반환 약속') || candidates[0];
        if (candidate?.alias) content.facts.find(fact => fact.tempFactId === 'f12').values.thread.linkCandidateAlias = candidate.alias;
        return { type: 'success', result: JSON.stringify(content) };
      };
      appendProfileEvidence(f.chat, 't4-a');
      const openThreadSource = f.chat.message.find(message => message.chatId === 't5-a');
      assert.ok(openThreadSource, 'A04L: the first batch has the open thread source');
      openThreadSource.data = OPEN_THREAD_SOURCE;
      const first = await f.run();
      assert.equal(first.completed, 1, 'A04L: the control batch commits');

      fiveMore(f);
      appendProfileEvidence(f.chat, 't9-a');
      secondArtifact = v5MeaningArtifact({ offset: 5, resolved: true });
      const acceptedQuote = '지호가 민아에게 열쇠를 돌려주어 오늘 열쇠 반환 약속이 이행되었다. 공연 허가는 아직 밝혀지지 않았다.';
      const acceptedSource = f.chat.message.find(message => message.chatId === 't10-a');
      assert.ok(acceptedSource, 'A04L: the second batch has the accepted thread source');
      acceptedSource.data = acceptedQuote;
      for (const row of [...secondArtifact.entities, ...secondArtifact.facts]) {
        for (const span of row.evidenceSpans || []) if (span.ref === 't10-a') span.quote = acceptedQuote;
      }
      f.control.artifact = secondArtifact;

      const fault = wrapPluginStateWriteAfterCommit(snapshot);
      const second = await f.run();
      fault.restore();
      assert.equal(fault.observation.injected, true, 'A04L: the local write fault actually ran');
      assert.equal(second.completed, 1, 'A04L: the canonical commit survives the local write fault');
      // A response failure is not a commit failure: the stored canon must not be rolled back.
      const memory = memoryOf(snapshot, 6);
      assert.equal(memory?.artifactSchema, 'libra.canonical_artifact.v5', 'A04L: the v5 bytes are durable');
      assert.equal(memory?.status, 'committed', 'A04L: the canonical memory stays committed (no rollback)');
      const headBefore = headOf(snapshot);
      assert.equal(headBefore?.throughTurn, 5, 'A04L: the State reflects the durable commit boundary');

      // One retry recovers it; a second retry must apply nothing.
      const retry = await f.r.api.retryPendingUnifiedState();
      assert.equal(Number(retry.recovered), 1, `A04L: one retry recovers the pending local receipt ${JSON.stringify(retry)}`);
      const headAfter = headOf(snapshot);
      assert.equal(headAfter?.status, 'ready', 'A04L: the recovered State is authoritative');
      assert.equal(headAfter?.throughTurn, 10, 'A04L: the retry reaches the committed successor');
      const charactersAfterFirst = clone(headAfter?.characters);
      const secondRetry = await f.r.api.retryPendingUnifiedState();
      assert.equal(Number(secondRetry.recovered || 0), 0, 'A04L: a second retry applies nothing (idempotent)');
      const headFinal = headOf(snapshot);
      assert.equal(headFinal?.throughTurn, 10, 'A04L: the second retry does not advance the State');
      assert.deepEqual(clone(headFinal?.characters), charactersAfterFirst, 'A04L: no duplicate state is applied');
      assert.equal(countCalls(f.control).canonical,2);
      assert.equal(memoryOf(snapshot, 6)?.status, 'committed', 'A04L: the canonical memory is untouched by the retry');

      results.a04l = { mode: 'plugin_only', injected: true, committed: true, recovered: Number(retry.recovered),
        secondRetryRecovered: Number(secondRetry.recovered || 0), preRetryThroughTurn: headBefore?.throughTurn ?? null,
        throughTurn: headFinal?.throughTurn ?? null, providerCalls: f.control.calls.length };
      console.log(JSON.stringify({ marker: 'A04L-mode', ...results.a04l }));
      console.log(JSON.stringify({ schema: 'acceptance.action_result.v1', case_id: 'A04L', mode: 'plugin_only',
        action: A04L_ACTION, assertion_result: true,
        observed: `A local pluginStorage write failed after the durable canonical commit. The committed v5 memory was not rolled back, the State stayed at turn ${headBefore?.throughTurn} before the retry, one retry reached turn ${headFinal?.throughTurn}, a second retry applied nothing, and the provider was not re-run.` }));
    } finally {
      await snapshot.cleanup();
    }
  }

  // ── A06L: the authority is unreachable; no hidden local authority may appear ──────────────
  {
    const snapshot = await serverFixture({ mode: 'server_only' });
    try {
      const f = snapshot.f;
      f.control.artifact = v5MeaningArtifact({ resolved: false });
      f.control.onCall = () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
      const first = await f.run();
      assert.equal(first.completed, 1, 'A06L: the control batch commits');
      const headBefore = headOf(snapshot);
      assert.ok(headBefore, 'A06L: a durable head exists before the outage');
      const localBefore = clone(localJson(snapshot, /:entities|:entity-registry:v2$|:continuity-state$|:manifest$/));

      // Take the authority away. The product must say so, not silently fall back to its copy.
      snapshot.hooks.beforeBatch = async () => { throw new Error('memory_suite_authority_unreachable'); };
      snapshot.hooks.beforeServerRequest = async () => { throw new Error('memory_suite_authority_unreachable'); };
      let failure = null;
      try {
        const retry = await f.r.api.retryPendingUnifiedState();
        if (retry && (retry.error || retry.ok === false)) failure = { code: String(retry.error || retry.code || 'retry_failed') };
        else {
          const rebuilt = await f.r.api.rebuildWorldManagerState({});
          if (rebuilt?.ok === false) failure = { code: String(rebuilt.error || rebuilt.code || 'rebuild_failed') };
        }
      } catch (error) {
        failure = { code: String(error?.message || error) };
      }
      snapshot.hooks.beforeBatch = null;
      snapshot.hooks.beforeServerRequest = null;
      assert.ok(failure, 'A06L: an unreachable authority produces an explicit failure, not a silent success');
      assert.notEqual(String(failure.code).trim(), '', 'A06L: the failure names a reason');
      // The local replica was not promoted: its durable bytes are unchanged.
      const localAfter = clone(localJson(snapshot, /:entities|:entity-registry:v2$|:continuity-state$|:manifest$/));
      assert.deepEqual(localAfter, localBefore, 'A06L: the local replica is not silently promoted to authority');

      results.a06l = { mode: 'server_only', explicitFailure: true, code: failure.code, localReplicaUnchanged: true };
      console.log(JSON.stringify({ marker: 'A06L-mode', ...results.a06l }));
      console.log(JSON.stringify({ schema: 'acceptance.action_result.v1', case_id: 'A06L', mode: 'server_only',
        action: A06L_ACTION, assertion_result: true,
        observed: `With the authority unreachable the product failed explicitly (${failure.code}) instead of promoting its local replica; the local durable bytes were unchanged.` }));
    } finally {
      await snapshot.cleanup();
    }
  }

  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'))).digest('hex');
  const testHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  console.log(JSON.stringify({ marker: 'A04L-A06L-local-contracts', results, sourceSha256: sourceHash, testSha256: testHash, result: 'PASS' }));
})().catch(error => {
  console.log(JSON.stringify({ marker: 'A04L-A06L-failed', message: String(error && error.message || error) }));
  console.error(error);
  process.exit(1);
});
