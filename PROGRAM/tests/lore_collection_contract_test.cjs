'use strict';
// Exercise the real collectors, including module ownership, rather than copied
// helper bodies. LF and CRLF checkouts must run the same assertions.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./gradia/host.cjs');
const {createLibraVmHarness} = require('./fixtures/libra_vm_harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

async function collector(owner, t) {
  const names = 'collectionFrom, selectedPersonaFromDb, buildSelectableModuleCatalog, collectRisuLorebookCandidates';
  const probe = {};
  if (owner === 'GRADIA') {
    const unloads = [];
    await load({
      api: {onUnload: async fn => unloads.push(fn)},
      testGlobals: {__loreProbe: probe},
      transformSource: source => source.replace('  const publicApi = Object.freeze({',
        `  Object.assign(globalThis.__loreProbe, {${names}});\n  const publicApi = Object.freeze({`)
    });
    t.after(async () => { for (const fn of unloads.reverse()) await fn(); });
    return probe;
  }
  const h = await createLibraVmHarness({}, {}, {
    contextGlobals: {__loreProbe: probe},
    transformSource: source => source.replace('      getUnifiedStorageStatus,',
      `      reviewLoreProbe: Object.assign(globalThis.__loreProbe, {${names}}),\n      getUnifiedStorageStatus,`)
  });
  t.after(() => h.cleanup());
  return probe;
}

for (const owner of ['GRADIA', 'LIBRA']) test(owner + ' preserves module identity while unwrapping lorebooks', async t => {
  const api = await collector(owner, t);
  const lore = (id, content = id) => ({id, key: id, content, alwaysActive: true});
  const mod = {id: 'selected', name: 'Selected module', enabled: true, lore: [lore('module-entry')]};
  const other = {id: 'other', enabled: true, lore: [lore('unselected-entry')]};
  const disabled = {id: 'disabled', enabled: false, lore: [lore('disabled-entry')]};
  const db = {modules: [mod, other, disabled], enabledModules: ['selected', 'other', 'disabled']};
  const candidates = (character = {}, database = {}, selected = []) => plain(api.collectRisuLorebookCandidates(
    character, database, {}, null, {selectedModuleLoreIds: selected}
  ));

  const modules = plain(api.collectionFrom(db.modules, 'modules'));
  assert.equal(modules[0].id, 'selected', 'module collection must retain the owning module');
  assert.equal(modules[0].lore[0].id, 'module-entry');
  const catalog = plain(api.buildSelectableModuleCatalog(db));
  assert.equal(catalog.find(row => row.key === 'selected')?.loreCount, 1);
  assert.equal(catalog.find(row => row.key === 'disabled')?.active, false);
  const selected = candidates({}, db, ['selected', 'disabled']);
  assert.deepEqual(selected.map(row => [row.moduleKey, row.content]), [['selected', 'module-entry']]);
  assert.equal(candidates({}, db, []).length, 0, 'unselected modules must remain excluded');

  const dictionary = {modules: {selected: {...mod, id: undefined}}, enabledModules: ['Selected module']};
  assert.equal(candidates({}, dictionary, ['Selected module'])[0]?.content, 'module-entry');
  assert.equal(candidates({modules: [mod]}, {}, ['selected'])[0]?.moduleKey, 'selected');
  const chatBound = plain(api.collectRisuLorebookCandidates({}, {}, {modules: [mod]}, null,
    {selectedModuleLoreIds: ['selected']}));
  assert.equal(chatBound[0]?.moduleKey, 'selected');

  const wrappers = [
    {entries: [lore('entries-a'), lore('entries-b')]},
    {items: [lore('items')]},
    [{name: 'A', entries: [lore('book-a')]}, {name: 'B', entries: [lore('book-b')]}],
    {entries: {one: lore('dictionary-lore')}},
    [{id: 'structured', key: 'nested', data: {content: 'nested-content'}}]
  ];
  const bodies = [['entries-a', 'entries-b'], ['items'], ['book-a', 'book-b'], ['dictionary-lore'], ['nested-content']];
  wrappers.forEach((wrapper, i) => {
    assert.deepEqual(candidates({id: 'character', lorebook: wrapper}).map(row => row.content), bodies[i]);
    const wrappedDb = {modules: [{id: 'wrapped', enabled: true, lorebook: wrapper}]};
    assert.deepEqual(candidates({}, wrappedDb, ['wrapped']).map(row => row.content), bodies[i]);
  });

  const embedded = {id: 'embedded', lore: [lore('embedded-entry')]};
  const personaDb = {personas: [{id: 'persona', name: 'Reader', personaPrompt: 'Persona text', embeddedModule: embedded}], selectedPersona: 'persona'};
  const persona = api.selectedPersonaFromDb(personaDb, {bindedPersona: 'persona'});
  const personaLore = plain(api.collectRisuLorebookCandidates({}, personaDb, {}, persona,
    {selectedModuleLoreIds: ['embedded']}));
  assert.equal(persona.id, 'persona');
  assert.equal(personaLore[0]?.moduleKey, 'embedded');
  assert.equal(personaLore[0]?.content, 'embedded-entry');
});
