// MemorySuite GUI verification -- stage 1 (diagnostics surfacing, LIBRA correction notice)
// and stage 2 (host theme bridge, list filters, defaults restore, scroll/focus preservation).
// Static structure checks plus real execution of the new pure render functions.
// Run: node gui_stage2_verify.js
const fs = require('fs');

const P = require('path').join(__dirname, '../plugins/');
const read = name => fs.readFileSync(P + name, 'utf8');
const libra = read('LIBRA.js');
const flash = read('Flashback_Memory.js');
const hayaku = read('HAYAKU_Locator_Continuity.js');

const rows = [];
const check = (label, ok, detail = '') => rows.push({ label, ok: !!ok, detail });
const count = (text, needle) => text.split(needle).length - 1;
const defines = (text, name) => new RegExp('const\\s+' + name + '\\s*=').test(text);
// Line-ending agnostic slice: normalise before searching so \r\n files behave like \n.
const norm = text => text.replace(/\r\n/g, '\n');
const sliceFn = (text, startMarker, endMarker) => {
  const source = norm(text);
  const a = source.indexOf(startMarker);
  if (a < 0) return null;
  const b = source.indexOf(endMarker, a);
  if (b < 0) return null;
  return source.slice(a, b + endMarker.length);
};

// ---------------------------------------------------------------- stage 1: LIBRA notice
check('LIBRA: 죽었던 라벨 함수가 호출됨', count(libra, 'worldManagerCorrectionStatusCopy(') >= 1,
  'refs=' + count(libra, 'worldManagerCorrectionStatusCopy'));
for (const name of ['worldManagerCorrectionReasonCopy', 'worldManagerCorrectionStalled',
  'buildWorldManagerCorrectionsPanel', 'buildWorldManagerStalledCorrectionNotice',
  'worldManagerStalledCorrectionCount', 'buildSwallowedDiagPanel']) {
  check('LIBRA: ' + name, defines(libra, name) && count(libra, name + '(') >= 1,
    'defined=' + defines(libra, name) + ' calls=' + count(libra, name + '('));
}
check('LIBRA: 교정 필터 기본값 all', /worldManagerCorrectionFilter:\s*'all'/.test(libra));
check('LIBRA: 롤백 확인창 휴면 경고', /되돌릴까요[\s\S]{0,240}이후 교정은 휴면 상태가 됩니다/.test(norm(libra)));

// ------------------------------------------------------- stage 1: Flashback log surfacing
check('Flashback: 숨겨진 로그 래퍼 제거', !flash.includes('<div style="display:none"><div id="lastActionLog">'));
check('Flashback: warningLog id 1회', count(flash, 'id="warningLog"') === 1, 'n=' + count(flash, 'id="warningLog"'));
check('Flashback: lastActionLog id 1회', count(flash, 'id="lastActionLog"') === 1);
check('Flashback: 활동 로그 패널이 렌더 함수로 갱신됨',
  defines(flash, 'renderActivityLogHtml') && /getGuiNode\('activityLogList'\)[\s\S]{0,80}innerHTML = renderActivityLogHtml\(\)/.test(norm(flash)));

