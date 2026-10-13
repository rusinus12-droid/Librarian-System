"""Shipped owner input edits require explicit selected execution; Chromium synthetic host."""
from pathlib import Path
import json, sys, shutil, subprocess, hashlib
try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError as error:
    if error.name != 'playwright':
        raise
    print(json.dumps({'test': 'source_review_owner_end_to_end_browser', 'result': 'NOT_RUN', 'reason': 'Python Playwright is not installed'}))
    raise SystemExit(77)

P = Path(sys.argv[1]).resolve()
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
source_hashes = {}


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
            page.route('http://localhost/**', lambda route: route.fulfill(body='<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0"></body></html>', content_type='text/html'))
            page.goto('http://localhost/source-owner')
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
            source_hashes[owner] = hashlib.sha256(plugin_source.encode()).hexdigest()
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
            original_visible = page.evaluate('JSON.stringify(__chat.message)')
            check(owner + ' source rules are exposed through current public input API', isinstance(page.evaluate('product.getSourceEditRules()'), dict))
            page.evaluate('''()=>{const second=testOwner==='libra'?11:3;__chat.message[1].data=testOwner==='hayaku'?hidden('Alice did not sign the office agreement.',testPackets.packets[0]):'Alice did not sign the office agreement.';__chat.message[second].data=testOwner==='hayaku'?hidden('Alice found a green ribbon.',testPackets.packets[1]):'Alice found a green ribbon.';}''')

            edited_visible = page.evaluate('JSON.stringify(__chat.message)')
            # An actual registered request boundary must not start source reconciliation.
            check(owner + ' actual before/after request hooks are registered', page.evaluate("typeof __reviewHooks.beforeRequest==='function'&&typeof __reviewHooks.afterRequest==='function'"))
            page.evaluate("async()=>{await __reviewHooks.beforeRequest([{role:'user',content:'Continue.'}],'model');await __reviewHooks.afterRequest(__chat.message.at(-1).data,'model');}")
            check(owner + ' request boundary starts no source model work', page.evaluate('__hostCalls.llm') == initial_calls, {'before':initial_calls,'after':page.evaluate('__hostCalls.llm')})
            check(owner + ' beforeRequest opens no consent dialog or dock', page.locator('#memorySuiteSourceReview, [x-memory-suite-source-review-dock], [x-memory-suite-source-edit-dialog]').count() == 0)
            check(owner + ' request boundary does not request the host root document', page.evaluate('__mainDomCalls') == 0, page.evaluate('__mainDomCalls'))
            check(owner + ' request boundary preserves edited original bytes', page.evaluate('JSON.stringify(__chat.message)') == edited_visible)
            if owner == 'libra':
                inventory = page.evaluate('async()=>product.listCanonicalBatchRanges()')
                selected = {'scopeKey':inventory['scopeKey'],'mode':'source_edit','ranges':inventory['ranges']}
            else:
                inventory = page.evaluate('async()=>product.listReanalysisRanges()')
                selected = {'scopeKey':inventory['scopeKey'],'topology':inventory['topology'],'ranges':inventory['ranges']}
            check(owner + ' detects exact current chat scope and two source ranges', bool(inventory.get('scopeKey')) and len(inventory.get('ranges',[])) == 2, inventory)
            check(owner + ' inventory refresh starts no model or popup', page.evaluate('__hostCalls.llm') == initial_calls and page.locator('#memorySuiteSourceReview, [x-memory-suite-source-review-dock], [x-memory-suite-source-edit-dialog]').count() == 0)
            # Capture the selected target, switch chats, and prove the public operation refuses it.
            refused = page.evaluate("""async({owner,selected})=>{const ids={id:__chat.id,chatId:__chat.chatId};__chat.id=__chat.chatId='wrong-current-chat';try{const result=owner==='libra'?await product.startSelectedCanonicalBatches(selected):await product.reanalyzeSelectedRanges(selected);return {ok:result.ok,reason:result.reason||''};}catch(e){return {ok:false,reason:e.message};}finally{Object.assign(__chat,ids);}}""", {'owner':owner,'selected':selected})
            check(owner + ' explicit selected stale target is refused', refused.get('ok') is not True, refused)
            check(owner + ' refused target starts no model and preserves originals', page.evaluate('__hostCalls.llm') == initial_calls and page.evaluate('JSON.stringify(__chat.message)') == edited_visible)
            # Returning from a different chat requires a fresh inventory, exactly as the GUI does.
            fresh_inventory = page.evaluate('async owner=>owner==="libra"?await product.listCanonicalBatchRanges():await product.listReanalysisRanges()', owner)
            check(owner + ' restored target refresh preserves scope and starts no model', fresh_inventory.get('scopeKey') == inventory.get('scopeKey') and page.evaluate('__hostCalls.llm') == initial_calls)
            selected = {'scopeKey':fresh_inventory['scopeKey'],'ranges':fresh_inventory['ranges'], **({'mode':'source_edit'} if owner=='libra' else {'topology':fresh_inventory['topology']})}
            outcome = page.evaluate("""async({owner,selected})=>owner==='libra'?await product.startSelectedCanonicalBatches(selected):await product.reanalyzeSelectedRanges(selected)""", {'owner':owner,'selected':selected})
            check(owner + ' explicitly selected two source ranges finish', outcome.get('ok') is True, outcome)
            check(owner + ' explicit action leaves edited original host messages unchanged', page.evaluate('JSON.stringify(__chat.message)') == edited_visible)
            if owner == 'flashback':
                check('Flashback explicit raw reconciliation uses no model call', page.evaluate('__hostCalls.llm') == initial_calls, page.evaluate('__hostCalls.llm'))
            else:
                check(owner + ' source reanalysis is caused only by explicit selection', page.evaluate('__hostCalls.llm') > initial_calls, {'before':initial_calls,'after':page.evaluate('__hostCalls.llm')})

            if owner == 'libra':
                memories = page.evaluate('async()=>product.getCanonicalMemories()')
                check('LIBRA both edited replacements are persisted after explicit selection', any('did not sign' in memory.get('text', '') for memory in memories) and any('green ribbon' in memory.get('text', '') for memory in memories))
            elif owner == 'hayaku':
                ledger = page.evaluate('async()=>product.ledger.inspect({includeRecords:true})')
                check('HAYAKU both edited source packets are retained', any('did not sign' in str(record) for record in ledger.get('records', [])) and any('green ribbon' in str(record) for record in ledger.get('records', [])), len(ledger.get('records', [])))
            else:
                scope = page.evaluate('async()=>product.resolveCurrentScope()')
                stored = page.evaluate('async scopeKey=>product._test.loadScopeRecords(scopeKey)', scope.get('scopeKey'))
                records = stored.get('records', [])
                check('Flashback both edited raw turns are stored after explicit selection', any('did not sign' in record.get('text', '') for record in records) and any('green ribbon' in record.get('text', '') for record in records), len(records))
            check(owner + ' visible host messages remain the edited source', page.evaluate("__chat.message[1].data.includes('did not sign') && __chat.message[testOwner==='libra'?11:3].data.includes('green ribbon')"))
            page.close()
        browser.close()
except Exception as error:
    errors.append(str(error))
    raise
finally:
    payload = {'test': 'source_review_owner_end_to_end_browser', 'environment': 'entire shipped plugins in Chromium; synthetic host/model/storage, no user database',
               'passed': sum(result['ok'] for result in results), 'total': len(results), 'errors': errors, 'sourceSha256':source_hashes, 'results': results}
    (E / 'RESULTS.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in payload.items() if key != 'results'}, ensure_ascii=False))
