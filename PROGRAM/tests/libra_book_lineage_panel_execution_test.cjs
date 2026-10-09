'use strict';
// THE READING-DESK PANEL MUST EXECUTE, NOT MERELY EXIST.
//
// MEASURED DEFECT (reported from a live reading desk, screen 4):
//   ReferenceError: string is not defined — thrown from buildBookHostLineagePanel.
//   `string` is a LIBRA memory-core LOCAL helper (defined inside the core closure). The GUI panel
//   cannot reach it, so the very first render of the reading desk threw. The panel is invoked while
//   buildBookDeskPanel builds its children array, so the failure took down the whole desk view even
//   though the worldline block sits inside a collapsed <details>.
//
// WHY THE EXISTING SUITE MISSED IT:
//   libra_host_worldline_gui_contract_test.cjs reads the panel SOURCE and asserts that certain
//   field labels appear in it. A string-presence check cannot see a runtime ReferenceError — the
//   offending line is present, and it is broken. That is the verification gap this suite closes.
//
// WHAT THIS SUITE LOCKS:
//   1. the shipped panel source can be EXECUTED; it returns a section node;
//   2. no bare `string(` call survives in the panel (only `String(`), so the same mistake cannot
//      come back through another field;
//   3. the panel still reports the branch/root distinction the GUI contract test protects;
//   4. the empty/unavailable snapshot path renders too (the desk must not break on first open);
//   5. the context deliberately does NOT define `string` — injecting the helper would hide the bug.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const between = (a, b) => {
  const i = source.indexOf(a); const j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `source anchors not found: ${a} .. ${b}`);
  return source.slice(i, j);
};
const panelSource = between('const buildBookHostLineagePanel =', 'const buildBookDeskPanel =');

// A DOM-free element model, the same shape the other GUI runtime suites use.
const el = (tag, attrs = {}, children = []) => ({ tag, ...attrs, children: children.filter(Boolean) });
const flat = n => [n, ...(n.children || []).flatMap(flat)];

const context = vm.createContext({
  // NOTE: `string` is intentionally ABSENT. It is a core-local helper; the panel must not need it.
  guiEl: el,
  LibraMemoryCore: { peekSnapshot: () => currentSnapshot },
  MemorySuiteHostLineage: { normalize: value => value || null }
});
let currentSnapshot = null;

vm.runInContext(`${panelSource};Object.assign(globalThis,{buildBookHostLineagePanel});`, context);

const lineage = extra => ({
  hostChatId: 'unified-chat', status: 'verified', kind: 'native_branch',
  path: ['parent-chat', 'unified-chat'], parentName: '이전 도서관', parentChatId: 'parent-chat',
  forkMessageId: 'm-42', commonPrefixPairs: 5, commonPrefixMessages: 12,
  canonicalPrefixEnd: 5, partialCanonicalPairs: 1, pathVerified: true, reason: 'native_marker_match',
  ...extra
});

const results = [];
const test = (name, fn) => { fn(); results.push(name); };

(async () => {
  // 1. THE REGRESSION. Before the fix this throws ReferenceError: string is not defined.
  test('panel executes and returns a section on a branch worldline', () => {
    currentSnapshot = {
      scope: { chatId: 'unified-chat' },
      hostLineage: lineage({}),
      manifest: { worldlineMeta: { parentWorldlineId: 'parent-chat', forkTurn: 5 }, nativeChatCopy: { durableVerified: true } }
    };
    const node = context.buildBookHostLineagePanel();
    assert.equal(node.tag, 'section', 'the panel must return a section node');
    assert.equal(node.dataset.bookSection, 'host-lineage');
    const texts = flat(node).map(n => n.text).filter(Boolean);
    assert.ok(texts.includes('세계선 구분'), 'the branch/root row must survive');
    assert.ok(texts.includes('분기 세계선'), `a branch worldline must be reported as 분기 세계선 (got ${JSON.stringify(texts.slice(0, 14))})`);
  });

  // 2. The desk must also open on a fresh/unavailable scope — that is the first-open path.
  //    NOTE: with no snapshot there is no lineage record, so the 세계선 구분 row is intentionally
  //    absent (it lives inside the `lineage ?` block). The requirement here is that the panel still
  //    RENDERS instead of throwing — the mistake this suite exists to catch.
  test('panel executes with no snapshot and reports the unavailable state', () => {
    currentSnapshot = null;
    const node = context.buildBookHostLineagePanel();
    assert.equal(node.tag, 'section');
    assert.equal(node.dataset.lineageStatus, 'unavailable');
    const texts = flat(node).map(n => n.text).filter(Boolean);
    assert.ok(texts.includes('정보 확인 전'), `an unavailable scope must say so (got ${JSON.stringify(texts.slice(0, 10))})`);
  });

  // 3. A root (non-branch) worldline: parentWorldlineId empty, kind not native_branch.
  test('panel executes for a root worldline without claiming a branch', () => {
    currentSnapshot = { scope: { chatId: 'unified-chat' }, hostLineage: lineage({ kind: 'host', status: 'independent', path: ['unified-chat'] }), manifest: { worldlineMeta: {} } };
    const node = context.buildBookHostLineagePanel();
    const texts = flat(node).map(n => n.text).filter(Boolean);
    assert.ok(texts.includes('기본 세계선'));
    assert.ok(!texts.includes('부모 월드라인'), 'a root worldline must not show a parent row');
  });

  // 4. THE GAP IS CLOSED, STATICALLY TOO: any bare `string(` call is the same defect wearing a
  //    different field name. Only `String(` (the builtin) may appear.
  //    Two traps this check had to survive, both measured:
  //      - the `i` flag makes `String(` itself match, so the check failed on the fix;
  //      - the fix's own comment mentions `string()`, and a comment is not a call.
  //    Comments are stripped first, then the scan runs case-sensitively.
  test('panel source calls no out-of-scope helper', () => {
    const code = panelSource
      .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
      .replace(/\/\/[^\n]*/g, ' ');           // line comments
    const bare = [...code.matchAll(/(?<![.\w$])string\s*\(/g)];   // lowercase only
    assert.equal(bare.length, 0,
      `panel must not call the core-local string() helper: ${JSON.stringify(bare.map(m => m[0]))}`);
  });

  console.log(JSON.stringify({ test: 'libra_book_lineage_panel_execution', passed: results.length, scenarios: results }));
  console.log('libra_book_lineage_panel_execution_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_book_lineage_panel_execution_test: FAIL');
  process.exitCode = 1;
});
