'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const sourcePath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
};

assert.match(source, /const STORY_ARC_COMPATIBILITY_SCHEMA = 'libra\.story_arc\.compatibility_projection\.v2'/,
  'Current Narrative compatibility projection schema is missing');

// Settings cleanup 2026-11-11: the in-memory Story Arc projection after each commit, the snapshot
// copy and the zero-caller legacy loader were retired. The one-time migration reads the legacy
// key itself; the projection now only carries a saved direction across copy/handoff/import and
// is computed on demand by the public API.
assert.equal((source.match(/storage\.setJson\(key\.storyArc\(/g) || []).length, 0,
  'runtime still writes the legacy Story Arc database');
assert.equal((source.match(/storage\.remove\(key\.storyArc\(/g) || []).length, 0,
  'runtime still deletes legacy Story Arc outside explicit whole-scope cleanup');
assert.equal((source.match(/key\.storyArc\(/g) || []).length, 0,
  'no runtime path reads the legacy Story Arc key; the migration owns it');
for (const retired of ['loadStoryArc', 'saveStoryArc', 'updateStoryArcAfterCommit', 'ensureStoryArcForResponse', 'storyArcPromptBlock'])
  assert.equal((source.match(new RegExp(`\b${retired}\b`, 'g')) || []).length, 0, `${retired} is retired`);

const rebuildRegion = between(
  'const rebuildStoryArc = async',
  'const setStoryArcDestination = async'
);
assert.match(rebuildRegion, /rebuildCurrentStateForWorldline/,
  'deprecated rebuild adapter must delegate to Current State rebuild');
assert.match(rebuildRegion, /setNarrativeDirection/,
  'legacy destination seed must migrate into Narrative Direction');
assert.doesNotMatch(rebuildRegion, /loadStoryArc|saveStoryArc|deriveStoryArcFromCanonicalHistory|refineStoryArcWithDirector|storyArcEnabled|key\.storyArc/,
  'deprecated rebuild adapter still revives legacy Story Arc authority');
assert.match(between('    async rebuildStoryArc(options', '    async setStoryArcDestination('), /arc: await publicApi\.getStoryArc\(\)/,
  'public rebuild still returns a Current Narrative projection');

const directionRegion = between(
  'const setStoryArcDestination = async',
  'const updateManifestRunIds = async'
);
assert.match(directionRegion, /setNarrativeDirection/,
  'legacy destination setter must delegate to Narrative Direction');
assert.match(directionRegion, /clearNarrativeDirection/,
  'legacy clear action must delegate to Narrative Direction');
assert.doesNotMatch(directionRegion, /saveStoryArc|storage\.|key\.storyArc/,
  'legacy destination compatibility actions still write Story Arc storage');

const snapshotRegion = between(
  'const refreshSnapshot = async',
  'const exportCurrentScope = async'
);
assert.match(snapshotRegion, /loadContinuityState/,
  'snapshot must read Current State Head');
assert.doesNotMatch(snapshotRegion, /storyArcCompatibilityProjection|loadStoryArc\s*\(/,
  'snapshot no longer carries a Story Arc copy');

const portableRollback = between(
  'const capturePortableStateDerivedRollback = async',
  'const portableStateTransferReceiptProjection ='
);
assert.doesNotMatch(portableRollback, /key\.storyArc/,
  'portable rollback still treats read-only legacy Story Arc as active derived state');

for (const reason of [
  'native_chat_copy_regenerated',
  'session_handoff_regenerated',
  'portable_archive_import',
  'portable_chat_copy'
]) {
  const at = source.indexOf(`reason: '${reason}'`);
  assert.notEqual(at, -1, `missing compatibility refresh for ${reason}`);
  const window = source.slice(Math.max(0, at - 500), at + 700);
  assert.match(window, /rebuildStoryArc\s*\(\s*\{/,
    `${reason} must use the compatibility adapter`);
  assert.match(window, /skipStateRebuild:\s*true/,
    `${reason} must not trigger a second Current State rebuild`);
}

const migrationRegion = between(
  'async function migrateStoryArcToNarrativeIfNeeded',
  'async function __libraCompletionGetNarrative'
);
assert.match(migrationRegion, /persistedHead[\s\S]*continuity-state[\s\S]*__libraCompletionUnwrapNarrative/,
  'migration must check persisted Current Narrative when the context getter is unavailable');
assert.match(migrationRegion, /legacy_preserved_current_narrative_kept/,
  'migration must preserve an existing Current Narrative');
assert.doesNotMatch(migrationRegion, /removeItem|removePluginStorage|story-arc[^\n]*=\s*null/,
  'migration must leave legacy source data untouched');


const mainPublicApi = between(
  'const publicApi = Object.freeze({',
  'const unload = async () => {'
);
for (const name of [
  'narrativeCompletionSchema',
  'migrateStoryArcToNarrativeIfNeeded',
  'validateAndBindNarrativePatchEvidence',
  'callNarrativeDeltaProvider',
  'narrativeStatePromptBlock',
  'narrativeDirectionPromptBlock'
]) assert.match(mainPublicApi, new RegExp(name), `${name} must be declared on the frozen main public API`);

const publicCompatibility = between(
  'function __libraCompletionInstallPublicApi() {',
  'queueMicrotask(__libraCompletionInstallPublicApi);'
);
assert.match(publicCompatibility, /Object\.isExtensible\(api\)/,
  'compatibility installer must not mutate the frozen main public API');
assert.match(publicCompatibility, /api\.getStoryArc\s*=\s*async/);
assert.match(publicCompatibility, /api\.rebuildStoryArc\s*=\s*async[\s\S]*rebuildWorldManagerNarrative/);
assert.match(publicCompatibility, /api\.setStoryArcDestination\s*=\s*async[\s\S]*setNarrativeDirection/);
assert.match(publicCompatibility, /api\.clearStoryArc\s*=\s*async[\s\S]*clearNarrativeDirection/);
assert.doesNotMatch(publicCompatibility, /saveStoryArc|story-arc:/,
  'public compatibility API must not restore legacy persistence');

process.stdout.write(`libra_story_arc_storage_retirement_contract_test: PASS (${path.basename(sourcePath)})\n`);
