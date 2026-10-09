'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const pluginPath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const start = source.indexOf('const resetWorldManagerPagedView =');
const end = source.indexOf('const buildWorldManagerDomainShell =', start);
assert.notEqual(start, -1, 'missing World Manager History GUI block');
assert.notEqual(end, -1, 'missing World Manager History GUI end marker');
const gui = source.slice(start, end);

assert.match(gui, /const buildWorldManagerHistoryDetailView =/, 'missing v3 provenance detail renderer');
assert.match(gui, /state_pipeline_v3/, 'History GUI must recognize v3 State Pipeline records');
assert.match(gui, /provenance\.statePipeline|provenance\?\.domains/, 'History GUI must read the v3 provenance bundle');
assert.match(gui, /정본 assertion/, 'History detail must expose canonical assertions');
assert.match(gui, /Observer review/, 'History detail must expose Observer reviews');
assert.match(gui, /희소 상태 patch/, 'History detail must expose sparse State patches');
assert.match(gui, /신규 인물 승인/, 'History detail must expose Entity Admission status');
assert.match(gui, /migration\/호환 근거/, 'legacy Delta must be visibly downgraded to migration/compatibility evidence');
assert.match(gui, /worldlineId:text\(item\?\.worldlineId\|\|'main'\)/,
  'History detail request must bind the logical State Worldline');
assert.match(gui, /worldHistoryMode:item\?\.recordMode/, 'History cards must declare their record mode');
assert.match(gui, /worldHistoryAuthority:item\?\.stateAuthority/, 'History cards must declare state authority');
assert.doesNotMatch(gui, /detail\?guiEl\('pre'.*JSON\.stringify\(detail\?\.delta\|\|detail\?\.patch\|\|detail/,
  'loaded v3 detail must not be rendered only as one undifferentiated raw Delta blob');

process.stdout.write('libra_world_manager_history_v3_gui_contract_test: PASS\n');
