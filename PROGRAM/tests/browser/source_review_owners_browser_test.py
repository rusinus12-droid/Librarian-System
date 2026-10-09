"""Full shipped plugin request-boundary reconciliation in Chromium for all owners."""
from pathlib import Path
import json, sys, shutil, subprocess
try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError as error:
    if error.name != 'playwright':
        raise
    print(json.dumps({'test': 'source_review_owner_end_to_end_browser', 'result': 'NOT_RUN', 'reason': 'Python Playwright is not installed'}))
    raise SystemExit(77)

P = Path(sys.argv[1])
E = Path(sys.argv[2])
E.mkdir(parents=True, exist_ok=True)
packet_data = json.loads(subprocess.check_output(['node', '-e', r'''
const h=require(process.argv[1]);
const originals=['Alice signed the office agreement.','Alice found a blue ribbon.'];
const packets=originals.map((text,i)=>h.createValidPacket({turn:i+1,subject:'Alice',scene:'office',summary:text}));
const edited=['Alice did not sign the office agreement.','Alice found a green ribbon.'];
const replies=edited.map((quote,i)=>{
  const packet=h.createValidPacket({turn:i+1,subject:'Alice',scene:'office',summary:quote});
  packet.entity.characters=[{name:'Alice'}];packet.planner.continuity_locks=[quote];const grounding=[];
  function walk(value,path){
    if(Array.isArray(value)){value.forEach((item,index)=>{if(item!=null&&(typeof item!=='string'||item.trim()))grounding.push({path:`${path}[${index}]`,source:'target',evidence:[quote]});});return;}
    if(value&&typeof value==='object')for(const[key,item]of Object.entries(value))walk(item,path?path+'.'+key:key);
  }
  for(const part of ['entity','world','narrative','planner'])walk(packet[part],part);
  grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote]});
  return{schema:'hayaku.native_repair_output.v1',packet,grounding};
});
console.log(JSON.stringify({packets,originals,replies}));
''', str(P / 'tests/fixtures/hayaku_runtime_harness.cjs')]))
results = []
errors = []


def check(name, ok, detail=None):
    results.append({'name': name, 'ok': bool(ok), 'detail': detail})
    if not ok:
        raise AssertionError(name + ': ' + str(detail))


