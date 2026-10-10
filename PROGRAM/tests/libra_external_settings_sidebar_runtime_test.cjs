'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const part=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,a);return source.slice(i,j);};
const el=(tag,attrs={},children=[])=>({tag,...attrs,children:children.filter(Boolean)}),flat=n=>[n,...(n.children||[]).flatMap(flat)];
const renders=[],refreshes=[],settings={retainedDraft:'unsaved edits'};
const c=vm.createContext({Gui:{bookPage:'memory',settingsHubSection:'input_writer',bookSettingsWorkbenchSection:'settings',dirty:true,state:settings,invalidations:new Set()},
 guiEl:el,queueGuiNavigationRender:()=>renders.push('navigation'),queueGuiRender:()=>{},closeCanonicalRangeDrawer:()=>{},resetCanonicalReaderView:()=>{},activeGuiResponseFamily:()=> 'libra',
 refreshModuleLoreCatalog:()=>{refreshes.push('modules');},refreshCharacterLoreCatalog:()=>{refreshes.push('character_lore_exclusions');},
 normalizePromptInjectionSection:v=>v,LIBRARIAN_STAGE_ID:'librarian',RETIRED_MEMORY_STAGE_IDS:[],GRADIA_STAGE_ALIAS_MAP:{},
 buildBookPage:(e,t,d,children)=>el('main',{text:t},children),buildBookMemoryAdvancedSettings:()=>el('article',{section:'pipeline'}),buildBookSaveBar:()=>el('footer',{dataset:{bookSaveBar:'true'}}),saveGuiState:()=>{throw Error('navigation must not save');},revertGuiStateFromStorage:()=>{throw Error('navigation must not reload');}});
vm.runInContext(part('const LIBRA_MEMORY_PIPELINE_STAGES =','const GUI_FAMILY_HUB_STATE_KEYS =')+
 part('const migrateCustomWorkshopSelection =','const buildSharedCustomShellPanel =')+
 part('const BOOK_NATIVE_SETTINGS_SECTIONS =','const bookQuickChoiceCard =')+
 part('const BOOK_EXTERNAL_SETTINGS_ITEMS =','const BOOK_MOBILE_ITEMS =')+
 part('const optionNodes =','const inputNode =')+
 ';Object.assign(globalThis,{items:BOOK_EXTERNAL_SETTINGS_ITEMS,selectBookSettingsRoomSection,buildBookSidebar,selectBookExternalSettings,bookExternalSettingsActive,buildBookSettingsNativeInnerPanel,buildBookSettingsPanel,buildBookNativeSettingsRoom,syncBookNavigationFromSharedTarget,bookSettingsRoomActiveSection});',c);
