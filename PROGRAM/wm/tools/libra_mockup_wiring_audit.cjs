#!/usr/bin/env node
/**
 * 목업 배선 감사 — surface-without-action 탐지
 *
 * 왜 필요한가: "id 가 존재하는가" 만 확인하면 빈 껍데기(surface-without-action)를 통과시킨다.
 * 실제로 이 프로젝트에서 id 241/241 통과 상태로 버튼 54개가 눌러도 아무 일이 없었다.
 *
 * 판정 방식: addEventListener 를 계측해 **요소가 실제로 리스너를 받았는지** 본다.
 *   - 클릭-후-DOM-변화 관찰은 오탐이 난다: 지연 토스트(1100ms)를 180ms 관찰로 재면 "무반응"으로 잡힌다.
 *   - 상위 위임(delegation)도 별도로 인정한다.
 *
 * 사용: node tools/libra_mockup_wiring_audit.cjs <목업파일경로>
 *   목업 HTML 은 저장소에 커밋하지 않는다(ux-prototype/ 은 로컬 보관). 그래서
 *   대상 경로는 **필수 인자**다 — 기본값을 두면 새 클론에서 없는 파일을 가리킨다.
 * 필요: playwright (npx 캐시의 playwright 를 NODE_PATH 로 지정하거나 로컬 설치)
 * 종료코드: 0 = 무배선 없음, 1 = 무배선 있음 (게이트로 쓸 수 있다), 2 = 사용법/의존성 오류
 */
const path = require('path');
const fs = require('fs');

const target = process.argv[2];
if (!target) {
  console.error('사용법: node tools/libra_mockup_wiring_audit.cjs <목업파일경로>');
  console.error('  (목업 HTML 은 저장소에 없다 — ux-prototype/ 등 로컬 경로를 넘긴다)');
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error('파일이 없습니다: ' + target);
  process.exit(2);
}
const KEYS = ['home','memory','entity','narrative','world','worldline','wa-entities','wa-world','wa-active','wa-tools','settings'];

let chromium;
const pwLoader = require('./libra_playwright_loader.cjs');
const pw = pwLoader.loadPlaywright();
if (!pw || !pw.chromium) {
  console.error(pwLoader.PLAYWRIGHT_HINT);
  process.exit(2);
}
({ chromium } = pw);

(async () => {
  const url = 'file:///' + target.replace(/\\/g, '/');
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  await ctx.addInitScript(() => {
    window.__LISTENERS = new Map();
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      try { if (this && this.nodeType === 1) {
        if (!window.__LISTENERS.has(this)) window.__LISTENERS.set(this, new Set());
        window.__LISTENERS.get(this).add(type);
      } } catch (e) {}
      return orig.call(this, type, fn, opts);
    };
    window.__listenerTypes = el => { const s = window.__LISTENERS.get(el); return s ? Array.from(s) : []; };
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const out = [];
  for (const k of KEYS) {
    const l = await page.$(`[data-go="${k}"]`);
    if (l) { await l.click(); await page.waitForTimeout(200); }
    const rows = await page.evaluate(panelKey => {
      const panel = document.getElementById('panel-' + panelKey);
      if (!panel) return [];
      const res = [];
      panel.querySelectorAll('button').forEach(btn => {
        const types = window.__listenerTypes(btn);
        let viaAncestor = null;
        for (let p = btn.parentElement; p && p !== document.body; p = p.parentElement) {
          const t = window.__listenerTypes(p);
          if (t.length) { viaAncestor = (p.className || p.tagName).toString().slice(0, 28); break; }
        }
        res.push({ panel: panelKey, id: btn.id || null, text: (btn.textContent || '').trim().slice(0, 24),
          listeners: types, viaAncestor, dynamic: !!btn.closest('tr') || btn.hasAttribute('data-del') });
      });
      return res;
    }, k);
    out.push(...rows);
  }

  // 중복 id 도 함께 본다 — 제품은 querySelector('#x') 로 첫 요소만 잡으므로 모호해진다
  const dupes = await page.evaluate(() => {
    const by = {};
    document.querySelectorAll('[id]').forEach(e => (by[e.id] = by[e.id] || []).push(e));
    return Object.entries(by).filter(([, v]) => v.length > 1).map(([k, v]) => `${k} ×${v.length}`);
  });

  const stat = out.filter(r => !r.dynamic);
  const inert = stat.filter(r => r.listeners.length === 0 && !r.viaAncestor);
  const report = {
    target, totalButtons: out.length, dynamicRowButtons: out.length - stat.length, staticButtons: stat.length,
    wired: stat.length - inert.length, inert: inert.length,
    inertList: inert.map(d => `${d.panel}#${d.id || '(no-id)'} "${d.text}"`),
    duplicateIds: dupes, pageErrors: errs
  };
  console.log(JSON.stringify(report, null, 2));
  await b.close();
  process.exit(inert.length || errs.length || dupes.length ? 1 : 0);
})();
