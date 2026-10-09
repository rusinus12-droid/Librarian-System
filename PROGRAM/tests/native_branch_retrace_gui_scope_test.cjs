'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {parent,character,clone}=require('./fixtures/native_branch_fixture.cjs');
const p=path.join(__dirname,'..'),source=fs.readFileSync(path.join(p,'plugins/RETRACE.js'),'utf8'),sdk=fs.readFileSync(path.join(p,'sdk/MemorySuiteHostLineage.source.js'),'utf8');
const i=source.indexOf('  const refreshOverview = async () => {'),j=source.indexOf('  const renderDiagnosticsPanel =',i);assert(i>=0&&j>i);
async function run(mode){const chat=parent('current',5),char=character([chat]);const expected={character:clone(char),chat:clone(chat)};const Runtime={overviewRefreshToken:0,visible:true,lastPreview:null,compatibilitySuite:null};
 const fn=vm.runInNewContext(sdk+'\nconst MemorySuiteHostLineage=createMemorySuiteHostLineage();\n'+source.slice(i,j)+';refreshOverview',{
 Runtime,renderOverviewPanel(){},renderDiagnosticsPanel(){},inspectTransition:async()=>{const result={context:expected};Runtime.lastPreview=result;return result},refreshMemorySuiteOwnerStorageDashboard:async()=>{},inspectCompatibilitySuite:async()=>{Runtime.compatibilitySuite={compatible:true}},compact:x=>String(x),
 getCurrentContext:async()=>{if(mode==='switch')chat.id='sibling';if(mode==='edit')chat.message[1].data='changed';if(mode==='hide')Runtime.visible=false;return {character:char,chat};}
 });const result=await fn();return {result,Runtime};}
(async()=>{const ok=await run('same');assert.ok(ok.result);for(const mode of ['switch','edit']){const f=await run(mode);assert.equal(f.result,null);assert.equal(f.Runtime.lastPreview,null);assert.equal(f.Runtime.compatibilitySuite,null);assert.ok(f.Runtime.overviewError)}console.log(JSON.stringify({test:'native_branch_retrace_gui_scope',passed:3}));})().catch(e=>{console.error(e);process.exitCode=1});
