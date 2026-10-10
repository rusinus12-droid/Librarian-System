'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const assertions = [];
const check = (name, ok, detail = null) => {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

async function load() {
  const chat = { id: 'canonical-name-chat', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'canonical-name-char', name: 'Canonical Name Test', chatPage: 0, chats: [chat], globalLore: [] };
  const args = new Map(Object.entries({ debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off' }));
  const risuai = {
    apiVersion: '3.0-test',
    async getRuntimeInfo(){ return { apiVersion: '3.0-test', platform: 'node-test' }; },
    async getArgument(name){ return args.get(name); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(_a, _b, next){ Object.assign(chat, clone(next)); char.chats[0] = chat; return true; },
    async setCharacter(next){ Object.assign(char, clone(next)); return true; },
    async addRisuReplacer(){ return true; }, async removeRisuReplacer(){ return true; },
    async addRisuScriptHandler(){ return true; }, async removeRisuScriptHandler(){ return true; },
    async registerBodyIntercepter(){ return 'canonical-name-test'; }, async unregisterBodyIntercepter(){ return true; }, async onUnload(){ return true; },
    async registerSetting(){ return true; }, async registerButton(){ return true; }, async showContainer(){ return true; }, async hideContainer(){ return true; },
    async getDatabase(){ return { personas: [], selectedPersona: null }; },
    pluginStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    safeLocalStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async getLocalPluginStorage(){ return { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } }; },
    async nativeFetch(){ throw new Error('unexpected fetch'); }
  };
  let code = fs.readFileSync(DIST, 'utf8');
  const exportCode = '\n;globalThis.__LIBRA_CANONICAL_NAME_TEST__={EntityManager,EntityCanonicalNameMigration,MemoryEngine,MemoryState,CompactMemoryCodec,StoryAuthor,Director};\n';
  const index = code.lastIndexOf('\n})();');
  if (index < 0) throw new Error('IIFE close not found');
  code = code.slice(0, index) + exportCode + code.slice(index);
  const context = {
    console: { log(){}, warn(){}, error(){}, debug(){} }, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('unexpected fetch'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: text => Buffer.from(String(text), 'base64').toString('binary'), btoa: text => Buffer.from(String(text), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  const result = vm.runInContext(code, context, { filename: DIST, timeout: 15000 });
  if (result && typeof result.then === 'function') await result;
  await new Promise(resolve => setTimeout(resolve, 60));
  return context.__LIBRA_CANONICAL_NAME_TEST__;
}

(async () => {
  const { EntityManager, EntityCanonicalNameMigration, MemoryEngine, CompactMemoryCodec, StoryAuthor, Director } = await load();
  check('migration_api_exported', !!EntityCanonicalNameMigration && typeof EntityCanonicalNameMigration.plan === 'function');
  const lore = [];
  EntityManager.clearCache();
  MemoryEngine.setTurn(7);
  const partial = EntityManager.updateEntity('텐마', {
    source: 'structured_packet',
    identity: { aliases: ['사키', 'Saki Tenma'] },
    status: { currentLocation: '교실' }
  }, lore);
  EntityManager.updateEntity('푸딩', { source: 'structured_packet' }, lore);
  EntityManager.updateRelation('푸딩', '텐마', { relationType: 'classmate', source: 'structured_packet' }, lore);
  const originalId = partial.id;
  const sourcePayload = {
    sourceHash: 'project-sekai-character-lore',
    cues: [{
      id: 'tenma-saki-lore',
      sourceType: 'character_lorebook',
      sourceId: 'tenma-saki',
      sourceLabel: 'Character Lorebook: 텐마 사키',
      text: 'canonicalName: 텐마 사키, aliases: 사키, Tenma Saki'
    }]
  };
  const planned = EntityCanonicalNameMigration.plan(lore, sourcePayload);
  check('strong_lore_and_alias_evidence_plans_full_name', planned.plans.length === 1 && planned.plans[0].oldName === '텐마' && planned.plans[0].newName === '텐마 사키', planned);
  const applied = EntityCanonicalNameMigration.applyPlans(lore, planned, { propagate: false });
  const migrated = EntityManager.getEntityCache().get('텐마 사키');
  const relation = Array.from(EntityManager.getRelationCache().values())[0];
  check('migration_preserves_existing_entity_id', migrated?.id === originalId, { originalId, migratedId: migrated?.id });
  check('automatic_migration_does_not_set_manual_name_lock', migrated?.meta?.nameManualLocked !== true, migrated?.meta);
  check('old_short_name_is_retained_as_alias', migrated?.meta?.aliases?.includes('텐마'), migrated?.meta?.aliases);
  check('relation_endpoint_is_rewritten', [relation?.entityA, relation?.entityB].includes('텐마 사키'), relation);
  check('migration_provenance_is_recorded', migrated?.meta?.canonicalNameMigration?.schema === EntityCanonicalNameMigration.SCHEMA, migrated?.meta?.canonicalNameMigration);
  check('migration_apply_reports_change', applied.changed === true && applied.applied.length === 1, applied);

  const memoryPayload = CompactMemoryCodec.buildTurnPayload('', '텐마가 공연을 준비한다. 텐마 사키는 이미 풀네임으로 기록됐다.', {
    turn: 3,
    sourceHash: 'canonical-name-memory-text',
    knownEntityNames: ['텐마', '텐마 사키']
  });
  const memoryLore = [{
    key: 'canonical-name-memory',
    comment: 'lmai_memory',
    content: `[META:${JSON.stringify({ t: 3, sourceHash: 'canonical-name-memory-text' })}]\n${CompactMemoryCodec.serialize(memoryPayload)}\n`
  }];
  const memoryRename = MemoryEngine.renameEntityReferencesInLore(memoryLore, '텐마', '텐마 사키', {
    currentTurn: 7,
    structuredOnly: false,
    rewriteAliases: false
  });
  const renamedMemoryText = CompactMemoryCodec.buildSearchTextFromPayload(CompactMemoryCodec.parsePayloadFromEntry(memoryLore[0]));
  check('episodic_memory_text_uses_canonical_full_name', memoryRename.changed === true && renamedMemoryText.includes('텐마 사키가 공연을 준비한다'), { memoryRename, renamedMemoryText });
  check('existing_full_name_is_not_duplicated', !renamedMemoryText.includes('텐마 사키 사키'), renamedMemoryText);
  check('memory_summary_projection_has_no_stale_short_name', !renamedMemoryText.includes('Scene result: 텐마가'), renamedMemoryText);

  StoryAuthor.resetState({
    narrativeGoal: '텐마가 공연을 준비하도록 다음 장면을 잇는다.',
    primaryTension: '텐마 사키는 이미 무대에 올라 있다.',
    focusCharacters: ['텐마']
  });
  Director.resetState({
    sceneMandate: '텐마가 선택의 결과를 직접 마주하게 한다.',
    focusCharacters: ['텐마']
  });
  const runtimePropagation = EntityCanonicalNameMigration.propagateReferences([], {
    oldName: '텐마',
    newName: '텐마 사키',
    previousNames: ['텐마']
  });
  check('story_author_narrative_reference_is_rewritten', StoryAuthor.getState().narrativeGoal.includes('텐마 사키가'), StoryAuthor.getState());
  check('director_narrative_reference_is_rewritten', Director.getState().sceneMandate.includes('텐마 사키가'), Director.getState());
  check('runtime_narrative_rewrite_avoids_full_name_duplication', !JSON.stringify({ author: StoryAuthor.getState(), director: Director.getState() }).includes('텐마 사키 사키'), runtimePropagation);

  EntityManager.clearCache();
  EntityManager.updateEntity('호시노', { source: 'structured_packet' }, []);
  const chatCorroborated = EntityCanonicalNameMigration.plan([], {
    cues: [{ sourceType: 'character_lorebook', sourceId: 'ichika', sourceLabel: 'Character Lorebook: 호시노 이치카', text: '호시노 이치카의 공식 프로필' }]
  }, {
    conversationEvidenceText: '호시노 이치카가 텐마 사키에게 인사를 건넸다.'
  });
  check('live_chat_full_name_corroborates_lore_candidate', chatCorroborated.plans.length === 1 && chatCorroborated.plans[0].newName === '호시노 이치카' && chatCorroborated.plans[0].evidence.conversationEvidence === true, chatCorroborated);

  const loreOnlyUncorroborated = EntityCanonicalNameMigration.plan([], {
    cues: [{ sourceType: 'character_lorebook', sourceId: 'ichika', sourceLabel: 'Character Lorebook: 호시노 이치카', text: '호시노 이치카의 공식 프로필' }]
  });
  check('lore_label_without_chat_memory_or_alias_is_not_auto_applied', loreOnlyUncorroborated.plans.length === 0 && loreOnlyUncorroborated.rejected.some(item => item.reason === 'uncorroborated_canonical_candidate'), loreOnlyUncorroborated);

  EntityManager.clearCache();
  EntityManager.updateEntity('Watson', { source: 'structured_packet' }, []);
  const westernMultipart = EntityCanonicalNameMigration.plan([], {
    cues: [{ sourceType: 'character_lorebook', sourceId: 'mary-jane-watson', sourceLabel: 'Character Lorebook: Profile', text: 'fullName: Mary Jane Watson, occupation: reporter' }]
  }, {
    conversationEvidenceText: 'Mary Jane Watson entered the newsroom.'
  });
  check('western_three_part_declared_name_is_supported', westernMultipart.plans.length === 1 && westernMultipart.plans[0].newName === 'Mary Jane Watson', westernMultipart);

  EntityManager.clearCache();
  EntityManager.updateEntity('텐마', { source: 'structured_packet' }, []);
  const ambiguous = EntityCanonicalNameMigration.plan([], {
    cues: [
      { sourceType: 'character_lorebook', sourceId: 'saki', sourceLabel: 'Character Lorebook: 텐마 사키', text: 'name: 텐마 사키' },
      { sourceType: 'character_lorebook', sourceId: 'tsukasa', sourceLabel: 'Character Lorebook: 텐마 츠카사', text: 'name: 텐마 츠카사' }
    ]
  });
  check('ambiguous_shared_family_name_is_not_auto_migrated', ambiguous.plans.length === 0 && ambiguous.rejected.some(item => item.reason === 'ambiguous_candidates'), ambiguous);

  EntityManager.clearCache();
  const locked = EntityManager.updateEntity('호시노', { source: 'manual' }, []);
  locked.meta.nameManualLocked = true;
  const lockedPlan = EntityCanonicalNameMigration.plan([], {
    cues: [{ sourceType: 'character_lorebook', sourceId: 'ichika', sourceLabel: 'Character Lorebook: 호시노 이치카', text: 'canonicalName: 호시노 이치카' }]
  });
  check('manual_name_lock_blocks_automatic_migration', lockedPlan.plans.length === 0, lockedPlan);

  console.log(JSON.stringify({ ok: true, assertions }, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
