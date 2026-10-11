/* Librarian Suite GUI — 시안용 공용 동작 (프레임워크 없음, 제품 코드가 아님)
   제품 이식 시에는 같은 data-* 계약을 guiEl()/replaceChildren 기반으로 옮기면 된다. */
(function () {
  'use strict';
  var ICONS = {
    home:'<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z"/>',
    grid:'<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    book:'<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 8h6M9 11.5h6"/>',
    shelf:'<path d="M5 4h3v16H5zM10 4h3v16h-3z"/><path d="m15.2 5.2 2.8-.8 3.2 14.6-2.8.8z"/>',
    user:'<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.6-3.7 3.4-5.6 7-5.6s6.4 1.9 7 5.6"/>',
    users:'<circle cx="9" cy="8.5" r="3.2"/><circle cx="17" cy="9.5" r="2.5"/><path d="M3 19c.5-3.3 3-5 6-5s5.5 1.7 6 5M16 14.2c2.6 0 4.5 1.4 5 4.3"/>',
    globe:'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.5 3.8 5.3 3.8 8.5S14.6 18 12 20.5C9.4 18 8.2 15.2 8.2 12S9.4 6 12 3.5z"/>',
    timeline:'<path d="M5 6h9M5 12h14M5 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="9" cy="18" r="2"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.4a7 7 0 0 0-2.2 1.3l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.4a7 7 0 0 0 2.2-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z"/>',
    sliders:'<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    check:'<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert:'<path d="M12 8v5M12 16.6v.1"/><path d="M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/>',
    info:'<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
    x:'<path d="m6 6 12 12M18 6 6 18"/>',
    more:'<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
    refresh:'<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    search:'<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
    save:'<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
    db:'<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
    server:'<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7.5 7.2v.1M7.5 16.8v.1"/>',
    link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    shield:'<path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.3 7 9 4.1-1.7 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
    bolt:'<path d="M13 3 5 13.5h6L10 21l9-11h-6z"/>',
    film:'<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4"/>',
    clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    wrench:'<path d="M14.5 6.5a4 4 0 0 0 4.9 5L21 9.8 18 7l1.5-1.5a4 4 0 0 0-5 1z"/><path d="m13.5 12.5-8 8-2-2 8-8"/>',
    spark:'<path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
    layers:'<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
    pen:'<path d="m15 5 4 4M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z"/>',
    image:'<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17 5-4.5 3.5 3L16 12l4.5 5"/>',
    sync:'<path d="M19 8a7.5 7.5 0 0 0-13-1.5L4 9m0-4.5V9h4.5M5 16a7.5 7.5 0 0 0 13 1.5L20 15m0 4.5V15h-4.5"/>',
    chat:'<path d="M4 5h16v11H9.5L4.5 20z"/><path d="M8 9h8M8 12.5h5"/>',
    arrow:'<path d="m9 5 7 7-7 7"/>',
    back:'<path d="m15 5-7 7 7 7"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    trash:'<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7"/>',
    download:'<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>',
    upload:'<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 20h14"/>',
    route:'<circle cx="6" cy="17" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M8.2 17H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>',
    pin:'<path d="m14 4 6 6-3 1-4 4-1 4-2.5-2.5L5 20l3.5-3.5L6 14l4-1 4-4z"/>',
    log:'<path d="M6 4h12v16H6z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
    cpu:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 3.5v2.5M14.5 3.5v2.5M9.5 18v2.5M14.5 18v2.5M3.5 9.5H6M3.5 14.5H6M18 9.5h2.5M18 14.5h2.5"/>',
    flag:'<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',
    eye:'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    lock:'<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    bookmark:'<path d="M7 4h10v16l-5-3.5L7 20z"/>',
    lamp:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.7.6 1 1.3 1 2.1h5c0-.8.3-1.5 1-2.1A6 6 0 0 0 12 3z"/>'
  };
  function sprite() {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">';
    Object.keys(ICONS).forEach(function (k) { s += '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + '</symbol>'; });
    document.body.insertAdjacentHTML('afterbegin', s + '</svg>');
  }
  function hydrateIcons(root) {
    (root || document).querySelectorAll('i[data-i]').forEach(function (el) {
      var cls = 'ic' + (el.dataset.size ? ' ic--' + el.dataset.size : '');
      el.outerHTML = '<svg class="' + cls + '" aria-hidden="true"><use href="#i-' + el.dataset.i + '"/></svg>';
    });
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---- 토스트 ---- */
  function toast(msg) {
    var box = $('.toasts'); if (!box) return;
    msg = String(msg).replace(/\{(\w+)\}/g, function (m, k) { return lastCtx && lastCtx[k] !== undefined ? lastCtx[k] : m; });
    var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status');
    t.innerHTML = '<svg class="ic ic--sm"><use href="#i-check"/></svg><span></span>'; t.lastChild.textContent = msg;
    box.appendChild(t); setTimeout(function () { t.remove(); }, 3200);
  }
  window.suiteToast = toast;

  /* ---- 페이지 전환 (사이드바 / 하단 탭바 공용) ---- */
  function goPage(id, opts) {
    var pages = $$('.page'); var found = false;
    pages.forEach(function (p) { var on = p.dataset.page === id; p.classList.toggle('is-active', on); if (on) { found = true; if (opts && opts.ctx) { lastCtx = opts.ctx; fillCtx(p, opts.ctx); document.dispatchEvent(new CustomEvent('suite:ctx', { detail: { page: id, ctx: opts.ctx } })); } } });
    if (!found) return;
    $$('[data-go]').forEach(function (b) {
      if (!(b.classList.contains('nav-item') || b.closest('.tabbar'))) return;
      if (b.dataset.go === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    var body = $('.page-body'); if (body) body.scrollTop = 0;
    if (!opts || !opts.silent) { try { history.replaceState(null, '', '#' + id); } catch (e) {} }
    document.dispatchEvent(new CustomEvent('suite:page', { detail: id }));
  }
  window.suiteGo = goPage; window.suiteFill = function (root, ctx) { fillCtx(root, ctx); };

  /* 사이드바 항목으로부터 모바일 탭바를 자동 구성 (최대 4 + 더보기) */
  function buildTabbar() {
    var bar = $('.tabbar'); if (!bar) return;
    var items = $$('.sidebar .nav-item[data-go]');
    var primary = items.filter(function (b) { return b.dataset.tab !== 'top'; });
    var cap = primary.length > 5 ? 4 : primary.length;
    var html = '';
    primary.slice(0, cap).forEach(function (b) {
      var icon = b.querySelector('use') ? b.querySelector('use').getAttribute('href') : '#i-grid';
      html += '<button type="button" data-go="' + b.dataset.go + '"><svg class="ic"><use href="' + icon + '"/></svg>' + (b.dataset.short || b.querySelector('.nav-text').textContent) + '</button>';
    });
    if (primary.length > cap) html += '<button type="button" data-more="1"><svg class="ic"><use href="#i-more"/></svg>더보기</button>';
    bar.innerHTML = html;
    var sheet = $('#sheet-more');
    if (sheet && primary.length > cap) {
      var list = '';
      primary.slice(cap).forEach(function (b) {
        var icon = b.querySelector('use').getAttribute('href');
        list += '<button type="button" class="row" data-go="' + b.dataset.go + '" data-close><span class="row__icon"><svg class="ic"><use href="' + icon + '"/></svg></span><span><span class="row__title">' + b.querySelector('.nav-text').textContent + '</span></span><svg class="ic ic--sm faint"><use href="#i-arrow"/></svg></button>';
      });
      sheet.querySelector('[data-more-list]').innerHTML = list;
    }
  }

  /* ---- 오버레이 ---- */
  var lastFocus = null;
  function resetOverlay(ov) {
    /* 위험 확인창은 열 때마다 입력 문구와 실행 버튼 상태를 초기화한다 (감사 B04) */
    $$('[data-typed]', ov).forEach(function (i) {
      i.value = '';
      var b = document.getElementById(i.dataset.typedTarget); if (b) b.disabled = true;
    });
    $$('.confirm-inline.is-open', ov).forEach(function (c) { c.classList.remove('is-open'); });
  }
  /* ---- 대상 컨텍스트: 선택 → 확인 → 실행 → 결과가 같은 대상을 가리키게 한다 ----
     data-fill="key"      : 텍스트(입력·선택은 값)를 ctx[key]로 채움. ctx에 key가 없으면 원래 값으로 되돌림(이전 대상 잔존 방지)
     data-variant="a b"   : ctx.variant가 목록에 있을 때만 보임. "default"는 ctx.variant가 없을 때 보임
     data-ctx='{...}'     : 버튼이 여는 창/작업/페이지에 넘길 대상
     data-inherit-ctx     : 컨텍스트 없이 열리면 직전 대상(lastCtx)을 이어받음
     토스트 문구의 {key}  : 현재 대상 값으로 치환 */
  function fillCtx(root, ctx) {
    var c = ctx || {};
    $$('[data-fill]', root).forEach(function (el) {
      var k = el.dataset.fill;
      var isField = el.matches('input,select,textarea');
      if (el.dataset.fillDefault === undefined) el.dataset.fillDefault = isField ? el.value : el.textContent;
      var v = c[k] !== undefined ? String(c[k]) : el.dataset.fillDefault;
      if (isField) el.value = v; else el.textContent = v;
    });
    $$('[data-variant]', root).forEach(function (el) {
      var list = el.dataset.variant.split(/\s+/);
      el.hidden = c.variant ? list.indexOf(c.variant) < 0 : list.indexOf('default') < 0;
    });
  }
  var lastCtx = null;
  window.suiteCtx = function () { return lastCtx; };
  function openOv(id, ctx) {
    var ov = document.getElementById(id); if (!ov) return;
    if (!ctx && ov.hasAttribute('data-inherit-ctx')) ctx = lastCtx;
    if (ctx) lastCtx = ctx;
    ov._ctx = ctx || null;
    resetOverlay(ov); fillCtx(ov, ctx);
    lastFocus = document.activeElement; ov.classList.add('is-open'); ov.setAttribute('aria-hidden', 'false');
    var f = ov.querySelector('[data-autofocus]') || ov.querySelector('button,input,select,textarea'); if (f) setTimeout(function () { f.focus(); }, 0);
    document.dispatchEvent(new CustomEvent('suite:open', { detail: { id: id, ctx: ctx || null } }));
  }
  function closeOv(ov) {
    if (!ov) return; ov.classList.remove('is-open'); ov.setAttribute('aria-hidden', 'true');
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }
  window.suiteOpen = openOv; window.suiteClose = function (id) { closeOv(document.getElementById(id)); };

  /* ---- 입력 변경 → 저장 바 (baseline / draft 구분, 되돌리기는 실제 값 복원) ---- */
  var dirty = new Set();
  var baseline = new Map();
  function trackedControls() {
    var out = [];
    $$('.page[data-track] input, .page[data-track] select, .page[data-track] textarea, .drawer input, .drawer select, .drawer textarea').forEach(function (el) {
      if (el.closest('.savebar') || el.closest('.search') || el.hasAttribute('data-typed') || el.hasAttribute('data-no-track') || el.type === 'file') return;
      out.push(el);
    });
    $$('.choices[data-dirty], .seg[data-dirty], .mode-switch[data-dirty]').forEach(function (el) { out.push(el); });
    return out;
  }
  function readVal(el) {
    if (el.matches('.choices')) return $$('.choice', el).map(function (c) { return c.classList.contains('is-on') ? '1' : '0'; }).join('');
    if (el.matches('.seg, .mode-switch')) return $$('button', el).map(function (c) { return c.getAttribute('aria-pressed') === 'true' ? '1' : '0'; }).join('');
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '0';
    return el.value;
  }
  function writeVal(el, v) {
    if (el.matches('.choices')) { $$('.choice', el).forEach(function (c, i) { c.classList.toggle('is-on', v.charAt(i) === '1'); }); return; }
    if (el.matches('.seg, .mode-switch')) {
      $$('button', el).forEach(function (c, i) { c.setAttribute('aria-pressed', String(v.charAt(i) === '1')); });
      el.dispatchEvent(new CustomEvent('suite:restore', { bubbles: true }));
      if (el.dataset.target) { var on = $$('button', el).filter(function (c) { return c.getAttribute('aria-pressed') === 'true'; })[0]; $$('[data-seg-panel="' + el.dataset.target + '"]').forEach(function (p) { p.hidden = !on || p.dataset.val !== on.dataset.val; }); }
      return;
    }
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = v === '1'; else el.value = v;
    if (el.dataset.out) { var o = document.getElementById(el.dataset.out); if (o) o.textContent = el.value + (el.dataset.unit || ''); }
  }
  function snapshot() { baseline = new Map(); trackedControls().forEach(function (el) { baseline.set(el, readVal(el)); }); dirty.clear(); }
  function recompute() {
    dirty.clear();
    trackedControls().forEach(function (el, i) {
      if (!baseline.has(el)) baseline.set(el, readVal(el));
      if (baseline.get(el) !== readVal(el)) dirty.add(el.id || el.name || ('c' + i));
    });
    renderSave();
  }
  function markDirty() { recompute(); }
  function revertAll() { baseline.forEach(function (v, el) { writeVal(el, v); }); recompute(); }
  function renderSave() {
    $$('.savebar').forEach(function (bar) {
      var n = dirty.size; bar.classList.toggle('is-dirty', n > 0);
      var b = bar.querySelector('[data-save-title]'), d = bar.querySelector('[data-save-desc]');
      if (b) b.textContent = n ? n + '개 변경이 저장되지 않았습니다' : '모든 변경이 저장되어 있습니다';
      if (d) d.textContent = n ? '저장하면 다음 요청부터 적용됩니다. 저장 전에는 어떤 값도 바뀌지 않습니다.' : '설정을 바꾸면 이곳에서 한 번에 저장합니다.';
      $$('[data-save], [data-revert]', bar).forEach(function (btn) { btn.disabled = n === 0; });
    });
  }
  window.suiteMarkDirty = markDirty;
  window.suiteSnapshot = function () { snapshot(); renderSave(); };

  /* ---- 접근성: 보이는 설명을 입력 컨트롤에 프로그램상 연결 (감사 B09) ---- */
  var uid = 0;
  function autoLabel() {
    $$('.field').forEach(function (f) {
      var lab = f.querySelector(':scope > label'); if (!lab || lab.htmlFor) return;
      var c = f.querySelector(':scope > input:not([type=hidden]), :scope > select, :scope > textarea'); if (!c) return;
      if (!c.id) c.id = 'auto-f' + (++uid);
      lab.htmlFor = c.id;
    });
    $$('.setting').forEach(function (row) {
      var nm = row.querySelector('.setting__name'); if (!nm) return;
      if (!nm.id) nm.id = 'auto-s' + (++uid);
      $$('input,select,textarea', row).forEach(function (c) {
        if (c.type === 'hidden' || c.hasAttribute('aria-label') || c.hasAttribute('aria-labelledby')) return;
        if (c.labels && c.labels.length && c.labels[0].textContent.replace(/\s+/g, '').length && !c.labels[0].classList.contains('switch')) return;
        c.setAttribute('aria-labelledby', nm.id);
      });
    });
    $$('input,select,textarea').forEach(function (c) {
      if (c.type === 'hidden' || c.hasAttribute('aria-label') || c.hasAttribute('aria-labelledby')) return;
      var named = c.labels && c.labels.length && c.labels[0].textContent.replace(/\s+/g, '').length && !c.labels[0].classList.contains('switch');
      if (named) return;
      var wrap = c.closest('label.row, label.check');
      var txt = wrap ? (wrap.querySelector('.row__title, b') || wrap).textContent : (c.getAttribute('placeholder') || '');
      if (!txt) { var card = c.closest('.card'); var t = card && card.querySelector('.card__title'); txt = t ? t.textContent : ''; }
      if (txt) c.setAttribute('aria-label', txt.trim());
    });
  }

  /* ---- 서브탭 프로그램 전환 ---- */
  function activateSubtab(pageId, name) {
    var pg = $('.page[data-page="' + pageId + '"]'); if (!pg) return;
    var tab = $('[data-subtab="' + name + '"]', pg); if (tab) tab.click();
  }
  window.suiteSubtab = activateSubtab;

  function init() {
    sprite(); hydrateIcons(document); buildTabbar();
    $$('.page').forEach(function (p) { if (!p.dataset.page) p.dataset.page = 'x'; });

    document.addEventListener('click', function (e) {
      var t = e.target;
      var go = t.closest('[data-go]');
      if (go) { var ov = go.closest('.overlay'); if (ov) closeOv(ov); goPage(go.dataset.go, go.dataset.ctx ? { ctx: safeJson(go.dataset.ctx) } : null); if (go.dataset.goSub) activateSubtab(go.dataset.go, go.dataset.goSub); if (go.dataset.toast) toast(go.dataset.toast); var m = $('.menu.is-open'); if (m) m.classList.remove('is-open'); return; }
      if (t.closest('[data-more]')) { openOv('sheet-more'); return; }
      var op = t.closest('[data-open]');
      if (op) { var ctx = null; if (op.dataset.ctx) { try { ctx = JSON.parse(op.dataset.ctx); } catch (er) {} } openOv(op.dataset.open, ctx); return; }
      var cl = t.closest('[data-close]');
      if (cl) {
        /* 닫기 + (중단 | 토스트 | 작업 시작)을 한 버튼에서 모두 수행 (감사 B06·B08) */
        var cov = cl.closest('.overlay');
        if (cl.hasAttribute('data-job-cancel') && cov) cancelJob(cov);
        closeOv(cov);
        if (cl.dataset.toast) toast(cl.dataset.toast);
        var nctx = cl.dataset.ctx ? safeJson(cl.dataset.ctx) : (cov && cov._ctx) || null;
        if (cl.dataset.thenOpen) openOv(cl.dataset.thenOpen, nctx);
        if (cl.dataset.thenGo) goPage(cl.dataset.thenGo, nctx ? { ctx: nctx } : null);
        var rj = cl.closest('[data-run-job]'); if (rj) runJob(rj.dataset.runJob, rj.dataset.ctx ? safeJson(rj.dataset.ctx) : null);
        return;
      }
      if (t.classList && t.classList.contains('overlay') && !t.dataset.sticky) { closeOv(t); return; }
      var mt = t.closest('[data-menu]');
      if (mt) { var menu = mt.closest('.menu'); var was = menu.classList.contains('is-open'); $$('.menu.is-open').forEach(function (x) { x.classList.remove('is-open'); }); if (!was) menu.classList.add('is-open'); return; }
      if (!t.closest('.menu')) $$('.menu.is-open').forEach(function (x) { x.classList.remove('is-open'); });

      var st = t.closest('[data-subtab]');
      if (st) {
        var grp = st.closest('[data-subtabs]'); var scope = grp.dataset.subtabs;
        $$('[data-subtab]', grp).forEach(function (b) { b.setAttribute('aria-selected', String(b === st)); });
        var root = grp.parentElement;
        $$('[data-subpanel]', root).forEach(function (p) { if (p.dataset.group === scope) p.classList.toggle('is-active', p.dataset.subpanel === st.dataset.subtab); });
        return;
      }
      var sg = t.closest('.seg button');
      if (sg) {
        var seg = sg.closest('.seg'); $$('button', seg).forEach(function (b) { b.setAttribute('aria-pressed', String(b === sg)); });
        if (seg.dataset.target) { $$('[data-seg-panel="' + seg.dataset.target + '"]').forEach(function (p) { p.hidden = p.dataset.val !== sg.dataset.val; }); }
        if (seg.dataset.dirty !== undefined) markDirty(seg);
        return;
      }
      var ch = t.closest('.choice');
      if (ch && ch.parentElement.classList.contains('choices')) {
        var single = ch.parentElement.dataset.multi === undefined;
        if (single) $$('.choice', ch.parentElement).forEach(function (c) { c.classList.toggle('is-on', c === ch); });
        else ch.classList.toggle('is-on');
        if (ch.parentElement.dataset.dirty !== undefined) markDirty(ch.parentElement);
        return;
      }
      var rowSel = t.closest('[data-select-row]');
      if (rowSel) { var lst = rowSel.parentElement; $$('[data-select-row]', lst).forEach(function (r) { r.classList.toggle('is-on', r === rowSel); if (r === rowSel) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); }); var tg = rowSel.dataset.selectRow; if (tg) { var droot = rowSel.closest('[data-detail-root]') || rowSel.closest('.overlay') || rowSel.closest('.page') || document; $$('[data-detail]', droot).forEach(function (d) { var show = d.dataset.detail === tg; d.hidden = !show; d.classList.toggle('is-on', show); }); } return; }
      var sv = t.closest('[data-save]');
      if (sv) { snapshot(); renderSave(); toast(sv.dataset.save || '저장하고 다시 읽어 확인했습니다. (시안)'); return; }
      var rv = t.closest('[data-revert]');
      if (rv) { revertAll(); toast('저장된 값으로 되돌렸습니다.'); return; }
      var ts = t.closest('[data-toast]');
      if (ts) { toast(ts.dataset.toast); $$('.menu.is-open').forEach(function (x) { x.classList.remove('is-open'); }); return; }
      var sc = t.closest('button[data-scenario]');
      if (sc) { document.documentElement.dataset.scenario = sc.dataset.scenario; $$('button[data-scenario]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === sc)); }); return; }
      var dv = t.closest('button[data-device]');
      if (dv) { var fr = $('.frame'); fr.dataset.device = dv.dataset.device; $$('button[data-device]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === dv)); }); return; }
      var job = t.closest('[data-run-job]');
      if (job) { if (job.disabled) return; runJob(job.dataset.runJob, job.dataset.ctx ? safeJson(job.dataset.ctx) : null); return; }
    });
    document.addEventListener('input', function (e) {
      var el = e.target;
      if (el.closest('.savebar')) return;
      if (el.matches('input,select,textarea')) recompute();
      var out = el.dataset.out; if (out) { var o = document.getElementById(out); if (o) o.textContent = el.value + (el.dataset.unit || ''); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { var open = $$('.overlay.is-open').pop(); if (open) { closeOv(open); e.preventDefault(); } }
      if (e.key === 'Tab') {
        var ov = $$('.overlay.is-open').pop(); if (!ov) return;
        var f = $$('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])', ov).filter(function (x) { return !x.disabled && x.offsetParent !== null; });
        if (!f.length) return; var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      var tab = e.target.closest && e.target.closest('[role=tab]');
      if (tab && /Arrow(Left|Right)|Home|End/.test(e.key)) {
        var tabs = $$('[role=tab]', tab.parentElement); var i = tabs.indexOf(tab);
        i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[i].focus(); tabs[i].click(); e.preventDefault();
      }
    });
    var pb = $('.proto-bar'); if (pb && !$('.proto-note', pb)) { var pn = document.createElement('span'); pn.className = 'proto-note'; pn.textContent = '표본 데이터 · 저장/삭제/진행은 시연용'; pb.appendChild(pn); }
    autoLabel(); snapshot(); renderSave();
    var h = (location.hash || '').replace('#', '');
    var qs = new URLSearchParams(location.search);
    if (qs.get('device')) { var fr = $('.frame'); if (fr) { fr.dataset.device = qs.get('device'); $$('button[data-device]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.device === qs.get('device'))); }); } }
    if (h) goPage(h, { silent: true });
    else { var first = $('.page.is-active'); if (first) goPage(first.dataset.page, { silent: true }); }
    if (qs.get('open')) openOv(qs.get('open'));
    if (qs.get('sub')) { var sp = (qs.get('sub') || '').split(':'); if (sp.length === 2) activateSubtab(sp[0], sp[1]); }
    document.dispatchEvent(new CustomEvent('suite:ready'));
  }

  /* ---- 작업 시뮬레이션 (진행 표시 시안) ---- */
  function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }
  function cancelJob(ov) {
    if (!ov || !ov._t) return;
    clearInterval(ov._t); ov._t = null; ov.dataset.state = 'cancelled';
    var msg = ov.querySelector('[data-job-msg]'); if (msg) msg.textContent = '중단을 요청했습니다. 이미 전송된 요청은 처리 중일 수 있습니다.';
    toast('중단을 요청했습니다. 이미 전송된 요청은 처리 중일 수 있습니다.');
  }
  function runJob(id, ctx) {
    var ov = document.getElementById(id); if (!ov) return;
    if (!ctx && ov.hasAttribute('data-inherit-ctx')) ctx = lastCtx;
    resetOverlay(ov); openOv(id, ctx);
    $$('[data-job-result]', ov).forEach(function (r) { r.hidden = true; });
    var bar = ov.querySelector('.progress>i');
    var steps = $$('.step', ov).filter(function (st) { return !st.closest('[hidden]'); });
    var msg = ov.querySelector('[data-job-msg]');
    var dones = $$('[data-job-done]', ov); var cancels = $$('[data-job-cancel]', ov);
    var labels = ((ctx && ctx.labels) || ov.dataset.jobLabels || '').split('|');
    var total = steps.length || Math.max(labels.length - 1, 1); var i = 0;
    ov.dataset.state = 'running';
    steps.forEach(function (s) { s.classList.remove('is-done', 'is-active'); }); dones.forEach(function (d) { d.hidden = true; }); cancels.forEach(function (c) { c.hidden = false; });
    if (bar) bar.style.setProperty('--v', '0%');
    clearInterval(ov._t);
    ov._t = setInterval(function () {
      if (i > 0 && steps[i - 1]) { steps[i - 1].classList.remove('is-active'); steps[i - 1].classList.add('is-done'); }
      if (i >= total) {
        clearInterval(ov._t); ov._t = null; ov.dataset.state = 'done';
        if (bar) bar.style.setProperty('--v', '100%');
        var fin = labels[labels.length - 1] || '완료했습니다.';
        if (msg) msg.textContent = fin; dones.forEach(function (d) { d.hidden = false; }); cancels.forEach(function (c) { c.hidden = true; });
        $$('[data-job-result]', ov).forEach(function (r) { r.hidden = false; }); fillCtx(ov, ov._ctx);
        if (!ov.classList.contains('is-open')) toast(fin);
        return;
      }
      if (steps[i]) steps[i].classList.add('is-active');
      if (bar) bar.style.setProperty('--v', Math.round((i + 0.5) / total * 100) + '%');
      if (msg && labels[i]) msg.textContent = labels[i]; i++;
    }, 1100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
