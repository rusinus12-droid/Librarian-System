'use strict';
// Production helpers extracted from LIBRA.js; only shared utilities are stubbed.
// The Micro overlap path must name a place the approved patch introduced, exactly
// as the post-canonical path does, instead of leaving its internal id on screen.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const part = (from, to) => { const i = source.indexOf(from), j = source.indexOf(to, i + from.length); assert.ok(i >= 0 && j > i, from); return source.slice(i, j); };
const context = vm.createContext({
  asArray: x => Array.isArray(x) ? x : [], asObject: x => x && typeof x === 'object' && !Array.isArray(x) ? x : {},
  clone: x => JSON.parse(JSON.stringify(x)), string: x => typeof x === 'string' ? x : '',
  statePipelineIdentityKey: x => String(x || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
  MICRO_WORLD_REFERENCE_FIELDS: { holderRef: ['person'], containerRef: ['world'], parentRef: ['world'] }
});
vm.runInContext([
  part('const microEffectiveEntityId =', 'const repairMicroEvidence ='),
  part('const microRegistryViewWithPatch =', 'const projectActiveMicroStateForResponse ='),
  'Object.assign(globalThis,{microEffectiveEntityId,microRegistryViewWithPatch,retainMicroLocationReference});'
].join('\n'), context);
// The overlap path must use the patch-aware view in both places it needs a name.
const overlap = part('const latest = group[group.length - 1];', 'for (let turn = canonicalThroughTurn + 1;');
assert.match(overlap, /const itemRegistry = microRegistryViewWithPatch\(registry, item\.patch\);/);
assert.match(overlap, /retainMicroLocationReference\(head, itemRegistry,/);
assert.doesNotMatch(overlap, /retainMicroLocationReference\(head, registry,/);

const registry = { entities: [{ id: 'ce_person_a', name: '세연', type: 'person', validated: true }] };
const created = { id: 'ce_world_87c91f6f', name: '거실', aliases: [], type: 'world', kind: 'location', validated: true, origin: 'micro' };
const patch = { set: { locationRef: created.id }, microNewEntities: [created] };
const proof = { exactQuote: '거실로 나왔다' };

// Without the patch view the place stays unnamed (the reported defect).
let head = { characters: [{ id: 'ce_person_a', name: '세연', state: {} }], world: [] };
context.retainMicroLocationReference(head, registry, 'character', 'locationRef', created.id, proof);
assert.equal(head.world.length, 0);

// With it, a read-only identity row names the place; no State field is invented.
head = { characters: [{ id: 'ce_person_a', name: '세연', state: {} }], world: [] };
context.retainMicroLocationReference(head, context.microRegistryViewWithPatch(registry, patch), 'character', 'locationRef', created.id, proof);
assert.equal(JSON.stringify(head.world.map(row => [row.id, row.name, row.state])), JSON.stringify([[created.id, '거실', {}]]));

// A patch entity whose name a standing record already has resolves to that record, not a duplicate.
const standing = { entities: [...registry.entities, { id: 'ce_world_old', name: '거실', type: 'world', kind: 'location', validated: true }] };
const view = context.microRegistryViewWithPatch(standing, patch);
assert.equal(view.entities.filter(row => row.name === '거실').length, 1);
assert.equal(context.microEffectiveEntityId(standing, patch, created.id), 'ce_world_old');
// The registry itself is never modified by building the view.
assert.equal(registry.entities.length, 1);
console.log('PASS overlap Micro reference keeps the approved patch name; standing records win; registry untouched');
