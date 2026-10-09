const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'); const vm=require('node:vm');
const file=process.env.GRADIA_FILE||require('node:path').join(__dirname,'../../plugins/GRADIA.js');
const {load}=require('./host.cjs');
test('old imported settings cannot restore second rewrite or private analysis',async()=>{
 const {plugin,getCalls}=await load();
 for(const legacy of [{output_mode:'risu_engine',information_transfer_mode:'draft_and_analysis'},{outputMode:'risu_engine',informationTransferMode:'draft_and_analysis'}]){
  const input=JSON.stringify(legacy);const result=plugin.debugImportedRuntimeToGui(legacy,{});
  assert.equal(result.outputMode,'draft_guided');assert.equal(result.informationTransferMode,'draft_only');assert.equal(JSON.stringify(legacy),input);
 }
 assert.equal(getCalls(),0);
});
test('private analysis cannot enter final handoff; draft and raw input retained',async()=>{
 const {plugin,getCalls}=await load();
 const stages=[{stage:'shadow_act',ok:true,draft:{rp_text:'Scene draft'},analysis:{summary:'PRIVATE_SENTINEL',constraints:['PRIVATE_SENTINEL'],risks:['PRIVATE_SENTINEL']},twoCallAnalysis:{analysis:{summary:'PRIVATE_SENTINEL',constraints:['PRIVATE_SENTINEL']}}}];
 const before=JSON.stringify(stages);
 assert.equal(plugin.debugBuildInformationTransfer(stages,'draft_and_analysis'),'');
 const recent={latestUser:'USER_RAW_SENTINEL',latestAssistant:'AI_RAW_SENTINEL'};const raw=JSON.stringify(recent);
 for(const writingMode of ['rp','novel']) {
 const out=plugin.debugBuildFinalOverlayDetailed('FINAL_DRAFT_SENTINEL',recent,{outputMode:'risu_engine',informationTransferMode:'draft_and_analysis',writingMode,twoCallAnalysis:stages[0].twoCallAnalysis});
 assert.ok(out.draftPreserved);assert.ok(out.overlay.includes('FINAL_DRAFT_SENTINEL'));assert.ok(!out.overlay.includes('PRIVATE_SENTINEL'));
 }
 assert.equal(JSON.stringify(stages),before);assert.equal(JSON.stringify(recent),raw);assert.equal(getCalls(),0);
});
test('input writer and recent-turn/lore public hooks remain available',async()=>{
 const {plugin,hooks}=await load();
 assert.equal(typeof plugin.rewriteInput,'function');assert.equal(hooks.input,undefined);assert.equal(typeof hooks.beforeRequest,'function');assert.equal(typeof plugin.debugBuildRecentChat,'function');assert.equal(typeof plugin.debugStageLoreReferenceFilter,'function');
 const messages=[{role:'user',messageId:'u1',content:'past'},{role:'assistant',messageId:'a1',content:'answer'},{role:'user',messageId:'u2',content:'current'}];const raw=JSON.stringify(messages);
 const recent=plugin.debugBuildRecentChat(messages,8);assert.equal(recent.latestUser,'current');assert.equal(JSON.stringify(messages),raw);
});
test('full source has no retired choice actions, final rewrite invocation or projection',{skip:(process.env.GRADIA_BUILD_FLAVOR==='Min'||process.env.GRADIA_FILE?.includes('.min.'))},()=>{
 const source=fs.readFileSync(file,'utf8');
 assert.ok(!/onClick:.*(?:applyInformationTransferModeToGui\('draft_and_analysis'\)|applySimpleOutputToGui\('risu_engine'\))/.test(source));
 assert.ok(!/await runRisuResponseEngine\(/.test(source));
 assert.ok(!/projectedCacheCalls\.push\([^\n]*RISU_ENGINE_STAGE/.test(source));
});
test('legacy stage planning keeps only SHADOW and serial AIDEs',async()=>{
 const {plugin}=await load();
 const plan=plugin.debugPipelineWorkStagePlan({mode:'normal',enableShadowAct:true,enableCharacterAide:true,enableWorldAide:true,enablePlotAide:true,outputMode:'risu_engine'});
 assert.deepEqual(Array.from(plan),['shadow_act','aide_character','aide_world','aide_plot']);
});
test('easy settings definition has no retired rewrite option',{skip:(process.env.GRADIA_BUILD_FLAVOR==='Min'||process.env.GRADIA_FILE?.includes('.min.'))},()=>{
 const source=fs.readFileSync(file,'utf8');
 const def=source.split('const SIMPLE_OUTPUT_DEFS =')[1].split('const NSFW_MODES')[0];
 assert.ok(!def.includes('risu_engine'));
});
test('default completed window and explicit stage overrides survive',async()=>{
 const {plugin}=await load();const messages=[];
 for(let i=1;i<=10;i++) messages.push({role:'user',messageId:`u${i}`,content:`Past user ${i}`},{role:'assistant',messageId:`a${i}`,content:`Past answer ${i}`});
 messages.push({role:'user',messageId:'u11',content:'Current action'});
 const before=JSON.stringify(messages);const recent=plugin.debugBuildRecentChat(messages);
 assert.equal(recent.recentTurnCount,8);assert.equal(recent.latestUser,'Current action');assert.equal(JSON.stringify(messages),before);
 const slots={shadow_act:{turn_window:5},aide_character:{turn_window:12},aide_world:{turn_window:3},aide_plot:{turn_window:1}};
 const result=plugin.debugAgentSlotV3Envelope(slots);
 for(const [stage,value] of Object.entries(slots))assert.equal(result.slots[stage].turn_window,value.turn_window);
 const injected=plugin.debugInjectSystemMessage(messages,'DRAFT_HANDOFF');
 assert.equal(JSON.stringify(injected.filter(m=>m.messageId)),JSON.stringify(messages));assert.equal(JSON.stringify(messages),before);
 const preservation=plugin.verifyMessageTransport(messages);assert.equal(preservation.preserved,true);assert.equal(preservation.identityPreserved,true);assert.equal(preservation.valuePreserved,true);
});
