"""Whole shipped plugin, synthetic Risu host and stored canonical/Micro fixture.

No live provider calls. Raw snapshots and screenshots stay outside the repository.
LIBRA_GUI_SOURCE selects a readable or minified artifact without source rewriting.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(os.environ.get('LIBRA_GUI_SOURCE', ROOT/'PROGRAM/plugins/LIBRA.js'))
OUT = Path(os.environ.get('LIBRA_WINDOW_OUTPUT', tempfile.mkdtemp(prefix='libra-window-')))
OUT.mkdir(parents=True, exist_ok=True)
seed_code = r"""
const {fixture}=require('./PROGRAM/tests/fixtures/libra_memory_graph_reader_fixture.cjs');
(async()=>{const x=await fixture();try{const f=x.f;
 await f.r.api.saveEmbeddingSettings({...await f.r.api.getEmbeddingSettings(),enabled:false});
 console.log(JSON.stringify({values:[...f.r.values],character:f.character,chat:f.chat}));
}finally{await x.cleanup();}})().catch(e=>{console.error(e);process.exitCode=1});
"""
seed = json.loads(subprocess.run(['node', '-e', seed_code], cwd=ROOT, check=True, text=True, capture_output=True).stdout)
checks = []
errors = []

def check(name, condition, detail=None):
    checks.append({'name': name, 'passed': bool(condition), 'detail': detail})
    assert condition, (name, detail)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(10000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.set_content("<html><body style='margin:0;background:#29333c;color:white'><h1>Chat workspace</h1><iframe id='plugin' title='LIBRA' style='position:fixed;inset:0;border:0;width:100%;height:100%;display:none'></iframe></body></html>")
        frame = page.frames[1]
        frame.add_script_tag(path=str(ROOT/'PROGRAM/tests/browser/libra_writer_host.js'))
        frame.evaluate(r"""seed=>{
          const h=__writerHost;h.values.clear();for(const [k,v]of seed.values)h.values.set(k,v);
          Object.assign(h.chat,seed.chat);Object.assign(h.character,seed.character);h.character.chats=[h.chat];h.hooks={};
          risuai.addRisuReplacer=async(type,fn)=>{h.hooks[type]=fn;return true};
          const show=risuai.showContainer,hide=risuai.hideContainer;
          risuai.showContainer=async mode=>{await show(mode);parent.document.querySelector('#plugin').style.display='block'};
          risuai.hideContainer=async()=>{await hide();parent.document.querySelector('#plugin').style.display='none'};
        }""", seed)
        frame.add_script_tag(content=SOURCE.read_text())
        frame.wait_for_function('!!window.__LIBRA__')
        frame.evaluate('__LIBRA__.openSettingsGui()')
        frame.locator('[data-memory-progress]').wait_for()
        # Dismiss the genuine first-run helper without running a connection test.
        frame.wait_for_timeout(200)
        if frame.locator('[data-libra-quick-dialog]').count():
            frame.locator('[data-libra-quick-dialog] .dialog__actions button').click()
        for w, h in [(2556, 1363), (1440, 1000), (900, 1024), (640, 900), (390, 844), (320, 640), (844, 390)]:
            page.set_viewport_size({'width': w, 'height': h})
            g = frame.evaluate("""()=>{const r=document.querySelector('.frame').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,overflow:document.documentElement.scrollWidth-innerWidth,bg:[document.documentElement,document.body,document.querySelector('#sga-rp-gui-root'),document.querySelector('.stage')].map(n=>getComputedStyle(n).backgroundColor)}}""")
            check(f'{w}x{h} centered', abs(g['x']+g['w']/2-w/2)<=1 and abs(g['y']+g['h']/2-h/2)<=1, g)
            check(f'{w}x{h} fits', g['w']<=w-30 and g['h']<=h-30 and g['overflow']<=1, g)
            check(f'{w}x{h} transparent exterior', all(x=='rgba(0, 0, 0, 0)' for x in g['bg']), g)
            close = frame.locator('.topbar > [data-close-gui]')
            check(f'{w} dedicated close visible', close.is_visible())
            close.click()
            check(f'{w} closes host container', page.locator('#plugin').evaluate("n=>n.style.display==='none'"))
            frame.evaluate('__LIBRA__.openSettingsGui()')
            frame.locator('[data-memory-progress]').wait_for()
        page.set_viewport_size({'width': 1440, 'height': 1000})
        frame.get_by_role('button', name='전달 근거 보기 →', exact=True).click()
        check('no request never substitutes stored Micro as delivery', frame.locator('[data-final-evidence]').get_attribute('data-delivery-status')=='unavailable')
        frame.locator('[data-final-evidence]').get_by_role('button', name='닫기', exact=True).click()
        # Drive the real response hook against the same physically stored records.
        output = frame.evaluate("__writerHost.hooks.beforeRequest([{role:'user',content:'민아 은빛 열쇠 준호 서재 기록회 현재 상황'}],'model')")
        receipt = frame.evaluate('__LIBRA__.getLastMemoryRecallViewer()')
        check('real request produces verified receipt', receipt.get('finalVerification', {}).get('status')=='verified', receipt.get('finalVerification'))
        used = [r for r in receipt['rows'] if r.get('injected') is True]
        families = {r['family'] for r in used}
        check('actual receipt includes canonical and Micro evidence', {'canonical','micro'}<=families, sorted(families))
        frame.evaluate('__LIBRA__.openSettingsGui()')
        frame.get_by_role('button', name='전달 근거 보기 →', exact=True).click()
        evidence = frame.locator('[data-final-evidence]')
        check('Home opens delivery dialog and stays on Home', evidence.is_visible() and frame.locator('.page.is-active').get_attribute('data-page')=='desk')
        check('every actually delivered item is grouped', evidence.locator('[data-evidence-family] details').count()==len(used))
        for row in used:
            check('receipt text really reached the response hook', row['text'] in '\n'.join(r.get('content','') for r in output))
        for label in ['정본 기억','Micro 기억']:
            check(label+' section visible', evidence.locator(f'[data-evidence-family="{label}"]').count()==1)
        evidence.locator('[data-evidence-family] details summary').first.click()
        check('evidence details show exact receipt excerpt', evidence.locator('.evidence-text').first.inner_text() in [r['text'].strip() for r in used])
        page.screenshot(path=str(OUT/'delivery-desktop.png'))
        page.set_viewport_size({'width':390,'height':844})
        page.screenshot(path=str(OUT/'delivery-mobile.png'))
        check('mobile evidence fits dialog', evidence.locator('.dialog').evaluate('n=>n.scrollWidth<=n.clientWidth+1'))
        page.keyboard.press('Escape')
        page.set_viewport_size({'width':1440,'height':1000})
        check('central duplicate model label removed', frame.locator('[data-memory-model] > strong').count()==0)
        refresh=frame.get_by_role('button',name='상태 새로고침',exact=True)
        check('Micro refresh uses suite button styling', 'btn' in refresh.get_attribute('class').split())
        def settings(group, section):
            frame.locator('.topbar [data-go=settings]').click()
            frame.locator(f'.setnav [data-subtab="{group}"]').click()
            if frame.locator('[data-product-settings-section]').get_attribute('data-product-settings-section')!=section:
                label={'embedding':'임베딩 연결','source_edits':'분석할 내용'}[section]
                frame.locator('[data-product-settings-section] > nav.tabs').get_by_role('tab',name=label,exact=True).click()
            panel=frame.locator(f'[data-product-settings-section="{section}"]');panel.wait_for();return panel
        embed=settings('ai','embedding')
        check('one model field and label', embed.locator('[data-embedding-field=model]').count()==1 and embed.get_by_text('임베딩 모델',exact=True).count()==1)
        check('one endpoint field and label', embed.locator('[data-embedding-field=url]').count()==1 and embed.get_by_text('Endpoint URL',exact=True).count()==1)
        check('one settings save bar', embed.locator('[data-book-save-bar]').count()==1)
        embed.locator('[data-embedding-field=provider]').select_option('voyageai')
        embed.locator('[data-embedding-field=model]').fill('voyage-4-large')
        embed.locator('[data-embedding-field=url]').fill('https://api.voyageai.com/v1/embeddings')
        embed.locator('[data-settings-room-save]').click()
        frame.wait_for_function("async()=> (await __LIBRA__.getEmbeddingSettings()).model==='voyage-4-large'")
        check('real embedding save preserves edited URL', frame.evaluate('async()=> (await __LIBRA__.getEmbeddingSettings()).url')=='https://api.voyageai.com/v1/embeddings')
        embed.get_by_role('button',name='빠른 연결 열기…',exact=True).click()
        quick=frame.locator('[data-libra-quick-dialog]')
        check('quick connect has no literal null nodes', quick.evaluate("n=>{const w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);for(let t;t=w.nextNode();)if(t.textContent.trim()==='null')return false;return true}"))
        page.keyboard.press('Escape')
        rules=settings('ref','source_edits')
        controls=rules.locator('[data-source-input-controls]');controls.wait_for()
        controls.locator('[data-source-input-add]').click()
        check('Add tag focuses editable empty row', frame.evaluate("document.activeElement.hasAttribute('data-rule-value')"))
        row=controls.locator('[data-source-input-row]').last
        row.locator('[data-rule-value]').fill('my_custom_tag')
        controls.locator('[data-source-input-apply]').click()
        frame.wait_for_function("__LIBRA__.getSourceEditRules().ignoredTags.includes('my_custom_tag')")
        check('new custom tag persisted', True)
        row=controls.locator('[data-source-input-row]').filter(has=frame.locator('[data-rule-value]')).filter(has=frame.locator('textarea')).filter(has_text='태그 이름 또는 XML 예시')
        custom=controls.locator('[data-source-input-row]').filter(has=frame.locator('[data-rule-value]')).all()
        target=next(r for r in custom if r.locator('[data-rule-value]').input_value()=='my_custom_tag')
        target.locator('[data-rule-delete]').click()
        controls.locator('[data-source-input-undo]').click()
        check('deleted tag restored before apply', any(n.input_value()=='my_custom_tag' for n in controls.locator('[data-rule-value]').all()))
        controls.locator('[data-source-input-defaults]').click()
        check('defaults are a draft until Apply', 'my_custom_tag' in frame.evaluate('__LIBRA__.getSourceEditRules().ignoredTags'))
        controls.locator('[data-source-input-apply]').click()
        frame.wait_for_function("!__LIBRA__.getSourceEditRules().ignoredTags.includes('my_custom_tag')")
        check('default rules can be restored and persisted', 'lb-xnai' in frame.evaluate('__LIBRA__.getSourceEditRules().ignoredTags'))
        check('no provider or chat sending from GUI', frame.evaluate('__writerHost.calls.model===0&&__writerHost.calls.network===0&&__writerHost.calls.send.length===0'))
        check('no browser errors', not errors, errors)
    finally:
        (OUT/'results.json').write_text(json.dumps({'source':str(SOURCE),'checks':checks,'errors':errors},ensure_ascii=False,indent=2))
        browser.close()
print(json.dumps({'passed':len(checks),'source':str(SOURCE),'output':str(OUT)},ensure_ascii=False))
