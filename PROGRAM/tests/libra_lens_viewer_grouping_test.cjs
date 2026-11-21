'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const createMockDom = () => {
  const rafCallbacks = [];
  const docListeners = new Map();
  let nextRafId = 1;
  const toCamel = attr => attr.slice(5).replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
  const toKebab = key => `data-${String(key).replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;

  const parseCompound = raw => {
    let s = raw.trim();
    const parts = { tag: '', id: '', classes: [], attrs: [] };
    if (!s) return parts;
    const tagMatch = s.match(/^[a-zA-Z0-9_-]+/);
    if (tagMatch) {
      parts.tag = tagMatch[0].toLowerCase();
      s = s.slice(tagMatch[0].length);
    }
    while (s.length) {
      if (s[0] === '#') {
        const m = s.slice(1).match(/^[a-zA-Z0-9_-]+/);
        parts.id = m ? m[0] : '';
        s = s.slice(1 + parts.id.length);
      } else if (s[0] === '.') {
        const m = s.slice(1).match(/^[a-zA-Z0-9_-]+/);
        if (!m) break;
        parts.classes.push(m[0]);
        s = s.slice(1 + m[0].length);
      } else if (s[0] === '[') {
        const close = s.indexOf(']');
        if (close < 0) break;
        const inner = s.slice(1, close).trim();
        const eq = inner.indexOf('=');
        if (eq < 0) {
          parts.attrs.push({ name: inner.toLowerCase(), op: 'exists', value: '' });
        } else {
          let name = inner.slice(0, eq).trim().toLowerCase();
          let op = '=';
          if (name.endsWith('^') || name.endsWith('$') || name.endsWith('*')) {
            op = `${name.slice(-1)}=`;
            name = name.slice(0, -1).trim();
          }
          let val = inner.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          parts.attrs.push({ name, op, value: val });
        }
        s = s.slice(close + 1);
      } else {
        break;
      }
    }
    return parts;
  };

  const getAttrValue = (el, attrName) => {
    if (!el || el.nodeType !== 1) return null;
    if (attrName === 'id') return el.id || null;
    if (attrName === 'class') return el.className || null;
    if (attrName.startsWith('data-')) {
      const camel = toCamel(attrName);
      if (el.dataset && Object.prototype.hasOwnProperty.call(el.dataset, camel)) {
        const v = el.dataset[camel];
        return v === undefined ? null : String(v);
      }
    }
    return el._attrs.has(attrName) ? el._attrs.get(attrName) : null;
  };

  const matchesCompound = (el, compound) => {
    if (!el || el.nodeType !== 1) return false;
    if (compound.tag && el.tagName.toLowerCase() !== compound.tag) return false;
    if (compound.id && el.id !== compound.id) return false;
    if (compound.classes.length) {
      const clsSet = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      for (const c of compound.classes) if (!clsSet.has(c)) return false;
    }
    for (const a of compound.attrs) {
      const val = getAttrValue(el, a.name);
      if (a.op === 'exists') {
        if (val == null) return false;
      } else if (a.op === '=') {
        if (val !== a.value) return false;
      } else if (a.op === '^=') {
        if (val == null || !val.startsWith(a.value)) return false;
      } else if (a.op === '$=') {
        if (val == null || !val.endsWith(a.value)) return false;
      } else if (a.op === '*=') {
        if (val == null || !val.includes(a.value)) return false;
      }
    }
    return true;
  };

  const tokenizeComplex = sel => {
    const tokens = [];
    let i = 0;
    const len = sel.length;
    while (i < len) {
      while (i < len && /\s/.test(sel[i])) i += 1;
      if (i >= len) break;
      if (sel[i] === '>') {
        tokens.push({ comb: '>' });
        i += 1;
        continue;
      }
      let start = i;
      let inBracket = false;
      while (i < len && (inBracket || (!/\s/.test(sel[i]) && sel[i] !== '>'))) {
        if (sel[i] === '[') inBracket = true;
        else if (sel[i] === ']') inBracket = false;
        i += 1;
      }
      if (tokens.length && !tokens[tokens.length - 1].comb) tokens.push({ comb: ' ' });
      tokens.push({ compound: parseCompound(sel.slice(start, i)) });
    }
    return tokens;
  };

  const matchesSingleSelector = (el, tokens) => {
    if (!tokens.length || !el || el.nodeType !== 1) return false;
    const last = tokens[tokens.length - 1];
    if (!last.compound || !matchesCompound(el, last.compound)) return false;
    let cur = el;
    for (let idx = tokens.length - 2; idx >= 0; idx -= 2) {
      const comb = tokens[idx].comb;
      const prevCompound = tokens[idx - 1]?.compound;
      if (!prevCompound) return false;
      if (comb === '>') {
        cur = cur.parentNode;
        if (!cur || !matchesCompound(cur, prevCompound)) return false;
      } else {
        let p = cur.parentNode;
        let ok = false;
        while (p && p.nodeType === 1) {
          if (matchesCompound(p, prevCompound)) { ok = true; cur = p; break; }
          p = p.parentNode;
        }
        if (!ok) return false;
      }
    }
    return true;
  };

  const matchesSelectorList = (el, selector) => {
    const parts = String(selector || '').split(',').map(s => s.trim()).filter(Boolean);
    return parts.some(part => matchesSingleSelector(el, tokenizeComplex(part)));
  };

  class MockTextNode {
    constructor(text) {
      this.nodeType = 3;
      this.parentNode = null;
      this._text = String(text ?? '');
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v ?? ''); }
  }

  class MockElement {
    constructor(tagName) {
      this.nodeType = 1;
      this.tagName = String(tagName).toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this._attrs = new Map();
      this.style = {};
      this.dataset = {};
      this._listeners = new Map();
      this.id = '';
      this.className = '';
      this.disabled = false;
      this.checked = false;
      this.selected = false;
      this.value = '';
      this.scrollTop = 0;
      this.scrollLeft = 0;
    }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get children() { return this.childNodes.filter(c => c.nodeType === 1); }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.documentElement) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get open() { return this._attrs.has('open'); }
    set open(v) {
      if (v) this._attrs.set('open', '');
      else this._attrs.delete('open');
    }
    get textContent() {
      return this.childNodes.map(c => c.textContent).join('');
    }
    set textContent(v) {
      this.childNodes = [];
      const s = String(v ?? '');
      if (s.length) this.appendChild(new MockTextNode(s));
    }
    setAttribute(k, v) {
      const name = String(k).toLowerCase();
      const str = String(v ?? '');
      this._attrs.set(name, str);
      if (name === 'id') this.id = str;
      else if (name === 'class') this.className = str;
      else if (name.startsWith('data-')) this.dataset[toCamel(name)] = str;
    }
    getAttribute(k) {
      const name = String(k).toLowerCase();
      if (name === 'id') return this.id || null;
      if (name === 'class') return this.className || null;
      if (name.startsWith('data-')) {
        const camel = toCamel(name);
        if (Object.prototype.hasOwnProperty.call(this.dataset, camel)) return String(this.dataset[camel]);
      }
      return this._attrs.has(name) ? this._attrs.get(name) : null;
    }
    removeAttribute(k) {
      const name = String(k).toLowerCase();
      this._attrs.delete(name);
      if (name === 'id') this.id = '';
      else if (name === 'class') this.className = '';
      else if (name.startsWith('data-')) delete this.dataset[toCamel(name)];
    }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(typeof n === 'string' ? new MockTextNode(n) : n);
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) { this.childNodes.splice(idx, 1); child.parentNode = null; }
      return child;
    }
    remove() {
      if (this.parentNode && typeof this.parentNode.removeChild === 'function') this.parentNode.removeChild(this);
    }
    replaceChildren(...nodes) {
      for (const old of [...this.childNodes]) old.parentNode = null;
      this.childNodes = [];
      for (const n of nodes) if (n) this.appendChild(n);
    }
    replaceWith(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      const idx = parent.childNodes.indexOf(this);
      if (idx < 0) return;
      this.parentNode = null;
      const inserted = nodes.filter(Boolean).map(n => {
        if (n.parentNode && typeof n.parentNode.removeChild === 'function') n.parentNode.removeChild(n);
        n.parentNode = parent;
        return n;
      });
      parent.childNodes.splice(idx, 1, ...inserted);
    }
    addEventListener(type, fn) {
      const key = String(type).toLowerCase();
      if (!this._listeners.has(key)) this._listeners.set(key, []);
      this._listeners.get(key).push(fn);
    }
    removeEventListener(type, fn) {
      const key = String(type).toLowerCase();
      const arr = this._listeners.get(key);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
    dispatchEvent(event) {
      const ev = event && typeof event === 'object' ? event : { type: String(event) };
      const type = String(ev.type || '').toLowerCase();
      if (!ev.target) ev.target = this;
      let defaultPrevented = false;
      ev.preventDefault = () => { defaultPrevented = true; };
      let stopped = false;
      ev.stopPropagation = () => { stopped = true; };
      let cur = this;
      while (cur) {
        ev.currentTarget = cur;
        for (const fn of [...(cur._listeners?.get(type) || [])]) fn.call(cur, ev);
        if (stopped || ev.bubbles === false) break;
        cur = cur.parentNode;
      }
      return !defaultPrevented;
    }
    click() {
      const notPrevented = this.dispatchEvent({ type: 'click', bubbles: true });
      if (notPrevented && this.tagName === 'SUMMARY' && this.parentNode?.tagName === 'DETAILS') {
        const det = this.parentNode;
        det.open = !det.open;
        det.dispatchEvent({ type: 'toggle', bubbles: false });
      }
    }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = node => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1) {
            if (matchesSelectorList(child, selector)) out.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) {
      const walk = node => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1) {
            if (matchesSelectorList(child, selector)) return child;
            const found = walk(child);
            if (found) return found;
          }
        }
        return null;
      };
      return walk(this);
    }
    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (matchesSelectorList(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    get classList() {
      const self = this;
      return {
        contains: cls => String(self.className || '').split(/\s+/).includes(cls),
        toggle(cls, force) {
          const list = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
          const has = list.has(cls);
          const next = force === undefined ? !has : Boolean(force);
          if (next) list.add(cls);
          else list.delete(cls);
          self.className = [...list].join(' ');
          return next;
        },
        add: (...clss) => {
          const list = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
          for (const c of clss) list.add(c);
          self.className = [...list].join(' ');
        },
        remove: (...clss) => {
          const list = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
          for (const c of clss) list.delete(c);
          self.className = [...list].join(' ');
        }
      };
    }
    toKebabDataset(k) { return toKebab(k); }
  }

  const doc = {
    documentElement: new MockElement('html'),
    head: new MockElement('head'),
    body: new MockElement('body'),
    readyState: 'complete',
    activeElement: null,
    createElement: tag => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: text => new MockTextNode(text),
    getElementById: id => doc.documentElement.querySelector(`#${id}`),
    querySelector: sel => doc.documentElement.querySelector(sel),
    querySelectorAll: sel => doc.documentElement.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };
  doc.scrollingElement = doc.documentElement;
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;

  const requestAnimationFrame = cb => {
    const id = nextRafId++;
    rafCallbacks.push({ id, cb });
    return id;
  };
  const cancelAnimationFrame = id => {
    const idx = rafCallbacks.findIndex(item => item.id === id);
    if (idx >= 0) rafCallbacks.splice(idx, 1);
  };
  const flushRaf = () => {
    const list = rafCallbacks.splice(0, rafCallbacks.length);
    for (const item of list) item.cb(Date.now());
  };

  return {
    document: doc,
    window: { scrollTo() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame,
    cancelAnimationFrame,
    flushRaf
  };
};

