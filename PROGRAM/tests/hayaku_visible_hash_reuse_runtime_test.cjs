'use strict';
// A warm history snapshot must reuse the digest for unchanged visible message bodies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const pluginPath = path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js');
  const source = fs.readFileSync(pluginPath, 'utf8');
  const anchor = "  const stableHash64 = (value = '') => {";
  assert.equal(source.split(anchor).length - 1, 1, 'instrument exactly one production hash function');
  const instrumented = source.replace(anchor, `${anchor}\n    const audit = globalThis.__visibleHashAudit || (globalThis.__visibleHashAudit = { calls: 0, longBodyCalls: 0 });\n    audit.calls += 1;\n    if (String(value ?? '').length >= 8000) audit.longBodyCalls += 1;`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-visible-hash-'));
  const file = path.join(dir, 'instrumented.js');
  fs.writeFileSync(file, instrumented);
  const longBody = '반복 검증 원문 가나다 ABC '.repeat(600);
  const messages = [];
  for (let i = 0; i < 8; i += 1) {
    messages.push({ role: 'user', chatId: `u${i}`, data: `질문 ${i}` });
    messages.push({ role: 'assistant', chatId: `a${i}`, data: `${longBody}${i}` });
  }
  let runtime;
  try {
    runtime = await createHayakuRuntime({ messages, autoRepair: false, pluginSourceFile: file, chatId: 'hash-parity' });
    const scope = await runtime.hayaku._test.currentChatScope();
    const setupLongBodyCalls = Number(runtime.context.__visibleHashAudit?.longBodyCalls || 0);
    const observe = (input, targetScope = scope) => {
      runtime.context.__visibleHashAudit = { calls: 0, longBodyCalls: 0 };
      const snapshot = runtime.hayaku._test.authoritativeChatSnapshot(input, targetScope);
      return { snapshot, audit: { ...runtime.context.__visibleHashAudit } };
    };
    const first = observe(scope.chatMessages);
    const retainedBeforeWarm = runtime.hayaku.lastDebug().messageRevisionCache.stats.retainedChars;
    const warm = observe(scope.chatMessages);
    const retainedAfterWarm = runtime.hayaku.lastDebug().messageRevisionCache.stats.retainedChars;
    assert.equal(retainedAfterWarm, retainedBeforeWarm, 'warm reuse must not increase cache retention');
    assert.equal(first.snapshot.conversationPairCount, 8);
    assert.equal(first.snapshot.chatSnapshotHash, 'h641isltmiqg2ex2', 'baseline snapshot identifier must stay byte-compatible');
    assert.equal(first.snapshot.conversationPairs[0].userHash, 'h644o3snpmncv05');
    assert.equal(first.snapshot.conversationPairs[0].assistantVisibleHash, 'h641zo91xcyn3g9b');
    assert.ok(setupLongBodyCalls + first.audit.longBodyCalls >= 8, 'instrumentation must see visible hashes during setup or initial observation');
    assert.ok(warm.audit.calls > 0, 'instrumentation must remain active on a warm snapshot');
    assert.deepEqual(warm.snapshot.conversationPairs, first.snapshot.conversationPairs);
    assert.equal(warm.audit.longBodyCalls, 0, 'unchanged visible bodies must not be rehashed on a cache hit');

    const previousHash = warm.snapshot.conversationPairs[0].assistantVisibleHash;
    runtime.chat.message[1].data = runtime.chat.message[1].data.replace('반복', '수정');
    const edited = observe(runtime.chat.message);
    assert.notEqual(edited.snapshot.conversationPairs[0].assistantVisibleHash, previousHash,
      'same-id same-length edits must invalidate the cached digest');
    assert.ok(edited.audit.longBodyCalls >= 1, 'edited visible body must be hashed again');

    observe(runtime.chat.message, { ...scope, key: `${scope.key}-alternate-1` });
    observe(runtime.chat.message, { ...scope, key: `${scope.key}-alternate-2` });
    const afterEviction = observe(runtime.chat.message);
    assert.ok(afterEviction.audit.longBodyCalls >= 8, 'scope eviction must recompute each visible body');

    runtime.chat.message[1].data = 'A'.repeat(1_048_576);
    const megabyteFirst = observe(runtime.chat.message);
    const megabyteWarm = observe(runtime.chat.message);
    assert.equal(megabyteWarm.audit.longBodyCalls, 0, '1 MiB visible body must be reused on a warm snapshot');
    assert.deepEqual(megabyteWarm.snapshot.conversationPairs, megabyteFirst.snapshot.conversationPairs);
    console.log(JSON.stringify({ test: 'hayaku_visible_hash_reuse_runtime', first: first.audit, warm: warm.audit, edited: edited.audit, megabyteWarm: megabyteWarm.audit }));
  } finally {
    await runtime?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
