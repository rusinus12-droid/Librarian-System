'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { load: loadGradia } = require('./gradia/host.cjs');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { fixture: libraFixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { createFixture: createFlashbackFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const PRESET_PATH = path.resolve(__dirname, '..', 'prompt', 'Leave_RisuAI_Preset.json');
const HTML_PATH = path.resolve(__dirname, '..', 'prompt', 'Leave_RisuAI_Preset.html');
const FLASHBACK_PATH = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const SDK_PATH = path.resolve(__dirname, '..', 'sdk', 'MemorySuiteSourceInput.libra.source.js');

const evalLeaveCbs = (template, vars = {}) => {
  const getVar = name => String(vars[name] ?? '0');
  const evalCond = expr => {
    const trimmed = expr.trim();
    if (trimmed.startsWith('{{equal::')) {
      const m = /^\{\{equal::\{\{getglobalvar::([a-z0-9_]+)\}\}::([^}]*)\}\}$/.exec(trimmed);
      if (!m) throw new Error(`Unsupported equal cond: ${trimmed}`);
      return getVar(m[1]) === m[2];
    }
    if (trimmed.startsWith('{{notequal::')) {
      const m = /^\{\{notequal::\{\{getglobalvar::([a-z0-9_]+)\}\}::([^}]*)\}\}$/.exec(trimmed);
      if (!m) throw new Error(`Unsupported notequal cond: ${trimmed}`);
      return getVar(m[1]) !== m[2];
    }
    if (trimmed.startsWith('{{any::')) {
      const inner = trimmed.slice('{{any::'.length, -2);
      const parts = inner.split('::{{').map((p, idx) => (idx === 0 ? p : `{{${p}`));
      return parts.some(evalCond);
    }
    throw new Error(`Unsupported CBS cond: ${trimmed}`);
  };

  let out = String(template || '');
  const openRe = /\{\{#if(?:_pure)?\s+/g;
  while (true) {
    openRe.lastIndex = 0;
    const match = openRe.exec(out);
    if (!match) break;
    const tagStart = match.index;
    const condStart = tagStart + match[0].length;
    let depth = 1;
    let pos = condStart;
    while (pos < out.length && depth > 0) {
      if (out.startsWith('{{', pos)) { depth += 1; pos += 2; continue; }
      if (out.startsWith('}}', pos)) { depth -= 1; pos += 2; continue; }
      pos += 1;
    }
    assert.equal(depth, 0, `Unclosed {{#if condition near ${out.slice(tagStart, tagStart + 80)}`);
    const condExpr = out.slice(condStart, pos - 2);
    const bodyStart = pos;
    let blockDepth = 1;
    let scan = bodyStart;
    let closeStart = -1;
    while (scan < out.length && blockDepth > 0) {
      const nextOpen = out.indexOf('{{#if', scan);
      const nextClose = out.indexOf('{{/if}}', scan);
      assert.ok(nextClose >= 0, `Missing {{/if}} for block at ${tagStart}`);
      if (nextOpen >= 0 && nextOpen < nextClose) {
        blockDepth += 1;
        scan = nextOpen + 5;
      } else {
        blockDepth -= 1;
        if (blockDepth === 0) closeStart = nextClose;
        scan = nextClose + '{{/if}}'.length;
      }
    }
    const innerBody = out.slice(bodyStart, closeStart);
    const replacement = evalCond(condExpr) ? evalLeaveCbs(innerBody, vars) : '';
    out = out.slice(0, tagStart) + replacement + out.slice(closeStart + '{{/if}}'.length);
  }
  return out;
};

test('Leave preset OOC mode toggle emits marker, OOC contract, @기억 rules, regex card, and keeps normal mode intact', () => {
  const preset = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.match(preset.customPromptTemplateToggle, /ooc_mode=.*select=꺼짐.*OOC 모드 \(방랑 사서 리브\),OOC 모드 \(담백한 어시스턴트\)/);
  assert.match(preset.customPromptTemplateToggle, /=↳ OOC 기억 조회: @기억\(전체\) · @리브라 · @하야쿠 · @플래시백.*=caption/);
  assert.match(html, /OOC 모드.*@기억.*@리브라.*@하야쿠.*@플래시백/s);

  const narrativeIndices = [1, 2, 3, 4, 5, 6, 7, 8];
  const block01 = preset.promptTemplate[0];
  const block09 = preset.promptTemplate[20];

  const normal01 = evalLeaveCbs(block01.text, { toggle_ooc_mode: '0' });
  const normal09 = evalLeaveCbs(block09.text, { toggle_ooc_mode: '0' });
  assert.doesNotMatch(normal01, /\[LIBRARIAN_OOC_MODE:ACTIVE\]/);
  assert.doesNotMatch(normal09, /LEAVE OOC COMMITMENT LOCK/);
  assert.match(normal01, /\[LEAVE ENGINE — OUTPUT CONTRACT & BASE QUALITY FLOOR\]/);

  for (const modeVal of ['1', '2']) {
    const vars = { toggle_ooc_mode: modeVal, toggle_output_lang: '0', toggle_writing_mode: '0', toggle_aide_core_continuity: '1', toggle_nsfw_mode: '3' };
    const out01 = evalLeaveCbs(block01.text, vars);
    const out09 = evalLeaveCbs(block09.text, vars);
    assert.ok(out01.includes('[LIBRARIAN_OOC_MODE:ACTIVE]'), `mode ${modeVal} emits suite marker`);
    assert.match(out01, /<ooc>\.\.\.<\/ooc>/);
    assert.match(out01, /@기억/);
    assert.match(out01, /@리브라/);
    assert.match(out01, /@하야쿠/);
    assert.match(out01, /@플래시백/);
    assert.doesNotMatch(out01, /STATE HUD CARD:/);
    assert.match(out09, /LEAVE OOC COMMITMENT LOCK/);
    assert.doesNotMatch(out09, /STEP 2 — LEAVE HUD/);
    if (modeVal === '1') assert.match(out01, /Wandering Librarian Leave \(리브\)/);
    if (modeVal === '2') assert.match(out01, /Objective OOC Assistant/);

    for (const idx of narrativeIndices) {
      const rendered = evalLeaveCbs(preset.promptTemplate[idx].text, vars).trim();
      assert.equal(rendered, '', `narrative block ${idx} must be empty during OOC mode ${modeVal}`);
    }
  }

  const oocRegex = (preset.regex || []).find(r => r?.comment?.includes('<ooc>'));
  assert.ok(oocRegex, 'Leave preset has editdisplay regex for <ooc>');
  const re = new RegExp(oocRegex.in, oocRegex.flag);
  const renderedDisplay = '<ooc>25일입니다.</ooc>'.replace(re, oocRegex.out);
  assert.match(renderedDisplay, /leave-ooc-card/);
  assert.match(renderedDisplay, /25일입니다\./);
  assert.equal('일반 서사 본문입니다.'.replace(re, oocRegex.out), '일반 서사 본문입니다.');
});

test('MemorySuiteSourceInput excludes <ooc> in both default rules and custom saved rules', () => {
  const code = fs.readFileSync(SDK_PATH, 'utf8');
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  for (const owner of ['libra', 'hayaku', 'flashback']) {
    const defaults = ctx.memorySuiteDefaultSourceRules(owner);
    assert.ok(defaults.ignoredTags.includes('ooc'), `${owner} default ignoredTags includes ooc`);
  }
  assert.equal(ctx.memorySuiteStripInternalSource('<ooc>25일입니다.</ooc>').trim(), '');
  assert.equal(ctx.memorySuiteStripInternalSource('본문 <ooc>질문 답변</ooc> 끝').replace(/\s+/g, ' ').trim(), '본문 끝');
});

test('GRADIA immediately passes through requests containing [LIBRARIAN_OOC_MODE:ACTIVE]', async () => {
  const g = await loadGradia({ captureInternals: true });
  g.internals.Runtime.settings = { ...(g.internals.Runtime.settings || {}), mode: 'novel' };
  const msgs = [
    { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]\nAnswer in <ooc>...</ooc>.' },
    { role: 'user', content: '@기억 예전에 아린이랑 푸딩이 첫키스한 날짜가 어떻게 되지?' }
  ];
  const out = await g.hooks.beforeRequest(msgs, 'model');
  assert.deepEqual(out, msgs);
  assert.equal(g.internals.Runtime.last?.skipped, true);
  assert.equal(g.internals.Runtime.last?.reason, 'ooc_mode');
  assert.equal(g.getCalls(), 0);
});

test('HAYAKU pauses capture/write in OOC mode, answers @기억 timeline date read-only, and ignores <ooc> pairs on later turns', async () => {
  const packet1 = createValidPacket({
    turn: 1,
    subject: '아린',
    scene: '한빛대 옥상',
    summary: '아린과 푸딩이 5월 25일 밤 옥상에서 첫키스를 했다.'
  });
  packet1.entity.characters.push({ name: '푸딩', current_state: '설렘' });
  packet1.world.time = '2026-05-25 21:30';
  packet1.world.location = '한빛대 옥상';

  const initialMessages = [
    { role: 'user', chatId: 'u1', data: '옥상에서 바람이 분다.' },
    { role: 'assistant', chatId: 'a1', data: hiddenPacketMessage('아린과 푸딩이 5월 25일 밤 첫키스를 했다.', packet1) }
  ];

  const runtime = await createHayakuRuntime({
    messages: initialMessages,
    transformSource: src => src.replace(
      'const exposeApi = () => {',
      'globalThis.__hayakuTestState = { Memory, authoritativeHistoryPairs, processRisuChatOutputEvent };\n  const exposeApi = () => {'
    )
  });
  try {
    const hState = runtime.context.__hayakuTestState;
    const { Memory, authoritativeHistoryPairs, processRisuChatOutputEvent } = hState;

    // 1. Plain OOC (no @trigger): completely silent, zero packet write contract, zero pending capture
    const silentReq = [
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '다음 전개 어떻게 잡을까?' }
    ];
    const silentOut = await runtime.callBeforeRequest(silentReq, 'model');
    assert.equal(Memory.lastBeforeRequest.reason, 'ooc_mode_silent');
    assert.equal(Memory.lastBeforeRequest.packetWriteActive, false);
    assert.equal(silentOut.some(m => String(m.content || '').includes('HAYAKU_STATE_PACKET_START')), false);
    assert.equal(Memory.pendingCaptures.length, 0);

    const afterSilent = await runtime.callAfterRequest('<ooc>다음 전개를 정리해 볼게요.</ooc>', 'model');
    assert.equal(afterSilent, '<ooc>다음 전개를 정리해 볼게요.</ooc>');
    assert.equal(Memory.captureBackendHealthPending, null);

    // 2. Targeted to @리브라 only: HAYAKU stays silent
    const libraOnlyReq = [
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '@리브라 아린이랑 푸딩이 첫키스한 날짜는?' }
    ];
    await runtime.callBeforeRequest(libraOnlyReq, 'model');
    assert.equal(Memory.lastBeforeRequest.reason, 'ooc_mode_silent');

    // 3. @기억 trigger: HAYAKU injects read-only timeline match with 5월 25일 and NO packet-write contract
    const memoryReq = [
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '@기억 예전에 아린이랑 푸딩이 첫키스한 날짜가 어떻게 되지?' }
    ];
    const memoryOut = await runtime.callBeforeRequest(memoryReq, 'model');
    assert.equal(Memory.lastBeforeRequest.ooc, true);
    assert.equal(Memory.lastBeforeRequest.oocReadOnly, true);
    assert.equal(Memory.lastBeforeRequest.packetWriteActive, false);
    assert.equal(Memory.pendingCaptures.length, 0);

    const injectedText = memoryOut.map(m => String(m.content || '')).join('\n');
    assert.match(injectedText, /2026-05-25 21:30/);
    assert.match(injectedText, /아린/);
    assert.match(injectedText, /푸딩/);
    assert.equal(injectedText.includes('HAYAKU_STATE_PACKET_START'), false);

    // chat-output listener skips <ooc> responses
    runtime.setMessages([
      ...initialMessages,
      { role: 'user', chatId: 'u-ooc', data: '@기억 예전에 아린이랑 푸딩이 첫키스한 날짜가 어떻게 되지?' },
      { role: 'assistant', chatId: 'a-ooc', data: '<ooc>5월 25일입니다.</ooc>' }
    ]);
    const oocOutputEvent = { messageIndex: 3, char: runtime.character, chat: runtime.chat, characterIndex: 0, chatIndex: 0 };
    await runtime.callChatOutput(oocOutputEvent);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(Memory.lastCaptureReceipt, null);
    const directChatOutRes = await processRisuChatOutputEvent(oocOutputEvent);
    assert.equal(directChatOutRes.skipped, true);
    assert.equal(directChatOutRes.reason, 'ooc_mode');

    // Subsequent normal RP turn sees ONLY the original 1 pair (OOC pair excluded cleanly)
    const historyView = authoritativeHistoryPairs(runtime.chat.message, { key: 'test-scope' });
    assert.equal(historyView.conversationPairCount, 1);
    const normalOut = await runtime.callBeforeRequest([{ role: 'user', content: '다음 날 아침이 밝았다.' }], 'model');
    assert.ok(!Memory.lastBeforeRequest.skipped);
    assert.equal(Memory.lastBeforeRequest.packetWriteActive, true);
    assert.ok(normalOut.some(m => String(m.content || '').includes('HAYAKU_STATE_PACKET_START')));
  } finally {
    await runtime.dispose();
  }
});

