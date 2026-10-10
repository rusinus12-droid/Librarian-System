#!/usr/bin/env python3
"""Full deployed plugin in Chromium; only external host/model/storage are controlled.
This does not stand in for an installed RisuAI or live model evaluation.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,shutil,subprocess,sys
P=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
E=Path(sys.argv[2]) if len(sys.argv)>2 else Path('/mnt/data/fifth_browser')
E.mkdir(parents=True,exist_ok=True)
artifact=json.loads(subprocess.check_output(['node','-e','console.log(JSON.stringify(require(process.argv[1]).artifact()))',str(P/'tests/fixtures/libra_unified_runtime_fixture.cjs')]))
source=json.loads((P/'tests/fixtures/unified_vertical_source.json').read_text())
s=(P/'plugins/LIBRA.js').read_text();needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert needle in s
s=s.replace(needle,'  globalThis.__wm={Gui,LibraMemoryCore,renderSettingsGui,bookSelectPeopleSection,bookSelectWorldSection,bookSelectStorySection};\n'+needle)
results=[];errors=[];completed=False

def check(name,value,detail=None):
 results.append({'name':name,'ok':bool(value),'detail':detail})
 if not value:raise AssertionError(name+': '+str(detail))
def latest(p):return p.evaluate('()=>__wm.LibraMemoryCore.peekSnapshot().continuityState')
def close_jobs(p):
 for item in p.locator('.canonical-job-overlay').all():
  if item.is_visible():item.get_by_role('button',name='닫기',exact=True).click()
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  p=browser.new_page(viewport={'width':1440,'height':1000});p.set_default_timeout(12000);p.on('pageerror',lambda e:errors.append(str(e)))
  p.set_content('<html lang="ko"><body></body></html>');p.add_script_tag(content=(P/'tests/browser/libra_writer_host.js').read_text())
  p.evaluate('''({source,artifact})=>{__writerHost.chat.message=source.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));__writerHost.chat.messages=__writerHost.chat.message;__writerHost.artifact=artifact;const old=risuai.getArgument;risuai.getArgument=async k=>['enable_character_ito','enable_world_ito','enable_plot_ito'].some(x=>k.includes(x))?'false':old(k);risuai.runLLMModel=async()=>{__writerHost.calls.model++;return {type:'success',result:JSON.stringify(__writerHost.artifact)}};}''',{'source':source,'artifact':artifact})
  p.add_script_tag(content=s);p.wait_for_function('!!window.__LIBRA__')
  p.evaluate('''async()=>{const c=await __LIBRA__.getLibraMemorySettings();await __LIBRA__.saveLibraMemorySettings({...c,memoryEngine:'unified',enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false});}''')
  run=p.evaluate('async()=>await __LIBRA__.runManualColdStart()');check('public typed five-turn job succeeds',run.get('completed')==1,run.get('failures'));close_jobs(p)
  p.evaluate('async()=>await __LIBRA__.openSettingsGui()');close_jobs(p)
  p.evaluate('__wm.bookSelectPeopleSection("characters")');article=p.locator('[data-current-head-article="characters"]');article.wait_for()
  article.get_by_role('button',name='수정',exact=True).click();editor=p.locator('[data-world-correction-editor="characters"]');editor.wait_for()
  name=editor.locator('.sga-field').filter(has=p.locator('label',has_text='이름')).first
  # The existing fieldNode's label is a div, not a native label; use the first profile input.
  editor.locator('input').first.fill('민아 선배');editor.locator('textarea').first.fill('민아\n기록 담당')
  editor.get_by_role('button',name='교정 저장',exact=True).click();p.wait_for_function('!__wm.Gui.worldManagerSaving && !__wm.Gui.worldManagerEditDraft')
  h=latest(p);mina=next(x for x in h['characters'] if x['name']=='민아 선배');check('GUI name and aliases are saved into typed identity',set(['민아','기록 담당']).issubset(set(mina['aliases'])))
  registry=p.evaluate('()=>[...__writerHost.values.values()].map(v=>{try{return JSON.parse(v)}catch{return null}}).filter(v=>v?.schema==="libra.entity_registry.v1")')
  # Public next analysis, not a hand-written Registry assertion, verifies persistence below.
  check('renaming does not make a model request',p.evaluate('__writerHost.calls.model')==1)
  article=p.locator('[data-current-head-article="characters"]');merge=article.locator('[data-world-identity-merge="characters"]');merge.locator('summary').click()
  target=next(x for x in h['characters'] if x['name']=='준호');merge.get_by_label('병합 후 남길 항목').select_option(target['id']);merge.get_by_role('button',name='병합 내용 확인',exact=True).click()
  p.wait_for_function('()=>[...document.querySelectorAll("button")].some(b=>b.textContent==="선택한 내용으로 병합 확정"&&!b.disabled)')
  p.screenshot(path=str(E/'merge_preview_1440.png'))
  check('merge preview contains source and destination names','민아 선배 → 준호' in merge.inner_text(),merge.inner_text()[:500])
  for sel in merge.locator('.sga-form-grid select').all():
   values=sel.locator('option').evaluate_all('(ns)=>ns.map(n=>n.value).filter(Boolean)')
   sel.select_option('source' if 'source' in values else 'drop' if 'drop' in values else values[0])
  merge.get_by_role('button',name='선택한 내용으로 병합 확정',exact=True).click();p.wait_for_function('()=>__wm.LibraMemoryCore.peekSnapshot().continuityState.characters.length===2')
  h=latest(p);check('GUI merge removes only the duplicate current identity',len(h['characters'])==2 and any(x['id']==target['id'] for x in h['characters']))
  check('directional relationship endpoint is rebound',h['relationships'][0]['subjectId']==target['id'])
  check('GUI merge calls no model',p.evaluate('__writerHost.calls.model')==1)
  p.evaluate('__wm.bookSelectPeopleSection("relationships")');article=p.locator('[data-current-head-article="relationships"]');article.wait_for()
  for width in [1440,390]:
   p.set_viewport_size({'width':width,'height':1000 if width>600 else 844});p.wait_for_timeout(100);p.screenshot(path=str(E/f'merged_relationship_{width}.png'))
   check(f'merged relationship at {width}px fits viewport',article.evaluate('(n)=>{const b=n.getBoundingClientRect();return b.right<=innerWidth+1&&b.left>=-1&&n.scrollWidth<=n.clientWidth+1}'))
  p.set_viewport_size({'width':1440,'height':1000})
  p.evaluate('''()=>{const extra=__writerHost.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`}));__writerHost.chat.message.push(...extra);const a=structuredClone(__writerHost.artifact);for(const x of [...a.entities,...a.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\\d+)/,(_,n)=>`t${Number(n)+5}`);__writerHost.artifact=a;}''')
  run=p.evaluate('async()=>await __LIBRA__.runManualColdStart()');close_jobs(p);check('next five-turn public analysis retains merged identity',run.get('completed')==1 and len(latest(p)['characters'])==2,run.get('failures'))
  saved=p.evaluate('''async()=>{const before=JSON.stringify([...__writerHost.values]);const calls=__writerHost.calls.model;const c=await __LIBRA__.getResponseContext({currentInput:'현재 관계를 확인한다.'});const checked=await __LIBRA__.validateResponseContext(c);return {same:before===JSON.stringify([...__writerHost.values]),calls:__writerHost.calls.model-calls,valid:checked.ok,refs:c.canonicalRefs.length};}''')
  check('browser ResponseContext is sealed and read-only',saved=={'same':True,'calls':0,'valid':True,'refs':2},saved)
  check('zero unhandled script errors',not errors,errors)
  completed=True;browser.close()
finally:
 report={'test':'libra_unified_fifth_browser','completed':completed,'boundary':'full production plugin in Chromium; controlled external host/model/storage; not installed RisuAI','passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors,'results':results}
 (E/'RESULTS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False))
