'use strict';
// The former paper workbench identity is superseded by the explicitly approved
// original mockup. Reachability, authority and independent setting owners remain.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../plugins/LIBRA.js'),'utf8');
const {extract,identity,literal}=require('./helpers/libra_approved_gui_contract.cjs');identity(source);
const ctx={Object,Array};vm.createContext(ctx);vm.runInContext(extract(source,'BOOK_SIDEBAR_PAGE_REGISTRY')+';this.pages=BOOK_SIDEBAR_PAGE_REGISTRY;',ctx);
assert.deepEqual(JSON.parse(JSON.stringify(ctx.pages.map(x=>x.id))),['desk','memory','people','world','story','settings']);
const pages=extract(source,'buildApprovedMockupDestinationDetail'),settings=extract(source,'buildApprovedMockupSettingsPanel'),quick=extract(source,'buildBookQuickSettingsDrawer');
for(const fn of ['buildBookMemoryReaderProjection','buildWorldManagerCharactersPanel','buildWorldManagerRelationshipsPanel','buildWorldManagerWorldPanel','buildWorldManagerNarrativePanel'])assert.match(pages+extract(source,'buildApprovedMockupMemory'),new RegExp(fn+'\\('),fn+' remains reachable');
for(const fn of ['buildLibrarianAnalyzerPanel','buildSharedExecutionLogsPanel','buildLibraReferenceHubPanel','buildAnalysisInputPanel','buildStateTrackingAvailabilityPanel','buildTransferTab','buildGeneralSettingsPanel','buildLibraServerConnectionPanel','buildLibraMemoryRestorePanel','buildApprovedProviderExpertFields','buildApprovedEmbeddingOperations'])assert.match(settings,new RegExp(fn+'\\('),fn+' has an actual Settings destination');
// The prompt dialog hosts the Lens Studio; the canonical prompt editor is retired (locked prompt).
assert.match(extract(source,'openApprovedPromptDialog'),/renderLensStudio\(\)/,'the prompt dialog hosts the Lens Studio');assert.doesNotMatch(extract(source,'openApprovedPromptDialog'),/buildLibraPromptStudioPanel/,'the canonical prompt editor is not mounted');
for(const forbidden of ['buildBookQuickInputWriterPanel','buildInputAssistSettingsPanel','buildMemoryPipelinePanel','buildGradiaDraftSettingsPanel','buildLibraResponseModeSettingsPanel'])assert.doesNotMatch(quick,new RegExp(forbidden+'\\('),'retired/duplicate workspace must not mount');
assert.match(quick,/buildBookQuickMemoryAgentsPanel\(\)/);assert.match(quick,/buildBookRecallSettingsPanel\(\)/);
assert.match(extract(source,'buildBookRecallSettingsPanel'),/buildBookQuickLibraResponsePanel\(\)/);
const quickMode=extract(source,'buildBookQuickLibraResponsePanel');assert.match(quickMode,/buildLibraClassicPanel\(\{compact:true\}\)/);assert.match(quickMode,/buildLibraLiveContextSettingsPanel\(\)/);
assert.match(quick,/drawer__head/);assert.match(quick,/drawer__body/);assert.match(quick,/drawer__foot savebar/);assert.match(quick,/saveBookQuickSettings/);assert.match(quick,/revertGuiStateFromStorage/);
assert.match(literal(source,'LIBRA_APPROVED_MOCKUP_STYLE'),/\.btn--primary\{/,'save uses original approved button palette');
for(const name of ['BOOK_PEOPLE_SECTIONS','BOOK_STORY_SECTIONS','BOOK_SETTINGS_WORKBENCH_SECTIONS','BOOK_QUICK_SECTIONS'])assert.ok(source.includes(name),'retained compatibility section '+name);
require('./helpers/libra_active_book_routes.cjs')(source);
const story=extract(source,'buildApprovedMockupStory');assert.match(story,/saveNarrativeDirectionDraft\(\)/);assert.match(story,/clearNarrativeDirectionDraft\(\)/);assert.match(pages,/buildWorldManagerNarrativePanel\(\)/,'current facts retain a distinct management path from future direction');
const relationshipRead=extract(source,'buildApprovedMockupPeople');assert.match(relationshipRead,/subjectId/);assert.match(relationshipRead,/targetId/);assert.match(relationshipRead,/rel__arrow/);assert.doesNotMatch(source,/const renderActiveTab\s*=|const buildBookPage\s*=/,'retired paper renderer is absent');
console.log('libra_book_ux_1to1_contract_test: PASS (approved mockup ownership and retained controls)');