test('LIBRA pauses analysis in OOC mode, runs read-only recall on @기억 with stripped query, and excludes <ooc> pairs', async () => {
  const f = await libraFixture({
    transformSource: src => src
      .replace(
        'const buildPairs = (chat, cacheKeyInput = \'\') => {',
        'const buildPairs = globalThis.__testBuildPairs = (chat, cacheKeyInput = \'\') => {'
      )
      .replace(
        'const beforeRequest = async (messages, type) => {',
        'globalThis.__libraCoreState = state;\n    const beforeRequest = async (messages, type) => {'
      )
  });
  try {
    // 1. Untriggered OOC skips recall & pendingMicro
    const silentMsgs = [
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '잡담하자' }
    ];
    const silentOut = await f.control.hooks.beforeRequest(silentMsgs, 'model');
    assert.deepEqual(silentOut, silentMsgs);
    let rt = f.r.api.getRuntime();
    assert.equal(rt.lastMemoryInjectionMeta.skipped, true);
    assert.equal(rt.lastMemoryInjectionMeta.skipReason, 'ooc_mode_silent');
    assert.equal(f.r.context.__libraCoreState.lastRequestScope.ooc, true);
    assert.equal(f.r.context.__libraCoreState.lastRequestScope.pendingMicro, null);

    // afterRequest during OOC skips scanning & clears health pending
    const afterRes = await f.control.hooks.afterRequest('<ooc>좋아요!</ooc>', 'model');
    assert.equal(afterRes, '<ooc>좋아요!</ooc>');
    assert.equal(f.r.context.__libraCoreState.lastAfterRequest.blockedReason, 'ooc_mode');
    assert.equal(f.r.context.__libraCoreState.lastAfterRequest.scheduled, false);
    assert.equal(f.control.calls.length, 0);

    // 2. Targeted to @플래시백 only: LIBRA stays silent
    await f.control.hooks.beforeRequest([
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '@플래시백 아린이랑 푸딩이 첫키스한 날짜는?' }
    ], 'model');
    rt = f.r.api.getRuntime();
    assert.equal(rt.lastMemoryInjectionMeta.skipReason, 'ooc_mode_silent');

    // 3. @기억 trigger strips prefix before recall and runs read-only without arming pendingMicro
    await f.control.hooks.beforeRequest([
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '@기억 아린이랑 푸딩이 첫키스한 날짜는?' }
    ], 'model');
    rt = f.r.api.getRuntime();
    assert.notEqual(rt.lastMemoryInjectionMeta.skipReason, 'ooc_mode_silent');
    assert.equal(f.r.context.__libraCoreState.lastRequestScope.ooc, true);
    assert.equal(f.r.context.__libraCoreState.lastRequestScope.pendingMicro, null);
    assert.equal(f.r.context.__libraCoreState.lastRecallInputResolution?.textPreview, '아린이랑 푸딩이 첫키스한 날짜는?');
    assert.equal(rt.lastMemoryRecallViewer?.queryText, '아린이랑 푸딩이 첫키스한 날짜는?');
    const afterRecallRes = await f.control.hooks.afterRequest('<ooc>25일입니다.</ooc>', 'model');
    assert.equal(afterRecallRes, '<ooc>25일입니다.</ooc>');
    assert.equal(f.r.context.__libraCoreState.lastAfterRequest.blockedReason, 'ooc_mode');
    assert.equal(f.r.context.__libraCoreState.lastAfterRequest.scheduled, false);
    assert.equal(f.control.calls.length, 0);

    // 4. buildPairs excludes <ooc> turn pair without merging OOC user prompt into next RP turn
    const pairs = f.r.context.__testBuildPairs({
      id: 'c1',
      message: [
        { role: 'user', chatId: 'u1', data: '첫 번째 서사' },
        { role: 'assistant', chatId: 'a1', data: '첫 번째 응답' },
        { role: 'user', chatId: 'u-ooc', data: '@기억 날짜 알려줘' },
        { role: 'assistant', chatId: 'a-ooc', data: '<ooc>25일입니다.</ooc>' },
        { role: 'user', chatId: 'u2', data: '두 번째 서사' },
        { role: 'assistant', chatId: 'a2', data: '두 번째 응답' }
      ]
    }, 'test-scope');
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].user.text, '첫 번째 서사');
    assert.equal(pairs[1].user.text, '두 번째 서사');
  } finally {
    await f.r.dispose?.();
  }
});

