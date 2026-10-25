'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {create,until,pause}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const input=require('./fixtures/unified_vertical_source.json');
test('actual canonical, Micro, lens and studio buttons open the shared popup without invoking analysis',{timeout:30000},async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'libra-unified-routes-')),pluginPath=path.join(temporary,'LIBRA.js');
  const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8'),anchor='  const publicApi = Object.freeze({\n    getHostLineageStatus:';assert.ok(source.includes(anchor));
  fs.writeFileSync(pluginPath,source.replace(anchor,'  globalThis.__readerRoutes={core:LibraMemoryCore,Gui};\n'+anchor));let f,calls=0;
  try{
    f=await create('LIBRA','Full',{pluginPath,initialChat:input.sourceRows.map(row=>({role:row.role,chatId:row.ref,data:row.text})),host:{runLLMModel:async options=>{
      calls++;const system=options.messages[0].content;
      if(system.includes('MICRO SOURCE CONTRACT')){
        const value=JSON.parse(options.messages.find(row=>row.role==='user').content),quote=value.assistant.text.slice(0,24);
        return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...value.binding,claims:[{changeKind:'event',text:'검증된 Micro 기억 '+calls,actor:'',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence:{role:'assistant',messageId:value.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
      }
      if(system.includes('[LIBRA LENS ANALYZER'))return {type:'success',result:JSON.stringify({items:[{label:'사건',text:'도서관의 설정을 기록했다. '+calls,refs:['t1-a'],quote:input.sourceRows.find(row=>row.ref==='t1-a').text.slice(0,24)}]})};
      return {type:'success',result:JSON.stringify(artifact())};
    }}});
    const {api,doc,context}=f,{core}=context.__readerRoutes;assert.equal((await api.runManualColdStart()).completed,1);
    const inventory=await api.listReanalysisRanges({kind:'micro'});assert.equal((await api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(row=>row.key==='2')})).ok,true);
    const lens=await api.createLens({name:'경로 확인 렌즈',instruction:{goal:'사건을 기록한다.'},cadence:{mode:'manual'},evidenceMode:'strict'});assert.equal((await core.runLensForRange({lensId:lens.lensId,startTurn:1,endTurn:2})).ok,true);
    const unopenedCalls=calls;await api.openSourceReanalysis({kind:'micro',scopeKey:core.peekSnapshot().scope.scopeKey,startTurn:2,endTurn:2});await until(()=>doc.querySelector('[data-reanalysis-page]')?.dataset.reanalysisPage==='micro'&&doc.querySelector('[data-reanalysis-ranges] input:checked')?.value==='2','open popup from hidden GUI',10000);assert.equal(calls,unopenedCalls);doc.querySelector('#dlg-libra-source-reanalysis .dialog__actions button').click();
    await pause(300);doc.querySelector('.sidebar [data-go="memory"]').click();await until(()=>doc.querySelector('[data-canonical-chapter][data-detail-loaded="true"]'),'canonical reader',10000);
    const selected=()=>[...doc.querySelectorAll('#dlg-libra-source-reanalysis [data-reanalysis-ranges] input:checked')].map(row=>row.value);
    const assertPopup=async(kind,key,before)=>{await until(()=>doc.querySelector('[data-reanalysis-page]')?.dataset.reanalysisPage===kind&&(!key||selected().includes(key)),'contextual '+kind+' popup',10000);assert.equal(calls,before,'navigation cannot invoke models');};
    const close=()=>doc.querySelector('#dlg-libra-source-reanalysis .dialog__actions button').click();
    let before=calls;const oldRevision=Number(context.__readerRoutes.Gui.canonicalReaderDetail.revision),canonical=doc.querySelector('[data-canonical-reader-reanalysis]');assert.ok(canonical);assert.equal(canonical.closest('.manage-only'),null);canonical.click();await assertPopup('canonical','1-5',before);
    doc.querySelector('[data-reanalysis-run]').click();await until(()=>!doc.querySelector('#dlg-libra-source-reanalysis'),'canonical completion',10000);assert.equal(calls,before+1);await until(()=>Number(context.__readerRoutes.Gui.canonicalReaderDetail?.revision)>oldRevision,'refreshed canonical revision',10000);
    [...doc.querySelectorAll('[data-canonical-job-portal] button')].find(button=>button.textContent==='닫기')?.click();
    doc.querySelector('[data-memory-reader-kind="micro"]').click();await until(()=>doc.querySelector('[data-micro-reader-turn="2"]'),'Micro list',10000);doc.querySelector('[data-micro-reader-turn="2"]').click();await until(()=>doc.querySelector('[data-micro-reader-detail="2"] [data-micro-reader-claim]'),'Micro detail',10000);
    before=calls;doc.querySelector('[data-micro-reader-reanalysis]').click();await assertPopup('micro','2',before);doc.querySelector('[data-reanalysis-run]').click();await until(()=>!doc.querySelector('#dlg-libra-source-reanalysis'),'Micro completion',10000);assert.equal(calls,before+1);await until(()=>doc.querySelector('[data-micro-reader-claim]')?.textContent.includes('검증된 Micro 기억 '+calls),'refreshed Micro',10000);
    doc.querySelector('[data-memory-reader-kind="lens"]').click();await until(()=>doc.querySelector('[data-lens-item-reanalysis]'),'lens item',10000);assert.equal(doc.querySelector('[data-lens-run-range-button]'),null);
    before=calls;doc.querySelector('[data-lens-item-reanalysis]').click();await assertPopup('lens','1-2',before);assert.equal(doc.querySelector('[data-reanalysis-lens]').value,lens.lensId);doc.querySelector('[data-reanalysis-run]').click();await until(()=>!doc.querySelector('#dlg-libra-source-reanalysis'),'lens completion',10000);assert.equal(calls,before+1);await until(()=>doc.querySelector('.lens-item__text')?.textContent.includes('도서관의 설정을 기록했다. '+calls),'refreshed lens',10000);
    before=calls;doc.querySelector('[data-lens-reader-reanalysis]').click();await assertPopup('lens',null,before);close();
    const studio=[...doc.querySelectorAll('.lens-rail__head button')].find(button=>button.textContent==='렌즈 스튜디오');assert.ok(studio);studio.click();await until(()=>doc.querySelector('[data-lens-studio-reanalysis]'),'lens studio',10000);
    before=calls;doc.querySelector('[data-lens-studio-reanalysis]').click();await assertPopup('lens',null,before);assert.equal(doc.querySelector('#dlg-prompt').classList.contains('is-open'),false);close();
    assert.equal(doc.querySelector('[data-recovery-kind="micro"]'),null);assert.equal(doc.querySelector('[data-unified-legacy-rebuild]'),null);
  }finally{await f?.close?.();fs.rmSync(temporary,{recursive:true,force:true});}
});