try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=shutil.which('chromium'), headless=True,
                                     args=['--no-sandbox', '--disable-dev-shm-usage'])
        for owner, filename in [('libra', 'LIBRA.js'), ('hayaku', 'HAYAKU_Locator_Continuity.js'), ('flashback', 'Flashback_Memory.js')]:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_default_timeout(12000)
            page.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0"></body></html>')
            page.add_script_tag(content=(P / 'tests/browser/hayaku_browser_host.js').read_text())
            page.evaluate('''({owner,packetData})=>{
              window.__modelRequests=[];window.__reviewHooks={};window.__hayakuRepairCount=0;
              risuai.addRisuReplacer=async(key,fn)=>{__reviewHooks[key]=fn;return true;};window.testOwner=owner;window.testPackets=packetData;window.__mainDomCalls=0;
              risuai.getRootDocument=async()=>{__mainDomCalls++;throw Error('automatic source reconciliation must not request the root DOM');};
              const originalArg=risuai.getArgument;risuai.getArgument=async key=>{if(key==='enable_gui')return 'true';if(owner==='libra'&&key==='state_enabled')return 'false';if(key==='enable_character_ito'||key==='enable_world_ito'||key==='enable_plot_ito')return 'false';return originalArg(key);};
              const hidden=(body,packet)=>body+'\\n<!-- HAYAKU_STATE_PACKET_START\\n'+JSON.stringify(packet)+'\\nHAYAKU_STATE_PACKET_END -->';window.hidden=hidden;
              __chat.message=[];const count=owner==='libra'?10:2;
              for(let n=1;n<=count;n++){let line=n===1?'Alice signed the office agreement.':n===6?'Alice found a blue ribbon.':'Alice waited in the office '+n+'.';if(owner!=='libra')line=packetData.originals[n-1];
                __chat.message.push({role:'user',id:'u'+n,chatId:'u'+n,data:'Describe the office '+n+'.'},{role:'assistant',id:'a'+n,chatId:'a'+n,data:owner==='hayaku'?hidden(line,packetData.packets[n-1]):line});}
              __chat.messages=__chat.message;
              risuai.runLLMModel=async request=>{__hostCalls.llm++;__modelRequests.push(request.messages);
                if(owner==='hayaku')return{type:'success',result:JSON.stringify(testPackets.replies[__hayakuRepairCount++])};
                if(owner==='flashback')throw Error('Flashback source reconciliation must not call an LLM');
                const user=(request.messages||[]).filter(message=>message.role==='user').map(message=>message.content).join('\\n');const match=user.match(/\\[t(\\d+)-u\\]/);const start=match?Number(match[1]):1;const quote=__chat.message[start*2-1].data;
                return{type:'success',result:JSON.stringify({schema:'libra.canonical_artifact.v4',entities:[{tempId:'alice',name:'Alice',type:'person',kind:'person',evidenceSpans:[{ref:'t'+start+'-a',quote}]}],facts:[{tempFactId:'event',domain:'character',subjectTempRef:'alice',claimKind:'character_state',values:{condition:quote},text:quote,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t'+start+'-a',quote}]}],stateBindings:[{factTempId:'event',typedValueField:'condition',stateDomain:'character',stateField:'condition'}]})};};
            }''', {'owner': owner, 'packetData': packet_data})

            plugin_source = (P / 'plugins' / filename).read_text()
            if owner == 'flashback':
                marker = 'const getFlashbackSourceEdits ='
                assert plugin_source.count(marker) == 1
                plugin_source = plugin_source.replace(marker, marker + ' globalThis.__testSourceEdits =', 1)
            page.add_script_tag(content=plugin_source)

            if owner == 'libra':
                page.wait_for_function('!!window.__LIBRA__?.getRuntime', timeout=30000)
                setup = page.evaluate('''async()=>{window.product=__LIBRA__;const settings=await product.getLibraMemorySettings();await product.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});return await product.runManualColdStart();}''')
                check('LIBRA ordinary capture is ready before source edits', setup.get('completed') == 2, setup)
            elif owner == 'hayaku':
                page.wait_for_function('!!window.HAYAKU', timeout=30000)
                setup = page.evaluate('''async()=>{window.product=HAYAKU;const test=HAYAKU._test,scope=await test.currentChatScope();await test.reconcileObservedChatTopology(scope,test.authoritativeChatSnapshot(scope.chatMessages,scope),'browser-source-history-baseline');return await product.ledger.inspect({includeRecords:true});}''')
                check('HAYAKU ordinary capture is ready before source edits', len(setup.get('records', [])) == 2, len(setup.get('records', [])))
            else:
                page.wait_for_function('!!window.__FlashbackMemory?.loadSettings', timeout=30000)
                setup = page.evaluate('''async()=>{window.product=__FlashbackMemory;const settings={...await product.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false};await product.saveSettings(settings);await product.ingestLiveChatColdStart({scope:'current',canonical:true});const scope=await product.resolveCurrentScope();return await product._test.loadScopeRecords(scope.scopeKey);}''')
                check('Flashback ordinary capture is ready before source edits', len(setup.get('records', [])) >= 2, len(setup.get('records', [])))

            initial_calls = page.evaluate('__hostCalls.llm')
            mode = page.evaluate('async()=>{await product.setSourceEditTrackingMode(\'auto\');return product.getSourceEditSyncStatus().mode;}')
            check(owner + ' defaults to automatic tracking', mode == 'auto', mode)
            page.evaluate('''()=>{const second=testOwner==='libra'?11:3;__chat.message[1].data=testOwner==='hayaku'?hidden('Alice did not sign the office agreement.',testPackets.packets[0]):'Alice did not sign the office agreement.';__chat.message[second].data=testOwner==='hayaku'?hidden('Alice found a green ribbon.',testPackets.packets[1]):'Alice found a green ribbon.';}''')

            if owner == 'libra':
                page.evaluate("async()=>{await __reviewHooks.beforeRequest([{role:'user',content:'Continue.'}],'model');await __reviewHooks.afterRequest('Next response.','model');}")
            elif owner == 'hayaku':
                page.evaluate("async()=>{const test=product._test,scope=await test.currentChatScope();await test.reconcileObservedChatTopology(scope,test.authoritativeChatSnapshot(scope.chatMessages,scope),'browser-source-edits');await test.handleBeforeRequest([{role:'user',content:'Continue.'}],'model');test.getHayakuSourceEdits().afterRequest();}")
            else:
                page.evaluate("async()=>{await __testSourceEdits().beforeRequest();__testSourceEdits().afterRequest();}")

            state = page.evaluate('product.getSourceEditSyncStatus()')
            check(owner + ' detected owner and current chat scope', state.get('owner') == owner and bool(state.get('scopeKey')), {'owner': state.get('owner'), 'scopeKey': state.get('scopeKey')})
            check(owner + ' both changed source units are automatically applied', len(state.get('events', [])) == 2 and len(state.get('tasks', [])) == 2 and all(task.get('state') == 'applied' for task in state.get('tasks', [])), {'events': len(state.get('events', [])), 'states': [task.get('state') for task in state.get('tasks', [])]})
            check(owner + ' beforeRequest opens no consent dialog or dock', page.locator('#memorySuiteSourceReview, [x-memory-suite-source-review-dock], [x-memory-suite-source-edit-dialog]').count() == 0)
            check(owner + ' automatic reconciliation does not request the host root document', page.evaluate('__mainDomCalls') == 0, page.evaluate('__mainDomCalls'))

            prompt_result = page.evaluate('async()=>product.reviewSourceEdits()')
            check(owner + ' legacy manual review entry point is disabled', prompt_result.get('reason') == 'automatic_before_request_only', prompt_result)
            check(owner + ' manual entry also leaves the host UI unchanged', page.locator('#memorySuiteSourceReview, [x-memory-suite-source-review-dock], [x-memory-suite-source-edit-dialog]').count() == 0 and page.evaluate('__mainDomCalls') == 0)
            if owner == 'flashback':
                check('Flashback automatic reconciliation uses no model call', page.evaluate('__hostCalls.llm') == initial_calls, page.evaluate('__hostCalls.llm'))
            else:
                check(owner + ' source reanalysis is caused by the request boundary', page.evaluate('__hostCalls.llm') > initial_calls, {'before': initial_calls, 'after': page.evaluate('__hostCalls.llm')})

            if owner == 'libra':
                memories = page.evaluate('async()=>product.getCanonicalMemories()')
                check('LIBRA both edited replacements are persisted automatically', any('did not sign' in memory.get('text', '') for memory in memories) and any('green ribbon' in memory.get('text', '') for memory in memories))
            elif owner == 'hayaku':
                ledger = page.evaluate('async()=>product.ledger.inspect({includeRecords:true})')
                check('HAYAKU both edited source packets are retained', any('did not sign' in str(record) for record in ledger.get('records', [])) and any('green ribbon' in str(record) for record in ledger.get('records', [])), len(ledger.get('records', [])))
            else:
                scope = page.evaluate('async()=>product.resolveCurrentScope()')
                stored = page.evaluate('async scopeKey=>product._test.loadScopeRecords(scopeKey)', scope.get('scopeKey'))
                records = stored.get('records', [])
                check('Flashback both edited raw turns are stored automatically', any('did not sign' in record.get('text', '') for record in records) and any('green ribbon' in record.get('text', '') for record in records), len(records))
            check(owner + ' visible host messages remain the edited source', page.evaluate("__chat.message[1].data.includes('did not sign') && __chat.message[3].data.includes('green ribbon')"))
            page.close()
        browser.close()
except Exception as error:
    errors.append(str(error))
    raise
finally:
    payload = {'test': 'source_review_owner_end_to_end_browser', 'environment': 'entire shipped plugins in Chromium; synthetic host/model/storage, no user database',
               'passed': sum(result['ok'] for result in results), 'total': len(results), 'errors': errors, 'results': results}
    (E / 'RESULTS.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in payload.items() if key != 'results'}, ensure_ascii=False))
