'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');

function extract(source, name) {
  const start = source.indexOf(`const ${name} =`);
  const end = source.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, `missing active function ${name}`);
  return source.slice(start, end + 6);
}

module.exports = function assertActiveBookRoutes(source) {
  assert.match(source, /const renderActiveTab = [^\n]*return buildBookExecutionFlowTab\(\)/);
  const pages = { desk:'buildBookDeskPanel', memory:'buildBookMemoryPanel', people:'buildBookPeoplePanel', world:'buildBookWorldPanel', story:'buildBookStoryPanel', settings:'buildBookSettingsPanel' };
  const settings = { references:'buildLibraReferenceHubPanel', memory:'buildLibraMemorySettingsPanel', state:'buildStateTrackingAvailabilityPanel', server:'buildLibraServerConnectionPanel', ai:'buildLibraProviderPanel', embedding:'buildLibraEmbeddingPanel', recovery:'buildLibraRecoveryPanel', transfer:'buildTransferTab', general:'buildGeneralSettingsPanel', source_edits:'buildAnalysisInputPanel', pipeline:'buildSharedPipelineShellPanel', agents:'buildSharedAgentShellPanel', custom:'buildSharedCustomShellPanel', logs:'buildSharedExecutionLogsPanel' };
  const ctx = { Gui: {}, normalizeBookPage:p=>Object.hasOwn(pages,p)?p:'desk', activeGuiResponseFamily:()=>ctx.family, guiEl:(tag,attrs,children)=>({tag,attrs,children}) };
  for (const name of [...Object.values(pages), ...Object.values(settings)]) ctx[name] = () => ({builder:name});
  vm.createContext(ctx);
  vm.runInContext(`${extract(source,'buildBookExecutionFlowTab')}\n${extract(source,'buildBookSettingsNativeInnerPanel')}\nthis.api={buildBookExecutionFlowTab,buildBookSettingsNativeInnerPanel};`,ctx);
  for(const family of ['libra','gradia']) {
    ctx.family=family;
    for(const [page,builder] of Object.entries(pages)) {
      ctx.Gui.bookPage=page;
      const tree=ctx.api.buildBookExecutionFlowTab();
      assert.equal(tree.attrs.dataset.activeBookPage,page);
      assert.equal(tree.children[0].builder,builder,`${family} page ${page}`);
    }
    ctx.Gui.bookPage='writing';assert.equal(ctx.api.buildBookExecutionFlowTab().children[0].builder,'buildBookDeskPanel','retired writing route falls back to desk');
    assert.equal(ctx.api.buildBookSettingsNativeInnerPanel('input_writer').builder,'buildLibraMemorySettingsPanel','retired input writer settings fall back to memory');
    for(const [section,builder] of Object.entries(settings)) assert.equal(ctx.api.buildBookSettingsNativeInnerPanel(section).builder,builder,`${family} settings ${section}`);
  }
  // Follow the actual owner pages down to the shared state management builders.
  for(const [owner,builders] of Object.entries({buildBookPeoplePanel:['buildWorldManagerCharactersPanel','buildWorldManagerRelationshipsPanel'],buildBookWorldPanel:['buildWorldManagerWorldPanel'],buildBookStoryPanel:['buildWorldManagerNarrativePanel','buildNarrativeDirectionPanel']})) {
    const body=extract(source,owner);
    for(const builder of builders) assert.ok(body.includes(`${builder}()`),`${owner} must retain ${builder}`);
  }
};
