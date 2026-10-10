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
  const chat = { id: 'entity-field-chat', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'entity-field-char', name: 'Entity Field Test', chatPage: 0, chats: [chat], globalLore: [] };
  const args = new Map(Object.entries({ debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off' }));
  const risuai = {
    apiVersion: '3.0-test', async getRuntimeInfo(){ return { apiVersion: '3.0-test' }; },
    async getArgument(name){ return args.get(name); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(_a, _b, next){ Object.assign(chat, clone(next)); char.chats[0] = chat; return true; },
    async setCharacter(next){ Object.assign(char, clone(next)); return true; }, async getDatabase(){ return { personas: [] }; },
    async addRisuReplacer(){ return true; }, async removeRisuReplacer(){ return true; }, async addRisuScriptHandler(){ return true; },
    async removeRisuScriptHandler(){ return true; }, async registerBodyIntercepter(){ return 'entity-field-test'; },
    async unregisterBodyIntercepter(){ return true; }, async onUnload(){ return true; }, async registerSetting(){ return true; },
    async registerButton(){ return true; }, async showContainer(){ return true; }, async hideContainer(){ return true; },
    pluginStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    safeLocalStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async getLocalPluginStorage(){ return this.pluginStorage; }, async nativeFetch(){ throw new Error('unexpected fetch'); }
  };
  let code = fs.readFileSync(DIST, 'utf8');
  const close = code.lastIndexOf('\n})();');
  if (close < 0) throw new Error('IIFE close not found');
  code = code.slice(0, close) + '\n;globalThis.__LIBRA_ENTITY_FIELD_TEST__={EntityManager,EntityProcessor:EntityAwareProcessor,MemoryEngine};\n' + code.slice(close);
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
  await new Promise(resolve => setTimeout(resolve, 40));
  return context.__LIBRA_ENTITY_FIELD_TEST__;
}

(async () => {
  const { EntityManager, EntityProcessor, MemoryEngine } = await load();
  MemoryEngine.setTurn(1);
  const legacy = EntityManager.normalizeEntityRecord({
    id: 71,
    name: '푸딩',
    identity: { summary: JSON.stringify({ role: '전학생', school: '미야마사카 여자 학원' }) },
    currentState: { summary: JSON.stringify({ location: '미야마사카 여자 학원 교실', mood: '기대감, 호기심', activity: '첫 수업 준비' }) },
    profile: { psychology: { baseline: '[]' } },
    meta: {}
  });
  check('legacy_identity_role_recovered', legacy.identity.roleInStory === '전학생', legacy.identity);
  check('legacy_identity_affiliation_recovered', legacy.identity.affiliation === '미야마사카 여자 학원', legacy.identity);
  check('legacy_state_location_recovered', legacy.currentState.location === '미야마사카 여자 학원 교실', legacy.currentState);
  check('legacy_state_mood_recovered', legacy.currentState.emotionalState.includes('기대감') && legacy.status.currentMood.includes('기대감'), { currentState: legacy.currentState, status: legacy.status });
  check('legacy_state_activity_recovered', legacy.currentState.activity === '첫 수업 준비', legacy.currentState);
  check('legacy_json_summaries_removed', legacy.identity.summary === '' && legacy.currentState.summary === '', { identity: legacy.identity, currentState: legacy.currentState });
  check('serialized_empty_psychology_removed', legacy.profile.psychology.baseline === '', legacy.profile.psychology);

  const lore = [{ key: 'lmai_entity::pudding', comment: 'lmai_entity', content: JSON.stringify({
    id: 71, name: '푸딩', identity: { summary: '{"role":"전학생","school":"미야마사카 여자 학원"}' },
    currentState: { summary: '{"location":"교실","mood":"호기심","activity":"수업 준비"}' }, meta: {}
  }) }];
  const migration = EntityManager.repairLegacyFieldMappings(lore);
  const migrated = JSON.parse(lore[0].content);
  check('lore_migration_updates_existing_record', migration.changed && migration.count === 1, migration);
  check('lore_migration_keeps_entity_id', migrated.id === 71, migrated);
  check('lore_migration_records_provenance', migrated.meta.fieldMappingMigration.schema === 'libra.entity_field_mapping.v1', migrated.meta);

  const extracted = EntityProcessor.extractStructuredEntitySignalsFromPackets({
    entity: { characters: [{
      name: '푸딩',
      identity: { role: '전학생', school: '미야마사카 여자 학원' },
      currentState: { location: '교실', mood: '기대감', activity: '첫 수업 준비' },
      psychology: []
    }] }
  }, { turn: 2, sourceMessageId: 'turn-2' });
  const entity = extracted.entities[0];
  check('new_structured_identity_fields_are_mapped', entity.identity.roleInStory === '전학생' && entity.identity.affiliation === '미야마사카 여자 학원', entity.identity);
  check('new_structured_state_fields_are_mapped', entity.currentState.location === '교실' && entity.currentState.emotionalState.includes('기대감') && entity.currentState.activity === '첫 수업 준비', entity.currentState);
  check('new_structured_objects_are_not_stringified', entity.identity.summary === '' && entity.currentState.summary === '' && entity.profile.psychology.baseline === '', entity);

  const gui = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js'), 'utf8');
  const events = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15d-gui-events-finalize.js'), 'utf8');
  check('gui_has_separate_natural_entity_fields', ['eAffiliation-val', 'eLocation-val', 'eMood-val', 'eActivity-val'].every(token => gui.includes(token)), null);
  check('gui_saves_separate_entity_fields', ['guiAffiliation', 'guiLocation', 'guiMood', 'guiActivity'].every(token => events.includes(token)), null);
  check('gui_background_no_longer_uses_identity_summary', !/guiLines\(background\?\.history \|\| \[\]\),\s*entity\?\.identity\?\.summary/.test(gui), null);

  console.log(JSON.stringify({ ok: true, assertions }, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
