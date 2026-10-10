'use strict';
// Stage 6: the GUI reads the link/trace structure rather than re-deriving it.
//
// The research note fixes the ORDER and says why: "UI 그림을 먼저 완성하고 실제 검색 연결을 나중에 붙이는
// 순서는 권하지 않는다. 검색에 쓰이는 link/trace 구조를 먼저 만든 뒤 GUI가 이를 읽도록 한다." Stages 1-4
// built the structure; this suite proves the GUI reads THAT structure and shows a reader the same three
// outcomes the observation reports.
//
// The boundary this suite works at is the RENDER FUNCTION, not a running host: a real DOM is not needed to
// answer the question the stage asks ("does the panel show what the stage found, and nothing else"), and a
// fake one keeps the assertions about CONTENT rather than about browser behaviour. The DOM stub is the
// same shape the sibling GUI suites use.
//
// Every case is written so it fails against the two shortcuts that would look right in a screenshot:
//   * showing a refusal as an agreement (the opposite meaning, from the same field);
//   * rendering an empty panel when nothing was found (an empty box reads as a broken feature rather than
//     as "this turn had nothing to add").
const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

// Expose the three GUI builders and the observation reader, so the suite drives the SHIPPED renderers.
// The accessor is a function so the names are resolved WHEN IT IS CALLED, after the plugin has finished
// evaluating; capturing them at this insertion point would hit the temporal dead zone for the builders
// that are declared later in the file.
const expose = source => source.replace(
  'const clearStructuredSettings =',
  'globalThis.__stage6 = () => associativeGuiForTest();\nconst clearStructuredSettings ='
);

const flat = node => [node, ...(node.children || []).flatMap(flat)];

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.dataset = {}; this.style = {}; this.listeners = {};
    this.className = ''; this.textContent = ''; this.attributes = {};
  }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  contains(node) { return flat(this).includes(node); }
  get isConnected() { return true; }
  getBoundingClientRect() {
    const id = this.dataset.associativeNode;
    if (this.dataset.associativeGraph) return { left: 0, top: 0, width: 600, height: 500, bottom: 500 };
    const top = id === 'source' ? 50 : this.className.includes('bridge') ? 210 : 390;
    const left = id === 'source' ? 250 : id === 'ce_world_6fd583a6' ? 390 : 120;
    return { left, top, width: 100, height: 70, bottom: top + 70 };
  }
}

const texts = node => flat(node).map(entry => String(entry.textContent || '')).filter(Boolean);
const withDataset = (node, key) => flat(node).filter(entry => Object.hasOwn(entry.dataset || {}, key));

// The observation the panel renders, in the shape `Runtime.lastAssociativeRecallDiagnostics` holds.
const observation = ({ candidates, bridges = [], active = true, mode = 'participation' } = {}) => ({
  schema: 'libra.associative_recall.v1', active,
  reason: active ? '' : 'no_reachable_candidate',
  hops: 1, seedEntities: 3, reachedMemories: candidates.length,
  basis: 'current_view', providerCalls: 0, llmCalls: 0, embeddingCalls: 0,
  budgetUnchanged: true, admitLimit: 2, minRelevance: 0.18, mode,
  sourceText: '서재에서 발견한 편지',
  bridges, candidates
});

const candidate = (overrides = {}) => ({
  memoryId: 'mem_000006', revision: 1, memoryKey: 'libra:v1:scope:s:memory:6:r1',
  source: 'associative', admitted: false, admittedReason: 'already_hydrated_by_shortlist',
  summary: '숨겨둔 편지를 다시 발견했다.', turnRange: { start: 41, end: 45 },
  refusal: null, via: [{ factKey: 'f1', entityId: 'ce_world_d5f9f6ea', entityName: '서재', claimKind: 'containment' }],
  ...overrides
});