test('groupLensMemoriesForReader groups by lens -> primary person -> turn range without duplication', async t => {
  const seam = '  const groupLensMemoriesForReader = ';
  const h = await createLibraVmHarness({}, {}, {
    transformSource: raw => {
      const source = raw.replace(/\r\n/g, '\n');
      assert.ok(source.includes(seam));
      return source.replace(seam, '  globalThis.__groupLensMemoriesForReader = (...args) => groupLensMemoriesForReader(...args);\n' + seam);
    }
  });
  t.after(() => h.cleanup());

  const groupFn = (...args) => JSON.parse(JSON.stringify(h.context.__groupLensMemoriesForReader(...args)));
  const lenses = [
    { lensId: 'lens_rel', name: '관계 변화' },
    { lensId: 'lens_sec', name: '비밀' }
  ];
  const items = [
    {
      itemId: 'i1', lensId: 'lens_sec', lensName: '비밀', whoTracked: true,
      turnRange: { start: 1, end: 5 },
      people: [{ key: 'p_user', name: '푸딩', role: 'user' }, { key: 'p_hayeon', name: '천하연', role: 'named' }]
    },
    {
      itemId: 'i2', lensId: 'lens_rel', lensName: '관계 변화', whoTracked: true,
      turnRange: { start: 11, end: 15 },
      people: [{ key: 'p_user', name: '푸딩', role: 'user' }, { key: 'p_soyeon', name: '천소연', role: 'named' }]
    },
    {
      itemId: 'i3', lensId: 'lens_rel', lensName: '관계 변화', whoTracked: true,
      turnRange: { start: 1, end: 5 },
      people: [{ key: 'p_soyeon', name: '천소연', role: 'named' }]
    },
    {
      itemId: 'i4', lensId: 'lens_rel', lensName: '관계 변화', whoTracked: true,
      turnRange: { start: 6, end: 10 },
      people: []
    },
    {
      itemId: 'i5', lensId: 'lens_rel', lensName: '관계 변화', whoTracked: false,
      turnRange: { start: 6, end: 10 },
      people: []
    }
  ];

  const desc = groupFn(items, { lenses, filterPerson: 'all', turnOrder: 'desc' });
  assert.deepEqual(desc.map(g => g.lensId), ['lens_rel', 'lens_sec'], 'follows registry lens order');
  const rel = desc[0];
  assert.equal(rel.count, 4);
  assert.deepEqual(
    rel.personGroups.map(pg => ({ key: pg.key, name: pg.name, count: pg.count })),
    [
      { key: 'p_soyeon', name: '천소연', count: 2 },
      { key: '__unassigned__', name: '인물 미지정', count: 1 },
      { key: 'unknown', name: '인물 불명', count: 1 }
    ]
  );
  assert.deepEqual(rel.personGroups[0].spanGroups.map(s => s.label), ['T11–T15', 'T1–T5']);
  assert.equal(rel.personGroups[0].rangeLabel, 'T1–T15');

  const sec = desc[1];
  assert.equal(sec.personGroups.length, 1);
  assert.equal(sec.personGroups[0].key, 'p_hayeon');
  assert.equal(sec.personGroups[0].name, '천하연');

  const asc = groupFn(items, { lenses, filterPerson: 'all', turnOrder: 'asc' });
  assert.deepEqual(asc[0].personGroups[0].spanGroups.map(s => s.label), ['T1–T5', 'T11–T15']);

  const userFiltered = groupFn(items, { lenses, filterPerson: 'p_user', turnOrder: 'desc' });
  assert.equal(userFiltered[0].personGroups[0].key, 'p_user');
  assert.equal(userFiltered[0].personGroups[0].count, 1);

  const totalInGroups = desc.reduce(
    (sum, lg) => sum + lg.personGroups.reduce(
      (pSum, pg) => pSum + pg.spanGroups.reduce((sSum, sg) => sSum + sg.items.length, 0),
      0
    ),
    0
  );
  assert.equal(totalInGroups, items.length);
});

