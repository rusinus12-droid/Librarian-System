'use strict';
const assert = require('node:assert/strict');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
(async () => {
  const f = await fixture();
  try {
    f.control.artifact = artifact(); // old provider output remains readable under its explicit v4 label
    assert.equal((await f.run()).completed, 1, 'the actual Librarian stage executes');
    assert.equal(countCalls(f.control).canonical,1);
    const call = f.control.calls[0][0];
    const system = call?.messages?.find(row => row.role === 'system')?.content || '';
    const user = call?.messages?.find(row => row.role === 'user')?.content || '';
    assert.match(system, /OUTPUT:.*libra\.canonical_artifact\.v5/,
      'the actual provider prompt requests v5');
    assert.doesNotMatch(system, /libra\.canonical_artifact\.v4/,
      'no subordinate prompt profile may ask the same model for v4');
    assert.match(system, /character_preference/);
    assert.match(system, /character_boundary/);
    assert.match(system, /values:\s*\{preferences:/,
      'the prompt names the accepted preference value key');
    assert.match(system, /values:\s*\{boundaries:/,
      'the prompt names the accepted boundary value key');
    assert.match(system, /content.*topic.*kind.*scope/s,
      'the producer contract defines structured content, topic, kind and scope');
    assert.match(system, /scope:\s*\{\s*subjectRef.*targetRef.*act.*when/s,
      'structured boundary scope carries registry-resolvable refs and both text axes');
    assert.doesNotMatch(system, /preferences:\["|boundaries:\["/,
      'the producer no longer serializes new items as bracket-tagged strings');
    assert.match(system, /link:\s*"reaffirm\|replace\|resolve\|reopen\|associate"/,
      'the prompt states the accepted link enum');
    assert.match(system, /resolution:\s*"fulfilled\|broken\|cancelled\|superseded\|completed\|withdrawn"/,
      'the prompt states the accepted resolution enum');
    assert.match(system, /target.*act.*when/i, 'boundary scope is described');
    assert.match(system, /source.*evidence/i, 'evidence remains mandatory');
    assert.match(user, /\[EXACT FIVE U\+A\]/);
    assert.match(user, /\[t5-a\]/);
    console.log(JSON.stringify({ test: 'libra_main_memory_v5_producer_contract', passed: 1,
      providerCalls: f.control.calls.length, systemChars: system.length }));
  } finally { await f.r.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
