'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const s=fs.readFileSync(path.join(__dirname,'runtime-factory-controller.source.js'),'utf8');
(async()=>{
 let writes=0;
 const ctx={runtimeDisposers:[],runtimeDetached:false,assertRuntimeActive(){},copySnapshot:x=>x,LatestTurnBaselineOwner:{isCurrent:()=>true,checkTopology:()=>true,claimPublication:()=>({}),invalidate(){}},RuntimeStateLease:{isCurrent:()=>true},MemoryEngine:{CONFIG:{}},resolveActiveChatContext:async()=>({ok:true,chat:{}}),LibraDataStorage:{readVerified:async()=>({ok:true,raw:'prior',resetGeneration:0}),saveVerified:async()=>{writes++;return {ok:false,reason:'fixture_stop'}}}};
 vm.createContext(ctx);vm.runInContext(s+'\nthis.publish=publishLatestWholeTurn; this.seed=record=>{const receipt={};preparedReanalyses.set(receipt,record);return receipt;};',ctx);
 const receipt=ctx.seed({state:'prepared',owner:{lease:{},postRaw:'prior',resetGeneration:0},source:{},configBytes:'{}',metadata:{},resolveSource:()=>({}),isViewCurrent:()=>false});
 const result=await ctx.publish(receipt);assert.equal(result.state,'rejected');assert.equal(writes,0,'closed originating view must reject before saveVerified');
 console.log(JSON.stringify({passed:1,failed:0}));
})().catch(e=>{console.error(e);process.exitCode=1});
