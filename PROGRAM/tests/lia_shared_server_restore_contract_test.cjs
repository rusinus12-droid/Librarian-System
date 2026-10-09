'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIA_Persona_Linker.js'), 'utf8');

assert.equal(source.match(/^[\/][\/]@version\s+(\S+)/m)[1], source.match(/const PLUGIN_VERSION = ["']([^"']+)/)[1]);

assert.match(source, /LIA_SHARED_DURABLE_RESTORE_KEYS/);
assert.match(source, /RESULT_VAULT_STORAGE_KEY[\s\S]*WORLD_BLUEPRINT_STORAGE_KEY[\s\S]*LIVE_PERSONA_STORAGE_KEY[\s\S]*PERSONA_VISUAL_ASSET_STORAGE_KEY[\s\S]*PERSONA_VISUAL_ASSET_PRESET_STORAGE_KEY/);
assert.match(source, /includeInScopeSync\s*:\s*true/);
assert.match(source, /key\.startsWith\(PERSONA_VISUAL_ASSET_BACKUP_PREFIX\)|startsWith\(PERSONA_VISUAL_ASSET_BACKUP_PREFIX\)/);
assert.match(source, /allowEmptyRestore\s*:\s*true/);
assert.match(source, /lia_restore_snapshot_empty/);
assert.match(source, /lia_restore_visual_asset_backup_chunk_dependency_missing/);
assert.match(source, /lia_restore_visual_asset_referenced_backup_missing/);
assert.match(source, /lia_restore_shared_store_invalid/);
assert.match(source, /sharedTombstones/);
assert.match(source, /cachedLivePersonaStore\s*=\s*null/);
assert.match(source, /cachedPersonaProofStore\s*=\s*null/);
assert.match(source, /excludedKeys:\[LLM_SECRET_STORAGE_KEY,LLM_SECRET_SYNCED_STORAGE_KEY,ILLUSTRATION_CONFIG_STORAGE_KEY\]/);
assert.match(source, /excludedContains:\['secret','credential','api_key','access_token','hosting_token'\]/);
assert.doesNotMatch(source, /actual\s+RisuAI\s+Persona\s+database[^\n]*Librarian System/i);

process.stdout.write('lia_shared_server_restore_contract_test: PASS\n');
