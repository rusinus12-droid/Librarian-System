"""Production LIBRA JS in Chromium. Only host/model/storage boundaries are synthetic.
No RisuAI installation or live model is involved. Private handles are test-only.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import shutil,json,subprocess,sys
P=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
E=Path(sys.argv[2]) if len(sys.argv)>2 else P.parent.parent/'UNIFIED_WORLD_BROWSER'
E.mkdir(parents=True,exist_ok=True)
artifact=json.loads(subprocess.check_output(['node','-e',"console.log(JSON.stringify(require(process.argv[1]).artifact()))",str(P/'tests/fixtures/libra_unified_runtime_fixture.cjs')]))
source=json.loads((P/'tests/fixtures/unified_vertical_source.json').read_text())
s=(P/'plugins/LIBRA.js').read_text();needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert needle in s
s=s.replace(needle,"  globalThis.__wm={Gui,LibraMemoryCore,renderSettingsGui,bookSelectPeopleSection,bookSelectWorldSection,bookSelectStorySection};\n"+needle)
results=[];errors=[];completed=False
def check(name,value,detail=None):
 results.append({'name':name,'ok':bool(value),'detail':detail})
 if not value:raise AssertionError(name+': '+str(detail))
def latest(p):return p.evaluate('()=>__wm.LibraMemoryCore.peekSnapshot().continuityState')
def run(p):
 result=p.evaluate('async()=>await __LIBRA__.runManualColdStart()')
 check('public manual cold start completed',result.get('completed')==1,result.get('failures'))
 if p.locator('.canonical-job-overlay').count():p.locator('.canonical-job-overlay').get_by_role('button',name='닫기',exact=True).click()
 return result
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  p=browser.new_page(viewport={'width':1440,'height':1000});p.set_default_timeout(12000);p.on('pageerror',lambda e:errors.append(str(e)))
  p.set_content('<html lang="ko"><body></body></html>');p.add_script_tag(content=(P/'tests/browser/libra_writer_host.js').read_text())
  p.evaluate('''({source,artifact})=>{__writerHost.chat.message=source.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));__writerHost.chat.messages=__writerHost.chat.message;__writerHost.artifact=artifact;__writerHost.originalArtifact=structuredClone(artifact);__writerHost.requests=[];const old=risuai.getArgument;risuai.getArgument=async k=>['enable_character_ito','enable_world_ito','enable_plot_ito'].some(x=>k.includes(x))?'false':old(k);risuai.runLLMModel=async arg=>{__writerHost.calls.model++;__writerHost.requests.push(arg.messages);return {type:'success',result:JSON.stringify(__writerHost.artifact)}};}''',{'source':source,'artifact':artifact})
  p.add_script_tag(content=s);p.wait_for_function('!!window.__LIBRA__')
  p.evaluate('''async()=>{const s=await __LIBRA__.getLibraMemorySettings();await __LIBRA__.saveLibraMemorySettings({...s,memoryEngine:'unified',enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false});}''')
  run(p);p.evaluate('async()=>await __LIBRA__.openSettingsGui()');p.locator('.canonical-job-overlay').get_by_role('button',name='닫기',exact=True).click()
  p.evaluate('__wm.bookSelectPeopleSection("relationships")');p.locator('[data-current-head-article="relationships"]').wait_for()
  article=p.locator('[data-current-head-article="relationships"]');check('directional prose is the article lead','신뢰한다고' in article.locator('.libra-current-article-lead').inner_text())
  check('actual source quote is displayed','민아만 암호를' in article.locator('.libra-current-evidence').inner_text())
  article.get_by_role('button',name='수정',exact=True).click();editor=p.locator('[data-world-correction-editor="relationships"]');editor.wait_for()
  check('relationship editor starts with text, not object string',editor.locator('textarea').input_value()=='신뢰한다고 명시적으로 말했다')
  editor.locator('textarea').fill('실력은 신뢰하지만 사적인 사정에는 거리를 둔다.');editor.get_by_role('button',name='교정 저장',exact=True).click();p.wait_for_function('!__wm.Gui.worldManagerSaving && !__wm.Gui.worldManagerEditDraft')
  check('actual GUI save updates Head via journal',latest(p)['relationships'][0]['state']['value']=='실력은 신뢰하지만 사적인 사정에는 거리를 둔다.')
  check('GUI correction made no model request',p.evaluate('__writerHost.calls.model')==1)
  for width in [1440,390]:
   p.set_viewport_size({'width':width,'height':1000 if width>600 else 844});p.wait_for_timeout(100);p.screenshot(path=str(E/f'relationship_{width}.png'))
   check(f'relationship/{width} article fits horizontal viewport',article.evaluate('(n)=>{const b=n.getBoundingClientRect();return b.right<=innerWidth+1&&b.left>=-1&&n.scrollWidth<=n.clientWidth+1}'))
  p.set_viewport_size({'width':1440,'height':1000})
  p.evaluate('__wm.bookSelectPeopleSection("characters")');p.locator('[data-current-head-article="characters"]').wait_for()
  person=p.locator('[data-current-head-article="characters"]');check('current location shows name instead of ID','서재' in person.locator('.libra-current-facts').inner_text())
  person.get_by_role('button',name='수정',exact=True).click();editor=p.locator('[data-world-correction-editor="characters"]');editor.wait_for()
  check('character simple editor uses actual available location identities','서재' in editor.locator('select').first.inner_text())
  editor.get_by_role('button',name='취소',exact=True).click()
  p.evaluate('__wm.bookSelectStorySection("structure")');p.locator('[data-unified-narrative="current"]').wait_for()
  narrative=p.locator('[data-unified-narrative="current"]');check('unified narrative has no future Arc/Lock panels',not narrative.get_by_role('heading',name='Arc',exact=True).count() and not narrative.get_by_role('heading',name='Lock',exact=True).count())
  narrative.get_by_role('button',name='수정',exact=True).click();editor=p.locator('[data-world-correction-editor="narrative_thread"]');editor.wait_for()
  editor.locator('textarea').nth(1).fill('허가자가 확인되지 않아 공연 준비가 막혀 있다.');editor.get_by_role('button',name='교정 저장',exact=True).click();p.wait_for_function('!__wm.Gui.worldManagerSaving && !__wm.Gui.worldManagerEditDraft')
  check('current interpretation persisted through public GUI correction',latest(p)['narrative']['threads'][0]['interpretation'].endswith('막혀 있다.'))
  p.screenshot(path=str(E/'narrative_1440.png'))
  p.evaluate('__wm.bookSelectWorldSection("guide")');p.locator('[data-book-world-projection="guide"]').wait_for()
  world=p.locator('[data-book-world-projection="guide"]');check('world guide translates stable reference IDs',not any(t in world.inner_text() for t in ['ce_person_','ce_world_']))
  p.screenshot(path=str(E/'world_1440.png'))
  # Add a later canonical using the real public batch entry. Then edit only T5.
  p.evaluate('''()=>{const extra=__writerHost.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`}));__writerHost.chat.message.push(...extra);const a=structuredClone(__writerHost.originalArtifact);for(const x of [...a.entities,...a.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\\d+)/,(_,n)=>`t${Number(n)+5}`);__writerHost.artifact=a;}''');run(p)
  p.evaluate('''()=>{const manifestKey=[...__writerHost.values.keys()].find(k=>k.startsWith('libra')&&k.endsWith(':manifest'));const m=JSON.parse(__writerHost.values.get(manifestKey));__writerHost.laterBefore=__writerHost.values.get(m.memories['6'].key);const q='서재에서 준호가 열쇠를 지호에게 건넸지만 지호는 민아에게 돌려주지 않았다. 오늘 반환 약속은 아직 이행되지 않았다. 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.';__writerHost.chat.message[9].data=q;const a=structuredClone(__writerHost.originalArtifact);for(const x of [...a.entities,...a.facts])for(const e of x.evidenceSpans)if(e.ref==='t5-a')e.quote=q;a.facts.find(f=>f.tempFactId==='f11').values.holderRef='jiho';a.facts.find(f=>f.tempFactId==='f11').text='지호는 열쇠를 민아에게 아직 반환하지 않았다.';a.facts.find(f=>f.tempFactId==='f12').values.thread.status='open';a.facts.find(f=>f.tempFactId==='f12').text='오늘 반환 약속은 아직 이행되지 않았다.';__writerHost.artifact=a;window.pending=__LIBRA__.reviewSourceEdits();}''')
  modal=p.locator('#memorySuiteSourceReview');modal.wait_for();check('actual own-iframe review identifies both direct and dependent ranges',modal.locator('article').count()==2)
  p.locator('[data-sr-none]').click();p.locator('[data-sr-key="1"]').check();p.screenshot(path=str(E/'selected_source_edit.png'));p.locator('[data-sr-approve]').click();p.wait_for_function('!document.querySelector("#memorySuiteSourceReview")');done=p.evaluate('()=>pending')
  check('selected source edit completes',done.get('ok') is True,done)
  check('only one selected segment creates model request',p.evaluate('__writerHost.calls.model')==3,p.evaluate('__writerHost.calls.model'))
  check('unselected later canonical remains byte-identical',p.evaluate('''()=>{const k=[...__writerHost.values.keys()].find(k=>k.startsWith('libra')&&k.endsWith(':manifest'));const m=JSON.parse(__writerHost.values.get(k));return __writerHost.values.get(m.memories['6'].key)===__writerHost.laterBefore;}'''))
  h=latest(p);check('T10 latest return survives the edited T5 replay',h['throughTurn']==10 and h['world'][next(i for i,r in enumerate(h['world']) if r['name']=='은빛 열쇠')]['state']['holderRef']==next(r['id'] for r in h['characters'] if r['name']=='민아'))
  check('old user correction is suspended when source basis changes',p.evaluate('async()=>{const j=await __LIBRA__.getWorldManagerCorrections();return j.records.some(r=>r.status==="suspended");}'))
  check('zero unhandled browser script errors',not errors,errors)
  completed=True;browser.close()
finally:
 report={'completed':completed,'test':'libra_unified_world_v2_browser','boundary':'full production plugin in Chromium; synthetic host/model/storage; not real RisuAI','passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors,'results':results}
 (E/'RESULTS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False))
