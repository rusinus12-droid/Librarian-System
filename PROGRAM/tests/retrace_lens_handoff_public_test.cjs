'use strict';
// Same five deployed peers and public RE:TRACE transition as U1; the lens adds
// real owner-produced notes, verified successor readers, and a fresh boot.
const assert=require('node:assert/strict');
require('./fixtures/retrace_u1_owner_writer_fixture.cjs').run({scenario:'different',gui:true,transformHarness(source){
 const replace=(before,after)=>{assert.ok(source.includes(before),'lens U1 seam exists: '+before.slice(0,70));source=source.replace(before,after);};
 replace('  const stableRows = rows =>',`  const savedModel=host.runLLMModel;
  host.runLLMModel=async()=>({type:'success',result:JSON.stringify({items:[{label:'약속',text:'지호는 은빛 열쇠를 오늘 반환하기로 약속했다.',refs:['t2-a'],quote:'오늘 돌려주겠다고 약속했다'}]})});
  for(const status of ['active','paused']){
    const lens=await libra.createLens({name:'승계 '+status,instruction:{goal:'열쇠와 약속'},status,cadence:{mode:'manual'}});
    assert.equal((await libra.runLensForRange(lens.lensId,{startTurn:1,endTurn:5})).ok,true);
  }
  host.runLLMModel=savedModel;
  const stableRows = rows =>`);
 replace('      const ownerReads = await targetOwnerReads(booted.context);',`      const ownerReads = await targetOwnerReads(booted.context);
      const lensTarget=await booted.context.__LIBRA__.inspectScopeLenses();
      assert.equal(lensTarget.memories.length,2);assert.ok(lensTarget.memories.every(item=>item.inherited&&item.readOnly));
      assert.equal(result.libraVerification?.verifiedLensArchives,2);assert.equal(result.libraVerification?.verifiedLensRecords,2);
      assert.match(booted.context.document.querySelector('[data-job-result]').textContent,/렌즈 기록 2개/);
      const lensRecall=await booted.context.__LIBRA__.recallLensMemories({query:'은빛 열쇠 약속',canonicalBudgetChars:12000});
      assert.match(lensRecall.renderedBlock,/이전 대화/);assert.ok(lensRecall.usedChars<=2600);`);
 replace('rebootReads = await targetOwnerReads(reboot.context);',`rebootReads = await targetOwnerReads(reboot.context);
        const lensReload=await reboot.context.__LIBRA__.inspectScopeLenses();
        assert.equal(JSON.stringify(lensReload.memories),JSON.stringify(lensTarget.memories),'immutable inherited notes survive reboot exactly');`);
 replace("assert.equal(rebootJournal.transferId, result.transferId, 'reboot reader sees the same transfer');",`
        assert.equal(rebootJournal.transferId,result.transferId);
        const rolledBack=await reboot.retrace.rollbackLibraLensHandoff({transferId:result.transferId,targetChatId:result.targetChatId});
        assert.equal(rolledBack.verified,true);assert.equal(rolledBack.removedRefs,2);
        assert.equal((await reboot.context.__LIBRA__.inspectScopeLenses()).memories.length,0);
        assert.equal((await reboot.context.__LIBRA__.getCanonicalMemories()).length,1,'lens rollback keeps canonical data');`);
 replace("console.log('U1_OWNER_WRITER_SUMMARY ' + JSON.stringify(auditSummary));",`
      console.log('LENS_U1_SUMMARY '+JSON.stringify({ok:auditSummary.publicResultOk,journal:auditSummary.journalState,lensArchives:result.libraVerification.verifiedLensArchives,lensRecords:result.libraVerification.verifiedLensRecords,reboot:true,rollback:true,gui:auditSummary.gui}));`);
 return source;
}});
