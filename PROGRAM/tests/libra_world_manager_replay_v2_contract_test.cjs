'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
assert.match(source, /STATE_CORRECTION_STORE_SCHEMA = 'libra\.state_correction_store\.v1'/);
assert.match(source, /STATE_CORRECTION_EVENT_SCHEMA = 'libra\.state_correction\.v1'/);
assert.match(source, /stateCorrections: scope => `\$\{PREFIX\}:scope:\$\{scope\.scopeKey\}:state-corrections:v2`/);
assert.match(source, /const rebuildCurrentStateForWorldline = async/);
assert.match(source, /const appendStateCorrection = async/);
assert.match(source, /const reconcileStateCorrectionStatuses = async/);
assert.match(source, /const usesStatePipelineV3=/);
assert.match(source, /await rebuildStateFromCanonicalChain\(\{[\s\S]*context:liveContext,manifest:liveManifest,fromStart:1/,
  'World Manager replay must rebuild v3 Entity Registry and Head from the active canonical chain');
assert.match(source, /previousRegistry=replayRegistryKey\?await storage\.getJson/,
  'v3 Registry is part of the replay transaction rollback boundary');
assert.doesNotMatch(source, /const buildSharedHeaderStatusPanel =|const buildSharedHomeOverviewPanel =|const buildInsightRail =/,
  'retired status dashboards must not remain in the shared GUI');
// The approved GUI routes People/World destinations through one dispatcher; the
// People route selects the characters/relationships World Manager panel from
// Gui.bookPeopleSection and the World route mounts the World Manager world panel.
const destinationStart = source.indexOf('const buildApprovedMockupDestinationDetail = page =>');
assert.ok(destinationStart >= 0, 'approved destination dispatcher exists');
const destinationEnd = source.indexOf("case 'story':", destinationStart);
assert.ok(destinationEnd > destinationStart, 'approved destination dispatcher has a story route');
const destination = source.slice(destinationStart, destinationEnd);
assert.match(destination, /case 'people':[\s\S]*Gui\.bookPeopleSection==='relationships'\?buildWorldManagerRelationshipsPanel\(\):buildWorldManagerCharactersPanel\(\)/);
assert.match(destination, /case 'world':[\s\S]*buildWorldManagerWorldPanel\(\)/);
assert.match(source, /buildWorldManagerRecordBrowser\(\{[\s\S]*?domain: 'characters'/);
assert.match(source, /buildWorldManagerRecordBrowser\(\{[\s\S]*?domain: 'relationships'/);
assert.match(source, /buildWorldManagerRecordBrowser\(\{[\s\S]*?domain: 'world'/);
assert.match(source, /async rebuildWorldManagerState\(options = \{\}\)/);
console.log('libra_world_manager_replay_v2_contract_test: ok');
