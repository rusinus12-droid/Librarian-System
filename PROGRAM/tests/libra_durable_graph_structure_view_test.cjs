'use strict';

// The structure card prints one view model: the node list, the chosen node's connections grouped
// by relation and direction, and the ring drawing. A background job's dependency on the runtime
// settings record is the lens registry only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  // ---- Durable graph structure');
const end = source.indexOf('  const buildDurableGraphStructureCard = ', start);
assert.ok(start > 0 && end > start, 'the structure view model block is present');
const { durableGraphStructureModel, graphNodeTitle, graphNodeMeta } = new Function(source.slice(start, end)
  + '\nreturn { durableGraphStructureModel, graphNodeTitle, graphNodeMeta };')();

const node = (id, layer, extra = {}) => ({ id, layer, family: '', kind: '', label: '', turn: null, turnRange: null, role: '', degree: 0, parent: '', ...extra });
const structure = {
  nodes: [
    node('e1', 'entity', { kind: 'person', label: '민아', degree: 3 }),
    node('e2', 'entity', { kind: 'object', label: '은빛 열쇠', degree: 2 }),
    node('s1', 'source', { family: 'canonical', label: 'canonical 2', turnRange: { start: 1, end: 5 }, degree: 2 }),
    node('m1', 'meaning', { family: 'canonical', label: '민아가 은빛 열쇠를 맡았다.', turn: 3, degree: 3, parent: 's1' }),
    node('m2', 'meaning', { family: 'canonical', label: '민아가 서재에 도착했다.', turn: 2, degree: 2, parent: 's1' }),
    node('m3', 'meaning', { family: 'micro', label: '열쇠가 책상 위에 있다.', turn: 6, degree: 1 })
  ],
  edges: [
    { from: 'm1', to: 's1', predicate: 'evidenced_by' }, { from: 'm2', to: 's1', predicate: 'evidenced_by' },
    { from: 'm1', to: 'e1', predicate: 'subject_of' }, { from: 'm2', to: 'e1', predicate: 'subject_of' },
    { from: 'm1', to: 'e2', predicate: 'target_of' }, { from: 'm3', to: 'e2', predicate: 'mentions' }
  ],
  summary: { nodes: 6, edges: 6, byLayer: { entity: 2, source: 1, meaning: 3 }, byFamily: { canonical: 2, micro: 1 },
    byPredicate: { evidenced_by: 2, subject_of: 2, target_of: 1, mentions: 1 } }
};

test('nodes are listed by how connected they are and narrowed by kind and text', () => {
  const all = durableGraphStructureModel(structure);
  assert.deepEqual(all.list.map(row => row.id).slice(0, 2).sort(), ['e1', 'm1']);
  assert.equal(all.listTotal, 6); assert.equal(all.selected, null); assert.equal(all.diagram, null);
  assert.deepEqual(durableGraphStructureModel(structure, '', { kind: 'entity' }).list.map(row => row.id), ['e1', 'e2']);
  assert.deepEqual(durableGraphStructureModel(structure, '', { kind: 'micro' }).list.map(row => row.id), ['m3']);
  assert.deepEqual(durableGraphStructureModel(structure, '', { kind: 'source' }).list.map(row => row.id), ['s1']);
  assert.deepEqual(durableGraphStructureModel(structure, '', { text: '열쇠' }).list.map(row => row.id).sort(), ['e2', 'm1', 'm3']);
  assert.deepEqual(all.tiles.map(tile => tile.value), [1, 3, 2, 6]);
  assert.deepEqual(all.predicates.map(item => item.label), ['근거', '주체', '대상', '언급']);
});

test('a chosen meaning node shows what it points to, by relation', () => {
  const view = durableGraphStructureModel(structure, 'm1');
  assert.equal(view.selected.id, 'm1');
  assert.deepEqual(view.connectionGroups.map(group => [group.predicate, group.outward, group.items.map(item => item.id)]),
    [['evidenced_by', true, ['s1']], ['subject_of', true, ['e1']], ['target_of', true, ['e2']]]);
  assert.equal(view.diagram.center.id, 'm1'); assert.equal(view.diagram.spokes.length, 3); assert.equal(view.diagram.hidden, 0);
  assert.ok(view.diagram.spokes.every(spoke => spoke.x >= 60 && spoke.x <= 500 && spoke.y >= 30 && spoke.y <= 270), 'neighbours stay inside the drawing');
});

