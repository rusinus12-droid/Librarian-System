'use strict';
const assert = require('node:assert/strict');

module.exports = function assertActiveBookRoutes(source) {
  assert.match(source, /const buildApprovedMockupDestinationDetail = page =>/);
  assert.match(source, /case 'desk': return buildApprovedMockupDesk\(\)/);
  assert.match(source, /case 'memory': return buildApprovedMockupMemory\(\)/);
  assert.match(source, /case 'people': \{[\s\S]*?const body=buildApprovedMockupPeople\(\)/);
  assert.match(source, /case 'world': \{\s+const body=buildApprovedMockupWorld\(\)/);
  assert.match(source, /case 'story': \{\s+const body=buildApprovedMockupStory\(\)/);
  assert.match(source, /case 'settings': return buildApprovedMockupSettings\(\)/);
  for (const oldRenderer of ['buildBookDeskPanel','buildBookMemoryPanel','buildBookPeoplePanel','buildBookWorldPanel','buildBookStoryPanel','buildBookSettingsPanel','buildBookExecutionFlowTab','renderActiveTab']) {
    assert.doesNotMatch(source, new RegExp(`const ${oldRenderer}\\s*=`), `${oldRenderer} is not a fallback renderer`);
  }
  assert.match(source, /const buildApprovedMockupSettings = \(\) =>/);
  assert.match(source, /const buildApprovedMockupSettingsPanel = \(groupId, sectionId\) =>/);
  for (const contract of ['memorySetting:key','providerField:key','embeddingField:key','settingsCategory:','buildLibraMemoryRestorePanel','buildLibraServerConnectionPanel']) {
    assert.ok(source.includes(contract), `mockup settings/detail preserves ${contract}`);
  }
  assert.doesNotMatch(source, /normalizeApprovedMockupProductClasses|adaptApprovedMockup/, 'no runtime DOM/class adapter');
  assert.doesNotMatch(source, /buildBookSettingsNativeInnerPanel\(/, 'no legacy settings panel adapter');
};
