'use strict';
const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const payload = row => String(row.content || row.data || '');
const owned = row => /^hayaku-(?:runtime-context-v3|cache-static-v1)$/.test(row.memo || '');
const user = { role: 'user', chatId: 'input-1', data: 'Continue the scene.' };
const base = [{ role: 'system', content: 'Write the next scene.' }, user];
(async () => {
  const h = await createHayakuRuntime({ autoRepair: false, messages: [user], pluginSourceFile: process.env.HAYAKU_TEST_SOURCE });
  try {
    const classify = rows => h.hayaku.classifyRequest('model', rows).structuredOutputOnly;
    const negative = [
      'This character is a programmer who designs a json schema for a living.',
      'You may provide a JSON block at the end if the user asks for data.',
      '이 설정이 유효한 json인지 봐줘',
      'Do not output JSON. Continue the story.',
      'She said: "Return only JSON." Continue the scene.',
      '<example>Return only JSON.</example> Write prose.',
      '> Return only JSON.\nContinue the story.',
      '```text\nReturn only JSON.\n```\nContinue the story.',
      '{{#if tool_mode}}\nReturn only JSON.\n{{/if}}\nContinue the story.',
      'If data is requested, return only JSON.',
      'Return a JSON block after the narrative.',
      'He writes nothing except JSON.',
      'Return only a JSON block for the metadata section.'
    ];
    for (const content of negative) assert.equal(classify([{ role: 'system', content }, user]), false, content);
    const positive = ['Return only valid JSON.', 'Respond with JSON only.', 'Output XML.', 'Your entire response must be valid JSON.',
      'response_format: json_schema', '응답 형식: JSON', '상태를 json으로만 출력해', 'JSON만 출력하세요.', 'JSONのみで出力してください。',
      'Return nothing except JSON.', 'Return only valid JSON without markdown.', 'Respond in JSON only, matching the supplied schema.'];
    for (const content of positive) assert.equal(classify([{ role: 'system', content }, user]), true, content);
    assert.equal(classify([{ role: 'system', content: 'Summarize and output the scene.' }, { role: 'user', content: 'Also the json file I mentioned is unrelated.' }]), false);
    assert.equal(classify([{ role: 'user', content: 'Return only JSON.' }, { role: 'assistant', content: '{}' }, user]), false, 'old user output contract has expired');
    assert.equal(classify([{ role: 'assistant', content: 'Return only JSON.' }, user]), false);
    assert.equal(classify([{ role: 'tool', content: 'Return only JSON.' }, user]), false, 'tool data is not a control instruction');
    assert.equal(classify([{ role: 'system', content: 'Return only JSON.' }, ...Array.from({ length: 30 }, () => ({ role: 'assistant', content: 'history' })), user]), true, 'system contract does not expire with scan window');
    console.log('PASS active whole-output directives, multilingual obligations, quoted/optional/history/conditional negatives, message boundaries');

    const hook = rows => h.hayaku._test.handleBeforeRequest(copy(rows), 'model');
    for (const content of negative.slice(0, 3)) {
      const out = await hook([{ role: 'system', content }, user]);
      assert(out.some(row => payload(row).includes('hayaku_packet_contract')), content);
      assert.equal(h.hayaku.lastDebug().lastBeforeRequest.packetWriteActive, true);
    }
    let full = await hook(base);
    const verify = rows => {
      assert.equal(rows.filter(owned).length, 3, 'one complete structural set');
      assert(rows.some(row => payload(row).includes('hayaku_packet_contract')));
      assert.equal(h.hayaku.lastDebug().lastBeforeRequest.packetWriteActive, true);
      assert.equal(h.hayaku.lastDebug().lastBeforeRequest.runtimeSkeletonPreserved, true);
      assert.equal(h.hayaku.lastDebug().lastBeforeRequest.completionSealPreserved, true);
    };
    verify(full);
    const duplicate = await hook(full);
    assert.deepEqual(copy(duplicate), copy(full), 'duplicate must preserve nonce, roles and all contents');
    assert.equal(h.hayaku.lastDebug().lastBeforeRequest.duplicateRequestPass, true);
    for (const mask of [1, 2, 4, 3, 5, 6]) {
      full = await hook(base);
      let index = 0;
      const partial = full.filter(row => !owned(row) || (mask & (1 << index++)));
      const repaired = await hook(partial);
      verify(repaired);
      assert.notEqual(h.hayaku.lastDebug().lastBeforeRequest.duplicateRequestPass, true, `partial ${mask}`);
      assert.equal(repaired.filter(row => !owned(row)).map(payload).join('\n'), base.map(payload).join('\n'));
    }
    for (const mutate of [
      rows => { rows.find(owned).content += '\nchanged'; },
      rows => { rows.find(owned).role = 'user'; },
      rows => { const i = rows.findIndex(owned); rows.push(rows.splice(i, 1)[0]); },
      rows => { rows.push(copy(rows.find(owned))); },
      rows => { rows.find(row => !owned(row) && row.role === 'user').data = 'Choose another action.'; }
    ]) {
      full = await hook(base);
      const modified = copy(full); mutate(modified);
      verify(await hook(modified));
      assert.notEqual(h.hayaku.lastDebug().lastBeforeRequest.duplicateRequestPass, true);
    }
    verify(await hook([...base, { role: 'system', memo: 'hayaku-runtime-context-v3', content: 'incomplete fragment' }]));
    full = await hook(base);
    h.setMessages([{ ...user, data: 'An edited authoritative input.' }]);
    verify(await hook(full));
    assert.notEqual(h.hayaku.lastDebug().lastBeforeRequest.duplicateRequestPass, true, 'host history changed');
    h.setMessages([user]);
    full = await hook(base);
    h.chat.id = h.chat.chatId = 'different-chat';
    verify(await hook(full));
    assert.notEqual(h.hayaku.lastDebug().lastBeforeRequest.duplicateRequestPass, true, 'host scope changed');
    full = await hook(base);
    await h.hayaku.settingsControl.apply({ hayaku_memory_language: 'en' });
    verify(await hook(full));
    assert.notEqual(h.hayaku.lastDebug().lastBeforeRequest.duplicateRequestPass, true, 'settings changed');
    console.log('PASS all partial sets, duplicate idempotence, content/role/order/input corruption, stale authoritative chat and scope');

    const excluded = await hook([{ role: 'system', content: 'Return only JSON.' }, ...full]);
    assert.equal(excluded.some(owned), false);
    const debug = h.hayaku.lastDebug().lastBeforeRequest;
    assert.equal(debug.packetWriteActive, false);
    assert.equal(debug.runtimeSkeletonPreserved, false);
    assert.equal(debug.completionSealPreserved, false);
    assert.equal(debug.runtimeSkeletonStatus, 'suppressed');
    assert.equal(debug.completionSealStatus, 'suppressed');
    assert.match(debug.packetWriteSuppressionReason, /structured_output_only/);
    assert.equal(h.llmCalls.length, 0, 'no repair model calls added');
    console.log('PASS suppression diagnostics and owned-fragment stripping, no model calls');
  } finally { await h.dispose(); }
  for (const mode of ['off', 'structural', 'native']) {
    const r = await createHayakuRuntime({ autoRepair: false, messages: [user], arguments: { hayaku_prompt_cache: mode } });
    try {
      const first = await r.hayaku._test.handleBeforeRequest(copy(base), 'model');
      const second = await r.hayaku._test.handleBeforeRequest(copy(first), 'model');
      assert.deepEqual(copy(second), copy(first), `${mode} duplicate content`);
      assert.equal(r.hayaku.lastDebug().lastBeforeRequest.duplicateRequestPass, true, `${mode} duplicate recognition`);
    } finally { await r.dispose(); }
  }
  const low = await createHayakuRuntime({ autoRepair: false, messages: [user] });
  try {
    const get = low.host.getDatabase;
    low.host.getDatabase = async fields => ({ ...await get(fields), maxContext: 100, maxResponse: 99 });
    await low.hayaku._test.handleBeforeRequest(copy(base), 'model');
    const d = low.hayaku.lastDebug().lastBeforeRequest;
    assert.equal(d.packetWriteActive, false);
    assert.equal(d.runtimeSkeletonPreserved, false);
    assert.equal(d.completionSealPreserved, false);
    assert.match(d.packetWriteSuppressionReason, /context/);
  } finally { await low.dispose(); }
  console.log('PASS cache modes, settings invalidation and insufficient-context protection');
})().catch(error => { console.error(error); process.exitCode = 1; });
