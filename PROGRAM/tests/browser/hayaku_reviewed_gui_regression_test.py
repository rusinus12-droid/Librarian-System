"""Mounted regressions for HAYAKU mockup job controls and route switching."""
from pathlib import Path
import os, shutil
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[3]
HOST=ROOT/"PROGRAM/tests/browser/hayaku_browser_host.js"
SOURCE=ROOT/"PROGRAM/plugins/HAYAKU_Locator_Continuity.js"

def main():
    exe=os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("chromium-browser")
    if not exe: raise SystemExit("CHROMIUM_PATH or chromium is required")
    host=HOST.read_text(encoding="utf-8"); src=SOURCE.read_text(encoding="utf-8")
    hook="  await install();"
    assert src.count(hook)==1
    src=src.replace(hook,"  globalThis.__hvg={Memory,viewerSetTab,viewerRenderDebugExportText,viewerConfirmRecordRegeneration,viewerConfirmNativeColdStart,viewerConfirmFailedAnalysisDelete,viewerConfirmOrphanCleanup,viewerConfirmReplacementVariant,viewerConfirmFailedAnalysisAdoption,showIndependentRecoveryConfirmation};\n"+hook)
    errors=[]
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=exe,headless=True,args=["--no-sandbox","--disable-dev-shm-usage"])
        page=browser.new_page(viewport={"width":390,"height":844})
        page.set_default_timeout(8000); page.on("pageerror",lambda e:errors.append(str(e)))
        page.set_content("<!doctype html><html lang='ko'><meta charset='utf-8'><body></body></html>")
        page.add_script_tag(content=host)
        # Product-shaped, fixture-only current packet and deterministic synthetic Other Ax response.
        page.evaluate("""()=>{
          const turn=1, quote='Alice opened the copper cabinet and found a silver key.';
          const packet={meta:{schema:'hayaku_packet_v1',packet_type:'current_snapshot',packet_schema_rev:2,scene_id:'workshop',turn_anchor:quote,confidence:0.82,summary_memory:{summary:quote,recallAnchors:['Alice','workshop'],recallAliases:{en:[quote]},canonicalAnchors:['person:Alice','event:turn_1','place:workshop'],mentionedEntityNames:['Alice'],directEvidenceSnippets:[quote],related_refs:[],confidence:0.82}},entity:{characters:[{name:'Alice',current_state:'found a silver key'}],relations:[],pov_memories:[],secrets:[]},world:{location:'workshop',time:'turn-1',scene:'workshop',weather:'',active_events:[{summary:quote}],historical_events:[],world_rules:[],offscreen_threads:[],factions:[],regions:[]},narrative:{scene_phase:'active',current_arc:'arc-1',pacing:'steady',conflict_traces:[],scene_deltas:[{summary:quote}],theme_motifs:[],critical_dialogue:[]},planner:{continuity_locks:[{summary:'Alice remains in the workshop.'}],do_not_resolve_yet:[],consequence_ledger:[],payoff_tracker:[],open_invitations:[]},importance:{overall:0.72,reason:['turn 1 evidence']}};
          const visible='Alice opened the copper cabinet and found a silver key.';
          __chat.message=[{role:'user',chatId:'gui-u1',id:'gui-u1',data:'I open the copper cabinet.'},{role:'assistant',chatId:'gui-a1',id:'gui-a1',data:`${visible}\n<!-- HAYAKU_STATE_PACKET_START ${JSON.stringify(packet)} HAYAKU_STATE_PACKET_END -->`,time:Date.now()}];
          __chat.messages=__chat.message;
          window.__syntheticModelCalls=0;
          risuai.runLLMModel=async()=>{
            window.__syntheticModelCalls++;__hostCalls.llm++;
            const candidate=structuredClone(packet); candidate.meta.packet_type='recovery_snapshot'; candidate.meta.summary_memory.summary=visible; candidate.planner.continuity_locks=[visible];
            const grounding=[]; const walk=(value,base)=>{if(Array.isArray(value)){value.forEach((v,i)=>{if(v!=null&&(typeof v!=='string'||v.trim()))grounding.push({path:`${base}[${i}]`,source:'target',evidence:[visible]});});return;}if(!value||typeof value!=='object')return;Object.entries(value).forEach(([k,v])=>walk(v,base?`${base}.${k}`:k));};
            for(const axis of ['entity','world','narrative','planner'])walk(candidate[axis],axis); grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[visible]});
            return {type:'success',result:JSON.stringify({schema:'hayaku.native_repair_output.v1',packet:candidate,grounding})};
          };
        }""")
        page.add_script_tag(content=src)
        page.wait_for_function("!!window.HAYAKU",timeout=30000)
        page.evaluate("HAYAKU.showUi()")
        page.wait_for_selector('.app[data-hayaku-mockup="1"]')
        page.wait_for_timeout(150)
        def open_and_keyboard_cancel(expression, overlay_selector):
            page.evaluate("()=>{let b=document.querySelector('#__keyboardTrigger');if(!b){b=document.createElement('button');b.id='__keyboardTrigger';b.textContent='test trigger';document.querySelector('.app').append(b);}b.focus();}")
            page.evaluate(f"()=>{{window.__keyboardDialogPromise=({expression});}}")
            page.wait_for_selector(f'{overlay_selector} [role="dialog"]')
            dialog=page.locator(f'{overlay_selector} [role="dialog"]')
            assert page.evaluate("document.activeElement.closest('[role=dialog]') !== null"),overlay_selector
            page.keyboard.press('Shift+Tab')
            assert page.evaluate("sel=>document.activeElement===[...document.querySelector(sel+' [role=dialog]').querySelectorAll('button:not([disabled])')].at(-1)",overlay_selector),overlay_selector
            page.keyboard.press('Tab')
            assert page.evaluate("sel=>document.activeElement===[...document.querySelector(sel+' [role=dialog]').querySelectorAll('button:not([disabled])')][0]",overlay_selector),overlay_selector
            page.keyboard.press('Escape')
            page.wait_for_selector(overlay_selector, state='detached')
            assert page.evaluate("document.activeElement.id")=='__keyboardTrigger',overlay_selector
            page.evaluate("()=>{document.querySelector('#__keyboardTrigger')?.remove();}")
        open_and_keyboard_cancel("__hvg.viewerConfirmRecordRegeneration({packetType:'current_snapshot'},{turns:[1],startTurn:1,endTurn:1})", '#hayakuRegenerateConfirmOverlay')
        open_and_keyboard_cancel("__hvg.viewerConfirmNativeColdStart(5,true,{completedTurns:147,extraCalls:1})", '#hayakuColdStartConfirmOverlay')
        open_and_keyboard_cancel("__hvg.viewerConfirmFailedAnalysisDelete({turn:1,revisionCount:1})", '#hayakuFailedAnalysisDeleteConfirmOverlay')
        open_and_keyboard_cancel("__hvg.viewerConfirmOrphanCleanup({removableRecords:2,removableChars:4812})", '#hayakuCleanupConfirmOverlay')
        open_and_keyboard_cancel("__hvg.viewerConfirmReplacementVariant({revision:1},{targetPairIndex:1})", '#hayakuVariantSelectConfirmOverlay')
        open_and_keyboard_cancel("__hvg.viewerConfirmFailedAnalysisAdoption({diagnosis:{title:'Synthetic',detail:'Keyboard test'},warning:true,confirmation:{}})", '#hayakuAdoptConfirm')
        page.evaluate("()=>{window.__regenConfirmPromise=__hvg.viewerConfirmRecordRegeneration({packetType:'current_snapshot'},{turns:[1],startTurn:1,endTurn:1});}")
        page.wait_for_selector('#hayakuRegenerateConfirmOverlay .steps')
        regen_dialog=page.locator('#hayakuRegenerateConfirmOverlay')
        assert regen_dialog.locator('.steps .step').count()==4
        regen_text=regen_dialog.inner_text()
        assert '기존 패킷은 아직 교체되지 않습니다' in regen_text and '이전 패킷은 다시 채택할 수 있게 보존됩니다' in regen_text
        assert '후보 만들기' in regen_text and '직접 고릅니다' in regen_text
        regen_dialog.locator('button.btn:not(.btn--primary)').click()
        page.evaluate("()=>{window.__coldConfirmPromise=__hvg.viewerConfirmNativeColdStart(5,true,{completedTurns:147,extraCalls:1});}")
        page.wait_for_selector('#hayakuColdStartConfirmOverlay .cost-table')
        cold_dialog=page.locator('#hayakuColdStartConfirmOverlay')
        assert '완료 U+A 147턴' in cold_dialog.inner_text() and '30묶음' in cold_dialog.inner_text() and '최대 +1회' in cold_dialog.inner_text()
        cold_dialog.locator('button.btn:not(.btn--primary)').click()
        page.evaluate("()=>{window.__deleteConfirmPromise=__hvg.viewerConfirmFailedAnalysisDelete({turn:1,revisionCount:1});}")
        page.wait_for_selector('#hayakuFailedAnalysisDeleteConfirmOverlay .note')
        assert 'Recovery Journal 원문과 복구 부채는 그대로' in page.locator('#hayakuFailedAnalysisDeleteConfirmOverlay').inner_text()
        page.locator('#hayakuFailedAnalysisDeleteConfirmOverlay button.btn').first.click()
        page.evaluate("()=>{window.__orphanConfirmPromise=__hvg.viewerConfirmOrphanCleanup({removableRecords:2,removableChars:4812});}")
        page.wait_for_selector('#hayakuCleanupConfirmOverlay .dialog')
        assert '2개' in page.locator('#hayakuCleanupConfirmOverlay').inner_text() and '4,812자' in page.locator('#hayakuCleanupConfirmOverlay').inner_text()
        page.locator('#hayakuCleanupConfirmOverlay button.btn').first.click()
        # Active bottom navigation must follow every routed destination.
        page.locator('.tabbar [data-go="packets"]').click()
        assert page.locator('.tabbar [aria-current="page"]').get_attribute("data-go")=="packets"
        page.evaluate("__hvg.viewerSetTab('recovery')")
        assert page.locator('.tabbar [aria-current="page"]').get_attribute("data-go")=="recovery"
        # Real mounted pre uses rendered text, not an input-only value property.
        page.evaluate("__hvg.Memory.ledgerViewer.debugExportText=JSON.stringify({visible:true},null,2); __hvg.viewerRenderDebugExportText()")
        assert 'visible' in page.locator('#hayakuViewerDebugExportText').inner_text()
        # Seed an isolated durable run/job using the product's storage API, no model call.
        page.evaluate("""async()=>{
          const m=__hvg.Memory, scope=m.ledgerViewer.scope;
          if(!scope?.key) throw Error('viewer scope unavailable');
          const run={schema:'hayaku.native_regeneration_run.v1',runId:'review-run-1',scopeKey:scope.key,state:'awaiting_choice',targetTurns:[2],replacementRecordIds:[],chunks:[{pairIndex:2,body:JSON.stringify({meta:{summary:'synthetic candidate'}})}]};
          const wr=await HAYAKU._test.writeNativeRunRecord('hayaku.v2.native_regeneration_run.',scope.key,run);
          if(!wr.durable) throw Error('seed run not durable');
          m.nativeRecovery.job={kind:'targeted_regeneration',state:'awaiting_choice',scopeKey:scope.key,runId:run.runId,targetTurns:[2],total:1,completed:1,cancellable:false,message:'synthetic review'};
          m.ledgerViewer.jobMinimized=false;
          HAYAKU._test.viewerRenderNativeJob();
        }""")
        page.wait_for_function("document.querySelector('#hayakuNativeJobComparison article') !== null")
        assert page.locator('[data-hayaku-job-body="regen"]').is_visible()
        assert page.locator('[data-hayaku-job-body="repair"]').is_hidden()
        assert page.locator('#hayakuNativeJobResultRegeneration').inner_text().find('기존 패킷은 아직 교체되지 않았습니다')>=0
        page.evaluate("()=>{__hvg.Memory.ledgerViewer.jobMinimized=true;HAYAKU._test.viewerRenderNativeJob();document.querySelector('#hayakuNativeJobChip').focus();}")
        page.locator('#hayakuNativeJobChip').click()
        assert page.locator('#hayakuNativeJobOverlay').is_visible()
        page.keyboard.press('Escape')
        page.wait_for_function("__hvg.Memory.ledgerViewer.jobMinimized===true")
        assert page.evaluate("__hvg.Memory.nativeRecovery.job.state")=='awaiting_choice'
        assert page.evaluate("__hvg.Memory.nativeRecovery.job.cancelRequested!==true")
        assert page.evaluate("document.activeElement.id")=='hayakuNativeJobChip'
        page.locator('#hayakuNativeJobChip').click()
        page.evaluate("()=>{__hvg.Memory.nativeRecovery.job={kind:'manual_missing_batch',state:'failed',scopeKey:__hvg.Memory.ledgerViewer.scope.key,message:'synthetic failure remains visible',result:{reason:'synthetic_failure'},cancellable:false};__hvg.Memory.ledgerViewer.jobMinimized=true;HAYAKU._test.viewerRenderNativeJob();}")
        page.locator('#hayakuNativeJobChip').click()
        page.keyboard.press('Escape')
        page.wait_for_function("__hvg.Memory.ledgerViewer.jobMinimized===true")
        assert page.evaluate("__hvg.Memory.nativeRecovery.job?.state==='failed' && __hvg.Memory.nativeRecovery.job?.result?.reason==='synthetic_failure'")
        page.locator('#hayakuNativeJobChip').click()
        for kind, body in [('manual_missing_batch','repair'),('cold_start','cold'),('background_repair_confirmation','background')]:
            page.evaluate("([kind])=>{const m=__hvg.Memory,s=m.ledgerViewer.scope;m.nativeRecovery.job={kind,state:kind==='background_repair_confirmation'?'awaiting_confirmation':'running',scopeKey:s.key,targetTurns:[1],total:1,currentTurn:1,cancellable:kind!=='background_repair_confirmation',message:'synthetic operation'};m.ledgerViewer.recoveryConfirmationUi={mode:'embedded'};m.ledgerViewer.jobMinimized=false;HAYAKU._test.viewerRenderNativeJob();}",[kind])
            assert page.locator(f'[data-hayaku-job-body="{body}"]').is_visible(),(kind,body)
            assert page.locator(f'[data-hayaku-job-body]:not([hidden])').count()==1,kind
        page.evaluate("()=>{__hvg.Memory.nativeRecovery.job={kind:'targeted_regeneration',state:'awaiting_choice',scopeKey:__hvg.Memory.ledgerViewer.scope.key,runId:'review-run-1',targetTurns:[2],total:1,completed:1,cancellable:false,message:'synthetic review'};HAYAKU._test.viewerRenderNativeJob();}")
        for choice in ["later","keep_original","adopt_regenerated"]:
            assert page.locator(f'[data-hayaku-regeneration-choice="{choice}"]').is_visible(),choice
        page.locator('[data-hayaku-regeneration-choice="later"]').click()
        assert page.locator('#hayakuNativeJobOverlay').is_hidden()
        page.locator('#hayakuNativeJobChip').click()
        assert page.locator('#hayakuNativeJobOverlay').is_visible()
        page.locator('[data-hayaku-regeneration-choice="keep_original"]').click()
        page.wait_for_function("__hvg.Memory.nativeRecovery.job?.state==='original_kept'")
        saved=page.evaluate("HAYAKU._test.readNativeRunRecord('hayaku.v2.native_regeneration_run.',__hvg.Memory.ledgerViewer.scope.key,'hayaku.native_regeneration_run.v1')")
        assert saved['run']['state']=='original_kept'
        page.locator('#closeHayakuNativeJob').click()
        # Exercise the actual product regeneration UI and durable adoption path with the valid packet fixture above.
        page.evaluate("__hvg.viewerSetTab('packets')")
        page.wait_for_selector('#hayakuViewerRecords [data-hayaku-record-select]')
        page.locator('#hayakuViewerRecords [data-hayaku-record-select]').first.click()
        page.wait_for_selector('#hayakuViewerRecordDetail [data-hayaku-regenerate-record]:not([disabled])')
        page.evaluate("""()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copiedPacket=value;}}});}""")
        page.locator('#hayakuViewerRecordDetail [data-hayaku-copy-record]').click()
        page.wait_for_function("typeof window.__copiedPacket==='string' && window.__copiedPacket.length>0")
        copied_packet=page.evaluate("JSON.parse(window.__copiedPacket)")
        assert copied_packet.get('meta',{}).get('schema')=='hayaku_packet_v1'
        old_id=page.locator('#hayakuViewerRecordDetail [data-hayaku-regenerate-record]').get_attribute('data-hayaku-regenerate-record')
        pre=page.evaluate("""async id=>{
          const scope=await HAYAKU._test.currentChatScope();
          const ledger=await HAYAKU.ledger.inspect({includeRecords:true});
          const old=ledger.records.find(row=>row.recordId===id);
          return {scopeKey:scope.key,chatId:__chat.id,messages:JSON.stringify(__chat.message),old:old&&{recordId:old.recordId,state:old.recordState,packetType:old.packetType,targetPairIndex:old.targetPairIndex,raw:old.raw}};
        }""",old_id)
        assert pre['old'] and pre['old']['state']=='active'
        page.locator('#hayakuViewerRecordDetail [data-hayaku-regenerate-record]').click()
        page.locator('#hayakuRegenerateConfirmOverlay button.btn--primary').click()
        page.wait_for_function("document.querySelector('#hayakuNativeJobChoices')?.hidden===false && !!document.querySelector('[data-hayaku-regeneration-choice=adopt_regenerated]')")
        staged=page.evaluate("""async()=>{
          const run=await HAYAKU._test.readNativeRunRecord('hayaku.v2.native_regeneration_run.',__hvg.Memory.ledgerViewer.scope.key,'hayaku.native_regeneration_run.v1');
          const ledger=await HAYAKU.ledger.inspect({includeRecords:true});
          return {run:run.run,ledgerRecords:ledger.records.map(row=>({recordId:row.recordId,state:row.recordState,targetPairIndex:row.targetPairIndex,packetType:row.packetType}))};
        }""")
        staged_old=next(row for row in staged['ledgerRecords'] if row['recordId']==old_id)
        assert staged_old['state']=='active', 'candidate generation must leave the target packet unchanged before adoption'
        assert staged['run']['state']=='awaiting_choice' and staged['run']['targetTurns']==[1]
        page.locator('[data-hayaku-regeneration-choice="adopt_regenerated"]').click()
        page.wait_for_function("__hvg.Memory.nativeRecovery.job?.state==='completed'")
        adopted=page.evaluate("""async id=>{
          const scope=await HAYAKU._test.currentChatScope();
          const ledger=await HAYAKU.ledger.inspect({includeRecords:true});
          const run=await HAYAKU._test.readNativeRunRecord('hayaku.v2.native_regeneration_run.',scope.key,'hayaku.native_regeneration_run.v1');
          const old=ledger.records.find(row=>row.recordId===id);
          const active=ledger.records.filter(row=>row.packetType==='recovery_snapshot'&&row.recordState==='active'&&Number(row.targetPairIndex)===1);
          return {scopeKey:scope.key,chatId:__chat.id,messages:JSON.stringify(__chat.message),old:old&&{recordId:old.recordId,state:old.recordState,raw:old.raw},active:active.map(row=>({recordId:row.recordId,state:row.recordState,raw:row.raw,targetPairIndex:row.targetPairIndex})),run:run.run};
        }""",old_id)
        assert adopted['scopeKey']==pre['scopeKey'] and adopted['chatId']==pre['chatId']
        assert adopted['messages']==pre['messages'], 'chat target and source messages remain fixed across adoption'
        assert adopted['old']['state']=='tombstoned' and adopted['old']['raw']==pre['old']['raw']
        assert len(adopted['active'])==1 and adopted['active'][0]['recordId']!=old_id
        assert 'silver key' in adopted['active'][0]['raw'] and adopted['run']['state']=='completed'
        assert page.evaluate('__syntheticModelCalls')==1
        # Confirmation dialog buttons are present and the decline path preserves the journal.
        page.evaluate("""()=>{
          const m=__hvg.Memory,s=m.ledgerViewer.scope;
          m.ledgerViewer.recoveryConfirmation={scopeKey:s.key,debtId:'synthetic-debt',pairIndex:2,targetFingerprint:'synthetic-target',sourceDigest:'synthetic-source',reason:'test',requestedAt:Date.now()};
          m.ledgerViewer.recoveryConfirmationUi={mode:'embedded'};
          m.nativeRecovery.job={kind:'background_repair_confirmation',state:'awaiting_confirmation',scopeKey:s.key,targetTurns:[2],total:1,currentTurn:2,cancellable:false,message:'synthetic confirmation'};
          m.ledgerViewer.jobMinimized=false; HAYAKU._test.viewerRenderNativeJob();
        }""")
        for answer in ['no','yes']:
            assert page.locator(f'[data-hayaku-recovery-confirmation="{answer}"]').is_visible(),answer
        page.locator('[data-hayaku-recovery-confirmation="no"]').click()
        page.wait_for_function("__hvg.Memory.nativeRecovery.job?.state==='cancelled'")
        page.locator('#closeHayakuNativeJob').click()
        # A stale/nonexistent target must fail closed even when the visible yes control is used.
        page.evaluate("""()=>{
          const m=__hvg.Memory,s=m.ledgerViewer.scope;
          m.ledgerViewer.recoveryConfirmation={scopeKey:s.key,debtId:'missing-target',pairIndex:9,targetFingerprint:'stale-target',sourceDigest:'stale-source',reason:'test',requestedAt:Date.now()};
          m.ledgerViewer.recoveryConfirmationUi={mode:'embedded'};
          m.nativeRecovery.job={kind:'background_repair_confirmation',state:'awaiting_confirmation',scopeKey:s.key,targetTurns:[9],total:1,currentTurn:9,cancellable:false,message:'stale synthetic target'};
          m.ledgerViewer.jobMinimized=false; HAYAKU._test.viewerRenderNativeJob();
        }""")
        page.locator('[data-hayaku-recovery-confirmation="yes"]').click()
        page.wait_for_function("__hvg.Memory.nativeRecovery.job?.state==='cancelled'")
        assert page.evaluate("__hvg.Memory.nativeRecovery.job?.result?.reason") == 'recovery_confirmation_source_changed'
        page.locator('#closeHayakuNativeJob').click()
        page.evaluate("()=>{const m=__hvg.Memory,s=m.ledgerViewer.scope;m.ledgerViewer.recoveryConfirmation={scopeKey:s.key,debtId:'synthetic-independent-debt',pairIndex:2,reason:'keyboard test',requestedAt:Date.now()};m.nativeRecovery.job={kind:'background_repair_confirmation',state:'awaiting_confirmation',scopeKey:s.key,targetTurns:[2],currentTurn:2,total:1,cancellable:false};m.ledgerViewer.recoveryConfirmationUi=null;}")
        page.evaluate("()=>{window.__independentShown=__hvg.showIndependentRecoveryConfirmation(__hvg.Memory.ledgerViewer.recoveryConfirmation);}")
        page.wait_for_selector('#hayaku-recovery-confirmation-overlay [role="dialog"]')
        independent=page.locator('#hayaku-recovery-confirmation-overlay [role="dialog"]')
        page.keyboard.press('Shift+Tab')
        assert page.evaluate("document.activeElement.closest('#hayaku-recovery-confirmation-overlay [role=dialog]')!==null")
        page.keyboard.press('Tab')
        assert page.evaluate("document.activeElement.closest('#hayaku-recovery-confirmation-overlay [role=dialog]')!==null")
        page.keyboard.press('Escape')
        page.wait_for_selector('#hayaku-recovery-confirmation-overlay',state='detached')
        assert page.evaluate("__hvg.Memory.nativeRecovery.job?.result?.declined===true")
        # A worldline detail action must switch back to the packet list before routing.
        page.evaluate("""()=>{
          const m=__hvg.Memory,s=m.ledgerViewer.scope;
          m.nativeRecovery.job=null; m.ledgerViewer.jobMinimized=false;
          __hvg.viewerSetTab('packets');
          m.ledgerViewer.ledger={enabled:true,scopeKey:s.key,records:[{recordId:'synthetic-record-2',targetPairIndex:2,recordState:'active',packetType:'current_snapshot',raw:JSON.stringify({meta:{summary:'synthetic worldline'}}),capturedAt:Date.now(),slotId:'slot-2'}]};
          document.querySelector('[data-packet-view="worldline"]').click();
        }""")
        page.wait_for_selector('#hayakuWorldlineDetail [data-hayaku-open-record]')
        page.locator('#hayakuWorldlineDetail [data-hayaku-open-record]').click()
        assert page.locator('#hayakuPacketListView').is_visible()
        assert page.locator('#hayakuPacketWorldlineView').is_hidden()
        # The embedded Portable Memory confirmation is a product-owned modal too:
        # it traps keyboard focus, Escape declines before export, and focus returns
        # to the control that opened it. This exercises the real mounted popup.
        page.evaluate("__hvg.viewerSetTab('recovery')")
        portable_backup=page.locator('#hayaku-portable-memory-backup-controls [data-portable-backup]')
        assert portable_backup.count()==1
        portable_backup.focus()
        portable_backup.click()
        page.wait_for_selector('[data-portable-backup-modal="hayaku_locator_continuity"] [role="dialog"]')
        portable_overlay=page.locator('[data-portable-backup-modal="hayaku_locator_continuity"]')
        page.keyboard.press('Shift+Tab')
        assert page.evaluate("document.activeElement.closest('[data-portable-backup-modal] [role=dialog]')!==null")
        page.keyboard.press('Tab')
        assert page.evaluate("document.activeElement.closest('[data-portable-backup-modal] [role=dialog]')!==null")
        page.keyboard.press('Escape')
        page.wait_for_selector('[data-portable-backup-modal="hayaku_locator_continuity"]',state='detached')
        assert page.evaluate("document.activeElement===document.querySelector('#hayaku-portable-memory-backup-controls [data-portable-backup]')")
        assert page.evaluate("__hvg.Memory.ledgerViewer.root.querySelector('[data-portable-status]').textContent===''")
        assert not errors,errors
        calls=page.evaluate("__hostCalls")
        assert calls['llm']==1 and calls['network']==0,calls
        print({"routes":["packets","recovery"],"keyboardConfirmDialogs":6,"independentEscDecline":True,"runningJobEscMinimizesNotCancels":True,"terminalEscapePreservesFailedResult":True,"portablePopupTabTrapEscDeclineFocusReturn":True,"jobChoiceControls":3,"recoveryConfirmControls":2,"staleTargetBlocked":True,"debugPreText":True,"worldlineDetailReturnsToList":True,"validUiAdoption":True,"activePacketReadback":True,"scopeAndSourceStable":True,"syntheticModelCalls":page.evaluate('__syntheticModelCalls'),"llmCalls":calls['llm'],"networkCalls":calls['network'],"pageErrors":errors})
        browser.close()
if __name__=="__main__": main()
