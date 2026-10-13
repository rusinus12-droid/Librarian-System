"""Unmodified official Full public open; synthetic host header/nav fit audit."""
from pathlib import Path
import os,json,hashlib
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[2]
artifact=Path(os.environ['RETRACE_HEADER_FULL']);source=artifact.read_bytes()
OUT=Path(os.environ['RETRACE_HEADER_OUT']);OUT.mkdir(parents=True,exist_ok=True)
widths=[320,360,375,390,414,640,641,900,901];results=[];failures=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in widths:
  page=browser.new_page(viewport={'width':width,'height':844});page.set_content('<!doctype html><meta charset="utf-8"><body></body>')
  page.add_script_tag(content=(P/'tests/browser/hayaku_browser_host.js').read_text())
  page.add_script_tag(content=source.decode());page.wait_for_function('!!globalThis.__RETRACE?.showUi');page.evaluate('globalThis.__RETRACE.showUi()')
  page.wait_for_selector('#overviewBody .owner');page.screenshot(path=str(OUT/f'public_full_header_{width}.png'))
  metrics=page.evaluate("""()=>{const r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}},name=document.querySelector('.brand__name'),status=document.querySelector('#globalStatus'),menu=document.querySelector('.topbar [data-menu]'),range=document.createRange();range.selectNodeContents(name);const a=r(name),b=r(status),c=r(menu),t=range.getBoundingClientRect();return {viewport:innerWidth,name:name.textContent,nameRect:a,nameTextWidth:t.width,status:status.textContent,statusRect:b,statusLabel:status.getAttribute('aria-label'),menuRect:c,nameVisible:t.width<=a.width+1&&a.right<=b.x,headerInside:c.right<=document.querySelector('.app').getBoundingClientRect().right&&a.x>=document.querySelector('.app').getBoundingClientRect().left,noOverlap:a.right<=b.x&&b.right<=c.x,statusInside:b.y>=document.querySelector('.topbar').getBoundingClientRect().top&&b.bottom<=document.querySelector('.topbar').getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth>innerWidth,bottom:[...document.querySelectorAll('.tabbar [data-tab]')].map(el=>({tab:el.dataset.tab,rect:r(el),visible:getComputedStyle(el.closest('.tabbar')).display!=='none'}))}}""")
  if not(metrics['name']=='RE:TRACE' and metrics['nameVisible'] and metrics['headerInside'] and metrics['noOverlap'] and metrics['statusInside'] and not metrics['overflow']):failures.append({'width':width,'reason':'header_fit','metrics':metrics})
  if not failures:
   status=page.locator('#globalStatus');status.focus();assert status.evaluate('(el)=>document.activeElement===el');assert status.get_attribute('aria-label') and status.get_attribute('title')
  page.locator('.topbar [data-menu]').click();assert page.locator('.menu__panel').is_visible();page.locator('.topbar [data-menu]').click()
  for item in metrics['bottom']:
   if not item['visible']:continue
   button=page.locator('.tabbar [data-tab="'+item['tab']+'"]');rect=button.bounding_box();assert rect and rect['width']>=44 and rect['height']>=44
   hit=button.evaluate('(el)=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}');assert hit, item
   button.click();assert button.get_attribute('aria-current')=='page'
   alternate=next(x['tab'] for x in metrics['bottom'] if x['tab']!=item['tab']);page.locator('.tabbar [data-tab="'+alternate+'"]').click();assert button.get_attribute('aria-current')!='page'
   button.focus();page.keyboard.press('Enter');assert button.get_attribute('aria-current')=='page'
  metrics['bottomHitAndKeyboard']=True;results.append(metrics);page.close()
 browser.close()
report={'sourceSHA256':hashlib.sha256(source).hexdigest(),'artifact':str(artifact),'viewports':results,'failures':failures,'boundary':'unmodified official Full, public showUi, synthetic host; no CSS injections or product source hooks'}
(OUT/'RESULTS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False));assert not failures,failures
