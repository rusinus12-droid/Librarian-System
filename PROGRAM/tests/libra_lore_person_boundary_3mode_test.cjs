'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

const lore = (id, content, keys = []) => ({ id, label: id, content,
  sourceType: 'character', source: 'character', keys, enabled: true, constant: true });
const personLinks = (index, id) => Array.from(index.links || []).filter(link =>
  String(link.identity || '').includes(`|${id}|`) && String(link.entityId || '').startsWith('ce_person_'));

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    const fx = await serverFixture({mode, args: {lore_link_index_enabled: 'true'}});
    try {
      const {f} = fx;
      assert.equal((await f.run()).completed, 1);
      const localRegistry = [...fx.local.entries()].find(([, raw]) => {
        try { return JSON.parse(raw)?.schema === 'libra.entity_registry.v2'; } catch { return false; }
      });
      const serverRegistry = fx.storedRows().find(row => row.value?.schema === 'libra.entity_registry.v2');
      const registryKey = localRegistry?.[0] || serverRegistry?.key;
      assert.ok(registryKey, `${mode}: canonical run established a Registry`);
      const registry = JSON.parse(JSON.stringify(localRegistry
        ? JSON.parse(localRegistry[1]) : serverRegistry.value));
      const mina = registry.entities.find(entity => entity.type === 'person' && entity.name === '민아');
      const jiho = registry.entities.find(entity => entity.type === 'person' && entity.name === '지호');
      assert.ok(mina?.id && jiho?.id);
      mina.aliases = [...mina.aliases, '도현', 'Alice', '동명'];
      jiho.aliases = [...jiho.aliases, '도현욱', '동명'];
      if (mode !== 'server_only') fx.local.set(registryKey, JSON.stringify(registry));
      if (mode !== 'plugin_only') await fx.mutate(registryKey, registry);

      const lorebook = [
        lore('long-name', '도현욱은 돌아왔다.'),
        lore('short-name', '도현은 돌아왔다.'),
        lore('particle-name', '도현에게 편지가 도착했다.'),
        lore('latin-alias', 'alice는 돌아왔다.'),
        lore('same-name', '동명은 도착했다.'),
        lore('generic-key', '무관한 기록만 있다.', ['도현'])
      ];
      f.character.lorebook = lorebook;
      const index = await f.r.api.getLoreLinkIndex({force: true});
      assert.equal(index.schema, 'libra.lore_link_index.v1');
      assert.equal(index.buildVersion, 'shared_person_boundary_v2');
      assert.equal(index.status.allowedLoreCount, 6, `${mode}: the test corpus is non-empty`);
      assert.deepEqual(personLinks(index, 'long-name').map(link => link.entityId), [jiho.id],
        `${mode}: 도현 inside 도현욱 does not name the shorter person`);
      assert.deepEqual(personLinks(index, 'short-name').map(link => link.entityId), [mina.id],
        `${mode}: a complete shorter name resolves its Registry identity`);
      assert.deepEqual(personLinks(index, 'particle-name').map(link => link.entityId), [mina.id],
        `${mode}: a Korean particle is a valid name boundary`);
      assert.deepEqual(personLinks(index, 'latin-alias').map(link => link.entityId), [mina.id],
        `${mode}: case differences in a confirmed Latin alias retain the complete name boundary`);
      const held = personLinks(index, 'same-name');
      assert.equal(held.length, 2, `${mode}: same-name people remain separate candidates`);
      assert.ok(held.every(link => link.resolution === 'held_ambiguous'),
        `${mode}: a shared alias cannot resolve a Registry identity automatically`);
      assert.equal(personLinks(index, 'generic-key').length, 0,
        `${mode}: a generic activation key is not a person mention in the Lore body`);
      const genericCandidate = {...lorebook.find(row => row.id === 'generic-key'), constant: false};
      for (const query of ['도현', '도현욱']) {
        const genericMaterial = await f.r.api.debugUnifiedLoreMaterial({
          candidates: [genericCandidate], currentInput: query, consumers: ['response_recall']
        });
        assert.ok(genericMaterial.stages?.response_recall?.selectedItems?.some(row => String(row.id).includes('generic-key')),
          `${mode}: the ordinary Lore key route remains eligible for ${query}`);
      }
      const localIndex = [...fx.local.entries()].find(([, raw]) => {
        try { return JSON.parse(raw)?.schema === 'libra.lore_link_index.v1'; } catch { return false; }
      });
      const serverIndex = fx.storedRows().find(row => row.value?.schema === 'libra.lore_link_index.v1');
      const indexKey = localIndex?.[0] || serverIndex?.key;
      assert.ok(indexKey);
      const stale = JSON.parse(JSON.stringify(index));
      stale.buildVersion = 'reference_link_v1';
      stale.links.push({linkKey: 'stale_false_person_link', identity: 'long-name',
        entityId: mina.id, entityName: '도현', resolution: 'reference'});
      if (mode !== 'server_only') fx.local.set(indexKey, JSON.stringify(stale));
      if (mode !== 'plugin_only') await fx.mutate(indexKey, stale);
      const restarted = await fx.restart();
      restarted.character.lorebook = lorebook;
      const rebuilt = await restarted.r.api.getLoreLinkIndex({});
      assert.equal(rebuilt.buildVersion, 'shared_person_boundary_v2',
        `${mode}: an old person-name index is rebuilt after restart`);
      assert.equal(rebuilt.links.some(link => link.linkKey === 'stale_false_person_link'), false,
        `${mode}: an old index cannot retain a false partial-name identity link`);
      console.log(`PASS Lore person-name evidence boundary in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
