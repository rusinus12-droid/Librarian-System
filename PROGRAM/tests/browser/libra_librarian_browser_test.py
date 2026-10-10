#!/usr/bin/env python3
"""Actual LIBRA deployment code and DOM; controlled host/provider, not RisuAI installation."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,shutil,subprocess,sys
P=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
E=Path(sys.argv[2]) if len(sys.argv)>2 else Path('/mnt/data/implementation08/evidence/browser08');E.mkdir(parents=True,exist_ok=True)
a=json.loads(subprocess.check_output(['node','-e','console.log(JSON.stringify(require(process.argv[1]).artifact()))',str(P/'tests/fixtures/libra_unified_runtime_fixture.cjs')]))
source=json.loads((P/'tests/fixtures/unified_vertical_source.json').read_text())
s=(P/'plugins/LIBRA.js').read_text();needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert needle in s
s=s.replace(needle,'  globalThis.__audit={Gui,LibraMemoryCore,renderSettingsGui,bookNavigate,selectBookSettingsRoomSection,buildLibrarianAnalyzerPanel,buildLibrarianConfigurationReviewPanel,bookSelectPeopleSection,bookSelectStorySection};\n'+needle)
results=[];errors=[];completed=False

def check(name,value,detail=None):
 results.append({'name':name,'ok':bool(value),'detail':detail})
 if not value:raise AssertionError(name+': '+str(detail))
def close_jobs(p):
 p.wait_for_function('()=>!__audit.Gui.canonicalJobRenderTimer')
 for n in p.locator('.canonical-job-overlay').all():
  if n.is_visible():n.get_by_role('button',name='닫기',exact=True).click()
def make_page(b,custom=None):
 p=b.new_page(viewport={'width':1440,'height':1100});p.set_default_timeout(15000);p.on('pageerror',lambda e:errors.append(str(e)));p.on('dialog',lambda d:d.accept())
 p.set_content('<html lang="ko"><body></body></html>');p.add_script_tag(content=(P/'tests/browser/libra_writer_host.js').read_text())
 p.evaluate('''({source,a,custom})=>{__writerHost.chat.message=source.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));__writerHost.artifact=a;__writerHost.calls.requests=[];const old=risuai.getArgument;risuai.getArgument=async k=>custom&&k==='character_prompt_custom'?custom:old(k);risuai.runLLMModel=async(arg)=>{__writerHost.calls.model++;__writerHost.calls.requests.push(arg);return {type:'success',result:JSON.stringify(__writerHost.artifact)}};}''',{'source':source,'a':a,'custom':custom})
 p.add_script_tag(content=s);p.wait_for_function('!!window.__LIBRA__');return p
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  p=make_page(b)
  cfg=p.evaluate('async()=>await __LIBRA__.getLibraMemorySettings()');check('default is Librarian, no opt-in required',cfg['memoryEngine']=='librarian')
  p.evaluate('async()=>await __LIBRA__.openSettingsGui()');p.evaluate('__audit.selectBookSettingsRoomSection("agents")');p.wait_for_selector('[data-librarian-analyzer="single"]')
  text=p.locator('[data-librarian-analyzer="single"]').inner_text()
  check('one visible memory analyzer and explicit separate call counts','LLM 1회' in text and '추가 LLM 0회' in text and 'ito' not in text and 'Observer' not in text,text[:300])
  for w in [1440,1024,768,390]:
   p.set_viewport_size({'width':w,'height':1050});p.wait_for_timeout(100);p.screenshot(path=str(E/f'librarian_settings_{w}.png'))
   check(f'Librarian settings fits {w}px',p.locator('[data-librarian-analyzer="single"]').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'))
  p.set_viewport_size({'width':1440,'height':1100})
  enabled=p.get_by_label('Librarian 기억 분석 사용',exact=True);enabled.uncheck();p.locator('[data-librarian-save]').click();p.wait_for_timeout(150)
  check('explicit OFF persists through GUI save',p.evaluate('async()=>(await __LIBRA__.getLibraProviderConfig()).enableLibrarian===false'))
  out=p.evaluate('async()=>await __LIBRA__.runManualColdStart()');check('OFF does not dispatch',p.evaluate('__writerHost.calls.model')==0,out)
  enabled=p.get_by_label('Librarian 기억 분석 사용',exact=True);enabled.check();p.locator('[data-librarian-save]').click();p.wait_for_timeout(150)
  # A failed disabled job is explicitly retried by user. No event-driven retry is granted.
  out=p.evaluate('async()=>await __LIBRA__.retryFailedMemoryAnalysis()');close_jobs(p)
  if out.get('completed')!=1:out=p.evaluate('async()=>await __LIBRA__.runManualColdStart()');close_jobs(p)
  check('actual user job commits one memory with one model call',out.get('completed')==1 and p.evaluate('__writerHost.calls.model')==1,out)
  p.evaluate('__audit.selectBookSettingsRoomSection("state")');p.wait_for_selector('[data-librarian-local-state="true"]');t=p.locator('[data-librarian-local-state]').inner_text()
  check('state workspace is local-only, no editable retired agents','0회' in t and p.locator('[data-librarian-local-state] input').count()<=1 and '상태 추적 멀티 파이프라인' not in t)
  m=p.evaluate('()=>__audit.LibraMemoryCore.peekSnapshot().memories[0]')
  chain=p.evaluate('async m=>await __LIBRA__.getCanonicalEvidenceChain({memoryId:m.memoryId,revision:m.revision})',m)
  layers={n['layer'] for n in chain['nodes']}
  check('actual v4 evidence shows facts and bindings, not invented Observer',{'source','fact','binding','head'}<=layers and not {'observation','verification','admission'}&layers,sorted(layers))
  for page in ['desk','memory','people','world','story']:
   p.evaluate('page=>__audit.bookNavigate(page)',page);p.wait_for_timeout(200)
   for w in [1440,390]:
    p.set_viewport_size({'width':w,'height':1050});p.wait_for_timeout(120);p.screenshot(path=str(E/f'{page}_{w}.png'))
    check(f'{page} read view fits {w}px',p.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
  check('all reads add zero model calls',p.evaluate('__writerHost.calls.model')==1)
  p.close()
  p=make_page(b,'인물의 지식 경계를 보존하라.');preview=p.evaluate('async()=>await __LIBRA__.getLibrarianConfigurationPreview()')
  check('legacy custom instructions require explicit review',preview['pendingReview'],preview)
  before=p.evaluate('__writerHost.calls.model');out=p.evaluate('async()=>await __LIBRA__.runManualColdStart()');close_jobs(p)
  check('unreviewed custom config cannot start generation',p.evaluate('__writerHost.calls.model')==before,out)
  p.evaluate('async()=>await __LIBRA__.openSettingsGui()');p.evaluate('__audit.selectBookSettingsRoomSection("agents")');p.wait_for_selector('[data-librarian-config-review="pending"]')
  review=p.locator('[data-librarian-config-review="pending"]');review.locator('summary').first.click();review.get_by_label('이 지침 가져오기',exact=True).check()
  p.evaluate('async()=>{__audit.Gui.invalidations.add("body");await __audit.renderSettingsGui();}')
  check('explicit review selection survives refresh',p.get_by_label('이 지침 가져오기',exact=True).is_checked())
  p.locator('[data-librarian-review-accept="selected"]').click();p.wait_for_selector('[data-librarian-config-review="acknowledged"]')
  check('review saves selected instructions without model',p.evaluate('__writerHost.calls.model')==before)
  p.locator('textarea.stage-prompt').fill(p.locator('textarea.stage-prompt').input_value()+'\n추가 확인 지침');p.locator('[data-librarian-save]').click();p.wait_for_timeout(150);preview=p.evaluate('async()=>await __LIBRA__.getLibrarianConfigurationPreview()')
  check('normal settings save does not lose review acknowledgment',not preview['pendingReview'],preview)
  check('old custom source remains accessible',any('지식 경계' in c['text'] for c in preview['candidates']))
  p.screenshot(path=str(E/'configuration_review_saved.png'));p.close()
  check('no uncaught browser errors',not errors,errors);b.close();completed=True
finally:
 report={'test':'libra_librarian_browser','completed':completed,'boundary':'full deployed JS and Chromium; controlled external host/model/storage','passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors,'results':results}
 (E/'RESULTS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False))
