'use strict';
// Embedded Planner/GRADIA workspaces and writing controls were retired. The
// surviving memory shell, lazy prompt workspace, save/revert and Book routes
// remain a concrete runtime contract, not a retirement-only source check.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.argv[2]||path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const part=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert(i>=0&&j>i,a);return source.slice(i,j);};
const state={runtime:{memoryMode:'draft-value'}},events=[];
const el=(tag,attrs={},children=[])=>({tag,attrs,children:children.filter(Boolean),addEventListener(kind,fn){this[kind]=fn;}});
const c=vm.createContext({Gui:{state,dirty:true,pipelineHubSection:'response_generation',agentHubSection:'draft'},Runtime:{settings:{cached:true},settingsLoadedAt:99},
 guiEl:el,guiLazyDetails:(attrs,summary,build)=>({...el('details',attrs,[summary]),build}),
 buildLibrarianAnalyzerPanel:(compact,advanced)=>{assert.equal(compact,false);assert.equal(advanced,true);return el('analysis');},
 setSharedCustomPromptDomain:domain=>events.push(['domain',domain]),buildLibraPromptStudioPanel:options=>{events.push(['prompt',options.allowedDomains]);return el('prompts');},
 LibraMemoryCore:{loadSettings:async options=>events.push(['core',options.force])},loadSettings:async()=>({runtime:{memoryMode:'persisted'}}),readSettingsPersistenceBasis:async()=>({semanticHash:'persisted-hash'}),
 applyGuiSettingsState:(settings,options)=>{c.Gui.state=settings;c.Gui.dirty=options.keepDirty!==false;events.push(['apply',options.basisHash]);},clearRequestReuseCache:()=>events.push(['clear']),renderSettingsGui:async()=>events.push(['render']),guiSetStatus:()=>events.push(['status'])});
vm.runInContext(part('const buildMemoryPipelineWorkspacePanel =','const setSharedCustomPromptDomain =')+part('const revertGuiStateFromStorage =','const primeGuiStateFromRuntimeCache =')+'\nObject.assign(globalThis,{buildSharedPipelineShellPanel,revertGuiStateFromStorage});',c);
(async()=>{
 const shell=c.buildSharedPipelineShellPanel();assert.equal(c.Gui.pipelineHubSection,'memory_pipeline');assert.equal(c.Gui.agentHubSection,'memory');assert.equal(shell.attrs.dataset.agentFamily,'libra');assert.equal(shell.children[0].tag,'analysis');
 assert.equal(c.Gui.state,state);assert.equal(c.Gui.dirty,true);assert.deepEqual(events,[],'render must not build prompts eagerly, save, or revert');
 shell.children[1].build();assert.equal(events[0][1],'memory');assert.deepEqual(Array.from(events[1][1]),['memory']);
 c.Gui.settingsSavePromise=Promise.resolve();assert.equal(await c.revertGuiStateFromStorage(),false);assert.equal(c.Gui.state,state,'a pending save cannot be overwritten by revert');
 c.Gui.settingsSavePromise=null;events.length=0;assert.equal(await c.revertGuiStateFromStorage(),true);assert.equal(c.Gui.state.runtime.memoryMode,'persisted');assert.equal(c.Gui.dirty,false);assert.equal(c.Runtime.settings,null);assert.equal(c.Runtime.settingsLoadedAt,0);assert.deepEqual(events.map(x=>x[0]),['core','apply','clear','render','status']);
 const render=part('async function renderSettingsGuiOnce()','const hideSettingsGui =');
 assert.match(render,/revertGuiStateFromStorage\(\)/);assert.match(render,/\[buildSidebarRegion\(\), buildMainRegion\(\)\]/);assert.doesNotMatch(render,/buildSharedHeaderStatusPanel\(\)|buildInsightRail\(\)/);
 require('./helpers/libra_active_book_routes.cjs')(source);
 assert.match(source,/\.libra-header-status,\.sga-insight-rail\{display:none!important\}/);
 console.log('libra_pipeline_draft_workspace_rc2_test: PASS (memory workspace and revert; family drafting controls retired)');
})().catch(e=>{console.error(e);process.exitCode=1;});
