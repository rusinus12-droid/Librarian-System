'use strict';
const assert = require('node:assert/strict');
const {test}=require('node:test');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const MARKER='HELD_T5_MUST_NOT_ENTER_PARTIAL_7491';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function prepared(){
  const fx=await serverFixture({mode:'plugin_only',args:{classic_live_tail_enabled:'true'}});
  fx.f.chat.message[9].data+=` ${MARKER}`;
  await fx.f.run();
  await fx.f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
  const key=[...fx.local].find(([,raw])=>{try{const x=JSON.parse(raw);return x.schema==='libra.completed_turn_receipt.v1'&&x.turn===5;}catch{return false;}})[0];
  const get=fx.backend.getItem;
  let held=false, release;
  const gate=new Promise(resolve=>{release=resolve;});
  fx.backend.getItem=async k=>{if(!held&&k===key){held=true;await gate;}return get(k);};
  return {fx,release,isHeld:()=>held};
}
test('partial receipt result survives an inner deadline overshoot',async()=>{
  // A real event-loop pause can consume the 25ms reserve after the physical
  // receipt timer fires. Keep the actual deadline and every source assertion.
  const a=await prepared();let stalled=false;
  try{
    const timer=a.fx.f.r.context.setTimeout;
    a.fx.f.r.context.setTimeout=(fn,ms,...args)=>timer(()=>{
      if(!stalled&&a.isHeld()&&ms>=1000&&ms<1400){
        stalled=true;const end=performance.now()+75;while(performance.now()<end){}
      }
      fn(...args);
    },ms);
    const prompt=await a.fx.f.control.hooks.beforeRequest([{role:'user',content:'Continue after timer pause'}],'model');
    assert.equal(stalled,true,'the physical receipt timeout experienced a real event-loop pause');
    const tail=a.fx.f.r.api.getLastLiveTail();
    assert.deepEqual(Array.from(tail?.sourcePairs||[],p=>p.turn),[2,3,4],
      'a selected bounded partial result survives the inner deadline overshoot');
    assert.doesNotMatch(tail.transcript,new RegExp(MARKER));
    assert.match(prompt.map(p=>p.content||'').join('\n'),/Continue after timer pause/);
    const hash=tail.hash;a.release();await sleep(50);
    assert.equal(a.fx.f.r.api.getLastLiveTail()?.hash,hash,'late physical read cannot add held T5');
    console.log('PASS partial receipt publication after event-loop deadline overshoot');
  }finally{a.release();await a.fx.cleanup();}
});
test('unselected receipt completion cannot overwrite a newer diagnostic',async()=>{
  // Delay only the inner receipt timeout callback until the outer request has
  // selected its fallback and a newer request has published a complete tail.
  const b=await prepared();let lateTimer=null;
  try{
    const timer=b.fx.f.r.context.setTimeout;
    b.fx.f.r.context.setTimeout=(fn,ms,...args)=>timer(()=>{
      if(!lateTimer&&b.isHeld()&&ms>=1000&&ms<1400){lateTimer=()=>fn(...args);return;}
      fn(...args);
    },ms);
    await b.fx.f.control.hooks.beforeRequest([{role:'user',content:'First request times out'}],'model');
    assert.equal(typeof lateTimer,'function','the inner completion remains pending after outer timeout');
    await b.fx.f.control.hooks.beforeRequest([{role:'user',content:'New request owns the diagnostic'}],'model');
    const newer=b.fx.f.r.api.getLastLiveTail();
    assert.deepEqual(Array.from(newer.sourcePairs,p=>p.turn),[2,3,4,5]);
    const hash=newer.hash;lateTimer();await sleep(50);
    assert.equal(b.fx.f.r.api.getLastLiveTail()?.hash,hash,
      'an unselected late receipt result cannot overwrite a newer request diagnostic');
    b.release();await sleep(50);
    assert.equal(b.fx.f.r.api.getLastLiveTail()?.hash,hash);
    console.log('PASS unselected late receipt result cannot publish runtime state');
  }finally{b.release();await b.fx.cleanup();}
});
