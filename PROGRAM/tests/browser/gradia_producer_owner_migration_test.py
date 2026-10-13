"""Real standalone GRADIA producer controls replacing retired LIBRA workbenches.
Only test instrumentation exposes existing functions; synthetic host blocks network.
"""
import asyncio, hashlib, json, os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[3]
SOURCE=ROOT/'PROGRAM/plugins/GRADIA.js'
EXECUTED_SOURCE=Path(os.environ.get('GRADIA_FULL_ARTIFACT',str(SOURCE)))
if os.environ.get('GRADIA_FULL_ARTIFACT'):
    assert EXECUTED_SOURCE.read_bytes()==SOURCE.read_bytes(), 'official Full must equal current source'
OUT=Path(os.environ.get('GRADIA_PRODUCER_OUTPUT','/tmp/gradia-producer-owner-migration'))
HOST=(Path(__file__).parent/'gradia_browser_host.js').read_text()

async def main():
    OUT.mkdir(parents=True,exist_ok=True)
    errors=[];checks=[]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        page=await browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.set_content('<!doctype html><html lang="ko"><body></body></html>')
        await page.evaluate(HOST)
        source=EXECUTED_SOURCE.read_text();marker='  const publicApi = Object.freeze({'
        assert source.count(marker)==1
        await page.add_script_tag(content=source.replace(marker,'  globalThis.__producer={Gui,loadSettings,showInputAssistComposer};\n'+marker))
        await page.evaluate('window.__SerialGradationAgentsForRP.openSettingsGui()')
        async def clean():
            await page.wait_for_function('!__producer.Gui.dirty&&!__producer.Gui.saving')
        async def save():
            await page.locator('#savebar [data-save]').click();await clean()
        async def route(name):
            await page.locator('.sidebar [data-go="'+name+'"]').click()
        await page.locator('.mode-switch [data-mode=rp]').click()
        await page.get_by_role('button',name='취소',exact=True).click()
        assert await page.evaluate('__producer.Gui.state.runtime.writingMode')=='novel'
        await page.locator('.mode-switch [data-mode=rp]').click()
        await page.get_by_role('button',name='확인 · RP 모드 적용',exact=True).click()
        await page.wait_for_function('__producer.Gui.state.runtime.writingMode==="rp"')
        await save()
        await page.locator('.mode-switch [data-mode=novel]').click()
        await page.locator('#savebar [data-revert]').click();await clean()
        assert await page.evaluate('__producer.Gui.state.runtime.writingMode')=='rp'
        assert await page.locator('.mode-switch [data-mode=rp]').get_attribute('aria-pressed')=='true'
        checks.append('RP confirmation cancel/apply/save/revert and active mode readback')
        await page.locator('.mode-switch [data-mode=novel]').click();await save()
        await page.locator('#q-input .choice').nth(0).click();await save()
        await page.locator('#q-input .choice').nth(1).click()
        await page.wait_for_function('__producer.Gui.dirty')
        await page.wait_for_function('!document.querySelector("#savebar [data-revert]").disabled')
        assert await page.locator('#savebar [data-revert]').is_enabled()
        await page.locator('#savebar [data-revert]').click();await clean()
        assert await page.evaluate('__producer.Gui.state.runtime.inputAssistMode')=='off'
        checks.append('actual Input Assist enablement dirty/save/revert/storage readback')
        await route('pipeline')
        await page.locator('.node[data-select-row=world]').click()
        prompt=page.locator('[data-stage-ins="세계관 AIDE"]')
        await prompt.fill('OWNER_PROMPT_READBACK');await save()
        await route('home');await route('pipeline')
        assert await prompt.input_value()=='OWNER_PROMPT_READBACK'
        await page.locator('.stage-detail[data-detail=world] [data-action=prompt-preview]').click()
        assert 'OWNER_PROMPT_READBACK' in await page.locator('.overlay.is-open').inner_text()
        await page.locator('.overlay.is-open').get_by_role('button',name='닫기',exact=True).click()
        checks.append('owned stage prompt editor/preview save and destination readback')
        await route('manage');await page.locator('[data-subtabs=mg] [data-subtab=adv]').click()
        placement=page.get_by_label('주입 위치',exact=True)
        choices=await placement.locator('option').evaluate_all('(xs)=>xs.map(x=>x.value)')
        previous=await placement.input_value()
        value=next(x for x in choices if x!=previous)
        await placement.select_option(value);await save()
        await route('home');await route('manage');await page.locator('[data-subtabs=mg] [data-subtab=adv]').click()
        assert await placement.input_value()==value
        assert '초안 + 분석 정보' not in await page.locator('.app').inner_text()
        assert await page.locator('#savebar [data-save]').count()==1
        checks.append('existing final injection placement save/readback and no private analysis option')
        await page.locator('[data-existing-response-options] summary').click()
        nsfw=page.get_by_label('NSFW 모드',exact=True)
        guidance=page.locator('[data-existing-response-field=nsfwGuidanceEnabled]')
        draft=page.get_by_label('소설 첫 초안 방식',exact=True)
        original=await nsfw.input_value()
        stored_before=await page.evaluate('JSON.stringify([...__storage])')
        bindings_before=await page.evaluate('Object.fromEntries(Object.entries(__producer.Gui.state.agents).map(([k,v])=>[k,v.presetName]))')
        await nsfw.select_option('soft')
        await page.locator('#savebar [data-revert]').click();await clean()
        assert await nsfw.input_value()==original
        assert await page.evaluate('JSON.stringify([...__storage])')==stored_before
        await nsfw.select_option('soft');await save()
        await guidance.uncheck();await save()
        settings=await page.evaluate('__producer.loadSettings()')
        assert settings['nsfwMode']=='soft' and settings['nsfwGuidanceEnabled'] is False
        assert await page.evaluate('Object.fromEntries(Object.entries(__producer.Gui.state.agents).map(([k,v])=>[k,v.presetName]))')==bindings_before
        assert 'NSFW GUIDANCE' not in await page.get_by_label('현재 NSFW 지침 미리보기',exact=True).input_value()
        await guidance.check();await save()
        assert 'NSFW GUIDANCE — SOFT' in await page.get_by_label('현재 NSFW 지침 미리보기',exact=True).input_value()
        await draft.select_option('input_inclusive');await save()
        await page.locator('.mode-switch [data-mode=rp]').click()
        await page.get_by_role('button',name='확인 · RP 모드 적용',exact=True).click()
        await save()
        await route('manage');await page.locator('[data-subtabs=mg] [data-subtab=adv]').click()
        await page.locator('[data-existing-response-options] summary').click()
        assert await draft.is_disabled()
        assert await page.evaluate('__producer.Gui.state.runtime.shadowDraftMode')=='author_directed'
        await draft.evaluate('(n)=>{n.value="classic";n.dispatchEvent(new Event("change",{bubbles:true}))}')
        assert await page.evaluate('__producer.Gui.state.runtime.shadowDraftMode')=='author_directed'
        assert await nsfw.input_value()=='soft' and await guidance.is_checked()
        await page.locator('.mode-switch [data-mode=novel]').click();await save()
        await route('manage');await page.locator('[data-subtabs=mg] [data-subtab=adv]').click()
        await page.locator('[data-existing-response-options] summary').click()
        assert await draft.input_value()=='input_inclusive' and await draft.is_enabled()
        assert await nsfw.input_value()=='soft' and await guidance.is_checked()
        checks.append('baseline NSFW mode/guidance/preview save/revert/readback; novel first-draft restoration and RP bypass guard')
        composer_storage_before=await page.evaluate('JSON.stringify([...__storage])')
        for outcome in ['cancel','submit']:
            await page.evaluate('()=>{window.__composition=__producer.showInputAssistComposer()}')
            await page.locator('.overlay.is-open textarea').fill('EXPLICIT_USER_COMPOSER_INPUT')
            await page.get_by_role('button',name='취소' if outcome=='cancel' else '진행',exact=True).click()
            result=await page.evaluate('__composition')
            assert result==(None if outcome=='cancel' else 'EXPLICIT_USER_COMPOSER_INPUT')
            assert await page.evaluate('JSON.stringify([...__storage])')==composer_storage_before
        checks.append('actual standalone Input Assist composer cancel/reopen/explicit input')
        await page.evaluate('()=>{window.__chatMutationCalls=0;for(const k of ["setChat","setChatFromIndex","sendChat","sendMessage"])risuai[k]=async()=>{window.__chatMutationCalls++;throw Error("CHAT MUTATION FORBIDDEN")}}')
        for method in ['debugAuthorDirectedInputChoicePicker','debugNovelInputChoicePicker']:
            choices=([{'id':'action_one','title':'Synthetic action','brief':'UNAPPROVED_PROPOSAL'}, {'id':'action_two','brief':'SECOND_PROPOSAL'}] if method=='debugAuthorDirectedInputChoicePicker' else [{'id':p,'perspective':p,'title':p,'input':'UNAPPROVED_PROPOSAL '+p} for p in ['user_focus','npc_focus','offscreen_focus']])
            async def picker():
                await page.evaluate('(x)=>{window.__choice=__SerialGradationAgentsForRP[x.method]("ORIGINAL_OWNER_INPUT",x.choices)}',{'method':method,'choices':choices})
                await page.locator('.overlay.is-open').wait_for()
            await picker()
            assert await page.locator('[data-input-choice-editor]').count()==len(choices)
            await page.keyboard.press('Escape')
            result=await page.evaluate('__choice')
            # Baseline GUI close() explicitly returns closed_original (headless
            # fallback returns original); preserve the GUI contract unchanged.
            assert result['action']=='closed_original' and result['content']=='ORIGINAL_OWNER_INPUT' and result['choice'] is None
            await picker()
            await page.locator('[data-input-choice-editor]').first.fill('EXPLICITLY_EDITED_CHOICE')
            await page.get_by_role('button',name='이 행동을 선택' if method=='debugAuthorDirectedInputChoicePicker' else '이 입력을 선택',exact=True).first.click()
            result=await page.evaluate('__choice')
            assert result['content']=='EXPLICITLY_EDITED_CHOICE' and result['edited'] is True
            assert result['choice']['id']==choices[0]['id']
            assert result['action']==('rp_action_choice_action_one' if method=='debugAuthorDirectedInputChoicePicker' else 'novel_choice_user_focus')
        assert await page.evaluate('__chatMutationCalls')==0
        checks.append('RP/novel candidate cancel preserves original; edited proposal requires explicit selection and never sends chat')
        for width,height in [(1440,1000),(390,844)]:
            await page.set_viewport_size({'width':width,'height':height})
            for name in ['pipeline','sources','results','manage']:
                await page.evaluate('(name)=>document.querySelector(".sidebar [data-go="+name+"]").click()',name)
                assert await page.locator('.page.is-active').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1')
            await page.screenshot(path=str(OUT/f'owner-{width}.png'))
        checks.append('standalone stage/skill/results/management destinations fit desktop/mobile')
        assert await page.evaluate('__networkCalls')==0
        assert errors==[],errors
        await browser.close()
    result={'sourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'checks':checks,'pageErrors':errors,'providerNetworkCalls':0,'boundary':'synthetic standalone host; existing functions exposed only for composer inspection; no actual RisuAI'}
    (OUT/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

if __name__=='__main__':asyncio.run(main())
