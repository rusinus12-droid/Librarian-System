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

// The six-product GUI retired the shared agent shell: the memory agent hub now
// routes into the Settings "workbench" group, whose W1 "기억 분석" destination
// mounts the single Librarian analyzer panel.
const workbenchSections = between('const BOOK_NATIVE_SETTINGS_SECTIONS = Object.freeze([', ']);')
  .split('\n').filter(line => /group: ?'workbench'/.test(line)).join('\n');
assert.doesNotMatch(workbenchSections, /id: ?'state'|label: ?'상태 추적'|buildStateTrackingAvailabilityPanel/);
assert.match(workbenchSections, /id: 'pipeline', group: 'workbench'[^\n]*label: '기억 분석'/);
assert.match(source, /const SHARED_AGENT_HUB_SECTIONS = Object\.freeze\(\['memory'\]\)/);
assert.match(between('const bookSettingsRoomActiveSection =', 'const selectBookSettingsRoomSection ='),
  /Gui\.agentHubSection === 'memory' \? 'memory_pipeline'[\s\S]*Gui\.bookSettingsWorkbenchSection = 'pipeline'/,
  'the memory agent hub opens the workbench memory-analysis destination');
const settingsPanel = between('const buildApprovedMockupSettingsPanel =', "if(sectionId==='logs')");
assert.match(settingsPanel, /if\(sectionId==='pipeline'\)return buildLibrarianAnalyzerPanel\(/);
const analyzer = between('const buildLibrarianAnalyzerPanel =', 'const exportConfiguration =');
assert.match(analyzer, /openApprovedPromptDialog\(/, 'the memory analyzer opens the memory prompt studio');
assert.doesNotMatch(analyzer, /buildDraftWorkspacePanel\(/);
assert.doesNotMatch(source, /buildDraftWorkspacePanel\(/);
assert.match(source, /if\(sectionId==='state'\)return buildStateTrackingAvailabilityPanel\('settings'\)/,
  'state tracking remains available in its owning Settings section');
assert.match(source, /\['state_pipeline','state_tracking'\]\.includes\(requested\)[\s\S]*pageId:'settings',settingsHubSection:'state'/);

console.log('libra_reading_desk_controls_contract_test: PASS');