// The production list is lexically scoped inside the extracted source; keep a
// fixture-side copy for the navigation assertions that need item metadata.
c.items = [
  ['ai','ai'],['embedding','embedding'],['memory_analysis','pipeline'],['performance','memory'],['source_edits','source_edits'],
  ['modules','references'],['character_lore_exclusions','references'],['response_materials','references'],
  ['server','server'],['recovery','recovery'],['transfer','transfer'],['state','state'],['logs','logs'],['debug','general']
].map(([id,section])=>({id,section,group:'test',label:id}));
const panels={source_edits:"buildSourceEditConsentPanel",input_writer:'buildInputAssistSettingsPanel',references:'buildLibraReferenceHubPanel',memory:'buildLibraMemorySettingsPanel',state:'buildStateTrackingAvailabilityPanel',server:'buildLibraServerConnectionPanel',ai:'buildLibraProviderPanel',embedding:'buildLibraEmbeddingPanel',recovery:'buildLibraRecoveryPanel',transfer:'buildTransferTab',general:'buildGeneralSettingsPanel',pipeline:'buildSharedPipelineShellPanel',agents:'buildSharedAgentShellPanel',custom:'buildSharedCustomShellPanel',logs:'buildSharedExecutionLogsPanel'};
const fixtureItems = c.items;
for(const[section,name]of Object.entries(panels))c[name]=options=>el('article',{section,options});
const results=[];
function test(name,fn){fn();results.push(name);}
test('all requested settings are external, independently reachable and active without changing unsaved values',()=>{
 assert.equal(fixtureItems.length,14);c.Gui.bookPage='settings';const buttons=flat(c.buildBookSidebar()).filter(n=>n.dataset?.externalSettings);assert.equal(buttons.length,14);
 for(const button of buttons){button.onClick();const def=fixtureItems.find(x=>x.id===button.dataset.externalSettings);assert.equal(c.Gui.bookPage,'settings');assert.equal(c.bookSettingsRoomActiveSection(),def.section);assert.equal(c.buildBookSettingsNativeInnerPanel(def.section).section,def.section);const active=flat(c.buildBookSidebar()).filter(n=>n.dataset?.externalSettings&&n.dataset.active==='true');assert.equal(active.length,1);assert.equal(active[0].dataset.externalSettings,def.id);assert.equal(c.Gui.state,settings);assert.equal(c.Gui.dirty,true);}
 assert.deepEqual(refreshes,['modules','character_lore_exclusions']);assert.ok(renders.length>=14);
});
test('connection deep links use the main settings workspace instead of opening a drawer',()=>{
 c.Gui.bookQuickOpen=false;
 for(const id of ['ai','embedding']){c.syncBookNavigationFromSharedTarget({pageId:id});assert.equal(c.bookSettingsRoomActiveSection(),id);assert.equal(c.Gui.bookQuickOpen,false);}
 c.Gui.settingsHubSection='server';c.syncBookNavigationFromSharedTarget({pageId:'settings',settingsHubSection:'server'});assert.equal(c.bookSettingsRoomActiveSection(),'server');assert.equal(c.Gui.bookQuickOpen,false);
});
test('leaving an open drawer retains draft and closes its overlay; saving blocks menu changes',()=>{
 c.Gui.bookQuickOpen=true;c.selectBookExternalSettings('ai');assert.equal(c.Gui.bookQuickOpen,false);assert.equal(c.Gui.dirty,true);
 c.Gui.bookQuickSaving=true;c.selectBookExternalSettings('modules');assert.equal(c.bookSettingsRoomActiveSection(),'ai');assert.ok(flat(c.buildBookSidebar()).filter(n=>n.dataset?.externalSettings).every(n=>n.disabled));c.Gui.bookQuickSaving=false;
});
test('visible settings page has no duplicate inner index and mobile navigation is not a settings edit',()=>{
 c.selectBookExternalSettings('modules');c.Gui.dirty=false;const page=c.buildBookSettingsPanel(),nodes=flat(page);assert.ok(!nodes.some(n=>n.class==='libra-book-settings-index'));const layout=nodes.find(n=>n.dataset?.nativeSettingsRoom);assert.equal(layout.style.gridTemplateColumns,'minmax(0, 1fr)');
 assert.equal(nodes.find(n=>n.tag==='article').options.showTabs,false);const picker=nodes.find(n=>n.tag==='select');assert.equal(picker.children.length,14);picker.onChange({target:{value:'embedding'}});assert.equal(c.bookSettingsRoomActiveSection(),'embedding');assert.equal(c.Gui.dirty,false);
});
test('legacy agent and custom routes converge on the single workbench without losing draft',()=>{
 for(const [old, expected]of [['memory','memory_pipeline'],['draft','response_generation']]){
  c.Gui.agentHubSection=old;c.Gui.bookSettingsWorkbenchSection='agents';assert.equal(c.bookSettingsRoomActiveSection(),'pipeline');assert.equal(c.Gui.pipelineHubSection,expected);
  c.selectBookSettingsRoomSection('agents');assert.equal(c.bookSettingsRoomActiveSection(),'pipeline');assert.equal(c.Gui.pipelineHubSection,expected);
 }
 c.Gui.agentHubSection='state';c.Gui.bookSettingsWorkbenchSection='agents';assert.equal(c.bookSettingsRoomActiveSection(),'state');assert.equal(c.Gui.settingsHubSection,'state');
 c.Gui.bookSettingsWorkbenchSection='agents';c.selectBookSettingsRoomSection('agents');assert.equal(c.bookSettingsRoomActiveSection(),'state');assert.equal(c.Gui.settingsHubSection,'state');
 c.Gui.customHubSection='memory';c.Gui.bookSettingsWorkbenchSection='custom';assert.equal(c.bookSettingsRoomActiveSection(),'pipeline');assert.equal(c.Gui.pipelineHubSection,'memory_pipeline');
 c.selectBookExternalSettings('agents');assert.equal(c.bookSettingsRoomActiveSection(),'pipeline');assert.equal(c.Gui.state,settings);
});
console.log(JSON.stringify({test:'libra_external_settings_sidebar_runtime',passed:results.length,results,boundary:'production navigation and panel functions with DOM/storage boundary substitutes; not live RisuAI'}));
