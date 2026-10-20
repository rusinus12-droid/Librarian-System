"""Exact LIA plugin in a fullscreen iframe with controlled native host/model I/O.
No user data or live provider is used. Tests both source and release artifacts.
"""
from pathlib import Path
import json, os, shutil, subprocess
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[3]
SOURCE=Path(os.environ.get('LIA_GUI_SOURCE',str(ROOT/'PROGRAM/plugins/LIA_Persona_Linker.js')))
OUT=Path(os.environ.get('LIA_WINDOW_OUTPUT','/tmp/lia-window-manual-notice'))
OUT.mkdir(parents=True,exist_ok=True)
seed_code="""const {createFixture}=require('./PROGRAM/tests/fixtures/lia_native_runtime_fixture.cjs');(async()=>{const f=await createFixture('official');process.stdout.write(JSON.stringify({values:[...f.values],db:f.db,chat:f.liveChat,char:f.character}));await f.dispose();})().catch(e=>{console.error(e);process.exitCode=1;});"""
SEED=json.loads(subprocess.check_output(['node','-e',seed_code],cwd=ROOT,text=True))
results,errors=[],[]
def check(name,condition,detail=None):
    results.append({'name':name,'ok':bool(condition),'detail':detail})
    assert condition,f'{name}: {detail}'

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    def mount():
        page=browser.new_page(viewport={'width':1440,'height':1000})
        page.set_default_timeout(8000)
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.set_content("<!doctype html><html><body style='margin:0;background:#283344;color:white'><h1>Chat workspace</h1><iframe id='plugin' title='LIA' style='position:fixed;inset:0;width:100%;height:100%;border:0;display:none'></iframe></body></html>")
        frame=page.frames[1]
        frame.evaluate(r"""seed=>{
          const values=new Map(seed.values),local=new Map(),db=seed.db,chat=seed.chat,char=seed.char;char.chats=[chat];db.characters=[char];
          db.personas[0].personaPrompt='Name: Source Persona\nAge: 27\nSpecies: Human\nOccupation: Explorer\nPersonality: Observant, kind, and quick to laugh.';
          db.personas.push({id:'second-persona',name:'Source Persona',personaPrompt:'Name: Source Persona\nAge: 32\nOccupation: Librarian\nPersonality: Quiet and patient, with a love of old maps.'});
          window.__lia={values,db,chat,char,index:0,open:null,output:null,hooks:new Map(),modelCalls:[],hostWrites:0,hidden:true};
          values.set('dynamicPersonaLorebookGeneratorLLMConfig',JSON.stringify({provider:'ollama',model:'mock-model',endpoint:'http://fixture.invalid/api/chat',stream:false,promptCacheMode:'off',maxCompletionTokens:4096}));
          values.set('liaPersonaIllustrationConfigV1',JSON.stringify({enabled:true,runtimeAttachEnabled:true,apiKey:'synthetic-retired-image-key'}));
          values.set('liaPersonaVisualAssetStoreV1',JSON.stringify({version:1,sets:{legacy:{personaKey:'legacy',images:{neutral:{assetPath:'legacy-image'}}}}}));
          __lia.legacyImageSettings=values.get('liaPersonaIllustrationConfigV1');__lia.legacyAssets=values.get('liaPersonaVisualAssetStoreV1');
          const storage={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);return true},removeItem:async k=>{values.delete(k);return true},keys:async()=>[...values.keys()]};
          window.risuai={pluginStorage:storage,safeLocalStorage:{getItem:async k=>local.get(k)??null,setItem:async(k,v)=>{local.set(k,v);return true},removeItem:async k=>local.delete(k),keys:async()=>[...local.keys()]},
            getArgument:async()=>'',setArgument:async()=>true,getLocalPluginStorage:async()=>risuai.safeLocalStorage,
            getDatabase:async fields=>Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,structuredClone(db[k])])):structuredClone(db),
            setDatabase:async patch=>{__lia.hostWrites++;Object.assign(db,structuredClone(patch));return true},
            getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>__lia.index,getCharacter:async()=>structuredClone(char),getCharacterFromIndex:async()=>structuredClone(char),
            getChatFromIndex:async(_c,i)=>structuredClone(char.chats[i]),getChat:async()=>structuredClone(char.chats[__lia.index]),
            setChatToIndex:async(_c,i,next)=>{__lia.hostWrites++;Object.assign(char.chats[i],structuredClone(next));return true},
            registerSetting:async(_n,fn)=>{__lia.open=fn;return true},registerButton:async()=>true,onUnload:async fn=>{__lia.unload=fn;return true},
            addRisuChatListener:async(_type,fn)=>{__lia.output=fn;return true},removeRisuChatListener:async()=>{__lia.output=null;return true},
            addRisuReplacer:async(type,fn)=>{__lia.hooks.set(type,fn);return true},removeRisuReplacer:async type=>__lia.hooks.delete(type),
            requestPluginPermission:async()=>true,addPluginChannelListener:async()=>true,removePluginChannelListener:async()=>true,postPluginChannelMessage:async()=>true,
            showContainer:async mode=>{if(mode!=='fullscreen')throw Error('Unsupported host mode');__lia.hidden=false;parent.document.querySelector('#plugin').style.display='block'},
            hideContainer:async()=>{__lia.hidden=true;parent.document.querySelector('#plugin').style.display='none'},
            nativeFetch:async(url,init)=>{if(!String(url).startsWith('http://fixture.invalid/'))throw Error('Unexpected network request');__lia.modelCalls.push(JSON.parse(init.body));return {ok:true,status:200,text:async()=>JSON.stringify({message:{content:JSON.stringify({summary:'Controlled five-turn result',liveState:[{key:'goal',category:'goal',value:'Find the silver key',durability:'persistent',confidence:96,evidence:['Explicit USER goal']}],coreCandidates:[],ignoredTransient:[]})},done:true,done_reason:'stop'})}},
            log:async()=>true};
          window.fetch=async()=>{throw Error('Live network forbidden')};
          window.__emit=()=>{const i=chat.message.length-1;__lia.output?.({char:structuredClone(char),chat:structuredClone(chat),characterIndex:0,chatIndex:0,messageIndex:i})};
        }""",SEED)
        frame.add_script_tag(content=SOURCE.read_text())
        frame.wait_for_function('!!__lia.open&&!!__lia.output')
        return page,frame
    try:
        page,frame=mount()
        frame.evaluate('__lia.open()')
        frame.locator('#pocket').wait_for(state='visible')
        check('image UI and emotion response hooks removed',frame.locator('[data-page=assets],#lia-image-enabled,#lia-image-provider').count()==0 and frame.evaluate('__lia.hooks.has("afterRequest")') is False)
        geometry="""()=>{const a=document.querySelector('.app').getBoundingClientRect();return {x:a.x,y:a.y,w:a.width,h:a.height,overflow:document.documentElement.scrollWidth-innerWidth,bg:[document.documentElement,document.body,document.querySelector('.stage')].map(n=>getComputedStyle(n).backgroundColor)}}"""
        for width,height in [(2556,1363),(1440,1000),(900,1024),(640,900),(390,844),(320,640),(844,390)]:
            page.set_viewport_size({'width':width,'height':height});frame.wait_for_timeout(40)
            g=frame.evaluate(geometry)
            check(f'{width}x{height}: centered',abs(g['x']+g['w']/2-width/2)<=1 and abs(g['y']+g['h']/2-height/2)<=1,g)
            check(f'{width}x{height}: fits screen',g['w']<=width-30 and g['h']<=height-30 and g['overflow']<=1,g)
            check(f'{width}x{height}: transparent exterior',all(c=='rgba(0, 0, 0, 0)' for c in g['bg']))
            frame.locator('#pocket [data-lia-open-bind]').click()
            first=frame.locator('#bind-list [data-lia-bind-choice]').first
            check(f'{width}: representative details visible',all(t in first.inner_text() for t in ['27','Explorer','Observant']))
            check(f'{width}: picker columns fit',first.evaluate("e=>{let r=e.getBoundingClientRect();return [...e.children].every(c=>c.getBoundingClientRect().right<=r.right+1)}"))
            check(f'{width}: selection label visible',first.locator('.pick').is_visible())
            if width==1440:page.screenshot(path=str(OUT/'picker-desktop.png'))
            if width==390:page.screenshot(path=str(OUT/'picker-mobile.png'))
            page.keyboard.press('Escape')
            frame.locator('[data-menu]').click()
            check(f'{width}: More menu opens',frame.locator('.menu.is-open .menu__panel').is_visible())
            frame.locator('.menu__panel [data-lia-refresh]').click()
            frame.locator('#pocket').wait_for(state='visible')
            check(f'{width}: refresh menu closes',frame.locator('.menu.is-open').count()==0)
            frame.locator('.topbar > [data-lia-close]').click()
            check(f'{width}: dedicated close hides container',frame.evaluate('__lia.hidden') is True)
            frame.evaluate('__lia.open()');frame.locator('#pocket').wait_for(state='visible')
        check('UI use makes zero model calls',frame.evaluate('__lia.modelCalls.length')==0)
        check('retired image settings and stored assets remain untouched',frame.evaluate('__lia.values.get("liaPersonaIllustrationConfigV1")===__lia.legacyImageSettings&&__lia.values.get("liaPersonaVisualAssetStoreV1")===__lia.legacyAssets'))
        frame.locator('[data-menu]').click();frame.locator('.menu__panel [data-lia-close]').click()
        frame.evaluate('__lia.chat.message.splice(8);__emit()');frame.wait_for_timeout(100)
        check('four turns do not notify',frame.locator('#lia-update-notice').count()==0)
        frame.evaluate("__lia.chat.message.push({role:'user',is_user:true,chatId:'u5',data:'User turn 5'});__emit()")
        frame.wait_for_timeout(60)
        check('incomplete fifth turn does not notify',frame.locator('#lia-update-notice').count()==0)
        frame.evaluate("__lia.chat.message.push({role:'assistant',is_user:false,chatId:'a5',data:'Assistant turn 5'});__emit();__emit()")
        frame.locator('#lia-update-notice').wait_for(state='visible')
        check('five-turn notice gives range and cost',all(x in frame.locator('#lia-update-notice').inner_text() for x in ['1~5','비용','수동']))
        check('no model call before consent',frame.evaluate('__lia.modelCalls.length')==0)
        frame.locator('[data-lia-notice=later]').click()
        frame.evaluate('__emit()');frame.wait_for_timeout(100)
        check('decline does not re-notify the same range',frame.locator('#lia-update-notice').count()==0 and frame.evaluate('__lia.modelCalls.length')==0)
        page.close()

        page,frame=mount()
        original=frame.evaluate('JSON.stringify(__lia.db.personas[0])')
        frame.evaluate('__emit();__emit()');frame.locator('#lia-update-notice').wait_for(state='visible')
        check('duplicate events share one consent dialog',frame.locator('#lia-update-notice').count()==1 and frame.evaluate('__lia.modelCalls.length')==0)
        frame.locator('[data-lia-notice=approve]').click()
        frame.wait_for_function('__lia.modelCalls.length===1')
        frame.wait_for_function("[...__lia.values].some(([k,v])=>k.startsWith('liaPersonaLinkerLivePersonaScopeV2::')&&JSON.parse(v).lastProcessedPairCount===5)")
        frame.locator('#upd-hint').wait_for(state='attached')
        check('consent runs one manual five-turn analysis',frame.evaluate('__lia.modelCalls.length')==1)
        check('original Persona is preserved',frame.evaluate('JSON.stringify(__lia.db.personas[0])')==original)
        check('live state appears in GUI','Find the silver key' in frame.locator('#live-persona-state').inner_text())
        check('next range resets after successful update',frame.locator('#upd-badge').inner_text().strip()=='0 / 5쌍')
        frame.evaluate("for(let n=6;n<=9;n++){__lia.chat.message.push({role:'user',is_user:true,chatId:'u'+n,data:'User turn '+n},{role:'assistant',is_user:false,chatId:'a'+n,data:'Assistant turn '+n})}__emit()")
        frame.wait_for_timeout(100)
        check('four further turns do not prompt early',frame.locator('#lia-update-notice').count()==0)
        frame.evaluate("__lia.chat.message.push({role:'user',is_user:true,chatId:'u10',data:'User turn 10'},{role:'assistant',is_user:false,chatId:'a10',data:'Assistant turn 10'});__emit()")
        frame.locator('#lia-update-notice').wait_for(state='visible')
        check('next five-turn batch offers its own range','6~10' in frame.locator('#lia-update-notice').inner_text() and frame.evaluate('__lia.modelCalls.length')==1)
        frame.locator('[data-lia-notice=later]').click()
        page.close()

        page,frame=mount()
        frame.evaluate('__emit()');frame.locator('#lia-update-notice').wait_for(state='visible')
        frame.evaluate("__lia.char.chats.push({...structuredClone(__lia.chat),id:'other-chat',chatId:'other-chat'});__lia.index=1")
        frame.locator('[data-lia-notice=approve]').click();frame.wait_for_timeout(150)
        check('chat switch during consent cannot analyze another Persona',frame.evaluate('__lia.modelCalls.length')==0)
        check('no uncaught browser errors',not errors,errors)
        page.close()
    finally:
        (OUT/'results.json').write_text(json.dumps({'source':str(SOURCE),'checks':results,'errors':errors},ensure_ascii=False,indent=2))
        browser.close()
print(json.dumps({'passed':len(results),'source':str(SOURCE),'output':str(OUT)},ensure_ascii=False))
