'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {load}=require('./host.cjs');
const prefix='serial_gradation_agents_for_rp:';
const retired=['prepareSessionHandoff','adoptSessionHandoff','verifySessionHandoff','retraceCapabilities','inspectForRetrace','getWriterControl','forceWriterRefresh','clearWriterDesigns','listWriterDesigns','getStoryArc','syncStoryArc','rebuildStoryArc','clearStoryArc','getArcDirectorStatus','getNarrativeLocalVectorStorageStats','debugLoadNarrativeArchiveEntryVector','exportLegacyMemory','debugNativeChatCopy'];
test('removed Writer Arc Archive and session-transfer APIs are absent rather than throwing stubs',async()=>{
 const h=await load();for(const name of retired)assert.equal(h.plugin[name],undefined,name);
 assert.equal(typeof h.plugin.runCreativeDirectionOoc,'function');assert.equal(typeof h.plugin.compileCreativeDirectionOoc,'function');
 assert.equal(typeof h.plugin.bindLibReadOnlyClient,'function');
});
test('retired runtime implementations and automatic native-copy adoption are deleted from the active plugin',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../plugins/GRADIA.js'),'utf8');
 assert.doesNotMatch(source,/label: 'Arc Director'|narrativeArchiveViewerHydrationPromise:/,'retired summary cards and GUI state are removed');
 for(const name of ['ensureWriterControl','prepareGradiaSessionHandoff','adoptGradiaSessionHandoff','verifyGradiaSessionHandoff','ensureNativeChatCopyAdopted','readStoryArcStore','writeStoryArcStore','readNarrativeArchiveStore','writeNarrativeArchiveStore'])assert.doesNotMatch(source,new RegExp('(?:const|function)\\s+'+name+'\\b'),name);
});
test('active creative OOC still compiles and saves a global stage prompt while legacy user records remain untouched',async()=>{
 const legacy=JSON.stringify({version:1,designs:{old:{updatedAt:1,manualUserIntent:{enabled:true,purpose:'Recovered user direction',instructions:['LEGACY_USER_DIRECTION'],summary:'old',revision:1,updatedAt:1}}}});
 const archive='{"private":"LEGACY_ARCHIVE_BYTES"}',prompts=[];
 const h=await load({storage:{[prefix+'writer_designs:v1']:legacy,[prefix+'narrative_archives:v1']:archive},api:{nativeFetch:async(url,init)=>{
  assert.match(url,/^https:\/\/offline\.invalid\//);prompts.push(JSON.parse(init.body));
  const content=prompts.length===1?'Agreed. I will use concrete actions and dialogue.':JSON.stringify({enabled:true,summary:'Creative guidance',creative_instruction:'Show emotion through action and dialogue.\nPreserve this plain prompt.'});
  return {ok:true,status:200,json:async()=>({choices:[{message:{content},finish_reason:'stop'}]}),text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
 }}});
 await h.plugin.saveProviderPreset('default',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',model:'synthetic',key:'test-only'});
 const reply=await h.plugin.runCreativeDirectionOoc('Use actions and dialogue for emotion.','aide_character');assert.ok(reply.reply);
 await h.plugin.compileCreativeDirectionOoc('aide_character');
 const saved=await h.plugin.getPromptOverrides();assert.equal(saved.before.aide_character.customPrompt,'Show emotion through action and dialogue.\nPreserve this plain prompt.');
 assert.ok(saved.before.shadow_act.customPrompt.includes('LEGACY_USER_DIRECTION'));
 assert.equal(h.store.get(prefix+'writer_designs:v1'),legacy);assert.equal(h.store.get(prefix+'narrative_archives:v1'),archive);assert.equal(prompts.length,2);
});
