'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const createHost=require('./fixtures/risu_plugin_channel_host.cjs');
const sources=Object.fromEntries([['libra','LIBRA.js'],['serial_gradation_agents_for_rp','GRADIA.js']]
  .map(([id,file])=>[id,fs.readFileSync(path.join(__dirname,'../plugins',file),'utf8')]));
const fingerprint=text=>crypto.createHash('sha256').update(text).digest('hex');
const queryText='민아 은빛 열쇠 도서관 기록';
const proposal={schema:'gradia.input-writer-proposal.v1',purpose:'input_writer_proposal',operationId:'writer-budget',
  proposalDigest:fingerprint(queryText),nativeContextDigest:fingerprint('native-context'),queryTruncated:false,factAdopted:false};
const microText=turn=>`기록${turn} 시작. 민아는 은빛 열쇠와 도서관 기록 ${turn}번을 확인했다. `
  +Array.from({length:7},(_,i)=>`${turn}번 기록의 ${i+1}항에 따르면 준호는 도서관 ${turn}층의 책장과 열쇠 보관함을 점검하고 그 결과를 민아에게 알렸다. `).join('')
  +`기록${turn} 끝.`;
// Observe completion of the real producer's delayed snapshot without replacing its reader.
const observeOwnerReadiness=source=>{
  const seam='    getCaptureBackendState() { return safeClone(LibraMemoryCore.getCaptureBackendState()); },';
  assert.ok(source.includes(seam));
  return source.replace(seam,`    ownerReadFixtureReady() {
      const s=LibraMemoryCore.state;
      return !s.microJobs.size && !s.receiptCaptureJobs.size && !s.storageWriteFence.size
        && !s.branchAuditInFlight.size && !s.timers.has('current_state_snapshot')
        && Number(s.snapshot?.refreshedAt||0)>=Number(s.lastMicroPublication?.at||0);
    },
`+seam);
};

for(const mode of ['plugin_only','server_only'])test(`${mode}: Input Writer receives at most 3000 complete canonical/lens characters while response evidence retains its larger budget`,{timeout:180000},async t=>{
  const bus=createHost(sources),x=await fixture({mode,hostOverrides:bus.api('libra'),transformSource:observeOwnerReadiness,microCount:8,microText});
  let transport;
  t.after(async()=>{await transport?.dispose();await x.cleanup();bus.dispose();});
  const f=x.f,api=f.r.api;
  await waitFor(()=>api.ownerReadFixtureReady(),15000);
  const lens=await api.createLens({name:'작성기 예산 렌즈',instruction:{goal:'열쇠와 기록의 분위기'},evidenceMode:'strict',
    recall:{enabled:true,mode:'recent',maxItems:2,share:100}});
  const lensText='WRITER_LENS_NOTE: 도서관의 정숙 규칙과 은빛 열쇠의 보관은 민아의 선택에 긴장을 준다.';
  const quote=f.chat.message.find(row=>row.chatId==='t1-a').data.slice(0,60);
  f.control.onCall=async()=>({type:'success',result:JSON.stringify({items:[{label:'분위기',text:lensText,quote,refs:['t1-a'],extra:{focus:'비정본 관점'}}]})});
  assert.equal((await api.runLensForRange(lens.lensId,{startTurn:1,endTurn:5})).acceptedCount,1);
  const registry=await api.getLensRegistry();await api.saveLensRegistry({...registry,recallSemantic:false});
  f.control.onCall=async()=>{throw Error('evidence reads must not analyze memory');};
  await api.buildMemoryGraphCorpus({limit:2});
  const scope={scopeKey:x.scopeKey,characterId:f.character.id,chatId:f.chat.id},maxCorpusBytes=65536;
  let capture;
  if(mode==='plugin_only'){
    transport=require('../tools/gradia_plugin_read.cjs')({role:'reader',api:bus.api('serial_gradation_agents_for_rp'),
      primitives:{fingerprint,byteLength:text=>Buffer.byteLength(text,'utf8')},timeoutMs:30000});
    const described=await transport.describe(scope,['libra']),client=transport.createClient(described.scopes);
    capture=async p=>{
      const session=await client.openReadSession(scope,{queryText,maxCorpusBytes,...(p?{proposal:p}:{})});
      return {content:session.snapshot.items.map(item=>item.content).join(''),engine:session.engine,
        current:()=>session.assertCurrent(),close:async()=>{session.close();await waitFor(()=>api.inspectMemoryGraphStore().resources.sessions===0,5000);}};
    };
  }else{
    const boot=await fetch(x.server.url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'libra'}}).then(r=>r.json());
    const binding={url:x.server.url,dataInstanceId:boot.dataInstanceId,resetEpoch:boot.resetEpochs.libra??0};
    transport=require('../tools/libra_gradia_unified_read.cjs')({role:'client',api:bus.api('serial_gradation_agents_for_rp'),timeoutMs:30000});
    capture=async p=>{
      const result=await transport.capture({scope,binding,queryText,maxCorpusBytes,...(p?{proposal:p}:{})});
      const proof=Object.fromEntries(['scope','readIdentity','dependencies','evidenceRevision','dataInstanceId','resetEpoch'].map(k=>[k,result[k]]));
      return {content:result.items.map(item=>item.content).join(''),engine:result.engine,
        current:async()=>(await transport.current({proof})).current,close:()=>transport.release(result.readIdentity.ownerReceiptId)};
    };
  }
  const calls=f.control.calls.length,writes=f.r.storageWrites.length,batches=x.server?.batches.length||0;
  const response=await capture();
  assert.ok(response.content.length>3000,`fixture must exceed the writer cap: ${response.content.length}`);
  assert.ok(response.content.length<=12000);assert.ok(response.content.includes(lensText));
  const responseText=response.content;await response.close();
  const writer=await capture(proposal);
  assert.equal(writer.engine.purpose,'input_writer_proposal');assert.deepEqual(JSON.parse(JSON.stringify(writer.engine.proposal)),proposal);
  assert.ok(writer.content.length<=3000,`canonical, lens headers and separators together: ${writer.content.length}`);
  assert.ok(writer.content.includes(lensText),'the smaller bundle still includes noncanonical lens evidence');
  assert.ok(writer.content.includes('정본 기억이 우선'));
  let selected=0;
  for(let turn=6;turn<14;turn++)if(writer.content.includes(`기록${turn} 시작.`)){
    selected++;assert.ok(writer.content.includes(microText(turn)),'selected canonical records remain whole');
  }
  assert.ok(selected>0,'actual canonical evidence remains alongside lens evidence');
  assert.equal(await writer.current(),true);
  const captureRequests=bus.messages.filter(m=>m.body.action==='capture'&&m.sender==='serial_gradation_agents_for_rp');
  const writerRequest=captureRequests.at(-1).body;
  assert.equal((writerRequest.payload||writerRequest).maxCorpusBytes,maxCorpusBytes,'shared byte cap is not reduced');
  await writer.close();
  const responseAgain=await capture();assert.equal(responseAgain.content,responseText,'writer read does not change subsequent response selection');
  await responseAgain.close();
  assert.equal(f.control.calls.length,calls);assert.equal(f.r.storageWrites.length,writes);assert.equal(x.server?.batches.length||0,batches);
  const stale=await capture(proposal);
  await api.updateLens(lens.lensId,{recall:{enabled:false,mode:'recent',maxItems:2,share:100}});
  await assert.rejects(()=>stale.current(),/LIB_READ_/);await stale.close();
  t.diagnostic(JSON.stringify({mode,responseCharacters:responseText.length,writerCharacters:writer.content.length,selectedCanonicalRecords:selected}));
});