test('lens viewer refreshes stale CSS, skips managed disclosures on restore, expands/collapses in-place with lazy hydration, and preserves scroll/input', async t => {
  const dom = createMockDom();
  const seam = '  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
  const h = await createLibraVmHarness({}, {}, {
    contextGlobals: {
      document: dom.document,
      window: dom.window,
      MutationObserver: dom.MutationObserver,
      requestAnimationFrame: dom.requestAnimationFrame,
      cancelAnimationFrame: dom.cancelAnimationFrame
    },
    transformSource: raw => {
      const source = raw.replace(/\r\n/g, '\n');
      assert.ok(source.includes(seam));
      return source.replace(
        seam,
        '  globalThis.__lensPerfUi={Gui,injectGuiStyle,captureGuiViewportState,restoreGuiViewportState,buildBookLensReaderProjection,rerenderLensReaderInPlace,lensReaderState,queueGuiNavigationRender};\n' + seam
      );
    }
  });
  t.after(() => h.cleanup());

  const ui = h.context.__lensPerfUi;
  const { document, flushRaf } = dom;

  // 1) injectGuiStyle() updates stale #sga-rp-gui-style and avoids redundant rewrites when sig matches
  const staleStyle = document.createElement('style');
  staleStyle.id = 'sga-rp-gui-style';
  staleStyle.textContent = '/* stale css */';
  document.head.appendChild(staleStyle);

  let writeCount = 0;
  let innerTextVal = staleStyle.textContent;
  Object.defineProperty(staleStyle, 'textContent', {
    get: () => innerTextVal,
    set: v => { writeCount += 1; innerTextVal = String(v); }
  });

  ui.injectGuiStyle();
  assert.equal(writeCount, 1, 'stale style element is refreshed once');
  assert.ok(staleStyle.dataset.libraStyleSig, 'style signature is stored');
  assert.match(staleStyle.textContent, /\.lens-item__head-right\{/);
  assert.match(staleStyle.textContent, /\.lens-item--compact \.lens-item__head-right \.btn--sm\{/);
  assert.match(staleStyle.textContent, /\.lens-group-span\{[^}]*content-visibility:auto/);
  assert.match(staleStyle.textContent, /\.lens-item:not\(\.lens-item--compact\)\{content-visibility:auto/);
  assert.match(staleStyle.textContent, /\.lens-group-person\[open\]>\.lens-group-person__summary \.lens-group-person__chev/);
  const personRule = staleStyle.textContent.match(/\.lens-group-person\{([^}]*)\}/)?.[1] || '';
  const spanRule = staleStyle.textContent.match(/\.lens-group-span\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(personRule, /overflow\s*:\s*hidden/, '.lens-group-person avoids overflow:hidden clipping lag');
  assert.doesNotMatch(spanRule, /overflow\s*:\s*hidden/, '.lens-group-span avoids overflow:hidden clipping lag');

  ui.injectGuiStyle();
  assert.equal(writeCount, 1, 'identical signature skips redundant style textContent rewrite');

  // Mount GUI shell for lens reader + viewport state tests
  const guiRoot = document.createElement('div');
  guiRoot.id = 'sga-rp-gui-root';
  const app = document.createElement('div');
  app.className = 'app t-libra';
  const main = document.createElement('div');
  main.className = 'main';
  const pageBody = document.createElement('div');
  pageBody.className = 'page-body';
  pageBody.dataset.guiViewKey = 'memory|read|lens';
  main.appendChild(pageBody);
  app.appendChild(main);
  guiRoot.appendChild(app);
  document.body.appendChild(guiRoot);

  ui.Gui.root = guiRoot;
  ui.Gui.app = app;
  ui.Gui.visible = true;
  ui.Gui.activeTab = 'memory';
  ui.Gui.bookPage = 'memory';
  ui.Gui.memoryHubSection = 'read';
  ui.Gui.bookMemoryKind = 'lens';
  ui.Gui.state = { runtime: { responseMode: { responseFamily: 'libra' } } };

  const reader = ui.lensReaderState();
  reader.loaded = true;
  reader.loading = false;
  reader.snapshotPairs = h.core.peekSnapshot()?.pairs;
  reader.snapshotStateKey = '';
  reader.data = {
    pairCount: 15,
    sourceTurns: { 't1-a': '소연은 비밀 열쇠를 숨겼다.', 't6-a': '하연이 문을 열었다.' },
    registry: {
      enabled: true,
      lenses: [{ lensId: 'lens_rel', name: '관계 변화', status: 'active' }]
    },
    memories: [
      {
        id: 'm1', itemId: 'i1', recordId: 'r1', recordKey: 'rk1',
        lensId: 'lens_rel', lensName: '관계 변화', label: '신뢰',
        text: '소연이 비밀을 털어놓았다.', quote: '비밀 열쇠를 숨겼다', quoteRef: 't1-a',
        refs: ['t1-a'], evidenceLevel: 'quoted', sourceCurrent: true, whoTracked: true,
        turnRange: { start: 1, end: 5 },
        people: [{ key: 'p_soyeon', name: '천소연', role: 'named' }]
      },
      {
        id: 'm2', itemId: 'i2', recordId: 'r2', recordKey: 'rk2',
        lensId: 'lens_rel', lensName: '관계 변화', label: '접촉',
        text: '하연이 방문을 두드렸다.', quote: '문을 열었다', quoteRef: 't6-a',
        refs: ['t6-a'], evidenceLevel: 'quoted', sourceCurrent: true, whoTracked: true,
        turnRange: { start: 6, end: 10 },
        people: [{ key: 'p_hayeon', name: '천하연', role: 'named' }]
      }
    ]
  };

  const unmanagedFold = document.createElement('details');
  unmanagedFold.open = true;
  const unmanagedSummary = document.createElement('summary');
  unmanagedSummary.textContent = '기타 접힘';
  unmanagedFold.appendChild(unmanagedSummary);
  pageBody.appendChild(unmanagedFold);

  const mountedReader = ui.buildBookLensReaderProjection();
  mountedReader.id = 'memory-root';
  mountedReader.dataset.productReadback = 'lens-memory-reader';
  mountedReader.setAttribute('role', 'tabpanel');
  mountedReader.setAttribute('aria-label', '렌즈 기억');
  pageBody.appendChild(mountedReader);

  const personDetails = () => [...pageBody.querySelectorAll('details.lens-group-person')];
  assert.equal(personDetails().length, 2);
  assert.ok(personDetails().every(d => d.open === true), 'all person groups start open');
  assert.ok(personDetails().every(d => d.dataset.guiManagedDisclosure === 'true'));
  const provFolds = pageBody.querySelectorAll('details.lens-prov');
  assert.equal(provFolds.length, 2);
  assert.ok(provFolds.every(d => d.dataset.guiManagedDisclosure === 'true'));

  const firstCard = pageBody.querySelector('.lens-item');
  const headRight = firstCard.querySelector('.lens-item__head > .lens-item__head-right');
  assert.ok(headRight, 'card header has right-side container');
  assert.deepEqual(headRight.children.map(n => n.textContent), ['수정', '재분석', '인용 확인']);
  assert.equal(headRight.children[0].dataset.lensItemEdit, 'true');
  assert.equal(headRight.children[1].dataset.lensItemReanalysis, 'true');
  const foot = firstCard.querySelector('.lens-item__foot');
  assert.ok(foot, 'card footer still holds delete action');
  assert.equal(foot.querySelector('[data-lens-item-edit]'), null);
  assert.equal(foot.querySelector('[data-lens-item-reanalysis]'), null);
  assert.deepEqual(foot.querySelectorAll('button').map(b => b.textContent), ['삭제']);

  // 2) Capture state while open, then collapse-all and run restoreGuiViewportState() + rAF flush:
  // unmanagedFold is restored, managed lens disclosures must NOT be reverted!
  const captured = ui.captureGuiViewportState();
  unmanagedFold.open = false;

  const collapseBtn = pageBody.querySelector('[data-lens-collapse-all="true"]');
  collapseBtn.click();
  assert.ok(personDetails().every(d => d.open === false), 'collapse-all closes every person group synchronously in-place');
  assert.equal(reader.collapsedGroups.size, 2, 'collapsedGroups tracks all collapsed group keys');

  ui.restoreGuiViewportState(captured);
  flushRaf();
  assert.equal(unmanagedFold.open, true, 'unmanaged disclosures still restore normally');
  assert.ok(personDetails().every(d => d.open === false), 'restoreGuiViewportState does not undo collapse-all');

  // 3) Expand-all reopens in-place and clears collapsedGroups
  const expandBtn = pageBody.querySelector('[data-lens-expand-all="true"]');
  expandBtn.click();
  assert.ok(personDetails().every(d => d.open === true), 'expand-all reopens every person group');
  assert.equal(reader.collapsedGroups.size, 0, 'collapsedGroups clears on expand-all');

  // 4) Lazy hydration for collapsed person groups on re-render
  pageBody.querySelector('[data-lens-collapse-all="true"]').click();
  pageBody.scrollTop = 240;
  pageBody.querySelector('[data-lens-turn-order="true"]').click(); // synchronous rerenderLensReaderInPlace()

  const reRenderedReader = pageBody.querySelector('[data-lens-reader="true"]');
  assert.equal(reRenderedReader.id, 'memory-root', 'rerenderLensReaderInPlace preserves #memory-root');
  assert.equal(reRenderedReader.dataset.productReadback, 'lens-memory-reader');
  assert.equal(reRenderedReader.getAttribute('role'), 'tabpanel');
  assert.equal(reRenderedReader.getAttribute('aria-label'), '렌즈 기억');
  assert.equal(pageBody.scrollTop, 240, 'rerenderLensReaderInPlace preserves .page-body scrollTop');

  const closedBodies = [...pageBody.querySelectorAll('.lens-group-person__body')];
  assert.equal(closedBodies.length, 2);
  assert.ok(closedBodies.every(b => b.childNodes.length === 0), 'collapsed groups skip building heavy DOM until opened');

  // Opening one group via summary click hydrates its body immediately
  const firstPerson = pageBody.querySelector('details.lens-group-person');
  const firstSummary = firstPerson.querySelector('.lens-group-person__summary');
  firstSummary.click();
  assert.equal(firstPerson.open, true);
  assert.ok(firstPerson.querySelectorAll('.lens-item').length >= 1, 'summary click hydrates collapsed person group');
  const secondPerson = personDetails()[1];
  assert.equal(secondPerson.querySelector('.lens-group-person__body').childNodes.length, 0, 'sibling group remains unhydrated');

  // Expand-all hydrates remaining collapsed sibling group and opens it
  pageBody.querySelector('[data-lens-expand-all="true"]').click();
  assert.ok(secondPerson.open === true && secondPerson.querySelectorAll('.lens-item').length >= 1, 'expand-all hydrates collapsed sibling groups');

  // 5) Debounced search input uses detailOnly in-place swap, keeps input node identity & scrollTop
  const searchInput = pageBody.querySelector('input[type="search"]');
  assert.ok(searchInput);
  pageBody.scrollTop = 180;
  searchInput.value = '비밀';
  searchInput.dispatchEvent({ type: 'input', target: searchInput });
  await new Promise(resolve => setTimeout(resolve, 140));

  assert.equal(pageBody.querySelector('input[type="search"]'), searchInput, 'search keeps the same input element in rail');
  assert.equal(pageBody.scrollTop, 180, 'debounced search preserves scrollTop');
  const visibleTexts = [...pageBody.querySelectorAll('.lens-item__text')].map(n => n.textContent);
  assert.deepEqual(visibleTexts, ['소연이 비밀을 털어놓았다.']);
});