test('Flashback pauses capture in OOC mode, runs read-only recall on @기억, and drops <ooc> turns from liveChatState', async () => {
  const rawSource = fs.readFileSync(FLASHBACK_PATH, 'utf8');
  const wrappedSource = rawSource.replace(
    'Runtime.registered.before = beforeRequest;',
    'globalThis.__fbLive = { liveChatReadState, liveChatStateFromNormalized };\n      Runtime.registered.before = beforeRequest;'
  );
  const f = await createFlashbackFixture({
    source: wrappedSource,
    nativeFetch: async () => {
      const vec = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
      const payload = { data: [{ embedding: vec }] };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload)
      };
    },
    arguments: {
      embedding_enabled: 'true',
      embedding_provider: 'openai',
      embedding_model: 'text-embedding-3-small',
      embedding_api_key: 'test-key',
      heuristic_recall: 'true'
    },
    chat: {
      id: 'fb-ooc-chat',
      chatId: 'fb-ooc-chat',
      message: [
        { role: 'user', chatId: 'u1', data: '옥상으로 올라갔다.' },
        { role: 'assistant', chatId: 'a1', data: '5월 25일 밤, 아린과 푸딩이 첫키스를 했다.' },
        { role: 'user', chatId: 'u-ooc', data: '@기억 아린이랑 푸딩이 첫키스한 날짜는?' },
        { role: 'assistant', chatId: 'a-ooc', data: '<ooc>25일입니다.</ooc>' },
        { role: 'user', chatId: 'u2', data: '다음 날이 되었다.' },
        { role: 'assistant', chatId: 'a2', data: '아린이 웃었다.' }
      ]
    }
  });
  try {
    const Runtime = f.api._test.Runtime;
    const beforeRequest = Runtime.registered.before;
    const afterRequest = Runtime.registered.after;
    const { liveChatReadState, liveChatStateFromNormalized } = f.context.__fbLive;
    assert.equal(typeof beforeRequest, 'function');
    assert.equal(typeof afterRequest, 'function');

    // 1. Live chat state drops <ooc> pair cleanly without leaking u-ooc into u2
    const live = liveChatReadState(f.currentChat, 'fb-scope');
    const liveState = liveChatStateFromNormalized(live.normalized);
    assert.equal(liveState.pairs.length, 2);
    assert.equal(liveState.pairs[0].userText, '옥상으로 올라갔다.');
    assert.equal(liveState.pairs[1].userText, '다음 날이 되었다.');

    // 2. Cold-start ingest existing RP turns so Flashback has finalized searchable episodes (and mock embedding works)
    const coldStartRes = await f.api.ingestLiveChatColdStart();
    assert.ok(Number(coldStartRes?.inserted || 0) >= 1);
    const savedRecordCountBeforeOoc = Number(coldStartRes?.total || coldStartRes?.inserted || 0);
    assert.equal(Runtime.pendingTurns.length, 0);

    // 3. Untriggered OOC skips recall & arms zero pendingTurns
    await beforeRequest([
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '그냥 이야기하자' }
    ], 'model');
    assert.equal(Runtime.lastRecall.skipped, true);
    assert.equal(Runtime.lastRecall.reason, 'ooc_mode_silent');
    assert.equal(Runtime.pendingTurns.length, 0);
    assert.equal(await afterRequest('<ooc>네, 이야기해요.</ooc>', 'model'), '<ooc>네, 이야기해요.</ooc>');

    // 4. Targeted to @하야쿠 only: Flashback stays silent
    await beforeRequest([
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '@하야쿠 아린이랑 푸딩이 첫키스한 날짜는?' }
    ], 'model');
    assert.equal(Runtime.lastRecall.skipped, true);
    assert.equal(Runtime.lastRecall.reason, 'ooc_mode_silent');
    await afterRequest('<ooc>하야쿠만 확인했어요.</ooc>', 'model');

    // 5. @기억 trigger runs read-only recall on stored episode with pendingTurns === 0
    const recallOut = await beforeRequest([
      { role: 'system', content: '[LIBRARIAN_OOC_MODE:ACTIVE]' },
      { role: 'user', content: '@기억 아린이랑 푸딩이 첫키스한 날짜는?' }
    ], 'model');
    assert.equal(Runtime.pendingTurns.length, 0);
    assert.equal(Runtime.lastRecall?.reason, 'ooc_recall_injected');
    const recalledJoined = recallOut.map(m => String(m.content || '')).join('\n');
    assert.match(recalledJoined, /5월 25일/);
    await afterRequest('<ooc>5월 25일입니다.</ooc>', 'model');
    assert.equal(Runtime.captureBackendHealthPending, null);

    // 6. chat-output listener skips <ooc> message and keeps manifest count unchanged
    const chatOutCount = await f.dispatchRisuChatEvent('output', {
      messageIndex: 3,
      char: f.character,
      chat: f.currentChat,
      characterIndex: 0,
      chatIndex: 0
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(chatOutCount, 1);
    assert.equal(Runtime.pendingTurns.length, 0);
    assert.equal(Number(f.api.debugState?.()?.manifestCount ?? savedRecordCountBeforeOoc), savedRecordCountBeforeOoc);
  } finally {
    await f.dispose();
  }
});
