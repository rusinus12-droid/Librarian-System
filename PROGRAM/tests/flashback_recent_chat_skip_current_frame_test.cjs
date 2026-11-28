'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');

const PROGRAM = path.resolve(__dirname, '..');

const TURN_1_USER = 'Where is the brass key hidden?';
const TURN_1_ASSISTANT = 'The brass key is locked inside the north library cedar chest behind the ledger.';
const TURN_2_USER = 'What password opens the cellar door?';
const TURN_2_ASSISTANT = 'The cellar door passphrase is amber lantern forty two spoken softly twice.';
const TURN_3_USER = 'And who keeps the spare harbour map?';
const TURN_3_ASSISTANT = 'Harbourmaster Yoon keeps the waterproof chart rolled inside the brass tube by the pier.';

function installEmbeddingFetch(f) {
  f.host.nativeFetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || '{}'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: inputs.map((_item, index) => ({ index, embedding: [1, 0, 0] }))
        };
      }
    };
  };
}

async function setupSeededChat(turns) {
  const f = await createFlashback(PROGRAM, { waitForLoaded: true });
  installEmbeddingFetch(f);
  const cfg = f.api._test.normalizeSettings({
    embeddingEnabled: true,
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1/embeddings',
    embeddingMaxRetries: 0,
    autoEpisodeIndex: false,
    contextualRecall: false,
    currentSceneTailEnabled: false,
    minScore: 0
  });
  await f.api.saveSettings(cfg);
  const chatMessages = [];
  for (const turn of turns) {
    chatMessages.push({ role: 'user', chatId: turn.userChatId, data: turn.user });
    chatMessages.push({ role: 'assistant', chatId: turn.assistantChatId, data: turn.assistant });
  }
  const chat = await f.host.getCurrentChat();
  chat.message = chatMessages;
  chat.messages = chatMessages;
  const scope = await f.api.resolveCurrentScope(false);
  await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
  return { f, scope, cfg };
}

