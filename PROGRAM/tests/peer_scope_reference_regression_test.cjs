const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict');
const read=n=>fs.readFileSync(path.join(__dirname,'../plugins',n),'utf8');
(async()=>{
 const h=read('HAYAKU_Locator_Continuity.js'),a=h.indexOf('  const releaseRecoveryDebtLeaseForNativeRepair ='),b=h.indexOf('  const updateRecoveryJournalBackgroundDecision =',a);let written=null,durable=true;
 const box={enqueueStorageOperation:fn=>fn(),compact:v=>String(v),RisuCompat:{currentChatScope:async()=>null},loadRecoveryVault:async()=>({records:[{recordId:'debt',repairLease:{leaseId:'lease',owner:'hayaku_native'},worldlineStatus:'active'}]}),ensureArray:v=>Array.isArray(v)?v:[],normalizeRecoveryDebtLease:v=>v,now:()=>1000,recoveryDebtRetryDelayMs:()=>500,normalizeRecoveryVaultRecord:v=>v,writeRecoveryVaultDirect:async(k,v)=>{written=v;return {durable,reason:durable?'':'write_failed'}},RECOVERY_DEBT_RETRY_DELAYS_MS:[500]};
 vm.runInNewContext(h.slice(a,b)+';globalThis.run=releaseRecoveryDebtLeaseForNativeRepair',box);
 for(const [outcome,expected] of [['failed',1500],['deferred',1500],['suspended',0]]){const result=await box.run({debtId:'debt',leaseId:'lease',scopeKey:'scope',outcome});assert.equal(result.ok,true);assert.equal(result.released,true);assert.equal(result.nextRetryAt,expected);assert.equal(written.records[0].nextRepairAt,expected);assert.equal(written.records[0].repairLease,null);}
 durable=false;assert.equal((await box.run({debtId:'debt',leaseId:'lease',scopeKey:'scope'})).released,false);
 // The approved GUI replaced the old dpg-live-enable button with the bind sheet
 // ([data-lia-bind-confirm] -> PersonaSelectionManager.applyCard). Exercise the
 // exact handler and the exact applyCard method so every referenced binding exists.
 const l=read('LIA_Persona_Linker.js'),start=l.indexOf('    if (target.matches("[data-lia-bind-confirm]")) {'),end=l.indexOf('\n      return;\n    }',start)+'\n      return;\n    }'.length;assert(start>=0&&end>start);
 for(const choice of ['id:selected','']){let status,level,applied=null,done;const finished=new Promise(r=>done=r);const target={disabled:false,isConnected:true,matches:sel=>sel==='[data-lia-bind-confirm]',closest:()=>null};
  const ctx={target,liaSelectedPersonaChoice:choice,getLiveRuntimeContext:async()=>({scope:'rt'}),PersonaSelectionManager:{applyCard:async(rt,c)=>{assert.equal(rt.scope,'rt');applied=c;return {liveReconfigured:false};}},closeLiaMockupDialog:()=>{},refreshPreview:async()=>{},refreshPersonaProofIndicator:async()=>{},setStatus:(m,lv)=>{status=m;level=lv;done();}};
  vm.runInNewContext('(()=>{'+l.slice(start,end)+'})()',ctx);await finished;await new Promise(r=>setImmediate(r));
  assert(!String(status).includes('is not defined'),status);
  if(choice){assert.equal(applied,choice);assert.equal(level,'ok');assert.equal(target.disabled,false);}else{assert.equal(applied,null);assert.equal(level,'error');assert(status.includes('선택하세요'));}}
 const as=l.indexOf('    async applyCard(ctx, choice) {'),ae=l.indexOf('\n    },\n  });',as);assert(as>=0&&ae>as);
 const refAt=l.indexOf('  function personaPanelChoiceRef(persona, index) {'),choiceRef=l.slice(refAt,l.indexOf('\n  }\n',refAt)+4);assert(refAt>=0);
 const personas=[{id:'old',name:'Old'},{id:'selected',name:'Selected'},{id:'live::other',name:'Other Live'}];
 for(const [choice,binding,expected] of [['id:selected',{enabled:true,sourcePersonaId:'old',livePersonaId:'live::mine',policy:'p',externalChangePolicy:'e',previousBinding:{personaId:'prev'}},{configure:'id:selected',resetLedger:true}],['id:old',{enabled:true,sourcePersonaId:'old',livePersonaId:'live::mine',policy:'p',externalChangePolicy:'e',previousBinding:null},{configure:'id:old',resetLedger:false}],['id:selected',null,{write:'selected'}],['id:live::other',null,{error:/직접 선택할 수 없습니다/}]]){
  let configured=null,written=null,reads=0;const runtimeCtx={scope:'rt'};
  const box={manualLivePersonaAction:false,appendDebugLog:()=>{},appendOperationLog:()=>{},livePersonaScopeKey:()=>'scope',isLivePersona:p=>String(p?.id||'').startsWith('live::'),
   ensurePersonaPanelPersonaId:async c=>{const id=String(c).slice(3);return {id,persona:personas.find(p=>p.id===id)};},
   readLivePersonaBindingForContext:async c=>{reads++;assert.equal(c.scope,'ctx');return binding;},
   configureLivePersonaSync:async(c,src,policy,ext,opts)=>{configured={c,src,policy,ext,opts};return {livePersonaId:'live::mine'};},
   PersonaBindingManager:{write:async(c,id,opts)=>{written={c,id,opts};return {after:{personaId:id}};}}};
  vm.runInNewContext(choiceRef+';globalThis.mgr=({async read(ctx){return {personas,runtimeCtx,selectedPersonaId:"",dynamicPersonaId:""};},\n'+l.slice(as,ae)+'\n    }});',Object.assign(box,{personas,runtimeCtx}));
  if(expected.error){await assert.rejects(()=>box.mgr.applyCard({scope:'ctx'},choice),expected.error);assert.equal(configured,null);assert.equal(written,null);continue;}
  const result=await box.mgr.applyCard({scope:'ctx'},choice);assert.equal(reads,1);assert.equal(result.nativeDefaultUnchanged,true);
  if(expected.configure){assert.equal(written,null);assert.equal(configured.c,runtimeCtx);assert.equal(configured.src,expected.configure);assert.equal(configured.policy,'p');assert.equal(configured.ext,'e');assert.equal(configured.opts.resetLedger,expected.resetLedger);assert.equal(configured.opts.previousBinding,binding.previousBinding);assert.equal(result.liveReconfigured,true);}
  else{assert.equal(configured,null);assert.equal(written.c,runtimeCtx);assert.equal(written.id,expected.write);assert.equal(result.liveReconfigured,false);}
 }
 const proofLine=l.split('\n').find(line=>line.includes('proof = await readPersonaProofForContext(runtimeCtx)'));assert(proofLine);const proof={verified:true},context={scopeKey:'sample'};const got=await vm.runInNewContext('(async()=>{'+proofLine+';return proof;})()',{runtimeCtx:context,proof:null,readPersonaProofForContext:async ctx=>{assert.equal(ctx,context);return proof}});assert.equal(got,proof);
 const f=read('Flashback_Memory.js'),line=f.split('\n').find(line=>line.includes('context.strategy || recallStrategyForQueryType'));assert(line);for(const strategy of [null,{prioritizeTypes:['response']}]){const fallback={prioritizeTypes:[]};const value=vm.runInNewContext(line+';strategy;',{context:{strategy},recallStrategyForQueryType:()=>fallback});assert.equal(value,strategy||fallback);}
 console.log('PASS HAYAKU lease outcomes/write failure; LIA bind-sheet selected/missing persona, applyCard live reconfigure/plain bind/foreign Live refusal and proof export; Flashback default/explicit strategy');
})().catch(e=>{console.error(e);process.exitCode=1;});
