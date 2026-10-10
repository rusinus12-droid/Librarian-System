#!/usr/bin/env node
'use strict';
// §32 VISUAL VERIFICATION AGAINST THE REAL GUI.
//
// The first version of this harness extracted a few CSS rules into a standalone page and forced
// padding. That measured a shape I had composed, not the product: no top bar, no sidebar, no save
// bar, and a status card the real page does not have. Its number was not evidence about the GUI.
//
// This harness loads the SHIPPED plugin into a host page the same way the existing browser suites do
// (tests/browser/libra_writer_host.js + the real LIBRA.js), opens the real settings GUI, and measures
// the real geometry: the visible viewport, the header, the status control, the workbench tabs, the
// content box, and the save bar. `bodyRatio` is the CONTENT element's height over the content
// viewport height — an area, not "from a top offset to the bottom of the screen".
//
// Run:  node tests/browser/libra_reading_space_measure_browser_test.cjs
// Needs playwright (any global or local install) and Chrome. Skips with a clear message if neither
// is available, so it never reports a pass it did not measure.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PROGRAM = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(PROGRAM, 'plugins', 'LIBRA.js');
const OUTPUT = process.env.LIBRA_READING_SPACE_OUT
  || path.join(require('node:os').tmpdir(), 'libra_reading_space_measure.json');
// §32.1 요청 1 is about the space spent BEFORE the reader reaches content, and §32.2 sets a reading
// target. Both are measured directly. A ceiling of 0.35 on the pre-content share allows a top bar, a
// header and a status control without letting decoration eat the first screen; a floor of 0.45 on the
// reading share keeps the content area from collapsing, without demanding that real navigation (the
// mobile bottom bar) be removed to hit a number.
const MAX_PRE_CONTENT_SHARE = 0.35;
// The header band itself. Measured 134px before this work and 66px after at 1440 wide, so a 96px
// ceiling fails if the stacked header ever comes back.
const MAX_HEADER_HEIGHT = 96;
// The pages the reading desk MUST offer, taken from the product's own BOOK_SIDEBAR_PAGE_REGISTRY.
// Enumerating the live menu instead would silently shrink the measurement set if an entry went
// missing — the check has to fail on a missing page, not skip it.
const EXPECTED_PAGES = ['desk', 'memory', 'people', 'world', 'story', 'writing', 'settings'];
// The save bar exists for the two rooms that edit stored state. A room losing it is a real
// regression, so its presence (and that it is on screen) is part of the pass condition.
const SAVE_BAR_PAGES = ['writing', 'settings'];

const requirePlaywright = () => {
  const candidates = ['playwright', '/tmp/_gui_pw/node_modules/playwright'];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (_) { /* try the next one */ }
  }
  return null;
};