test('all candidates excluded by recent chat records exact match proof and renders clearly in Current frame', async () => {
  const { f, scope } = await setupSeededChat([
    { userChatId: 'u1', user: TURN_1_USER, assistantChatId: 'a1', assistant: TURN_1_ASSISTANT },
    { userChatId: 'u2', user: TURN_2_USER, assistantChatId: 'a2', assistant: TURN_2_ASSISTANT }
  ]);
  try {
    const requestMessages = [
      { role: 'system', content: 'Stay consistent with the scene details.' },
      { role: 'user', chatId: 'u1', content: TURN_1_USER },
      { role: 'assistant', chatId: 'a1', content: TURN_1_ASSISTANT },
      { role: 'user', chatId: 'u2', content: TURN_2_USER },
      {
        role: 'assistant',
        chatId: 'a2',
        content: `OOC recap: ${TURN_2_ASSISTANT} Everything else stays quiet.`
      },
      { role: 'user', chatId: 'u3', content: 'Remind me about the brass key and the cellar door passphrase.' }
    ];

    await f.api._test.beforeRequest(requestMessages, 'model');
    const debug = await f.api.debugState();
    const lastRecall = debug.lastRecall;

    assert.equal(lastRecall.candidates, 0);
    assert.equal(lastRecall.selected.length, 0);
    assert.ok(lastRecall.recentChatFiltered >= 2, 'dropped candidates are counted in recentChatFiltered');
    const ex = lastRecall.recentChatExclusion;
    assert.ok(ex, 'recentChatExclusion summary is present on Runtime.lastRecall');
    assert.equal(ex.allCandidatesExcluded, true);
    assert.equal(ex.excludedCandidates, lastRecall.recentChatFiltered);
    assert.equal(ex.excludedTurnCount, 2);
    assert.equal(ex.shownMessageCount, 6);
    assert.equal(ex.shownAssistantCount, 2);
    assert.equal(ex.matches.length, 2);

    const turn1Match = ex.matches.find(item => item.turnIndex === 1);
    const turn2Match = ex.matches.find(item => item.turnIndex === 2);
    assert.ok(turn1Match, 'turn 1 match recorded');
    assert.equal(turn1Match.matchType, 'exact');
    assert.equal(turn1Match.requestMessageIndex, 3);
    assert.equal(turn1Match.assistantOrdinal, 1);
    assert.ok(turn1Match.droppedCandidates >= 1);
    assert.ok(turn1Match.storedPreview.includes('brass key'));
    assert.ok(turn1Match.matchedPreview.includes('brass key'));

    assert.ok(turn2Match, 'turn 2 match recorded');
    assert.equal(turn2Match.matchType, 'contained_in_recent_message');
    assert.equal(turn2Match.requestMessageIndex, 5);
    assert.equal(turn2Match.assistantOrdinal, 2);
    assert.ok(turn2Match.matchOffset > 0);
    assert.ok(turn2Match.storedPreview.includes('amber lantern'));
    assert.ok(turn2Match.matchedPreview.includes('amber lantern'));

    const panelHtml = f.api._test.renderLastRecallPanel(lastRecall, scope.scopeKey);
    assert.match(panelHtml, /정상 생략/);
    assert.match(panelHtml, /최근 챗 일치 제외/);
    assert.match(panelHtml, /본문 완전 일치/);
    assert.match(panelHtml, /최근 응답 본문에 포함됨/);
    assert.match(panelHtml, /전송 메시지 #3/);
    assert.match(panelHtml, /전송 메시지 #5/);
    assert.match(panelHtml, /T1 ·/);
    assert.match(panelHtml, /T2 ·/);
    assert.match(panelHtml, /brass key/);
    assert.match(panelHtml, /amber lantern/);
    assert.doesNotMatch(panelHtml, /이 검색에서 선택된 기억이 없습니다\./);

    const overview = f.api._test.flashbackOverviewRecallSummary(lastRecall, scope.scopeKey);
    assert.equal(overview.badge, '정상 생략');
    assert.equal(overview.value, '최근 챗 중복 생략');
    assert.match(overview.meta, /최근 대화 일치 2턴/);

    const activity = f.api.getActivityLog().filter(row => row.event === 'memory_recall_completed').at(-1);
    assert.ok(activity, 'memory_recall_completed activity logged');
    assert.match(activity.message, /이미 최근 대화에 포함되어 리콜을 생략했습니다/);
    assert.doesNotMatch(activity.message, /관련된 기억 후보를 찾지 못했습니다/);
  } finally {
    await f.cleanup();
  }
});

test('mixed recall keeps older turns while collapsing recent-chat exclusion proof', async () => {
  const { f, scope } = await setupSeededChat([
    { userChatId: 'u1', user: TURN_1_USER, assistantChatId: 'a1', assistant: TURN_1_ASSISTANT },
    { userChatId: 'u2', user: TURN_2_USER, assistantChatId: 'a2', assistant: TURN_2_ASSISTANT },
    { userChatId: 'u3', user: TURN_3_USER, assistantChatId: 'a3', assistant: TURN_3_ASSISTANT }
  ]);
  try {
    const requestMessages = [
      { role: 'user', chatId: 'u3', content: TURN_3_USER },
      { role: 'assistant', chatId: 'a3', content: TURN_3_ASSISTANT },
      { role: 'user', chatId: 'u4', content: 'Where did we hide the brass key and cellar passphrase earlier?' }
    ];

    await f.api._test.beforeRequest(requestMessages, 'model');
    const lastRecall = (await f.api.debugState()).lastRecall;

    assert.ok(lastRecall.selected.length > 0, 'older turns not in recent chat are still recalled');
    assert.ok(lastRecall.recentChatFiltered >= 1, 'turn 3 in recent chat is excluded');
    assert.equal(lastRecall.recentChatExclusion.allCandidatesExcluded, false);
    assert.equal(lastRecall.recentChatExclusion.matches.length, 1);
    assert.equal(lastRecall.recentChatExclusion.matches[0].turnIndex, 3);
    assert.equal(lastRecall.recentChatExclusion.matches[0].matchType, 'exact');

    const panelHtml = f.api._test.renderLastRecallPanel(lastRecall, scope.scopeKey);
    assert.match(panelHtml, /frame-card/);
    assert.match(panelHtml, /최근 챗 일치로 제외된 기억 근거/);
    assert.match(panelHtml, /T3 ·/);
    assert.doesNotMatch(panelHtml, /정상 생략/);
    assert.doesNotMatch(panelHtml, /<details class="fold" open><summary>최근 챗 일치로 제외된 기억 근거/);
  } finally {
    await f.cleanup();
  }
});

test('inspectRequestPreviousTurnMatch reports exact, contained, stored_contains, and joined matches', async () => {
  const f = await createFlashback(PROGRAM, { waitForLoaded: true });
  try {
    const inspect = f.api._test.inspectRequestPreviousTurnMatch;
    const stored = 'The silver compass needle spins rapidly whenever someone opens the iron gate.';

    const exact = inspect([{ role: 'assistant', content: stored }], stored);
    assert.equal(exact.matched, true);
    assert.equal(exact.matchType, 'exact');
    assert.equal(exact.requestMessageIndex, 1);
    assert.equal(exact.assistantOrdinal, 1);

    const contained = inspect(
      [{ role: 'user', content: 'hi' }, { role: 'assistant', content: `Prefix note: ${stored} Suffix note.` }],
      stored
    );
    assert.equal(contained.matched, true);
    assert.equal(contained.matchType, 'contained_in_recent_message');
    assert.equal(contained.requestMessageIndex, 2);
    assert.equal(contained.assistantOrdinal, 1);
    assert.ok(contained.matchOffset > 0);

    const storedContains = inspect(
      [{ role: 'assistant', content: 'The silver compass needle spins rapidly whenever' }],
      stored
    );
    assert.equal(storedContains.matched, true);
    assert.equal(storedContains.matchType, 'stored_contains_recent_message');

    const joinedStored = 'Alpha one! Beta two! Gamma 3.';
    const joined = inspect(
      [
        { role: 'assistant', content: 'Alpha one!' },
        { role: 'assistant', content: 'Beta two!' },
        { role: 'assistant', content: 'Gamma 3.' }
      ],
      joinedStored
    );
    assert.equal(joined.matched, true);
    assert.equal(joined.matchType, 'joined_messages_match');
    assert.equal(joined.role, 'joined');
  } finally {
    await f.cleanup();
  }
});
