'use strict';
// 시각화 목업 검증 — "정적 그림"이 아니라 "동작"을 잰다.
//   ① pageerror 0  ② 실제 렌더(캔버스에 픽셀이 그려졌는가)
//   ③ 정지 시 rAF 중단(=CPU 0)  ④ LOD 임계 실제 전환  ⑤ 규모 전환 rebuild
const path = require('path');
const fs = require('fs');
const loader = require('./libra_playwright_loader.cjs');

(async () => {
  const out = { ok: false, checks: [], measurements: {} };
  const pw = loader.loadPlaywright();
  if (!pw) {
    out.reason = 'playwright_unavailable';
    out.hint = loader.PLAYWRIGHT_HINT;
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }
  const { chromium } = pw;

  const PAGE = 'file:///' + path.join(__dirname, '..', 'ux-prototype', 'libra-hme-graph-view.html').replace(/\\/g, '/');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto(PAGE, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const check = (name, ok, details = {}) => out.checks.push({ name, ok: !!ok, details });

  // ① 오류 0 을 먼저 본다 — 오류가 있으면 나머지 초록은 의미가 없다
  check('E1: 페이지 오류 0', errs.length === 0, { errors: errs });

  // ② 실제 렌더 — 캔버스 픽셀이 비어 있지 않은가
  const painted = await page.evaluate(() => {
    const cv = document.getElementById('cv');
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) n++;
    return { sampled: Math.floor(d.length / (4 * 97)), nonEmpty: n, w: cv.width, h: cv.height };
  });
  out.measurements.canvas = painted;
  check('E2: 캔버스에 도형이 실제로 그려졌다', painted.nonEmpty > 50 && painted.w > 0, painted);

  // ③ 정지 시 rAF 중단 — 실제 프레임 수가 멈추는가
  // 렌더 루프가 멈췄는지는 **캔버스 픽셀 해시 비교**로 잰다.
  //   perf 텍스트 동일성은 fps 갱신 타이밍 때문에 흔들리고(실측 오판),
  //   브라우저 rAF 가 살아있는지는 우리 루프와 무관하다. 그림이 완전히 같으면 루프가 멈춘 것이다.
  const idle = await page.evaluate(async () => {
    const cv = document.getElementById('cv');
    const hash = () => {
      const c = cv.getContext('2d');
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4 * 31) { h ^= d[i] + d[i+1]*3 + d[i+2]*7; h = (h * 16777619) >>> 0; }
      return h;
    };
    const spin = document.getElementById('spin');
    if (spin.checked) { spin.checked = false; spin.dispatchEvent(new Event('change')); }
    // 소진 대기 (alpha 0 도달까지)
    await new Promise(r => setTimeout(r, 6000));
    const h1 = hash();
    await new Promise(r => setTimeout(r, 900));
    const h2 = hash();
    await new Promise(r => setTimeout(r, 900));
    const h3 = hash();
    const perf = document.getElementById('perf').textContent;
    return { h1, h2, h3, frozen: h1 === h2 && h2 === h3,
             idleLabel: /정지/.test(perf), alpha: (perf.match(/alpha ([\d.]+)/) || [])[1] };
  });
  out.measurements.idle = idle;
  check('E3: [핵심] 정지 후 렌더 루프가 실제로 멈춘다 — 그림이 더 이상 변하지 않는다 (CPU 0)',
    idle.frozen && idle.idleLabel && Number(idle.alpha) === 0, idle);

  // ④ LOD 임계 실제 전환 — 줌으로 배율을 넘나든다
  const lod = await page.evaluate(async () => {
    const r = document.getElementById('stage').getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const fire = (dy) => document.getElementById('stage').dispatchEvent(
      new WheelEvent('wheel', { deltaY: dy, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    const before = document.getElementById('lod').textContent;
    for (let i = 0; i < 6; i++) fire(-120);          // 확대
    await new Promise(r2 => setTimeout(r2, 120));
    const zoomed = document.getElementById('lod').textContent;
    for (let i = 0; i < 22; i++) fire(120);         // 축소 — LOD 임계(0.42) 아래까지
    await new Promise(r2 => setTimeout(r2, 120));
    const out2 = document.getElementById('lod').textContent;
    return { before, zoomed, zoomedOut: out2 };
  });
  out.measurements.lod = lod;
  check('E4: [핵심] LOD 임계가 실제로 전환된다 (확대 on ↔ 축소 off)',
    /on/.test(lod.zoomed) && /off/.test(lod.zoomedOut), lod);

  // ⑤ 허브 경유 경로 — 실측 데이터가 화면에 실제로 나오는가
  const paths = await page.evaluate(() => {
    const who = [...document.querySelectorAll('#paths .path .who')].map(e => e.textContent.trim());
    const hops = [...document.querySelectorAll('#paths .path .hop')].map(e => e.textContent.replace(/\s+/g,' ').trim());
    return {
      hubCount: who.length,
      hubLabel: document.getElementById('hubn').textContent,
      note: document.getElementById('hubnote').textContent.slice(0, 60),
      whosAll: who,
      whos: who.slice(0, 5),
      hops: hops.slice(0, 3)
    };
  });
  out.measurements.paths = paths;
  // 판정: 인물 **이름**이 나와야 한다. 해시 id(tsueo 같은)가 나오면 매칭이 안 된 것이다.
  // 잘라 온 배열(whos)과 전체 수(hubCount)를 섞어 비교하면 오판한다 — 실측에서 그렇게 오판했다.
  //   전수(whosAll)를 따로 받아 비교한다.
  const named = paths.whosAll.filter(w => /인물\s+[가-힣]{2,}/.test(w));
  check('E5: [핵심] 허브 경유 경로가 인물 **이름**과 함께 화면에 나온다 (실측 데이터)',
    paths.hubCount > 0 && named.length === paths.hubCount,
    { hubCount: paths.hubCount, namedCount: named.length, sample: paths.whos, hops: paths.hops });

  // ⑥ 규모 전환 — rebuild 가 실제로 값을 바꾸는가
  const scales = {};
  for (const n of ['24', '400']) {
    await page.evaluate(k => {
      document.querySelector('#scale button[data-n="' + k + '"]').click();
    }, n);
    await page.waitForTimeout(600);
    scales[n] = await page.evaluate(() => ({
      nodes: document.getElementById('perf').textContent.match(/노드 (\d+)/)?.[1],
      paths: document.querySelectorAll('#paths .path').length,
      note: document.getElementById('hubnote').textContent.slice(0, 40)
    }));
  }
  out.measurements.scales = scales;
  check('E6: 규모 전환이 실제로 그래프를 바꾼다 (24 ↔ 400)',
    String(scales['24'].nodes) !== String(scales['400'].nodes)
      && scales['24'].paths === 0 && scales['400'].paths > 0, scales);

  // ⑦ [핵심 제약] 큰 그래프에서 프레임 시간이 렉 기준(16.7ms) 안에 드는가.
  //   사용자 제약: "그래프 노드가 많아져도 렉이 걸리지 않도록".
  //   물리를 최대로 돌리는 상태(alpha 1, spin on)에서 잰다 — 정지 후에는 당연히 0 이라 의미가 없다.
  await page.evaluate(() => {
    const spin = document.getElementById('spin');
    if (!spin.checked) { spin.checked = true; spin.dispatchEvent(new Event('change')); }
  });
  await page.waitForTimeout(200);
  // [핵심 제약] 렉 기준 — **최악 조건**(조밀 배치 + 최대 alpha)에서 잰다.
  //   균일 배치만 재면 전쌍 반발력도 cutoff 밖이라 저렴해 보인다.
  //   실측: 균일 배치에서 O(n^2) 변이가 1.2ms 로 통과했다 — 검증이 무의미했다.
  const perf = await page.evaluate(async () => {
    document.querySelector('#scale button[data-n="400"]').click();
    await new Promise(r => setTimeout(r, 800));
    const t = window.__HME_TEST__;
    if (!t) return { error: 'no_test_hook' };
    // 규모별 × 배치별로 잰다
    const rows = [];
    for (const n of ['140', '400']) {
      document.querySelector('#scale button[data-n="' + n + '"]').click();
      await new Promise(r => setTimeout(r, 800));
      rows.push({ scale: n, layout: 'uniform', ...(await t.burst(20)) });
      t.densify(40);
      rows.push({ scale: n, layout: 'dense', ...(await t.burst(20)) });
    }
    // 400 규모의 조밀 배치가 최악 — 이걸 판정에 쓴다
    const worst = rows.filter(r => r.layout === 'dense').sort((a,b) => b.avg - a.avg)[0];
    return { rows, worst, labelsDrawn: window.__HME_TEST__.getState().labelsDrawn };
  });
  out.measurements.perf = perf;
  const worst = perf.worst || {};
  check('E7: [핵심 제약] 최악 조건(조밀 배치)에서도 프레임이 렉 기준 안에 든다 (avg < 16.7ms)',
    Number(worst.nodes) > 300 && worst.avg > 0 && worst.avg < 16.7,
    { worst, rows: (perf.rows || []).map(r => ({ scale: r.scale, layout: r.layout, nodes: r.nodes, avg: Number(r.avg.toFixed(2)), max: Number(r.max.toFixed(2)) })) });

  // ⑧ 반발력 구현 A/B — **측정으로 채택**한다. "격자가 항상 빠르다"는 가정은 실측에서 틀렸다.
  const ab = await page.evaluate(async () => {
    const t = window.__HME_TEST__;
    const rows = [];
    for (const dense of [false, true]) {
      document.querySelector('#scale button[data-n="400"]').click();
      await new Promise(r => setTimeout(r, 800));
      if (dense) t.densify(40);
      for (const mode of ['grid', 'pair']) {
        t.setRepulsion(mode);
        rows.push({ dense, ...(await t.ab(mode, 20)) });
      }
    }
    return rows;
  });
  out.measurements.repulsionAB = ab.map(r => ({
    dense: r.dense, mode: r.mode, nodes: r.nodes,
    avg: Number(r.avg.toFixed(2)), med: Number(r.med.toFixed(2)), max: Number(r.max.toFixed(2))
  }));
  const g400 = ab.find(r => r.mode === 'grid' && r.dense);
  const p400 = ab.find(r => r.mode === 'pair' && r.dense);
  const faster = (g400 && p400) ? (g400.avg <= p400.avg ? 'grid' : 'pair') : null;
  out.measurements.repulsionWinner = faster;
  check('E8: 반발력 두 구현을 같은 조건으로 재고 빠른 쪽을 채택했다',
    faster !== null && Number(g400.nodes) > 300, { winner: faster, ab: out.measurements.repulsionAB });

  // ⑨ [가시성] 그래프가 **화면 안에** 들어오는가 — 좌표가 맞아도 화면 밖이면 안 보인다.
  //   실측: fit 없이 346 노드가 반경 448px 로 퍼져 그래프의 절반이 뷰포트(724px) 밖으로 나갔다.
  const vis = await page.evaluate(async () => {
    // spin 을 꺼야 물리가 소진되고 자동 fit 이 돈다 (E7/E8 이 켜 놓았다).
    const spin = document.getElementById('spin');
    if (spin.checked) { spin.checked = false; spin.dispatchEvent(new Event('change')); }
    document.querySelector('#scale button[data-n="400"]').click();
    await new Promise(r => setTimeout(r, 11000));   // 물리 소진 + 자동 fit 까지 대기
    const t = window.__HME_TEST__;
    const st = t.getState();
    const r = t.bounds();
    const W = document.getElementById('stage').clientWidth, H = document.getElementById('stage').clientHeight;
    // 화면 좌표로 변환해 뷰포트 안 비율을 잰다
    return { W, H, scale: st.scale, tx: st.tx, ty: st.ty,
             minX: r.minX, maxX: r.maxX, minY: r.minY, maxY: r.maxY,
             screenW: (r.maxX - r.minX) * st.scale, screenH: (r.maxY - r.minY) * st.scale,
             nodes: st.nodes };
  }).catch(e => ({ error: String(e.message) }));
  out.measurements.visibility = vis;
  check('E9: [핵심] 그래프 전체가 뷰포트 안에 들어온다 (fit-to-view)',
    !vis.error && vis.screenW <= vis.W + 2 && vis.screenH <= vis.H + 2,
    vis);

  // ⑩ [정보 구조] 인물 허브가 서로 분리돼 있는가 — 겹치면 클러스터가 안 읽힌다.
  //   실측: 분리 전 4개 인물이 중심에 겹쳐 "허브 1개 + 기억 다수"처럼 보였다.
  const spread = await page.evaluate(async () => {
    const spin = document.getElementById('spin');
    if (spin.checked) { spin.checked = false; spin.dispatchEvent(new Event('change')); }
    document.querySelector('#scale button[data-n="400"]').click();
    await new Promise(r => setTimeout(r, 11000));
    const t = window.__HME_TEST__;
    const s2 = t.hubSpread(), st = t.getState();
    return { ...s2, scale: st.scale };
  });
  out.measurements.hubSpread = spread;
  // 화면 기준 최소 거리 — 노드 지름(약 18px)보다 충분히 떨어져야 라벨이 안 겹친다
  const screenMin = (spread.minDist || 0) * (spread.scale || 1);
  check('E10: [정보 구조] 인물 허브가 서로 분리돼 있다 (화면 기준 최소거리 > 60px)',
    spread.hubs >= 2 && screenMin > 60, { ...spread, screenMinDist: Number(screenMin.toFixed(1)) });

  await page.screenshot({ path: path.join(__dirname, '..', 'ux-prototype', '_shot-graph-400.png') });
  await page.evaluate(() => document.querySelector('#scale button[data-n="140"]').click());
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, '..', 'ux-prototype', '_shot-graph-140.png') });

  out.ok = out.checks.every(c => c.ok);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(out.ok ? 0 : 1);
})().catch(e => { console.log(JSON.stringify({ ok: false, fatal: String(e && e.stack || e) }, null, 2)); process.exit(1); });