const MEASURE = () => {
  const rect = el => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), height: Math.round(b.height), width: Math.round(b.width) };
  };



  // The reading surface is the page's content AFTER its header — `.libra-book-page` contains the
  // header, so measuring the page itself can never show the header's cost.
  const pageEl = document.querySelector('.libra-book-page');
  const content = (() => {
    if (!pageEl) return document.querySelector('.libra-book-stage');
    // The reading surface is the LARGEST non-header child that actually has a box. Taking merely the
    // first non-header child picked up a zero-height mobile picker on the settings room.
    const kids = [...pageEl.children].filter(child => !String(child.className || '').includes('libra-book-page-head'));
    let best = null;
    let bestArea = 0;
    for (const child of kids) {
      const box = child.getBoundingClientRect();
      const area = box.width * box.height;
      if (area > bestArea) { bestArea = area; best = child; }
    }
    return best;
  })();
  const contentBox = content ? content.getBoundingClientRect() : null;
  const topBar = document.querySelector('.libra-book-top');
  const topBarBottom = topBar ? topBar.getBoundingClientRect().bottom : 0;
  // `.sga-main` is the plugin's scroll viewport: everything the reader can actually see and scroll.
  const viewportEl = document.querySelector('.sga-main');
  const viewportBox = viewportEl ? viewportEl.getBoundingClientRect() : null;
  const availableHeight = viewportBox ? Math.max(0, viewportBox.height) : null;
  const saveBarEl = document.querySelector('[data-book-save-bar]');
  const saveBarBox = saveBarEl ? saveBarEl.getBoundingClientRect() : null;
  const titleRow = document.querySelector('.libra-book-page-title-row');
  const kidHeights = titleRow ? [...titleRow.children].map(k => k.getBoundingClientRect().height) : [];
  const statePopover = document.querySelector('.libra-book-state-popover');
  const statusCard = document.querySelector('.libra-book-state-progress');
  // The header band: the page head where there is one (desk uses a different shell whose top band is
  // the status line, so that is its header for this measurement).
  const headerBox = document.querySelector('.libra-book-page-head')
    || (document.querySelector('.libra-book-page') ? null : document.querySelector('.sga-status'));
  const headerBottom = headerBox ? headerBox.getBoundingClientRect().bottom : null;
  const stateTop = statePopover ? statePopover.getBoundingClientRect().top : null;
  // Occlusion: how much of the CONTENT area sits under the save bar or under the header.
  // What the reader cannot use for text: the header band over the content, a sticky save bar over it,
  // and the persistent status line that lives in the scroll viewport above the page.
  const statusLine = document.querySelector('.sga-main > .sga-status');
  const statusLineBox = statusLine ? statusLine.getBoundingClientRect() : null;
  const occluded = contentBox ? Math.max(0,
    (headerBottom && contentBox.top < headerBottom ? Math.min(headerBottom, contentBox.bottom) - contentBox.top : 0)
    + (saveBarBox && contentBox.bottom > saveBarBox.top ? contentBox.bottom - Math.max(saveBarBox.top, contentBox.top) : 0)
  ) : null;
  const chromeHeight = statusLineBox ? Math.max(0, statusLineBox.height) : 0;
  const contentHeight = contentBox ? contentBox.height : null;
  return {
    measuredPage: window.__readingSpace ? __readingSpace.Gui.bookPage : null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    topBar: topBar ? { bottom: Math.round(topBarBottom) } : null,
    // headerBox is a DOM element, so its geometry must come from getBoundingClientRect(); reading
    // `.top`/`.height` off the element itself yields undefined and JSON turns that into null.
    header: headerBox ? (() => { const b = headerBox.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; })() : null,
    titleRow: titleRow ? { height: Math.round(titleRow.getBoundingClientRect().height) } : null,
    titleRowKids: kidHeights.length,
    titleRowOneLine: (() => {
      if (!titleRow || kidHeights.length < 2) return false;
      if (getComputedStyle(titleRow).flexWrap === 'wrap') return false;
      const band = [...titleRow.children].map(k => { const b = k.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
      const tallest = Math.max(...band.map(b => b.bottom - b.top));
      const mids = band.map(b => (b.top + b.bottom) / 2);
      return Math.max(...mids) - Math.min(...mids) <= tallest / 2 + 1;
    })(),
    statusControl: statePopover ? { top: Math.round(stateTop), height: Math.round(statePopover.getBoundingClientRect().height) } : null,
    statusCardPresent: !!statusCard,
    statusInsideHeader: stateTop !== null && headerBottom !== null && stateTop < headerBottom,
    // THE READER'S NUMBER: the content area's height as a share of the scroll viewport the reader
    // actually has, minus anything the header or the save bar covers.
    scrollViewportHeight: availableHeight === null ? null : Math.round(availableHeight),
    statusLineHeight: Math.round(chromeHeight),
    contentHeight: contentHeight === null ? null : Math.round(contentHeight),
    occludedHeight: occluded === null ? null : Math.round(occluded),
    // Of the reader's scroll room (viewport minus the always-present status line), how much does the
    // page content occupy once the header band and any sticky save bar are removed? This is the share
    // of the visible area that is actually reading surface.
    usableContentRatio: (() => {
      const room = (availableHeight ?? 0) - chromeHeight;
      if (!(room > 0) || contentHeight === null || occluded === null) return null;
      return Number((Math.max(0, contentHeight - occluded) / room).toFixed(3));
    })(),
    // The complaint's own number: how much of the screen is spent before the reading area begins
    // (i.e. everything above the content — top bar, header, status control).
    preContentShare: contentBox ? Number((contentBox.top / window.innerHeight).toFixed(3)) : null,
    // How much of the screen the reading area itself occupies.
    readingAreaShare: contentHeight === null ? null : Number((contentHeight / window.innerHeight).toFixed(3)),
        saveBar: saveBarBox ? (() => {
      const style = saveBarEl.ownerDocument.defaultView.getComputedStyle(saveBarEl);
      // The scroll viewport the reader actually has: on this GUI that is `.sga-main`. Intersecting the
      // bar with it is what makes "visible" mean "on screen" — a bar dragged below the fold by a
      // transform is still height>0 and display:flex, and the earlier check called it visible.
      const view = document.querySelector('.sga-main');
      const viewBox = view ? view.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
      const inViewport = saveBarBox.bottom > viewBox.top && saveBarBox.top < viewBox.bottom
        && saveBarBox.right > viewBox.left && saveBarBox.left < viewBox.right;
      const interTop = Math.max(saveBarBox.top, viewBox.top);
      const interBottom = Math.min(saveBarBox.bottom, viewBox.bottom);
      const visibleHeight = Math.max(0, interBottom - interTop);
      // The bar's own controls must also be reachable: a button covered by something else is not
      // usable even when the bar's rectangle is on screen. hitTargetAt is computed by the caller with
      // elementFromPoint so this stays a pure measurement.
      const styled = saveBarBox.height > 0 && saveBarBox.width > 0
        && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
      return { top: Math.round(saveBarBox.top), bottom: Math.round(saveBarBox.bottom),
               height: Math.round(saveBarBox.height),
               inViewport, visibleHeight: Math.round(visibleHeight),
               visible: styled && inViewport && visibleHeight > 0,
               styled };
    })() : null,
    // Is the save bar's own action actually clickable — nothing else on top of it? Null when there is
    // no save bar on this page.
    saveBarActionReachable: (() => {
      const bar = document.querySelector('[data-book-save-bar]');
      if (!bar) return null;
      const button = bar.querySelector('button');
      if (!button) return null;
      const box = button.getBoundingClientRect();
      const cx = Math.round(Math.min(Math.max(box.left + box.width / 2, 1), window.innerWidth - 1));
      const cy = Math.round(Math.min(Math.max(box.top + box.height / 2, 1), window.innerHeight - 1));
      const hit = document.elementFromPoint(cx, cy);
      const own = hit && (bar.contains(hit) || hit === bar);
      return { found: !!hit, own, tag: hit ? hit.tagName : null,
               disabled: button.disabled === true || button.getAttribute('aria-disabled') === 'true' };
    })(),
    viewportElScrollable: viewportEl ? viewportEl.scrollHeight > viewportEl.clientHeight + 4 : null,
    contentTag: content ? String(content.className || '').slice(0, 60) : null
  };
}

  // The save bar, judged where the reader actually meets it: with the room scrolled to its end.
  const MEASURE_SAVE_BAR = () => {
    const bar = document.querySelector('[data-book-save-bar]');
    if (!bar) return { present: false };
    const view = document.querySelector('.sga-main');
    const viewBox = view ? view.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    const box = bar.getBoundingClientRect();
    const style = window.getComputedStyle(bar);
    const interTop = Math.max(box.top, viewBox.top);
    const interBottom = Math.min(box.bottom, viewBox.bottom);
    const visibleHeight = Math.max(0, interBottom - interTop);
    const styled = box.height > 0 && box.width > 0
      && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    // The bar has TWO actions and they must be checked separately: `querySelector('button')` picked
    // 되돌리기 (the first one), so removing the actual 저장 button still passed — the review caught it
    // by deleting [data-settings-room-save] alone and watching the suite stay green.
    const probe = (selector, label) => {
      const button = bar.querySelector(selector);
      if (!button) return { label, present: false };
      const b = button.getBoundingClientRect();
      const cx = Math.round(Math.min(Math.max(b.left + b.width / 2, 1), window.innerWidth - 1));
      const cy = Math.round(Math.min(Math.max(b.top + b.height / 2, 1), window.innerHeight - 1));
      const hit = document.elementFromPoint(cx, cy);
      return { label, present: true,
               // Reachable means the point resolves to THIS button (or something inside it).
               // `bar.contains(hit)` was too loose: an overlay covering the button also lives inside
               // the bar, so a blocked button still looked reachable.
               own: !!(hit && (hit === button || button.contains(hit))),
               blockedBy: hit && !(hit === button || button.contains(hit))
                 ? `${hit.tagName}${hit.className ? '.' + String(hit.className).slice(0, 30) : ''}` : null,
               disabled: button.disabled === true || button.getAttribute('aria-disabled') === 'true',
               top: Math.round(b.top), height: Math.round(b.height) };
    };
    const actions = [probe('[data-settings-room-save]', '설정 저장'),
                     probe('[data-settings-room-revert]', '되돌리기')];
    const [save, revert] = actions;
    const action = {
      actionsPresent: actions.filter(a => a.present).length,
      // Every action in the bar must be present AND reachable. Each keeps its own verdict so a
      // blocked one is identifiable; only the enablement rule differs between them (see the gate).
      allReachable: actions.every(a => a.present === true && a.own === true),
      blocked: actions.filter(a => a.present && !a.own).map(a => `${a.label}<-${a.blockedBy}`),
      missing: actions.filter(a => !a.present).map(a => a.label),
      savePresent: save.present === true, saveOwn: save.present === true && save.own === true,
      revertPresent: revert.present === true, revertOwn: revert.present === true && revert.own === true,
      saveDisabled: save.present ? save.disabled === true : null,
      revertDisabled: revert.present ? revert.disabled === true : null };
    return { present: true, top: Math.round(box.top), bottom: Math.round(box.bottom),
             height: Math.round(box.height), styled, visibleHeight: Math.round(visibleHeight),
             visible: styled && visibleHeight > 0, action,
             scrollTop: view ? Math.round(view.scrollTop) : null,
             atMaxScroll: view ? Math.abs(view.scrollTop - (view.scrollHeight - view.clientHeight)) < 3 : null };
  };
;

(async () => {
  const playwright = requirePlaywright();
  if (!playwright) {
    console.error('libra_reading_space_measure: SKIP — playwright is not installed (looked in the module path and /tmp/_gui_pw).');
    process.exit(0);
  }
  const browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true
  });
  const report = { test: 'libra_reading_space_measure', maxPreContentShare: MAX_PRE_CONTENT_SHARE, maxHeaderHeight: MAX_HEADER_HEIGHT, viewports: {} };
  let failures = 0;
  try {
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', error => errors.push(String(error?.message || error).slice(0, 200)));
      await page.setContent('<html lang="ko"><body></body></html>');
      await page.addScriptTag({ path: path.join(__dirname, 'libra_writer_host.js') });
      let source = fs.readFileSync(PLUGIN, 'utf8');
      const marker = '  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
      assert.ok(source.includes(marker), 'the reading-space harness needs the public-API marker');
      source = source.replace(marker,
        '  globalThis.__readingSpace={Gui,bookNavigate,renderSettingsGui,queueGuiRender,queueGuiNavigationRender};\n' + marker);
      await page.addScriptTag({ content: source });
      await page.waitForFunction(() => !!window.__LIBRA__);
      await page.evaluate(() => __LIBRA__.openSettingsGui());
      await page.waitForTimeout(700);
      // EVERY page, not only the three with a state domain. The review's point was that measuring one
      // page leaves the writing room, the settings room and the save bar unverified — and the save
      // bar only exists inside the writing/settings rooms, so it was never measured at all.
      // `people` / `world` / `story` carry the header state control; `writing` / `settings` have no
      // state domain by design, so they are not expected to show one.
      const allPages = await page.evaluate(() => [...document.querySelectorAll('.libra-book-sidebar [data-book-page]')]
        .map(n => n.dataset.bookPage));
      // A missing menu entry fails here rather than quietly removing a page from the run.
      const missing = EXPECTED_PAGES.filter(id => !allPages.includes(id));
      if (missing.length) {
        failures += 1;
        console.error(`[${name}] the reading desk is missing page(s): ${missing.join(', ')} (offered: ${allPages.join(', ')})`);
      }
      const pages = {};
      for (const target of allPages) {
        await page.evaluate(name => {
          const entry = document.querySelector(`.libra-book-sidebar [data-book-page="${name}"]`);
          if (entry) entry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }, target);
        await page.waitForTimeout(700);
        const now = await page.evaluate(() => (window.__readingSpace ? __readingSpace.Gui.bookPage : null));
        const pageMeasure = await page.evaluate(MEASURE);
        // The save bar's REACHABILITY is a separate, second-phase measurement: scroll the room to its
        // own end (what a reader does) and then ask whether the bar and its action are actually there.
        // The room's END is used deliberately — scrollIntoView({block:'end'}) parks the bar under the
        // mobile bottom navigation, which turned a reachable bar into an apparent blocker and also
        // pushed the content above the viewport (a negative preContentShare).
        if (SAVE_BAR_PAGES.includes(target)) {
          await page.evaluate(() => {
            const view = document.querySelector('.sga-main');
            if (view) view.scrollTop = view.scrollHeight;
          });
          await page.waitForTimeout(300);
          pageMeasure.saveBarReachable = await page.evaluate(MEASURE_SAVE_BAR);
          await page.evaluate(() => {
            const view = document.querySelector('.sga-main');
            if (view) view.scrollTop = 0;
          });
        } else {
          pageMeasure.saveBarReachable = null;
        }
        pageMeasure.pageErrors = errors.slice();
        pageMeasure.requestedViewport = { width, height };
        pageMeasure.reached = now === target;
        pageMeasure.statePagesPresent = allPages;
        const pagePre = pageMeasure.preContentShare;
        const pageHeader = pageMeasure.header ? pageMeasure.header.height : null;
        const stateDomain = ['people', 'world', 'story'].includes(target);
        pageMeasure.stateDomain = stateDomain;
        // The save bar must EXIST and be on screen in the rooms that edit stored state. Recording its
        // height without requiring it would let the bar disappear without failing anything.
        const needsSaveBar = SAVE_BAR_PAGES.includes(target);
        pageMeasure.needsSaveBar = needsSaveBar;
        // Required, REACHABLE (on screen after scrolling to it), and its action not covered.
        // `disabled` is reported but not gated: the save button is inert until something is edited,
        // which is the product's intended behaviour, not a layout defect.
        const reach = pageMeasure.saveBarReachable;
        // BOTH actions must be present AND reachable (allReachable covers 되돌리기 too — it used to be
        // checked for presence only, so a hidden revert button passed). The save button must also be
        // ENABLED: it is disabled only while a save is in flight. 되돌리기's disabled state is not
        // gated — it is disabled when there is nothing to revert, which is intended.
        const saveBarOk = !needsSaveBar || !!(reach && reach.present === true
          && reach.visible === true
          && reach.action && reach.action.actionsPresent === 2
          && reach.action.allReachable === true
          && reach.action.saveDisabled === false);
        const pageOk = pageMeasure.reached
          && pageMeasure.pageErrors.length === 0
          && typeof pagePre === 'number' && pagePre <= MAX_PRE_CONTENT_SHARE
          && typeof pageHeader === 'number' && pageHeader <= MAX_HEADER_HEIGHT
          && saveBarOk
          && (stateDomain
            ? (pageMeasure.titleRowOneLine === true && pageMeasure.statusInsideHeader === true
               && pageMeasure.statusCardPresent === false)
            : true);
        pageMeasure.meetsTarget = pageOk;
        pages[target] = pageMeasure;
        if (!pageOk) failures += 1;
        const saveBarNote = reach && reach.present
          ? `${reach.height}px@end@${reach.top}${reach.visible ? '' : '(NOT-ON-SCREEN)'}`
          : 'none';
        const hitNote = reach && reach.action
          ? (reach.action.actionsPresent === 2 && reach.action.allReachable
              ? `(save-ok${reach.action.saveDisabled ? ':DISABLED' : ''},revert:${reach.action.revertDisabled ? 'clean' : 'ok'})`
              : `(!actions:${reach.action.missing.length ? 'missing=' + reach.action.missing.join('+') : ''}${reach.action.blocked.length ? (reach.action.missing.length ? ',' : '') + 'blocked=' + reach.action.blocked.join('+') : ''})`)
          : '';
        console.log(`[${name}/${target}] reached=${pageMeasure.reached} header=${pageHeader}px preContent=${pagePre} readingArea=${pageMeasure.readingAreaShare} saveBar=${saveBarNote}${hitNote}${needsSaveBar && !saveBarOk ? ' *REQUIRED*' : ''} errors=${pageMeasure.pageErrors.length} meets=${pageOk}`);
      }
      report.viewports[name] = { pages, pageCount: allPages.length, expectedPageCount: EXPECTED_PAGES.length, missingPages: missing };
      const measured = pages[allPages.find(id => ['people', 'world', 'story'].includes(id)) || allPages[0]];
      report.viewports[name].summary = measured;
      await page.close();
    }
  } finally {
    await browser.close();
  }
  report.pass = failures === 0;
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  console.log(failures === 0
    ? 'libra_reading_space_measure_browser_test: PASS'
    : 'libra_reading_space_measure_browser_test: FAIL');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_reading_space_measure_browser_test: FAIL');
  process.exitCode = 1;
});