// -------------------------------------------------- stage 1: HAYAKU diagnostics (now wrapped)
check('HAYAKU: 진단 렌더 함수 존재', defines(hayaku, 'viewerRenderSwallowedDiagInner'));
check('HAYAKU: 진단 렌더가 스크롤 보존으로 감싸짐',
  /const viewerRenderSwallowedDiag = \(\.\.\.args\) => viewerPreserveScroll\(/.test(norm(hayaku)));
check('HAYAKU: 진단 패널 컨테이너 1개', count(hayaku, 'id="hayakuViewerSwallowedDiag"') === 1);

// ------------------------------------------------------------ stage 2: theme bridge, all three
for (const [label, text] of [['Flashback', flash], ['HAYAKU', hayaku], ['LIBRA', libra]]) {
  check(label + ': 테마 브리지 설치', text.includes('globalThis.__memorySuiteTheme = bridge'));
  check(label + ': getColorScheme 사용', text.includes("typeof api.getColorScheme !== 'function'"));
  check(label + ': 테마 시작 호출', /__memorySuiteTheme\?\.start\?\.\(/.test(text));
  check(label + ': 테마 정지 호출', /__memorySuiteTheme\?\.stop\?\.\(/.test(text));
  // The host-colour mapping CSS was retired with the shared Librarian Suite GUI design system:
  // the bridge now only publishes data-risu-theme attributes, and the opt-in switch below stays.
  check(label + ': 색 추종 속성은 opt-in일 때만 설정', /if \(this\.followColors === true\) root\.setAttribute\('data-risu-theme-colors', '1'\);\s*else root\.removeAttribute\('data-risu-theme-colors'\);/.test(norm(text)));
  // Colour following is opt-in: the mapped palette measured worse than the hand-tuned one.
  check(label + ': 색 추종은 기본 꺼짐', /followColors: false,/.test(text));
  check(label + ': 색 추종 전환 메서드', /setFollowColors\(on\) \{/.test(text));
  check(label + ': 부분 팔레트 거부', text.includes("this.lastError = 'missing colour: '"));
}
check('HAYAKU: 호스트 테마 타입을 data 속성으로 받음', hayaku.includes("root.setAttribute('data-risu-theme-type', type);"));
check('LIBRA: Book 종이 테마는 light 색상 체계 유지', libra.includes("const bookTheme = String(panelOptions.theme || '').toLowerCase() === 'book';") && libra.includes('#${rootId}{color-scheme:light;'));

// ----------------------------------------- stage 2: theme bridge actually runs and is safe
const bridgeText = sliceFn(flash, '      const THEME_KEYS = [', '      globalThis.__memorySuiteTheme = bridge;');
check('Flashback: 브리지 코드를 원본에서 그대로 잘라냄', !!bridgeText && norm(flash).includes(bridgeText || 'x'),
  'len=' + (bridgeText || '').length);
if (bridgeText) {
  const styleWrites = [];
  const attrs = {};
  const fakeRoot = {
    style: { setProperty: (name, value) => styleWrites.push([name, value]) },
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: name => { delete attrs[name]; },
  };
  const fakeGlobal = { document: { documentElement: fakeRoot } };
  const make = new Function('globalThis', bridgeText + '\n return globalThis.__memorySuiteTheme;');
  const bridge = make(fakeGlobal);

  const full = {
    bgcolor: '#0b0e14', darkbg: '#141923', borderc: '#7ea5f8', selected: '#222b3d',
    draculared: '#ff7d86', textcolor: '#f2f5fa', textcolor2: '#b0bad0',
    darkBorderc: '#2d384d', darkbutton: '#1a2130', type: 'light',
  };
  check('브리지: 완전한 팔레트 적용', bridge.apply({ name: 'test', scheme: full }) === true);
  check('브리지: 9개 변수 전부 기록', styleWrites.length === 9, 'writes=' + styleWrites.length);
  check('브리지: data-risu-theme 설정', attrs['data-risu-theme'] === '1');
  check('브리지: light 타입 반영', attrs['data-risu-theme-type'] === 'light');
  check('브리지: darkBorderc -> darkborderc 변환',
    styleWrites.some(([name, value]) => name === '--risu-theme-darkborderc' && value === '#2d384d'));

  const before = styleWrites.length;
  bridge.apply({ name: 'test', scheme: full });
  check('브리지: 같은 팔레트는 다시 쓰지 않음', styleWrites.length === before, 'writes=' + styleWrites.length);

  const partial = { ...full };
  delete partial.darkbutton;
  check('브리지: 불완전한 팔레트 거부', bridge.apply({ scheme: partial }) === false, bridge.lastError);
  check('브리지: 거부해도 이전 값 유지', styleWrites.length === before);
  check('브리지: null 입력 거부', bridge.apply(null) === false);
  check('브리지: 색이 아닌 값 거부', bridge.apply({ scheme: { ...full, bgcolor: '<script>' } }) === false);
  check('브리지: status() 동작', typeof bridge.status().applied === 'boolean');
}

// ------------------------------------------------- stage 2: Flashback list filter runs for real
const filterText = sliceFn(flash, '  const applyGuiListFilter = (inputId, containerId, itemSelector, countId = \'\') => {',
  '  const GUI_LIST_FILTERS = Object.freeze([');
check('Flashback: 필터 코드를 원본에서 그대로 잘라냄', !!filterText, 'len=' + (filterText || '').length);
if (filterText) {
  const body = filterText.slice(0, filterText.lastIndexOf('  const GUI_LIST_FILTERS'));
  const nodes = [
    { text: '유나가 은열쇠를 건넸다', hidden: false, hasAttribute: () => false },
    { text: '금고 장부를 확인했다', hidden: false, hasAttribute: () => false },
    { text: '자리표시자', hidden: false, hasAttribute: name => name === 'data-gui-filter-exempt' },
  ];
  for (const node of nodes) Object.defineProperty(node, 'textContent', { get() { return this.text; } });
  const container = { querySelectorAll: () => nodes };
  let inputValue = '';
  const counts = {};
  const fn = new Function('getGuiNode', 'text', 'formatNumber', 'setNodeText', 'globalThis',
    body + '\n return applyGuiListFilter;')(
    id => (id === 'in' ? { value: inputValue } : (id === 'box' ? container : null)),
    v => String(v == null ? '' : v),
    n => String(n),
    (id, value) => { counts[id] = value; },
    {});

  let result = fn('in', 'box', 'tr', 'n');
  check('필터: 빈 검색이면 전부 표시', result.shown === 2 && nodes.every(node => node.hidden === false),
    JSON.stringify(result));
  inputValue = '은열쇠';
  result = fn('in', 'box', 'tr', 'n');
  check('필터: 일치하는 항목만 남김', result.shown === 1 && nodes[0].hidden === false && nodes[1].hidden === true,
    JSON.stringify(result));
  check('필터: 자리표시자 행은 절대 숨기지 않음', nodes[2].hidden === false);
  check('필터: 표시 개수 갱신', String(counts.n || '').includes('1'), counts.n);
  inputValue = '없는말';
  result = fn('in', 'box', 'tr', 'n');
  check('필터: 일치 없으면 0개', result.shown === 0);
}

// --------------------------------------------- stage 2: Flashback defaults restore + view state
check('Flashback: 기본값 복원 함수', defines(flash, 'restoreDefaultSettingsToUi'));
check('Flashback: ARG 강제 항목은 건너뜀', /flashbackSettingSource\(key\) === 'argument'\) \{ skipped\.push\(key\); continue; \}/.test(flash));
check('Flashback: 복원은 저장하지 않음(draft)', !/restoreDefaultSettingsToUi[\s\S]{0,600}await saveSettings/.test(norm(flash)));
check('Flashback: 복원 버튼 2개', count(flash, 'restoreDefaultsBtn') >= 2 && count(flash, 'restoreAdvancedDefaultsBtn') >= 2);
check('Flashback: 뷰 상태 캡처/복원 함수', defines(flash, 'captureGuiViewState') && defines(flash, 'restoreGuiViewState'));
check('Flashback: 재마운트가 캡처를 먼저 함',
  /const viewState = captureGuiViewState\(root\);[\s\S]{0,80}const html = await buildUiHtml\(\);/.test(norm(flash)));
check('Flashback: 재마운트 뒤 복원 호출',
  /bindUiEvents\(root\);\s*restoreGuiViewState\(root, viewState\);/.test(norm(flash)));
check('Flashback: 스크롤 대상에 4개 컨테이너 포함',
  flash.includes("const GUI_SCROLL_SELECTOR = '.tabs,.list,.table-wrap,[data-manual-editor]';"));

// --------------------------------------------------- stage 2: HAYAKU filters + scroll + defaults
check('HAYAKU: 목록 필터 정의 3개', count(hayaku, "Object.freeze({ input: 'hayaku") === 3);
for (const id of ['hayakuWorldlineFilter', 'hayakuLogFilter', 'hayakuSwallowedDiagFilter']) {
  check('HAYAKU: ' + id + ' 입력 존재', count(hayaku, 'id="' + id + '"') === 1);
}
check('HAYAKU: 설정 검색', count(hayaku, 'id="hayakuSettingsFilter"') === 1 && defines(hayaku, 'viewerApplySettingsFilter'));
check('HAYAKU: 섹션별 기본값', count(hayaku, 'button[data-load-defaults="[data-subpanel]"]') === 1 && defines(hayaku, 'viewerLoadSectionDefaults'));
const sectionDefaults = sliceFn(hayaku, '  const viewerLoadSectionDefaults = () => {', '    return { section, restored };');
check('HAYAKU: 섹션 기본값 함수를 원본에서 그대로 잘라냄', !!sectionDefaults, 'len=' + (sectionDefaults || '').length);
check('HAYAKU: 섹션 기본값은 저장하지 않음(draft만)',
  !!sectionDefaults && !/viewerApplySettings|setArgument|storage\.set|saveStateCorrection/.test(sectionDefaults),
  'writes=none');
check('HAYAKU: 스크롤 보존이 async 렌더를 기다림',
  /if \(result && typeof result\.then === 'function'\)/.test(hayaku));
check('HAYAKU: 4개 렌더 모두 래핑', count(hayaku, '=> viewerPreserveScroll(') === 4, 'n=' + count(hayaku, '=> viewerPreserveScroll('));
check('HAYAKU: 필터 재적용이 after 콜백에서 실행', count(hayaku, '() => viewerApplyListFilter(VIEWER_LIST_FILTERS.find(') === 4);

// ---------------------------------------- stage 3: shared Librarian Suite GUI design system + Korean typography
// The retired --ms-* token block was replaced by one shared design-system stylesheet that every
// plugin embeds verbatim; these checks pin its Korean-typography and accessibility rules.
const DS_START = 'Librarian Suite GUI — 공용 디자인 시스템';
const designSystem = text => {
  const source = norm(text), a = source.indexOf(DS_START);
  if (a < 0) return '';
  const b = source.indexOf('/* ---------- 시안 도구줄', a);
  return b < 0 ? '' : source.slice(a, b);
};
const systems = [designSystem(flash), designSystem(hayaku), designSystem(libra)];
for (const [label, text, css] of [['Flashback', flash, systems[0]], ['HAYAKU', hayaku, systems[1]], ['LIBRA', libra, systems[2]]]) {
  check(label + ': 공용 디자인 시스템 블록 1회만', count(text, DS_START) === 1 && css.length > 800, 'n=' + count(text, DS_START) + ' len=' + css.length);
  check(label + ': 한글 우선 글꼴 스택', /--font-sans:Pretendard[^;]*"Noto Sans KR"[^;]*"Malgun Gothic"/.test(css.replace(/\\"/g, '"')));
  check(label + ': 본문 줄간격 1.65', css.includes('font:var(--fs-body)/1.65 var(--font-sans)'));
  check(label + ': 모서리 3단계', ['--r-sm:7px', '--r-md:11px', '--r-lg:15px'].every(t => css.includes(t)));
  check(label + ': 타입 스케일(최소 12px 본문 계열)',
    ['--fs-note:12px', '--fs-body:13px', '--fs-sub:15px', '--fs-title:19px', '--fs-page:27px'].every(t => css.includes(t)));
  check(label + ': 로컬 모션 토큰 사용', css.includes('--motion:.16s'));
  check(label + ': 모션 축소 설정 존중', css.includes('@media (prefers-reduced-motion:reduce){:root{--motion:0s}*{animation:none!important;scroll-behavior:auto!important}}'));
  check(label + ': 한글 단어 중간 줄바꿈 금지', css.includes('word-break:keep-all'));
  // keep-all alone would let a hash overflow its box; overflow-wrap must accompany it.
  check(label + ': 긴 토큰은 넘치지 않게 overflow-wrap 동반', css.includes('overflow-wrap:break-word'));
  // Code must keep character breaking, otherwise JSON dumps get ragged.
  check(label + ': 코드 블록은 문자 단위 줄바꿈 유지', css.includes('code,pre,kbd,textarea{font-family:var(--font-mono);word-break:break-all}'));
  check(label + ': 숫자 자릿수 정렬', css.includes('font-variant-numeric:tabular-nums'));
  check(label + ': 키보드 포커스 표시', css.includes(':focus-visible{outline:2px solid'));
  check(label + ': 블러/반투명 큰 면 금지 규칙 준수', !/backdrop-filter\s*:/.test(css));
}
check('LIBRA: Book 종이 서체 보존(Georgia 세리프 선언)', count(libra, 'Georgia,"Noto Serif KR",serif') >= 1,
  'n=' + count(libra, 'Georgia,"Noto Serif KR",serif'));
check('세 파일의 공용 디자인 시스템 블록이 완전히 동일', systems[0].length > 800 && systems[0] === systems[1] && systems[1] === systems[2],
  'len=' + systems.map(b => b.length).join('/'));

// ------------------------------------------- elevation must not be taken from host greys
for (const [label, text] of [['Flashback', flash], ['HAYAKU', hayaku], ['LIBRA', libra]]) {
  // RisuAI's `darkbg` is DARKER than `bgcolor`; the shared design system never maps surfaces to it.
  check(label + ': 카드 표면이 host darkbg를 쓰지 않음', !/--surface:var\(--risu-theme-darkbg\)/.test(text));
  check(label + ': 테마별 강조색 4종 정의', ['#126457', '#2a55c4', '#5568e8', '#7352a3'].every(color => text.includes('--accent:' + color + ';')));
}

// ------------------------------------------------------------------------------------ report
const pad = Math.max(...rows.map(r => r.label.length));
for (const r of rows) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label.padEnd(pad) + (r.detail ? '  ' + r.detail : ''));
const failed = rows.filter(r => !r.ok).length;
console.log('\n' + (rows.length - failed) + '/' + rows.length + ' passed');
process.exit(failed ? 1 : 0);
