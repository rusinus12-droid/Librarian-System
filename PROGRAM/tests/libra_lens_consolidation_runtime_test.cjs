'use strict';
// Lens anti-fragmentation: multi-quote evidence, topic synthesis, intra-batch consolidation,
// read-time `supersedes` evolution chains across batches & handoffs, recall roll-up, and Viewer folding.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const plain = value => JSON.parse(JSON.stringify(value));
const src = ref => input.sourceRows.find(row => row.ref === ref).text;

const createViewerMockDom = () => {
  const toCamel = attr => attr.slice(5).replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
  class TextNode {
    constructor(text) { this.nodeType = 3; this.parentNode = null; this._text = String(text ?? ''); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v ?? ''); }
  }
  const parsePart = raw => {
    let s = raw.trim();
    const out = { tag: '', id: '', classes: [], attrs: [] };
    const tm = s.match(/^[a-zA-Z0-9_-]+/);
    if (tm) { out.tag = tm[0].toLowerCase(); s = s.slice(tm[0].length); }
    while (s.length) {
      if (s[0] === '#') {
        const m = s.slice(1).match(/^[a-zA-Z0-9_-]+/); out.id = m ? m[0] : ''; s = s.slice(1 + out.id.length);
      } else if (s[0] === '.') {
        const m = s.slice(1).match(/^[a-zA-Z0-9_-]+/); if (!m) break; out.classes.push(m[0]); s = s.slice(1 + m[0].length);
      } else if (s[0] === '[') {
        const c = s.indexOf(']'); if (c < 0) break;
        const inner = s.slice(1, c).trim(), eq = inner.indexOf('=');
        if (eq < 0) out.attrs.push({ name: inner.toLowerCase(), op: 'exists', val: '' });
        else {
          const name = inner.slice(0, eq).trim().toLowerCase();
          let val = inner.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
          out.attrs.push({ name, op: '=', val });
        }
        s = s.slice(c + 1);
      } else break;
    }
    return out;
  };
  const matchCompound = (el, comp) => {
    if (!el || el.nodeType !== 1) return false;
    if (comp.tag && el.tagName.toLowerCase() !== comp.tag) return false;
    if (comp.id && el.id !== comp.id) return false;
    if (comp.classes.length) {
      const cls = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      for (const c of comp.classes) if (!cls.has(c)) return false;
    }
    for (const a of comp.attrs) {
      const val = el.getAttribute(a.name);
      if (a.op === 'exists' ? val == null : val !== a.val) return false;
    }
    return true;
  };
  class Elem {
    constructor(tag) {
      this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.childNodes = [];
      this.parentNode = null; this._attrs = new Map(); this.style = {}; this.dataset = {};
      this._listeners = new Map(); this.id = ''; this.className = ''; this.disabled = false;
      this.checked = false; this.selected = false; this.value = ''; this.scrollTop = 0;
    }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get children() { return this.childNodes.filter(c => c.nodeType === 1); }
    get open() { return this._attrs.has('open'); }
    set open(v) { if (v) this._attrs.set('open', ''); else this._attrs.delete('open'); }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.childNodes = []; const s = String(v ?? ''); if (s) this.appendChild(new TextNode(s)); }
    setAttribute(k, v) {
      const n = String(k).toLowerCase(), s = String(v ?? '');
      this._attrs.set(n, s);
      if (n === 'id') this.id = s; else if (n === 'class') this.className = s;
      else if (n.startsWith('data-')) this.dataset[toCamel(n)] = s;
    }
    getAttribute(k) {
      const n = String(k).toLowerCase();
      if (n === 'id') return this.id || null; if (n === 'class') return this.className || null;
      if (n.startsWith('data-')) {
        const camel = toCamel(n);
        if (Object.prototype.hasOwnProperty.call(this.dataset, camel)) return String(this.dataset[camel]);
      }
      return this._attrs.has(n) ? this._attrs.get(n) : null;
    }
    removeAttribute(k) {
      const n = String(k).toLowerCase(); this._attrs.delete(n);
      if (n === 'id') this.id = ''; else if (n === 'class') this.className = '';
      else if (n.startsWith('data-')) delete this.dataset[toCamel(n)];
    }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    appendChild(c) {
      if (!c) return c;
      if (c.parentNode?.removeChild) c.parentNode.removeChild(c);
      c.parentNode = this; this.childNodes.push(c); return c;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new TextNode(n) : n); }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; } return c; }
    replaceChildren(...nodes) { for (const o of [...this.childNodes]) o.parentNode = null; this.childNodes = []; for (const n of nodes) if (n) this.appendChild(n); }
    replaceWith(...nodes) {
      const p = this.parentNode; if (!p) return;
      const i = p.childNodes.indexOf(this); if (i < 0) return;
      this.parentNode = null;
      const ins = nodes.filter(Boolean).map(n => { if (n.parentNode?.removeChild) n.parentNode.removeChild(n); n.parentNode = p; return n; });
      p.childNodes.splice(i, 1, ...ins);
    }
    addEventListener(t, fn) { const k = String(t).toLowerCase(); if (!this._listeners.has(k)) this._listeners.set(k, []); this._listeners.get(k).push(fn); }
    dispatchEvent(ev) {
      const e = ev && typeof ev === 'object' ? ev : { type: String(ev) };
      const k = String(e.type || '').toLowerCase();
      if (!e.target) e.target = this;
      let cur = this;
      while (cur) { e.currentTarget = cur; for (const fn of [...(cur._listeners?.get(k) || [])]) fn.call(cur, e); cur = cur.parentNode; }
      return true;
    }
    click() {
      this.dispatchEvent({ type: 'click' });
      if (this.tagName === 'SUMMARY' && this.parentNode?.tagName === 'DETAILS') {
        this.parentNode.open = !this.parentNode.open;
        this.parentNode.dispatchEvent({ type: 'toggle' });
      }
    }
    querySelectorAll(sel) {
      const selectors = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
      const matchSingle = (el, single) => {
        const parts = single.split(/\s+/).filter(Boolean).map(parsePart);
        if (!parts.length || !matchCompound(el, parts[parts.length - 1])) return false;
        let cur = el.parentNode;
        for (let i = parts.length - 2; i >= 0; i -= 1) {
          while (cur && !matchCompound(cur, parts[i])) cur = cur.parentNode;
          if (!cur) return false;
          cur = cur.parentNode;
        }
        return true;
      };
      const out = [];
      const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { if (selectors.some(s => matchSingle(c, s))) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) {
      const parts = String(sel || '').split(/\s+/).filter(Boolean).map(parsePart);
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (parts.length === 1 && matchCompound(cur, parts[0])) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
  }
  const doc = {
    documentElement: new Elem('html'), head: new Elem('head'), body: new Elem('body'),
    readyState: 'complete', createElement: t => new Elem(t), createElementNS: (_ns, t) => new Elem(t),
    createTextNode: t => new TextNode(t),
    getElementById: id => doc.documentElement.querySelector(`#${id}`),
    querySelector: s => doc.documentElement.querySelector(s),
    querySelectorAll: s => doc.documentElement.querySelectorAll(s), addEventListener() {}, removeEventListener() {}
  };
  doc.scrollingElement = doc.documentElement;
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return { document: doc, window: { scrollTo() {} }, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
};

test('multi-quote items and topic metadata validate through source checks and session handoff', async () => {
  const f = await lensFixture();
  try {
    const q1 = '지호가 민아 소유의 은빛 열쇠를 빌려 받았고, 오늘 돌려주겠다고 약속했다.';
    const q2 = '오늘 열쇠를 반환하겠다는 약속은 이행되었다.';
    let seenPrompt = '';
    f.setReply(args => {
      seenPrompt = JSON.stringify(args);
      return JSON.stringify({
        items: [{
          label: '약속',
          topic: '은빛 열쇠 대여와 반환',
          text: '지호가 민아의 은빛 열쇠를 빌렸다가 약속대로 돌려주었다.',
          refs: ['t2-a', 't5-a'],
          quotes: [
            { ref: 't2-a', quote: q1 },
            { ref: 't5-a', quote: q2 }
          ],
          who: ['지호', '민아'],
          whoRef: 't2-a'
        }]
      });
    });
    const lens = await f.add('약속 추적', 'active', { evidenceMode: 'strict', trackSubject: true });
    const sysPrompt = JSON.parse(seenPrompt)[0].messages[0].content;
    assert.match(sysPrompt, /"topic"/);
    assert.match(sysPrompt, /"quotes"/);

    const inspected = plain(await f.api.inspectScopeLenses());
    const item = inspected.memories.find(row => row.lensId === lens.lensId);
    assert.ok(item);
    assert.equal(item.topic, '은빛 열쇠 대여와 반환');
    assert.equal(item.quote, q1, 'primary quote stays populated for backward compatibility');
    assert.equal(item.quoteRef, 't2-a');
    assert.equal(item.quotes.length, 2, 'all verified quotes are retained');
    assert.deepEqual(Object.keys(item.extra || {}), [], 'topic and quotes stay structural, not extra');

    // Archive handoff validates multi-quote items and preserves excerpts for every quote turn
    await f.api.prepareSessionHandoff({ transferId: 'consolidation_multi_quote' });
    const target = f.target();
    const adopted = await f.api.adoptSessionHandoff({ transferId: 'consolidation_multi_quote', targetChatId: target.id });
    assert.equal(adopted.verified, true);
    const carried = plain(await f.api.inspectScopeLenses()).memories.find(row => row.lensId === lens.lensId);
    assert.equal(carried.inherited, true);
    assert.equal(carried.topic, '은빛 열쇠 대여와 반환');
    assert.equal(carried.quotes.length, 2);
    assert.ok(carried.sourceTurns['t2-a'].includes('오늘 돌려주겠다고 약속했다'));
    assert.ok(carried.sourceTurns['t5-a'].includes('이행되었다'));
  } finally {
    await f.close();
  }
});

test('intra-batch consolidation merges same-topic notes per person while keeping distinct threads apart', async () => {
  const f = await lensFixture();
  try {
    const batch = [
      { turn: 1, user: { text: src('t1-u') }, assistant: { text: src('t1-a') } },
      { turn: 2, user: { text: src('t2-u') }, assistant: { text: src('t2-a') } },
      { turn: 5, user: { text: src('t5-u') }, assistant: { text: src('t5-a') } }
    ];
    const consolidated = plain(f.api.evaluateLensCandidateItems({
      items: [
        {
          label: '소지품', topic: '은빛 열쇠 이동',
          text: '지호가 민아에게 은빛 열쇠를 빌렸다.',
          refs: ['t2-a'], quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고',
          who: ['지호'], whoRef: 't2-a'
        },
        {
          label: '소지품', topic: '은빛 열쇠 이동',
          text: '지호가 열쇠를 민아에게 돌려주었다.',
          refs: ['t5-a'], quote: '지호가 그것을 민아에게 돌려주었다',
          who: ['지호'], whoRef: 't5-a'
        },
        {
          label: '소지품', topic: '은빛 열쇠 이동',
          text: '민아는 열쇠의 원래 소유자였다.',
          refs: ['t2-a'], quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고',
          who: ['민아'], whoRef: 't2-a'
        }
      ]
    }, { evidenceMode: 'strict', trackSubject: true }, batch));

    assert.equal(consolidated.acceptedItems.length, 2, 'same person+topic merges (2 -> 1); different person stays separate');
    const jiho = consolidated.acceptedItems.find(i => i.who[0].name === '지호');
    assert.match(jiho.text, /빌렸다.*돌려주었다/);
    assert.deepEqual(jiho.refs, ['t2-a', 't5-a']);
    assert.equal(jiho.quotes.length, 2);

    // Without topic, distinct items in the same batch are never silently merged
    const withoutTopic = plain(f.api.evaluateLensCandidateItems({
      items: [
        { label: '메모', text: '첫째 메모입니다.', refs: ['t2-a'], quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고', who: ['지호'], whoRef: 't2-a' },
        { label: '메모', text: '둘째 메모입니다.', refs: ['t5-a'], quote: '지호가 그것을 민아에게 돌려주었다', who: ['지호'], whoRef: 't5-a' }
      ]
    }, { evidenceMode: 'strict', trackSubject: true }, batch));
    assert.equal(withoutTopic.acceptedItems.length, 2);
  } finally {
    await f.close();
  }
});

test('supersedes chain consolidates across batches without mutating history and rolls back on source edit', async () => {
  const f = await lensFixture();
  try {
    let reply = null;
    const prompts = [];
    f.setReply(args => {
      prompts.push(JSON.stringify(args));
      return JSON.stringify(reply);
    });
    const lens = await f.add('상태 추적', 'active', {
      trackSubject: true,
      cadence: { mode: 'manual' },
      recall: { role: 'relevant', maxItems: 3 }
    });
    await f.api.deleteLensMemories({ lensId: lens.lensId });

    // Span 1: T1-T2
    reply = {
      items: [{
        label: '이동', topic: '도서관 열쇠',
        text: '지호가 민아의 은빛 열쇠를 서재에서 빌렸다. 독특한 단어: 서재초기보관.',
        refs: ['t2-a'], quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고',
        who: ['지호'], whoRef: 't2-a'
      }]
    };
    await f.r.core.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 2 });

    // Span 2: T3-T4 supersedes Span 1's n1
    reply = {
      items: [{
        label: '이동', topic: '도서관 열쇠',
        text: '지호가 준호에게 열쇠 보관을 잠시 맡겼다.',
        refs: ['t3-u'], quote: '준호에게 잠시 열쇠를 들어 달라고 부탁했다',
        who: ['지호'], whoRef: 't3-u',
        supersedes: ['n1']
      }]
    };
    await f.r.core.runLensForRange(lens.lensId, { startTurn: 3, endTurn: 4 });
    assert.match(prompts.at(-1), /\[OPEN NOTES\][\s\S]*\[n1\] \(T1–T2 · 지호 · 이동 · 도서관 열쇠\)/);

    // Span 3: T5-T5 supersedes Span 2's head (OPEN NOTES should NOT list already-superseded T1-T2)
    reply = {
      items: [{
        label: '이동', topic: '도서관 열쇠',
        text: '지호가 준호에게서 열쇠를 받아 민아에게 돌려주었다.',
        refs: ['t5-a'], quote: '지호가 그것을 민아에게 돌려주었다',
        who: ['지호'], whoRef: 't5-a',
        supersedes: ['n1']
      }]
    };
    const r3 = await f.r.core.runLensForRange(lens.lensId, { startTurn: 5, endTurn: 5 });
    assert.equal(r3.run.counts.superseded, 1);
    const prompt3User = JSON.parse(prompts.at(-1))[0].messages[1].content;
    const openNotesSection = prompt3User.split('[OPEN NOTES]')[1].split('[SOURCE TURNS]')[0];
    assert.match(openNotesSection, /\[n1\] \(T3–T4 · 지호 · 이동 · 도서관 열쇠\)/);
    assert.doesNotMatch(openNotesSection, /T1–T2/, 'superseded earlier fragment is omitted from OPEN NOTES');

    // Stored historical records remain intact and unmutated
    const storeKey = [...f.r.values.keys()].find(k => k.endsWith(`:lens:${lens.lensId}:records`));
    const rawStore = JSON.parse(f.r.values.get(storeKey));
    assert.equal(rawStore.records['main:t1-t2'].items[0].supersedes, undefined);
    assert.equal(rawStore.records['main:t1-t2'].items[0].supersededBy, undefined);

    // inspectScopeLenses resolves chain cleanly at read time
    const inspected = plain(await f.api.inspectScopeLenses()).memories.filter(m => m.lensId === lens.lensId);
    const head = inspected.find(m => m.turnRange.start === 5);
    const mid = inspected.find(m => m.turnRange.start === 3);
    const first = inspected.find(m => m.turnRange.start === 1);
    assert.equal(head.supersededBy, null);
    assert.equal(head.supersedeHistory.length, 2);
    assert.deepEqual(head.supersedeHistory.map(h => h.turnRange.start), [1, 3], 'history is ordered oldest -> newest');
    assert.equal(mid.supersededBy.turn, 5);
    assert.equal(first.supersededBy.turn, 5);

    // Recall injects ONLY the consolidated head, includes 이전 흐름, skips superseded fragments,
    // and finds the head even when querying a term that only appeared in T1-T2 ("서재초기보관")!
    const recall = plain(await f.api.recallLensMemories({ query: '서재초기보관', canonicalBudgetChars: 12000 }));
    assert.equal(recall.injectedItems.length, 1, 'only consolidated head enters recall');
    assert.equal(recall.injectedItems[0].itemId, head.itemId);
    assert.match(recall.renderedBlock, /이전 흐름:/);
    assert.match(recall.renderedBlock, /도서관 열쇠/);
    assert.equal(recall.skippedCandidates.filter(s => s.reasonCode === 'superseded_by_newer_note').length, 2);

    // Editing T5 invalidates Span 3 -> Span 2 (T3-T4) automatically becomes active head with 1 history entry!
    const savedT5 = f.chat.message[9].data;
    f.chat.message[9].data = 'completely unrelated rewritten assistant response.';
    const afterEdit = plain(await f.api.inspectScopeLenses()).memories.filter(m => m.lensId === lens.lensId && m.sourceCurrent);
    const restoredHead = afterEdit.find(m => m.turnRange.start === 3);
    assert.ok(restoredHead);
    assert.equal(restoredHead.supersededBy, null);
    assert.equal(restoredHead.supersedeHistory.length, 1);
    assert.equal(restoredHead.supersedeHistory[0].turnRange.start, 1);

    const recallAfterEdit = plain(await f.api.recallLensMemories({ query: '서재초기보관', canonicalBudgetChars: 12000 }));
    assert.equal(recallAfterEdit.injectedItems.length, 1);
    assert.equal(recallAfterEdit.injectedItems[0].itemId, restoredHead.itemId);
    f.chat.message[9].data = savedT5;
  } finally {
    await f.close();
  }
});

