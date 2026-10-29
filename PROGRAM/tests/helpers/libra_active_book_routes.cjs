'use strict';
const assert = require('node:assert/strict');

module.exports = function assertActiveBookRoutes(source) {
  assert.match(source, /const buildApprovedMockupDestinationDetail = page =>/);
  assert.match(source, /case 'desk': return buildApprovedMockupDesk\(\)/);
  assert.match(source, /case 'memory': return buildApprovedMockupMemory\(\)/);
  // Read and manage are separate screens: each destination renders its reader or its manage view, never both.
  assert.match(source, /case 'people': return Gui\.bookPeopleSection==='profile'\?buildApprovedMockupPeople\(\):buildApprovedManageView\('people'/);
  assert.match(source, /case 'world': return Gui\.bookWorldSection==='guide'\?buildApprovedMockupWorld\(\):buildApprovedManageView\('world'/);
  assert.match(source, /case 'story': return Gui\.bookStorySection==='toc'\?buildApprovedMockupStory\(\):buildApprovedManageView\('story'/);
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
