'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, until } = require('./fixtures/flashback_complete_gui_fixture.cjs');

test('Flashback GUI opens searchable full person dictionary from header and inline recall panel buttons', async () => {
  const s = await create('Flashback');
  try {
    const scope = await s.api.resolveCurrentScope();
    const scopeKey = scope.scopeKey;
    const names = [
      '민아', '지호', '준호', '서연', '하연', '태오', '유진', '도윤',
      '수빈', '시우', '예은', '현우', '지안', '채원', '건우'
    ];
    const sources = names.map((name, idx) => ({
      role: 'response',
      sourceType: 'response',
      origin: 'live_chat',
      sourceId: `turn_${idx + 1}`,
      sourceHash: `hash_${idx + 1}`,
      turnIndex: idx + 1,
      pairIndex: idx + 1,
      text: `${name}: "안녕하세요, 기록 ${idx + 1}입니다."\n${name}는 고개를 끄덕였다.\n${name}씨와 함께 서재로 갔다.`
    }));
    const records = await s.api._test.buildRecordsFromSources(sources, null, scope, { deferEmbedding: true });
    await s.api._test.saveAllRecords(records, null, scope);

    // 1. renderPersonDictionaryDialogHtml renders >12 entries and escapes XSS safely.
    const twentyEntries = Array.from({ length: 20 }, (_, i) => ({
      name: i === 0 ? '<img src=x onerror=alert(1)>' : `인물_${i + 1}`,
      aliases: i === 0 ? ['<script>bad()</script>'] : [`별칭_${i + 1}`],
      source: i % 2 === 0 ? 'auto_raw_records' : 'lore_entity',
      score: i % 2 === 0 ? 5.5 : null
    }));
    const dialogHtml = s.api._test.renderPersonDictionaryDialogHtml({
      originLabel: '최근 리콜 기준',
      entries: twentyEntries,
      queryTargets: ['<img src=x onerror=alert(1)>'],
      mismatchedCount: 3
    });
    assert.ok(!dialogHtml.includes('<img src=x'), 'XSS img tag in name must be escaped');
    assert.ok(!dialogHtml.includes('<script>bad'), 'XSS script tag in alias must be escaped');
    assert.ok(dialogHtml.includes('인물_20'), 'entries beyond 12 are all rendered');
    assert.ok(dialogHtml.includes('이번 쿼리 타깃'), 'queryTarget badge shown');
    assert.ok(dialogHtml.includes('타 인물 감점 3건'), 'mismatched count shown');

    // 2. Empty panel and populated panel both include [data-fb-open-person-dict].
    const emptyPanelHtml = s.api._test.renderLastRecallPanel({ scopeKey, at: Date.now(), latestUser: '질문', selected: [] }, scopeKey);
    assert.match(emptyPanelHtml, /data-fb-open-person-dict/);

    // 3. Open the actual Flashback GUI; click header #openPersonDictBtn BEFORE any recall -> reads records read-only & shows all 15 names.
    await s.open();
    await until(() => s.doc.querySelector('#openPersonDictBtn'), 'header person dict button');
    s.doc.querySelector('#openPersonDictBtn').click();
    const overlay = await until(() => s.doc.body.querySelector('.overlay.is-open [role="dialog"]'), 'person dict dialog');
    assert.match(overlay.textContent, /자동 인물 사전/);
    assert.match(overlay.textContent, /15명/);
    assert.match(overlay.textContent, /저장된 기억 원문 분석 기준/);
    for (const name of names) {
      assert.ok(overlay.textContent.includes(name), `dialog includes discovered person ${name}`);
    }

    // Search filter narrows visible rows cleanly.
    const searchInput = overlay.querySelector('#fbPersonDictSearch');
    assert.ok(searchInput, 'search input rendered in dialog');
    searchInput.value = '서연';
    searchInput.dispatchEvent(new s.dom.window.Event('input', { bubbles: true }));
    const visibleRows = Array.from(overlay.querySelectorAll('[data-fb-person-row]')).filter(row => !row.hidden);
    assert.equal(visibleRows.length, 1);
    assert.ok(visibleRows[0].textContent.includes('서연'));
    assert.match(overlay.querySelector('#fbPersonDictFilterStatus').textContent, /검색 결과 1명 \/ 전체 15명/);

    // Close modal.
    const closeBtn = Array.from(overlay.querySelectorAll('button')).find(btn => btn.textContent.trim() === '닫기');
    assert.ok(closeBtn);
    closeBtn.click();
    await until(() => !s.doc.body.querySelector('.overlay.is-open [role="dialog"]'), 'person dict closed');

    // 4. Inline button rendered inside #lastRecallPanel also opens the dialog via delegated click binding.
    const panelEl = s.doc.querySelector('#lastRecallPanel');
    assert.ok(panelEl, '#lastRecallPanel exists');
    panelEl.innerHTML = s.api._test.renderLastRecallPanel({
      scopeKey,
      at: Date.now(),
      latestUser: '서연과 민아의 이야기',
      selected: [],
      personIsolation: {
        dictionary: names,
        queryTargets: ['서연'],
        mismatchedCount: 2
      }
    }, scopeKey);
    const inlineBtn = panelEl.querySelector('[data-fb-open-person-dict]');
    assert.ok(inlineBtn, 'inline 인물 사전 열람 button exists inside #lastRecallPanel');
    inlineBtn.click();
    const inlineOverlay = await until(() => s.doc.body.querySelector('.overlay.is-open [role="dialog"]'), 'inline person dict dialog');
    assert.match(inlineOverlay.textContent, /15명/);
    const inlineCloseBtn = Array.from(inlineOverlay.querySelectorAll('button')).find(btn => btn.textContent.trim() === '닫기');
    inlineCloseBtn.click();
    await until(() => !s.doc.body.querySelector('.overlay.is-open [role="dialog"]'), 'inline person dict closed');
  } finally {
    await s.close();
  }
});