test('a chosen entity shows the memories that name it, with the direction reversed', () => {
  const view = durableGraphStructureModel(structure, 'e1');
  assert.deepEqual(view.connectionGroups.map(group => [group.predicate, group.outward, group.items.map(item => item.id).sort()]), [['subject_of', false, ['m1', 'm2']]]);
  const key = durableGraphStructureModel(structure, 'e2');
  assert.deepEqual(key.connectionGroups.map(group => group.predicate).sort(), ['mentions', 'target_of']);
});

test('the drawing is capped and says how many neighbours it left out', () => {
  const many = { nodes: [node('c', 'entity', { label: '중심', degree: 20 }), ...Array.from({ length: 20 }, (_, i) => node('n' + i, 'meaning', { family: 'micro', label: '기록 ' + i, degree: 1 }))],
    edges: Array.from({ length: 20 }, (_, i) => ({ from: 'n' + i, to: 'c', predicate: 'subject_of' })), summary: structure.summary };
  const view = durableGraphStructureModel(many, 'c');
  assert.equal(view.diagram.spokes.length, 12); assert.equal(view.diagram.hidden, 8);
  assert.equal(view.connectionGroups[0].items.length, 20, 'the list below the drawing keeps all of them');
});

test('titles and facts read in the user\'s terms', () => {
  assert.equal(graphNodeTitle(structure.nodes[2]), '정본 기록 · 항목 2개');
  assert.equal(graphNodeTitle(node('x', 'entity')), '이름을 확인하지 못한 대상');
  assert.equal(graphNodeMeta(structure.nodes[0]), '대상 · 인물 · 연결 3');
  assert.equal(graphNodeMeta(structure.nodes[3]), '기억 항목 · 정본 · T3 · 연결 3');
  assert.equal(graphNodeMeta(structure.nodes[2]), '원본 기록 · 정본 · T1–T5 · 연결 2');
});

test('a background job depends on the lens registry, not on every runtime setting', () => {
  assert.match(source, /frame\.observeExtra\(STORAGE_RUNTIME_SETTINGS_KEY,raw,lensRegistryProjection\)/);
  assert.match(source, /if\(!before\.project\|\|before\.project\(now\)!==before\.projected\)throw new Error\('LIBRA_BACKGROUND_SETTINGS_CHANGED'\)/);
  const frame = source.slice(source.indexOf('observeExtra(storageKey,raw,project=null)'), source.indexOf("throw new Error('LIBRA_BACKGROUND_SETTINGS_CHANGED')"));
  // The same comparison, run here: another field of the record changes, the lens registry does not.
  const extraReads = new Map(), stable = value => JSON.stringify(value);
  const project = raw => stable(JSON.parse(raw).lens_registry);
  const observe = (key, raw) => { if (!extraReads.has(key)) extraReads.set(key, { raw: stable(raw), project, projected: project(raw) }); };
  const check = now => { for (const before of extraReads.values()) { if (before.raw === stable(now)) continue; if (!before.project || before.project(now) !== before.projected) throw new Error('LIBRA_BACKGROUND_SETTINGS_CHANGED'); } };
  observe('settings', JSON.stringify({ lens_registry: { lenses: ['a'] }, lastOpenedSection: 'memory' }));
  assert.doesNotThrow(() => check(JSON.stringify({ lens_registry: { lenses: ['a'] }, lastOpenedSection: 'graph' })));
  assert.throws(() => check(JSON.stringify({ lens_registry: { lenses: ['a', 'b'] }, lastOpenedSection: 'graph' })), /SETTINGS_CHANGED/);
  assert.ok(frame.includes('project(raw)'));
});
