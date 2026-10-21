"""Whole LIBRA/HAYAKU plugins in Chromium with synthetic native/storage data.
No user data, external model, backend request or host selection write.
"""
from pathlib import Path
import json,os,shutil
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
OUT=Path(os.environ.get('SCOPE_MANAGER_BROWSER_OUTPUT','/tmp/owner-scope-management-browser'));OUT.mkdir(parents=True,exist_ok=True)
ART=os.environ.get('SCOPE_MANAGER_ARTIFACT_ROOT')
checks=[];errors=[]
def check(name,result,detail=None):
    checks.append({'name':name,'ok':bool(result),'detail':detail})
    assert result,f'{name}: {detail}'
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    try:
        for owner,file,hostfile in [('LIBRA','LIBRA.js','libra_writer_host.js'),('HAYAKU','HAYAKU_Locator_Continuity.js','hayaku_browser_host.js')]:
            page=browser.new_page(viewport={'width':1440,'height':1000});page.set_default_timeout(15000)
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.route('http://localhost/**',lambda route:route.fulfill(status=200,content_type='text/html',body='<html><body></body></html>'))
            page.goto('http://localhost/scope-manager')
            page.set_content('<!doctype html><body style="margin:0;background:#29333c"><iframe id="plugin" style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe></body>')
            frame=page.frames[1];frame.add_script_tag(path=str(ROOT/'PROGRAM/tests/browser'/hostfile))
            frame.evaluate(r'''async owner=>{
              const char=owner==='LIBRA'?__writerHost.character:__character;
              const original=risuai.getDatabase.bind(risuai);
              const other={chaId:'stored-character',name:'보존된 캐릭터',chats:[{id:'inactive-chat',name:'찾을 채팅'}]};
              risuai.getDatabase=async fields=>{const value=await original(fields);if(!fields||fields.includes('characters'))value.characters=[structuredClone(char),other];return value;};
              risuai.showContainer=async()=>true;window.confirm=()=>{throw Error('Native confirm forbidden');};
              let h64=value=>{let h=0xcbf29ce484222325n;for(let n=0;n<value.length;n++)h=BigInt.asUintN(64,(h^BigInt(value.charCodeAt(n)))*0x100000001b3n);return 'h64'+h.toString(36);};
              window.__scopeTestKeys={};
              for(const [characterId,chatId,name]of [['stored-character','inactive-chat','찾을 채팅'],['removed-character','orphan-chat','보존된 고아 채팅']]){
                const scopeKey=owner==='LIBRA'?'browser-scope-'+chatId+'-long-'.repeat(15):'chat_'+h64(characterId+'\n'+chatId);
                const key=owner==='LIBRA'?`libra:v1:scope:${scopeKey}:manifest`:'hayaku.v2.ledger.'+scopeKey;
                const value=owner==='LIBRA'?{schema:'libra.manifest.v1',scopeKey,characterId,chatId,characterName:'보존된 캐릭터',chatTitle:name,updatedAt:'2026-10-20T12:30:00.000Z',memories:{},inheritedMemories:[],privateBody:'PRIVATE_MEMORY_BODY'}:{version:'hayaku_storage_ledger_v2',scopeKey,identity:{schema:'hayaku.scope_identity.v1',scopeKey,characterId,chatId,characterName:'보존된 캐릭터',chatTitle:name},updatedAt:'2026-10-20T12:30:00.000Z',records:[],slotHeads:[],tombstones:[],privateBody:'PRIVATE_MEMORY_BODY'};
                window.__scopeTestKeys[chatId]=key;await risuai.pluginStorage.setItem(key,JSON.stringify(value));
              }
            }''',owner)
            source=Path(ART)/file if ART else ROOT/'PROGRAM/plugins'/file
            frame.add_script_tag(content=source.read_text())
            if owner=='LIBRA':
                frame.wait_for_function('!!window.__LIBRA__');frame.evaluate('__LIBRA__.openSettingsGui()')
                frame.locator('[data-memory-progress]').wait_for();frame.wait_for_timeout(200)
                if frame.locator('[data-libra-quick-dialog]').count():frame.locator('[data-libra-quick-dialog] .dialog__actions button').click()
                frame.locator('.topbar [data-go=settings]').click();frame.locator('.setnav [data-subtab=store]').click();frame.get_by_role('tab',name='스코프 데이터 관리',exact=True).click()
            else:
                frame.wait_for_function('!!window.HAYAKU');frame.evaluate('HAYAKU.showUi()');frame.locator('[data-hayaku-viewer-tab=scopes]').click()
            manager=frame.locator('[data-scope-manager]')
            try:manager.locator('[data-scope-row]').first.wait_for()
            except Exception:
                print(owner,frame.evaluate("()=>({managers:document.querySelectorAll('[data-scope-manager]').length,rows:document.querySelectorAll('[data-scope-row]').length,summary:document.querySelector('[data-scope-summary]')?.textContent,errors:document.querySelector('[data-owner-scope-manager-host]')?.textContent,section:document.querySelector('[data-product-settings-section]')?.getAttribute('data-product-settings-section')})"),flush=True)
                raise
            check(owner+': compact semantic table',manager.locator('table thead th').all_text_contents()==['','캐릭터 / 채팅','정본 / Micro' if owner=='LIBRA' else '패킷 / 슬롯','저장 키','상태','업데이트','관리'] and manager.locator('tbody tr[data-scope-row]').count()==3)
            if owner=='LIBRA':check('LIBRA: storage category has independent scope tab',frame.locator('.setnav [data-subtab=store]').get_attribute('aria-selected')=='true' and frame.get_by_role('tab',name='스코프 데이터 관리',exact=True).get_attribute('aria-selected')=='true')
            check(owner+': whole owner catalog visible','스코프 데이터 관리' in manager.inner_text())
            check(owner+': current scope is not selectable',manager.locator('tr[data-current=true] [data-scope-select]').is_disabled())
            check(owner+': stored update time',manager.locator('[data-scope-row] time[datetime="2026-10-20T12:30:00.000Z"]').count()==2)
            check(owner+': readable search and filter',manager.evaluate("e=>{const p=getComputedStyle(e);return [...e.querySelectorAll('input[type=search],select')].every(c=>{const s=getComputedStyle(c);return s.color===p.color&&s.backgroundColor===p.backgroundColor&&s.color!==s.backgroundColor})}"))
            check(owner+': memory body excluded','PRIVATE_MEMORY_BODY' not in manager.inner_text() and 'PRIVATE_MEMORY_BODY' not in manager.locator('[data-scope-diagnostics-text]').input_value())
            manager.locator('[data-scope-filter]').select_option('detached')
            check(owner+': orphan remains listed',manager.locator('[data-scope-row]').count()==1 and '보존된 고아 채팅' in manager.inner_text())
            manager.locator('[data-scope-filter]').select_option('all');manager.locator('[data-scope-search]').fill('찾을 채팅')
            check(owner+': inactive chat searchable',manager.locator('[data-scope-row]').count()==1)
            manager.locator('[data-scope-delete-one]').click()
            manager.locator('[data-scope-confirm]').wait_for(state='visible')
            check(owner+': explicit selected-scope consent','1개' in manager.locator('[data-scope-confirm-text]').inner_text())
            manager.locator('[data-scope-cancel]').click();manager.locator('[data-scope-confirm]').wait_for(state='hidden')
            for width,height in [(1440,1000),(900,1024),(640,900),(390,844),(320,640)]:
                page.set_viewport_size({'width':width,'height':height});frame.wait_for_timeout(350)
                manager.evaluate("e=>e.scrollIntoView({block:'nearest'})")
                geometry=manager.evaluate('e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,w:r.width,overflow:e.scrollWidth-e.clientWidth}}')
                check(f'{owner} {width}: panel fits',geometry['w']>100 and geometry['x']>=0 and geometry['right']<=width+1 and geometry['overflow']<=1,geometry)
                manager.locator('[data-scope-row] [data-scope-detail]').first.evaluate('e=>e.open=true')
                check(f'{owner} {width}: key detail visible',manager.locator('[data-scope-row] [data-scope-detail]').first.is_visible())
                if width in [1440,390]:
                    manager.locator('[data-scope-search]').fill('');manager.locator('[data-scope-filter]').select_option('all')
                    manager.locator('[data-scope-row] [data-scope-detail]').evaluate_all('nodes=>nodes.forEach(e=>e.open=false)')
                    manager.evaluate("e=>e.scrollIntoView({block:'end'})")
                    page.screenshot(path=str(OUT/f'{owner}-{width}.png'))
            page.set_viewport_size({'width':1440,'height':1000});frame.wait_for_timeout(350)
            frame.wait_for_function("!document.querySelector('[data-scope-refresh]').disabled")
            manager.locator('[data-scope-search]').fill('');manager.locator('[data-scope-pick=orphan]').click()
            check(owner+': orphan selection does not delete',frame.evaluate("async()=>!!await risuai.pluginStorage.getItem(__scopeTestKeys['orphan-chat'])"))
            manager.locator('[data-scope-action=export]').click();manager.locator('[data-scope-confirm]').wait_for(state='visible')
            with page.expect_download() as download_event:manager.locator('[data-scope-approve]').click()
            backup=json.loads(Path(download_event.value.path()).read_text())
            check(owner+': explicit backup contains selected original',backup['schema']=='memory-suite.scope-data-backup.v1' and any('PRIVATE_MEMORY_BODY' in str(row['value']) for row in backup['records']))
            manager.locator('[data-scope-refresh]').wait_for(state='visible');frame.wait_for_function("!document.querySelector('[data-scope-refresh]').disabled")
            manager.locator('[data-scope-pick=orphan]').click();manager.locator('[data-scope-action=delete]').click();manager.locator('[data-scope-confirm]').wait_for(state='visible')
            check(owner+': deletion requires backup acknowledgement',manager.locator('[data-scope-approve]').is_disabled())
            manager.locator('[data-scope-cancel]').click();manager.locator('[data-scope-confirm]').wait_for(state='hidden')
            check(owner+': cancelled deletion preserves original',frame.evaluate("async()=>!!await risuai.pluginStorage.getItem(__scopeTestKeys['orphan-chat'])"))
            manager.locator('[data-scope-delete-one]').click();manager.locator('[data-scope-delete-ack]').check();manager.locator('[data-scope-approve]').click()
            frame.wait_for_function("/완료|작업 보류/.test(document.querySelector('[data-scope-result]').textContent)")
            check(owner+': selected orphan deleted',frame.evaluate("async()=>!await risuai.pluginStorage.getItem(__scopeTestKeys['orphan-chat'])"),manager.locator('[data-scope-result]').inner_text())
            check(owner+': other inactive scope preserved',frame.evaluate("async()=>!!await risuai.pluginStorage.getItem(__scopeTestKeys['inactive-chat'])"))
            check(owner+': zero network/model calls',frame.evaluate('__writerHost.calls.network===0&&__writerHost.calls.model===0' if owner=='LIBRA' else '__hostCalls.network===0&&__hostCalls.llm===0'))
            page.close()
        check('no uncaught browser errors',not errors,errors)
    finally:
        (OUT/'results.json').write_text(json.dumps({'checks':checks,'errors':errors},ensure_ascii=False,indent=2));browser.close()
print(json.dumps({'passed':len(checks),'output':str(OUT)}))
