const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'parts', '15-gui-and-exports.js'), 'utf8');
const cssMatch = source.match(/const GUI_CSS = `([\s\S]*?)`;\s*\n\s*const GUI_BODY/);
const bodyMatch = source.match(/const GUI_BODY = `([\s\S]*?)`;\s*\n\s*\/\/ Pure/);
if (!cssMatch || !bodyMatch) throw new Error('GUI_CSS or GUI_BODY extraction failed');

const runtimePreview = String.raw`
(() => {
  const root = document.querySelector('.gui-wrap');
  // 실제 makeGuiAccordion(15a) 과 동일한 구조를 낸다 — idx 번호와 hint 포함.
  const makeAcc = (index, title, nodes, options = {}) => {
    const acc = document.createElement('div');
    acc.className = 'acc' + (options.open ? ' open' : '');
    const header = document.createElement('div');
    header.className = 'acc-h';
    header.innerHTML = '<span class="ttl"><span class="idx">' + String(index).padStart(2, '0') + '</span>' + title + '</span><span class="chev">›</span>';
    acc.appendChild(header);
    if (options.hint) {
      const hint = document.createElement('div');
      hint.className = 'acc-hint';
      hint.textContent = String(options.hint);
      acc.appendChild(hint);
    }
    const body = document.createElement('div');
    body.className = 'acc-b';
    nodes.filter(Boolean).forEach(node => body.appendChild(node));
    acc.appendChild(body);
    header.onclick = () => acc.classList.toggle('open');
    return acc;
  };
  const settings = root.querySelector('#tab-settings');
  const grid = settings.querySelector('.sgrid');
  const sections = Array.from(grid.children).filter(node => node.classList.contains('ss'));
  const response = sections.find(node => /응답 개선/.test(node.querySelector('h3')?.textContent || ''));
  const provider = settings.querySelector('[data-settings-section="llm-profiles"]');
  const heading = settings.querySelector('.panel-heading');
  const tail = Array.from(settings.childNodes).slice(Array.from(settings.childNodes).indexOf(grid) + 1).filter(node => node.nodeType !== 3 || node.textContent.trim());
  provider?.querySelector('h3')?.remove();
  const defaultField = provider?.querySelector('#sllmdefault')?.closest('.fld');
  const testButton = provider?.querySelector('#btn-test-llmp');
  const testStatus = provider?.querySelector('#llmp-test-status');
  const summary = document.createElement('section');
  summary.className = 'settings-overview';
  summary.innerHTML = '<div class="prototype-settings-heading"><h3>기본 LLM 프로필</h3><p>별도 연결 설정 없이 저장된 프로필 하나를 기본값으로 사용합니다.</p></div><div class="prototype-profile-summary"></div><div class="home-actions"></div>';
  if (defaultField) summary.querySelector('.prototype-profile-summary').appendChild(defaultField);
  const state = document.createElement('div'); state.className = 'fld'; state.innerHTML = '<label>연결 상태</label><div class="home-actions"><span class="status-pill ok">정상</span><span class="setting-note">기본 · Gemini 균형 · gemini-3.5-flash</span></div>';
  summary.querySelector('.prototype-profile-summary').appendChild(state);
  if (testButton) { testButton.textContent = '기본 프로필 테스트'; summary.querySelector('.home-actions').appendChild(testButton); }
  if (testStatus) summary.querySelector('.home-actions').appendChild(testStatus);
  const work = document.createElement('section'); work.className = 'prototype-work-mode'; work.innerHTML = '<div class="prototype-work-mode-head"><h3>작동 방식</h3><span>필요할 때만 켜는 보조 기능입니다.</span></div>';
  response?.querySelector('h3')?.remove(); Array.from(response?.childNodes || []).forEach(node => work.appendChild(node));
  const accs = [];
  // 실제와 동일한 한국어 제목 매핑 (composeSettingsPanelLayout).
  const mapTitle = (rawTitle) => {
    if (/Flex|Service Tier/.test(rawTitle)) return '모델 세부 설정과 Flex Service Tier';
    if (/Embedding|임베딩/.test(rawTitle)) return '임베딩과 기억 검색';
    if (/데이터 작성|가중치/.test(rawTitle)) return '분석 범위와 내부 데이터';
    if (/캐논 DB/.test(rawTitle)) return '캐논 DB와 고급 설정';
    return rawTitle.replace(/^[^\p{L}\p{N}]+/u, '');
  };
  if (provider) accs.push(makeAcc(1, 'LLM 프로필과 작업별 배정', Array.from(provider.childNodes), { open: true, key: 'settings-llm-profiles' }));
  sections.filter(node => node !== provider && node !== response).forEach((section, index) => {
    const titleNode = section.querySelector('h3');
    const rawTitle = titleNode?.textContent?.trim() || ('설정 ' + (index + 1));
    const title = mapTitle(rawTitle);
    titleNode?.remove();
    accs.push(makeAcc(index + 1 + (provider ? 0 : 0), title, Array.from(section.childNodes), {
      open: /Flex|Service Tier|Embedding|임베딩/.test(title),
      key: 'settings-' + (index + 1)
    }));
  });
  if (tail.length) accs.push(makeAcc(0, '데이터 관리와 진단', tail, { key: 'settings-cache-actions' }));
  // 실제와 동일하게 표시 번호를 01..N 으로 순차 재부여한다.
  accs.forEach((acc, order) => {
    const idxNode = acc.querySelector('.acc-h .idx');
    if (idxNode) idxNode.textContent = String(order + 1).padStart(2, '0');
  });
  settings.replaceChildren(heading, summary, work, ...accs);

  const activate = name => {
    root.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
    root.querySelectorAll('.tb').forEach(button => {
      const target = ['memory','entity','narrative','world'].includes(name) ? 'memory' : name;
      const selected = button.dataset.tab === target;
      button.classList.toggle('on', selected); button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  };
  root.querySelectorAll('.tb').forEach(button => button.onclick = () => activate(button.dataset.tab));
  root.querySelectorAll('[data-view-tab]').forEach(button => button.onclick = () => activate(button.dataset.viewTab));
  root.querySelector('#btn-home-settings').onclick = () => activate('settings');
  root.querySelector('#libra-global-status').textContent = '준비 완료 · T128까지 동기화됨';
  root.querySelector('#home-llm-pill').textContent = '정상'; root.querySelector('#home-llm-pill').classList.add('ok');
  root.querySelector('#home-llm-value').textContent = 'Gemini · 균형 모드';
  root.querySelector('#home-llm-note').textContent = '분석 모델이 연결되어 있습니다.';
  root.querySelector('#home-data-pill').textContent = '최신'; root.querySelector('#home-data-pill').classList.add('ok');
  root.querySelector('#home-data-value').textContent = '메모리 84 · 인물 12 · 관계 9';
  root.querySelector('#home-data-note').textContent = '마지막 동기화: T128';
  root.querySelector('#home-additional-pill').textContent = '4개'; root.querySelector('#home-additional-pill').classList.add('ok');
  root.querySelector('#home-additional-value').textContent = '추가 요소 2 · 자동 추적 2';
  root.querySelector('#home-additional-note').textContent = '다음 응답에 자동 반영됩니다.';
  root.querySelector('#home-sync-title').textContent = '새 대화 6개가 아직 반영되지 않았습니다';
  // 메모리 '그래프' 보기 — 실제 제품 배선을 흉내내지 않고 같은 계약을 심는다.
  //   여기서 재는 것은 마크업·CSS·렌더 경로가 화면에서 실제로 보이는가다.
  //   실제 배선 검증은 test:mem-graph-view 가 실행 하니스로 한다.
  //   (이 블록은 백틱 리터럴 안이므로 템플릿 문자열을 쓰지 않는다 — 쓰면 파일이 깨진다.)
  (() => {
    const host = root.querySelector('#ml-graph');
    const cv = root.querySelector('#ml-graph-cv');
    const kpi = root.querySelector('#ml-graph-kpi');
    const paths = root.querySelector('#ml-graph-paths');
    const card = root.querySelector('#ml');
    const tblNode = root.querySelector('#ml-table');
    const tbl = tblNode && tblNode.closest('.tbl');
    if (!host || !cv) return;
    const WHO = ['아리엘', '세라', '카일', '미르'];
    const nodes = [], edges = [];
    const W = 820, H = 460;
    for (let i = 1; i <= 60; i += 1) {
      const a = (i * 2.399963) % (Math.PI * 2);
      const r = 40 + Math.sqrt(i) * 22;
      nodes.push({ id: 'm' + i, type: 'memory', label: 'm_' + i, turn: i,
                   x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0, deg: 0 });
    }
    WHO.forEach((n, i) => {
      const a = (i / WHO.length) * Math.PI * 2;
      nodes.push({ id: 'e' + i, type: 'entity', label: n, turn: 1, deg: 0,
                   x: W / 2 + Math.cos(a) * 120, y: H / 2 + Math.sin(a) * 120, vx: 0, vy: 0 });
    });
    nodes.push({ id: 'l0', type: 'lore', label: 'lb_별핵', turn: 1, deg: 0, x: W / 2 - 220, y: 90, vx: 0, vy: 0 });
    nodes.push({ id: 'l1', type: 'lore', label: 'lb_북부', turn: 1, deg: 0, x: W / 2 + 220, y: H - 90, vx: 0, vy: 0 });
    const by = new Map(nodes.map(n => [n.id, n]));
    for (let i = 1; i <= 60; i += 1) {
      const e = by.get('e' + (i % WHO.length)), m = by.get('m' + i);
      edges.push({ a: e, b: m, relation: 'mentions_entity', weight: 1 }); e.deg += 1; m.deg += 1;
      if (i > 1) edges.push({ a: by.get('m' + (i - 1)), b: m, relation: 'turn_proximity', weight: .4 });
    }
    edges.push({ a: by.get('l0'), b: by.get('e0'), relation: 'described_by_lore', weight: .7 });
    edges.push({ a: by.get('l1'), b: by.get('e2'), relation: 'described_by_lore', weight: .6 });
    for (let it = 0; it < 60; it += 1) {
      for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
        const A = nodes[i], B = nodes[j];
        const dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy;
        if (d2 > 90000 || d2 < 1e-4) continue;
        const f = 900 / d2, d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
        A.vx -= ux * f; A.vy -= uy * f; B.vx += ux * f; B.vy += uy * f;
      }
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = 46 + 130 * (1 - Math.min(1, e.weight));
        const f = (d - rest) * 0.0016 * (e.weight + .25), ux = dx / d, uy = dy / d;
        e.a.vx += ux * f; e.a.vy += uy * f; e.b.vx -= ux * f; e.b.vy -= uy * f;
      }
      for (const q of nodes) {
        q.vx += (W / 2 - q.x) * 0.0012; q.vy += (H / 2 - q.y) * 0.0016;
        q.vx *= .6; q.vy *= .6; q.x += q.vx; q.y += q.vy;
      }
    }
    const hubs = nodes.filter(n => n.type === 'entity');
    for (let i = 0; i < hubs.length; i += 1) for (let j = i + 1; j < hubs.length; j += 1) {
      const A = hubs[i], B = hubs[j];
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1;
      if (d >= 170) continue;
      const push = (170 - d) * .5, ux = dx / d, uy = dy / d;
      A.x -= ux * push; A.y -= uy * push; B.x += ux * push; B.y += uy * push;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of nodes) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    const sc = Math.min(1.8, Math.max(.18, Math.min(W / ((x1 - x0) + 128), H / ((y1 - y0) + 128))));
    const tx = W / 2 - ((x0 + x1) / 2) * sc, ty = H / 2 - ((y0 + y1) / 2) * sc;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    const ctx = cv.getContext('2d');
    ctx.setTransform(DPR * sc, 0, 0, DPR * sc, DPR * tx, DPR * ty);
    const COL = { entity: '#c9a15a', lore: '#339cff', memory: '#6d8090' };
    const REL = { mentions_entity: 'rgba(201,161,90,.55)', described_by_lore: 'rgba(51,156,255,.5)',
                  turn_proximity: 'rgba(109,128,144,.16)' };
    for (const e of edges) {
      ctx.strokeStyle = REL[e.relation] || 'rgba(109,128,144,.2)';
      ctx.lineWidth = .9; ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    for (const q of nodes) {
      const r = (q.type === 'entity' ? 9 : q.type === 'lore' ? 7 : 4.2) * (1 + Math.min(.5, q.deg / 40));
      if (q.type === 'entity') { ctx.beginPath(); ctx.arc(q.x, q.y, r * 2.6, 0, 6.2832); ctx.fillStyle = 'rgba(201,161,90,.10)'; ctx.fill(); }
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 6.2832); ctx.fillStyle = COL[q.type]; ctx.fill();
      if (q.type !== 'memory') { ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(12,16,19,.85)'; ctx.stroke(); }
    }
    ctx.font = '600 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const placed = [];
    const labels = nodes.filter(q => q.type !== 'memory').concat(nodes.filter(q => q.type === 'memory' && q.deg > 4));
    for (const q of labels) {
      const t = q.type === 'memory' ? ('T' + q.turn) : q.label;
      const w = ctx.measureText(t).width, ly = q.y + 12;
      const clash = placed.some(z => q.x - w / 2 < z.x1 + 15 && q.x + w / 2 + 15 > z.x0 && ly < z.y1 + 4 && ly + 12 > z.y0);
      if (clash) continue;
      placed.push({ x0: q.x - w / 2, x1: q.x + w / 2, y0: ly, y1: ly + 12 });
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(12,16,19,.9)'; ctx.strokeText(t, q.x, ly);
      ctx.fillStyle = q.type === 'memory' ? '#9fb0bd' : '#e7edf1'; ctx.fillText(t, q.x, ly);
    }
    kpi.innerHTML = '<div><div class="v">' + nodes.length + ' / 406</div><div class="k">노드</div></div>'
      + '<div><div class="v">' + edges.length + ' / 1424</div><div class="k">엣지</div></div>'
      + '<div><div class="v">4</div><div class="k">인물</div></div>'
      + '<div><div class="v">2</div><div class="k">로어</div></div>';
    paths.innerHTML = '<div class="mg-empty" style="padding:2px 0 6px">엣지 관계<br>'
      + '<b style="color:var(--accent2)">mentions_entity</b> 400<br>'
      + '<b style="color:var(--accent2)">shared_entity</b> 896<br>'
      + '<b style="color:var(--accent2)">turn_proximity</b> 128<br>'
      + '<b style="color:var(--accent2)">described_by_lore</b> 2</div>';
    host.classList.remove('hide');
    if (card) card.classList.add('hide');
    if (tbl) tbl.classList.add('hide');
    const gbtn = root.querySelector('[data-mem-view="graph"]');
    if (gbtn) root.querySelectorAll('[data-mem-view]').forEach(x => x.classList.toggle('on', x === gbtn));
  })();
  // 관계 화면 '그래프' 보기 — 같은 계약을 심는다. 실제 배선 검증은 test:rel-graph-view 가 한다.
  //   (이 블록은 백틱 리터럴 안이므로 템플릿 문자열을 쓰지 않는다.)
  (() => {
    const host = root.querySelector('#rl-graph');
    const cv = root.querySelector('#rl-graph-cv');
    const kpi = root.querySelector('#rl-graph-kpi');
    const paths = root.querySelector('#rl-graph-paths');
    const rowHost = root.querySelector('#rl');
    const wrap = rowHost && rowHost.closest('.tbl-wrap');
    if (!host || !cv) return;
    const WHO = ['아리엘', '세라', '카일', '미르'];
    const W = 820, H = 460;
    const nodes = WHO.map((n, i) => {
      const a = (i / WHO.length) * Math.PI * 2 - Math.PI / 2;
      return { id: 'e' + i, label: n, type: 'entity', turn: 1, deg: 0,
               x: W / 2 + Math.cos(a) * 130, y: H / 2 + Math.sin(a) * 130, vx: 0, vy: 0 };
    });
    const RELS = [[0, 1, 0.8], [0, 2, 0.35], [1, 3, 0.6], [2, 3, 0.5], [0, 3, 0.25]];
    const edges = [];
    for (const [i, j, w] of RELS) {
      edges.push({ a: nodes[i], b: nodes[j], relation: 'relation_record', weight: w });
      nodes[i].deg += w; nodes[j].deg += w;
    }
    // fit — 제품은 물리 정지 시 graphFit 이 돈다. 프리뷰가 안 하면 화면이 제품과 달라진다(실측).
    let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
    for (const q of nodes) { if (q.x < fx0) fx0 = q.x; if (q.x > fx1) fx1 = q.x; if (q.y < fy0) fy0 = q.y; if (q.y > fy1) fy1 = q.y; }
    const fsc = Math.min(1.8, Math.max(.18, Math.min(W / ((fx1 - fx0) + 128), H / ((fy1 - fy0) + 128))));
    const ftx = W / 2 - ((fx0 + fx1) / 2) * fsc, fty = H / 2 - ((fy0 + fy1) / 2) * fsc;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    const ctx = cv.getContext('2d');
    ctx.setTransform(DPR * fsc, 0, 0, DPR * fsc, DPR * ftx, DPR * fty);
    // 관계선 — 두께·색으로 친밀도를 드러낸다
    for (const e of edges) {
      const close = e.weight;
      ctx.strokeStyle = 'rgba(201,161,90,' + (0.3 + close * 0.6).toFixed(2) + ')';
      ctx.lineWidth = 1 + close * 3;
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    for (const p of nodes) {
      const r = 11 * (1 + Math.min(.6, p.deg / 3));
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.6, 0, 6.2832); ctx.fillStyle = 'rgba(201,161,90,.10)'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fillStyle = '#c9a15a'; ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(12,16,19,.85)'; ctx.stroke();
    }
    ctx.font = '600 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const p of nodes) {
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(12,16,19,.9)';
      ctx.strokeText(p.label, p.x, p.y + 15);
      ctx.fillStyle = '#e7edf1'; ctx.fillText(p.label, p.x, p.y + 15);
    }
    kpi.innerHTML = '<div><div class="v">4 / 4</div><div class="k">인물</div></div>'
      + '<div><div class="v">' + RELS.length + '</div><div class="k">관계</div></div>'
      + '<div><div class="v">' + edges.length + '</div><div class="k">엣지</div></div>'
      + '<div><div class="v">' + Math.round(edges.reduce((a, e) => a + e.weight, 0) / edges.length * 100) + '%</div><div class="k">평균 수치</div></div>';
    paths.innerHTML = '<div class="mg-empty" style="padding:2px 0 6px">엣지 관계<br>'
      + '<b style="color:var(--accent2)">relation_record</b> 3<br>'
      + '<b style="color:var(--accent2)">shared_entity</b> 896<br>'
      + '<b style="color:var(--accent2)">mentions_entity</b> 40</div>';
    host.classList.remove('hide');
    if (!document.getElementById('pv-hit-note')) {
      const note = document.createElement('div');
      note.id = 'pv-hit-note';
      note.style.cssText = 'position:static;margin-top:6px;font-size:11px;color:#c9a15a;opacity:0;transition:.15s';
      host.appendChild(note);
    }
    if (rowHost) rowHost.classList.add('hide');
    if (wrap) wrap.classList.add('hide');
    const gbtn = root.querySelector('[data-rel-view="graph"]');
    if (gbtn) root.querySelectorAll('[data-rel-view]').forEach(x => x.classList.toggle('on', x === gbtn));
    // 상호작용(C) — 클릭하면 그 인물의 프로필 패널로 이동한다.
    //   좌표 변환은 fit(위)의 역이며, 제품 hit test 와 같은 규칙이다.
    const hitAt = (clientX, clientY) => {
      const rect = cv.getBoundingClientRect();
      const wx = (clientX - rect.left - ftx) / fsc;
      const wy = (clientY - rect.top - fty) / fsc;
      let best = null, bestD = Infinity;
      for (const q of nodes) {
        const rr = 11 * (1 + Math.min(.6, q.deg / 3)) + 16;
        const d = Math.hypot(q.x - wx, q.y - wy);
        if (d <= rr && d < bestD) { best = q; bestD = d; }
      }
      return best;
    };
    cv.style.cursor = 'default';
    cv.addEventListener('mousemove', (ev) => {
      const h = hitAt(ev.clientX, ev.clientY);
      cv.style.cursor = h ? 'pointer' : 'default';
      cv.style.outline = h ? '2px solid #e0bd7c' : 'none';
      cv.style.outlineOffset = h ? '-2px' : '0';
    });
    cv.addEventListener('mouseleave', () => { cv.style.cursor = 'default'; cv.style.outline = 'none'; });
    cv.addEventListener('click', (ev) => {
      const h = hitAt(ev.clientX, ev.clientY);
      if (!h) return;
      // 프리뷰에는 실제 프로필 렌더러가 없다 — 이동 경로를 배지로 알린다.
      const note = document.getElementById('pv-hit-note');
      if (note) note.textContent = '→ ' + h.label + ' 프로필로 이동';
      if (note) note.style.opacity = '1';
    });
  })();
  root.querySelector('#home-recent-list').innerHTML = '<div class="home-recent-row"><div class="home-recent-copy"><strong>아리엘과 유진의 신뢰가 상승했습니다</strong><span class="home-card-note">관계 · T127 · 직접 근거 확인됨</span></div><button class="btn bs">보기</button></div><div class="home-recent-row"><div class="home-recent-copy"><strong>폐쇄 색인실이 세계관 정본에 추가되었습니다</strong><span class="home-card-note">세계관 · T126 · 사용자 설정</span></div><button class="btn bs">보기</button></div>';
})();`;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIBRA production GUI preview</title><style>${cssMatch[1]}</style></head><body>${bodyMatch[1]}<script>${runtimePreview}</script></body></html>`;
const output = path.join(root, 'review-checkpoints', 'libra-production-gui-preview.html');
fs.writeFileSync(output, html, 'utf8');
console.log(output);
