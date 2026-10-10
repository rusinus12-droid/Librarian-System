'use strict';
// RENDER-PATH PROOF for the 서사 방향 fix.
//
// The sibling suite (libra_narrative_direction_loop_and_general_headers_test.cjs) proves the empty
// scope path does not re-schedule a render, using only the load function. This suite drives the
// ACTUAL panel builder over a DOM stub and counts renders through the real render queue, so the
// claim is checked on the path a user's click takes:
//
//   click a 작성실 tab -> queueGuiNavigationRender -> renderSettingsGui -> buildNarrativeDirectionPanel
//     -> (must NOT schedule another render)
//
// Before the fix that chain re-armed the navigation timer forever, so the click that set
// Gui.bookWritingTab never reached a painted frame.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.env.LIBRA_TEST_PLUGIN
  ? path.resolve(process.env.LIBRA_TEST_PLUGIN)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

// Minimal element stub: enough for the panel builder to run and for us to walk the result.
const el = (tag, attrs = {}, children = []) => ({
  tag, class: attrs.class, text: attrs.text, dataset: attrs.dataset || {}, attrs,
  children: (Array.isArray(children) ? children : [children]).filter(Boolean)
});
const flat = node => [node, ...(node.children || []).flatMap(flat)];

const buildHarness = scopeKey => {
  const state = { renders: 0, Gui: {
    narrativeDirectionDraft: null, narrativeDirectionDraftKey: '', narrativeDirectionLoading: false,
    narrativeDirectionSaving: false, narrativeDirectionError: '', narrativeDirectionLoadSerial: 0
  } };
  const context = vm.createContext({
    Gui: state.Gui,
    guiEl: el,
    guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    guiAsArray: value => Array.isArray(value) ? value : [],
    text: value => String(value ?? ''),
    libraGuiText: value => String(value ?? ''),
    LibraMemoryCore: { peekSnapshot: () => ({ scope: { scopeKey } }) },
    queueGuiNavigationRender: () => { state.renders += 1; },
    // fieldNode / inputNode / checkboxNode / libraStatusBadge are siblings in the GUI scope; the
    // panel body only needs them to RETURN nodes so the structure can be walked.
    fieldNode: (label, node) => el('label', { text: label }, [node]),
    inputNode: () => el('input'),
    checkboxNode: () => el('input'),
    libraStatusBadge: (label, tone) => el('span', { text: label, dataset: { tone } }),
    Promise, JSON, Number, String, Error, console,
    __LIBRA__: {
      getPlannerNarrativeDirection: async ({ scopeKey: requested }) => ({
        schema: 'libra.narrative_direction.v1', scopeKey: requested, revision: 1, goal: 'g',
        completionConditions: [], doNotForce: [], softPreferences: [], locked: false, source: 'test', updatedAt: 1
      })
    }
  });
  const code = `${between('const narrativeDirectionScopeKey = () =>', 'const buildNarrativeDirectionPanel =')}\n`
    + `${between('const buildNarrativeDirectionPanel = () => {', 'const buildWorldManagerNarrativePanel =')}\n`
    + `({ buildNarrativeDirectionPanel });`;
  const { buildNarrativeDirectionPanel } = vm.runInContext(code, context, { filename: 'panel.js' });
  return { state, build: buildNarrativeDirectionPanel };
};

const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  // ── empty scope: rendering the panel must not schedule another render ───────────────────────
  {
    const { state, build } = buildHarness('');
    let tree = null;
    for (let pass = 0; pass < 6; pass += 1) {
      tree = build();
      await settle();
    }
    assert.equal(state.renders, 0,
      'rendering the panel with no scope must not schedule a render (that is the loop that froze the tab bar)');
    assert.match(state.Gui.narrativeDirectionError, /scope/,
      'the refusal must still be recorded so the user is told why the draft is absent');
    const texts = flat(tree).map(node => node.text).filter(Boolean);
    assert.ok(texts.includes('앞으로의 방향'), 'the panel still renders its section heading');
    assert.ok(texts.some(t => /불러오지 못했습니다|읽는 중입니다/.test(String(t))),
      'the panel still shows the not-loaded state rather than a silent blank');
  }

  // ── control: with a real scope the draft loads, and the completion render is requested once ──
  {
    const { state, build } = buildHarness('chat-room-1');
    build();
    await settle();
    await settle();
    assert.equal(state.Gui.narrativeDirectionDraft?.scopeKey, 'chat-room-1',
      'a real scope must still load the draft — the fix removes the loop, not the feature');
    assert.equal(state.renders, 1, 'the completed load requests exactly one render to show the draft');
    const tree = build();
    const texts = flat(tree).map(node => node.text).filter(Boolean);
    assert.ok(texts.includes('사용자 서사 방향'), 'the editor renders once the draft is present');
  }

  console.log(JSON.stringify({ test: 'libra_narrative_direction_render_path', ok: true }));
  console.log('PASS 서사 방향: the panel builder never re-schedules a render, and a real scope still renders the editor');
})().catch(error => { console.error(String(error?.stack || error)); process.exit(1); });
