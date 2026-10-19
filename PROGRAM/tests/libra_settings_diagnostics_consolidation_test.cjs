'use strict';
// Execute the current diagnostics builders; user selection controls lazy hydration.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {maskSource}=require('../tools/lib/ultralight_scan.cjs');
const source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const masked=maskSource(source);
function declaration(name){
 const start=masked.indexOf('const '+name+' =');assert.ok(start>=0,'current builder exists: '+name);
 let depth=0;
 for(let i=start;i<masked.length;i++){
  const c=masked[i];if('({['.includes(c))depth++;else if(')}]'.includes(c))depth--;
  else if(c===';'&&depth===0)return source.slice(start,i+1);
 }
 throw Error('unterminated builder: '+name);
}
const built=[],hydrations=[],Gui={diagnosticLogSection:'log'};
const el=(tag,attrs={},children=[])=>({tag,...attrs,children:children.filter(Boolean)});
const panel=id=>()=>{built.push(id);return el('section',{panel:id});};
const context=vm.createContext({Gui,guiEl:el,
 fieldNode:(label,control)=>el('label',{text:label},[control]),optionNodes:rows=>rows.map(([value,label])=>el('option',{value,text:label})),
 guiLazyDetails:(attrs,summary,build)=>{hydrations.push(build);return el('details',attrs,[summary]);},queueGuiNavigationRender(){},
 buildOperationalHealthPanel:panel('health'),buildSwallowedDiagPanel:panel('swallowed'),buildWorldManagerDiagnosticsPanel:panel('state_reflection'),buildDebugTab:panel('runtime'),buildDiagnosticLogList:panel('log')});
vm.runInContext(['DIAGNOSTIC_LOG_SECTIONS','buildDiagnosticLogSection','buildGeneralSettingsPanel'].map(declaration).join('\n')+'\nObject.assign(globalThis,{DIAGNOSTIC_LOG_SECTIONS,buildGeneralSettingsPanel});',context);
const ids=Array.from(context.DIAGNOSTIC_LOG_SECTIONS,row=>row.id);
assert.deepEqual(ids,['log','health','swallowed','state_reflection','runtime']);
for(const id of ids){
 built.length=0;hydrations.length=0;Gui.diagnosticLogSection=id;
 const node=context.buildGeneralSettingsPanel();assert.equal(node.dataset.diagnosticSettings,id);
 assert.deepEqual(built,[],'opening settings never eagerly mounts an unselected diagnostics panel');assert.equal(hydrations.length,1);
 const result=hydrations[0]();assert.deepEqual(built,[id],'opening the selected disclosure hydrates only its own live builder');assert.equal(result.children[0].panel,id);
}
Gui.diagnosticLogSection='removed-section';built.length=0;hydrations.length=0;
const fallback=context.buildGeneralSettingsPanel();assert.equal(fallback.dataset.diagnosticSettings,'log');hydrations[0]();assert.deepEqual(built,['log']);
const general=declaration('buildGeneralSettingsPanel');assert.doesNotMatch(general,/buildAnalysisInputPanel\s*\(/,'diagnostics never mounts duplicate analysis-input controls');
assert.match(source,/sectionId==='source_edits'\)return buildAnalysisInputPanel\(\)/,'the dedicated analysis-input route stays executable');
assert.match(source,/id:'source_edits',group:'settings'/,'the dedicated settings entry survives');
console.log('libra_settings_diagnostics_consolidation_test: PASS (five real builders, deferred hydration, one selected panel, stale-selection fallback, dedicated source-input route)');