(async () => {
  const r = await createLibraVmHarness({}, {}, { transformSource: expose });
  const tests = [];
  try {
    r.context.document = {
      createElement: tag => new Element(tag),
      createElementNS: (_namespace, tag) => new Element(tag),
      createTextNode: value => Object.assign(new Element('#text'), { textContent: value }),
      activeElement: null
    };
    const t = r.context.__stage6();
    const rt = t.Runtime;

    // 1. With no observation, the panel is ABSENT. An empty box would read as a broken feature, and the
    //    expansion legitimately finds nothing on most turns.
    rt.lastAssociativeRecallDiagnostics = null;
    assert.equal(t.buildAssociativeRecallPanel({ hideWhenEmpty: true }), null,
      'no observation means no panel, not an empty one');
    assert.equal(t.associativeGuiObservation(), null, 'the reader reports nothing rather than a blank shell');
    tests.push('with nothing observed the panel is absent rather than empty');

    // 2. An INACTIVE observation is the same case: "reached nothing" is not something to display as a
    //    connection, and the reason belongs in diagnostics rather than in a connection panel.
    rt.lastAssociativeRecallDiagnostics = observation({ active: false, candidates: [] });
    assert.equal(t.buildAssociativeRecallPanel({ hideWhenEmpty: true }), null,
      'an inactive expansion renders no connection panel');
    tests.push('an inactive expansion renders no connection panel');

    // 3. An AGREEMENT is labelled as agreement, never as a refusal: the two carry opposite meanings and
    //    collapsing them would tell a reader the link was rejected when both paths found the same memory.
    rt.lastAssociativeRecallDiagnostics = observation({
      candidates: [candidate({ admitted: false, admittedReason: 'already_hydrated_by_shortlist' })],
      bridges: [{ id: 'ce_world_d5f9f6ea', entityName: '서재' }]
    });
    const agreed = t.buildAssociativeRecallPanel({ hideWhenEmpty: true });
    assert.ok(agreed, 'an active expansion with a reached candidate renders');
    const agreedRows = withDataset(agreed, 'associativeCandidate');
    assert.equal(agreedRows.length, 1);
    assert.equal(agreedRows[0].dataset.associativeOutcome, 'agreed', 'the outcome datum says agreement');
    assert.ok(texts(agreed).some(line => line.includes('일치')),
      `an agreement is labelled as such: ${JSON.stringify(texts(agreed))}`);
    assert.equal(texts(agreed).some(line => line.includes('제외')), false,
      'an agreement must never be labelled as a refusal');
    tests.push('an agreement is shown as agreement, never as a refusal');

    // 4. A REFUSAL shows the RULE that refused it. Without the rule, "omitted" is indistinguishable from
    //    "the link was broken", which is the same confusion the observation's own reasons exist to prevent.
    rt.lastAssociativeRecallDiagnostics = observation({
      candidates: [candidate({ admitted: false, admittedReason: 'min_relevance', refusal: { rule: 'min_relevance', relevance: 0.04, floor: 0.18 } })],
      bridges: [{ id: 'ce_world_d5f9f6ea', entityName: '서재' }]
    });
    const refused = t.buildAssociativeRecallPanel({ hideWhenEmpty: true });
    const refusedRows = withDataset(refused, 'associativeCandidate');
    assert.equal(refusedRows[0].dataset.associativeOutcome, 'omitted');
    assert.ok(texts(refused).some(line => line.includes('min_relevance')),
      `a refusal names the rule that refused it: ${JSON.stringify(texts(refused))}`);
    tests.push('a refusal names the rule that refused it');

    // 5. An ADMITTED candidate is shown as added, and the bridge entities that carried it are named —
    //    a reader has to be able to see the PATH, which is the point of showing connections at all.
    rt.lastAssociativeRecallDiagnostics = observation({
      candidates: [candidate({ admitted: true, admittedReason: 'delivered_within_budget', refusal: null })],
      bridges: [{ id: 'ce_world_d5f9f6ea', entityName: '서재' }, { id: 'ce_world_6fd583a6', entityName: '도서관' }]
    });
    const added = t.buildAssociativeRecallPanel({ hideWhenEmpty: true });
    assert.equal(withDataset(added, 'associativeCandidate')[0].dataset.associativeOutcome, 'added');
    const bridgeChips = withDataset(added, 'associativeBridge');
    assert.equal(bridgeChips.length, 2, 'every bridge entity is shown');
    assert.deepEqual(bridgeChips.map(chip => texts(chip).find(value => ['서재', '도서관'].includes(value))), ['서재', '도서관'],
      'a bridge is shown by NAME, not by its opaque id');
    tests.push('an admitted candidate is shown as added and its bridge entities are named');

    // The approved visual is a traversable node graph. A text list can report the same words while
    // losing the relationships, so assert the shipped renderer exposes the source, bridge, memory and
    // their actual edges. The memory must connect only through its recorded `via` entity.
    const graph = withDataset(added, 'associativeGraph')[0];
    assert.ok(graph, 'the panel renders a graph rather than a candidate text list');
    const graphNodes = withDataset(graph, 'associativeNode');
    assert.ok(graphNodes.some(node => node.dataset.associativeNode === 'source'));
    assert.ok(graphNodes.some(node => node.dataset.associativeNode === 'ce_world_d5f9f6ea'));
    assert.ok(graphNodes.some(node => node.dataset.associativeNode === 'mem_000006:r1'));
    assert.ok(texts(graph).includes('서재에서 발견한 편지'), 'the source node shows the real recall input');
    assert.ok(texts(graph).some(value => value.includes('숨겨둔 편지')), 'the memory node uses its stored summary');
    const graphEdges = withDataset(graph, 'associativeEdge').map(edge => edge.dataset.associativeEdge);
    assert.ok(graphEdges.includes('ce_world_d5f9f6ea>mem_000006:r1'));
    assert.equal(graphEdges.includes('ce_world_6fd583a6>mem_000006:r1'), false,
      'an unrecorded bridge must not be drawn as a candidate path');
    tests.push('the graph renders source, bridge and memory nodes with only recorded paths');

    r.context.requestAnimationFrame = callback => callback();
    const drawn = t.buildAssociativeRecallPanel({ hideWhenEmpty: true });
    const drawnEdges = withDataset(drawn, 'associativeEdge');
    assert.ok(drawnEdges.length > 0 && drawnEdges.every(edge => /^M \d+ \d+ C /u.test(edge.getAttribute('d') || '')),
      'the graph lays out visible SVG curves after mounting');
    assert.ok(drawnEdges.some(edge => edge.getAttribute('class')?.includes('active')),
      'the selected memory path is highlighted');
    tests.push('recorded graph paths are laid out and the selected route is highlighted');

    assert.equal(t.buildAssociativeRecallPanel({ hideWhenEmpty: true, memoryRef: 'mem_other:r1' }), null,
      'an evidence drawer must not attach the latest graph to an unrelated memory');
    assert.ok(t.buildAssociativeRecallPanel({ hideWhenEmpty: true, memoryRef: 'mem_000006:r1' }));
    tests.push('memory details show only a graph path for that memory');

    const omittedMemory = withDataset(refused, 'associativeCandidate')[0];
    assert.equal(omittedMemory.tagName, 'BUTTON', 'memory nodes can be selected by keyboard and pointer');
    omittedMemory.listeners.click[0]();
    const detail = withDataset(refused, 'associativeDetail')[0];
    assert.ok(detail, 'a selected node has a detail region');
    assert.ok(texts(detail).some(value => value.includes('관련성이 낮아')),
      'the omitted node explains the refusal in reader-facing language');
    assert.ok(texts(detail).some(value => value.includes('서재')),
      'the selected memory shows the actual bridge path');
    const technical = flat(detail).find(node => node.tagName === 'DETAILS');
    assert.ok(technical, 'raw memory refs and refusal codes stay behind a technical disclosure');
    assert.ok(texts(technical).some(value => value.includes('min_relevance')));
    tests.push('selecting a memory reveals its outcome and named path');

    // A row that passed the gate but fell outside MMR/packing remains omitted in the GUI. The panel
    // consumes the same final outcome field as preview diagnostics, so it cannot report pool admission
    // as delivery.
    rt.lastAssociativeRecallDiagnostics = observation({
      candidates: [candidate({ admitted: false, admittedReason: 'dropped_by_mmr', refusal: null })],
      bridges: []
    });
    const dropped = t.buildAssociativeRecallPanel({ hideWhenEmpty: true });
    const droppedRow = withDataset(dropped, 'associativeCandidate')[0];
    assert.equal(droppedRow.dataset.associativeOutcome, 'omitted');
    assert.ok(texts(dropped).some(line => line.includes('dropped_by_mmr')));
    tests.push('a gated but unselected candidate stays omitted with its MMR reason');

    // 6. The cost line is always present when the panel is. It is the one number the note requires every
    //    observation to report, and hiding it would invite reading "no provider call" as unstated.
    for (const view of [agreed, refused, added]) {
      const cost = withDataset(view, 'associativeCost');
      assert.equal(cost.length, 1, 'the panel always states its cost');
      assert.ok(String(cost[0].textContent).includes('0'), 'the provider-call count is shown');
    }
    tests.push('the panel always states its provider-call cost');

    // 7. THE THREE SURFACES SHARE THIS ONE BUILDER, so a reader sees the same facts in all of them. This is
    //    asserted structurally: each surface must call the shared builder, which is what keeps the three
    //    from drifting into three different descriptions of one event.
    const plugin = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
    const callSites = (plugin.match(/buildAssociativeRecallPanel\(\{/g) || []).length;
    assert.ok(callSites >= 3, `the three surfaces each render the shared panel (found ${callSites} call sites)`);
    for (const surface of ['buildLibraRecallViewerPanel', 'buildCanonicalEvidenceChainView', 'buildLibraMemoriesPanel']) {
      const start = plugin.indexOf(`const ${surface} =`);
      assert.ok(start > 0, `${surface} exists`);
      const body = plugin.slice(start, start + 24000);
      assert.ok(body.includes('buildAssociativeRecallPanel({'),
        `${surface} renders the shared associative panel rather than its own description of the event`);
    }
    tests.push('all three required surfaces render the one shared panel');


    // 8. ACCESSIBILITY. The research note cites the W3C Disclosure pattern for exactly this reason: a
    //    reader who cannot use a mouse must still be able to walk the connection path and read what each
    //    node says. The graph is a SET OF BUTTONS, not decorated boxes — asserted structurally, because a
    //    screenshot cannot show whether a keyboard can reach a node.
    rt.lastAssociativeRecallDiagnostics = observation({
      candidates: [candidate({ admitted: false, admittedReason: 'already_hydrated_by_shortlist' })],
      bridges: [{ id: 'ce_world_d5f9f6ea', entityName: '서재' }, { id: 'ce_world_6fd583a6', entityName: '도서관' }]
    });
    const a11yGraph = t.buildAssociativeRecallPanel({ hideWhenEmpty: true });
    assert.ok(a11yGraph, 'the graph renders');
    const nodes = withDataset(a11yGraph, 'associativeNode');
    assert.ok(nodes.length >= 3, `the graph has a node per clue, bridge and memory: ${nodes.length}`);
    for (const node of nodes) {
      assert.equal(String(node.tagName), 'BUTTON',
        `every node must be a real button so a keyboard can reach it, saw <${node.tagName}>`);
      assert.equal(String(node.getAttribute('type')), 'button', 'the button must not act as a submit control');
      assert.equal(String(node.getAttribute('aria-pressed') ?? '').length > 0, true,
        'a selectable node announces its pressed state');
    }
    // Exactly one node is pressed at a time: the graph always has a selection, and it is announced.
    const pressed = nodes.filter(node => String(node.getAttribute('aria-pressed')) === 'true');
    assert.equal(pressed.length, 1, `exactly one node is the current selection: ${pressed.length}`);

    // The detail panel is a live region, so selecting a node ANNOUNCES the change rather than silently
    // swapping text a screen reader would never read.
    const live = flat(a11yGraph).filter(node => String(node.getAttribute('aria-live') || '') === 'polite');
    assert.ok(live.length >= 1, 'the selected-node detail is a polite live region');

    // The wire SVG is decorative: the same relationships are in the buttons themselves, so announcing it
    // again would duplicate every connection as unlabeled graphics.
    const wires = flat(a11yGraph).filter(node => String(node.tagName) === 'svg'
      || String(node.getAttribute('class') || '').includes('libra-assoc-wires'));
    for (const wire of wires) {
      assert.equal(String(wire.getAttribute('aria-hidden')), 'true',
        'the decorative wire layer is hidden from assistive technology');
    }
    tests.push('every node is a reachable button with an announced selection, and the wires are decorative');

    console.log(JSON.stringify({
      test: 'libra_associative_recall_gui', passed: tests.length, tests,
      boundary: 'the shipped render functions against a DOM stub; no browser is started and no host runs'
    }, null, 1));
    process.stdout.write('libra_associative_recall_gui_test: PASS\n');
  } finally { await r.cleanup(); }
})().catch(error => { console.error(error?.stack || String(error)); process.exitCode = 1; });
