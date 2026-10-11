'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../plugins/LIBRA.js'), 'utf8');
assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
};

const summary = between('const buildBookMemoryModelSummary =', 'const buildBookMemoryProgressPanel =');
assert.match(summary, /presetChoicesFromState\(true\)/);
assert.match(summary, /memoryModelSave: 'analysis'/);
assert.match(summary, /await saveGuiState\(\)/, 'Reading Desk preset changes use the durable settings save path');

const jobSurface = between('function renderCanonicalJobSurface', 'const refreshGuiRuntimeIndicators =');
assert.match(jobSurface, /canonicalJobObservedIds/);
assert.match(jobSurface, /terminal && !Gui\.canonicalJobObservedIds\.has/,
  'unobserved historical terminal jobs must remain hidden');
assert.match(jobSurface, /if \(!terminal \|\| launchedHere\)/,
  'active or explicitly launched jobs are tracked in the current GUI session');

const workbench = between('const buildSharedAgentShellPanel =', 'const setSharedCustomPromptDomain =');
assert.doesNotMatch(workbench, /id: 'state'|label: '상태 추적'|buildStateTrackingAvailabilityPanel/);
assert.match(workbench, /agentHub:'memory'/);
assert.match(workbench, /buildMemoryPipelinePanel\(\)/);
assert.match(workbench, /buildMemoryPromptStudioDisclosure\(/);
assert.doesNotMatch(workbench, /buildDraftWorkspacePanel\(/);
assert.match(source, /settingsHubSection === 'state' \? buildStateTrackingAvailabilityPanel\('settings'\)/,
  'state tracking remains available in its owning Settings section');
assert.match(source, /\['state_pipeline','state_tracking'\]\.includes\(requested\)[\s\S]*pageId:'settings',settingsHubSection:'state'/);

console.log('libra_reading_desk_controls_contract_test: PASS');