test('lens viewer hides superseded intermediate fragments by default, renders history fold & multi-quotes, and supports toggling raw history', async t => {
  const dom = createViewerMockDom();
  const seam = '  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
  const h = await createLibraVmHarness({}, {}, {
    contextGlobals: dom,
    transformSource: raw => {
      const source = raw.replace(/\r\n/g, '\n');
      assert.ok(source.includes(seam));
      return source.replace(seam, '  globalThis.__lensConsolidationUi={Gui,injectGuiStyle,buildBookLensReaderProjection,lensReaderState};\n' + seam);
    }
  });
  t.after(() => h.cleanup());

  const ui = h.context.__lensConsolidationUi;
  const { document } = dom;
  ui.injectGuiStyle();

  const guiRoot = document.createElement('div');
  guiRoot.id = 'sga-rp-gui-root';
  const app = document.createElement('div');
  app.className = 'app t-libra';
  const main = document.createElement('div');
  main.className = 'main';
  const pageBody = document.createElement('div');
  pageBody.className = 'page-body';
  main.appendChild(pageBody);
  app.appendChild(main);
  guiRoot.appendChild(app);
  document.body.appendChild(guiRoot);

  ui.Gui.root = guiRoot;
  ui.Gui.app = app;
  ui.Gui.visible = true;
  ui.Gui.bookPage = 'memory';
  ui.Gui.bookMemoryKind = 'lens';
  ui.Gui.state = { runtime: { responseMode: { responseFamily: 'libra' } } };

  const reader = ui.lensReaderState();
  reader.loaded = true;
  reader.loading = false;
  reader.snapshotPairs = h.core.peekSnapshot()?.pairs;
  reader.snapshotStateKey = '';
  reader.data = {
    pairCount: 10,
    sourceTurns: { 't1-a': '손목에 통증이 시작했다.', 't6-a': '붕대를 감았다.', 't8-a': '부기가 가라앉기 시작했다.' },
    registry: { enabled: true, lenses: [{ lensId: 'lens_body', name: '몸 상태', status: 'active' }] },
    memories: [
      {
        id: 'm_old', itemId: 'li_old', recordId: 'r1', recordKey: 'rk1',
        lensId: 'lens_body', lensName: '몸 상태', label: '증상', topic: '왼손 손목 부상',
        text: '손목 통증이 시작되었다. 초기단서XYZ', quote: '손목에 통증이 시작했다', quoteRef: 't1-a',
        refs: ['t1-a'], evidenceLevel: 'quoted', sourceCurrent: true, whoTracked: true,
        turnRange: { start: 1, end: 5 }, people: [{ key: 'p_jiho', name: '지호', role: 'named' }],
        supersededBy: { byKey: 'r:rk2:li_head', turn: 8, itemId: 'li_head' }, supersedeHistory: []
      },
      {
        id: 'm_head', itemId: 'li_head', recordId: 'r2', recordKey: 'rk2',
        lensId: 'lens_body', lensName: '몸 상태', label: '회복', topic: '왼손 손목 부상',
        text: '지호의 왼손 손목 부기가 가라앉고 있다.',
        quote: '붕대를 감았다', quoteRef: 't6-a',
        quotes: [
          { ref: 't6-a', quote: '붕대를 감았다' },
          { ref: 't8-a', quote: '부기가 가라앉기 시작했다' }
        ],
        refs: ['t6-a', 't8-a'], evidenceLevel: 'quoted', sourceCurrent: true, whoTracked: true,
        turnRange: { start: 6, end: 10 }, people: [{ key: 'p_jiho', name: '지호', role: 'named' }],
        supersededBy: null,
        supersedeHistory: [{
          itemId: 'li_old', recordKey: 'rk1', turnRange: { start: 1, end: 5 },
          label: '증상', topic: '왼손 손목 부상', text: '손목 통증이 시작되었다. 초기단서XYZ'
        }]
      }
    ]
  };

  const mounted = ui.buildBookLensReaderProjection();
  mounted.id = 'memory-root';
  pageBody.appendChild(mounted);

  // Superseded card is hidden by default -> only head card renders
  assert.equal(pageBody.querySelectorAll('.lens-item').length, 1);
  const headCard = pageBody.querySelector('.lens-item');
  assert.equal(headCard.querySelector('[data-lens-topic="true"]').textContent, '왼손 손목 부상');
  assert.equal(headCard.querySelector('[data-lens-multi-quotes="2"]').querySelectorAll('blockquote').length, 2);
  const historyFold = headCard.querySelector('[data-lens-history="true"]');
  assert.ok(historyFold, 'consolidated card shows previous flow fold');
  assert.match(historyFold.querySelector('summary').textContent, /이전 흐름 1건 보기/);
  assert.match(historyFold.textContent, /손목 통증이 시작되었다/);

  // Clicking toggle button shows superseded intermediate card
  const toggleBtn = pageBody.querySelector('[data-lens-toggle-superseded="true"]');
  assert.ok(toggleBtn);
  assert.match(toggleBtn.textContent, /갱신 전 기록 1건 보기/);
  toggleBtn.click();
  assert.equal(reader.showSuperseded, true);
  assert.equal(pageBody.querySelectorAll('.lens-item').length, 2);
  assert.match(pageBody.textContent, /이후 갱신됨 · T8 · 최신 카드에 통합/);

  // Toggle back hides superseded card, and search still matches history text
  pageBody.querySelector('[data-lens-toggle-superseded="true"]').click();
  assert.equal(pageBody.querySelectorAll('.lens-item').length, 1);
  reader.query = '초기단서XYZ';
  pageBody.replaceChildren(ui.buildBookLensReaderProjection());
  assert.equal(pageBody.querySelectorAll('.lens-item').length, 1, 'search matches consolidated history step');
});
