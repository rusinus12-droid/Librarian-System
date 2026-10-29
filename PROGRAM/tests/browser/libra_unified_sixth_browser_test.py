#!/usr/bin/env python3
"""Production JS/GUI with explicit synthetic host/model/storage boundaries, not RisuAI E2E."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, shutil, subprocess, sys
P=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
E=Path(sys.argv[2]) if len(sys.argv)>2 else Path('/mnt/data/sixth_browser');E.mkdir(parents=True,exist_ok=True)
artifact=json.loads(subprocess.check_output(['node','-e','console.log(JSON.stringify(require(process.argv[1]).artifact()))',str(P/'tests/fixtures/libra_unified_runtime_fixture.cjs')]))
source=json.loads((P/'tests/fixtures/unified_vertical_source.json').read_text())
s=(P/'plugins/LIBRA.js').read_text();needle='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';assert needle in s
s=s.replace(needle,'  globalThis.__wm={Gui,LibraMemoryCore,renderSettingsGui,bookSelectPeopleSection,bookSelectWorldSection,bookSelectStorySection,bookSelectSettingsWorkbench,buildLibraMemorySettingsPanel};\n'+needle)
results=[];errors=[];completed=False

def check(name,value,detail=None):
 results.append({'name':name,'ok':bool(value),'detail':detail})
 if not value:raise AssertionError(name+': '+str(detail))
def close_jobs(p):
 p.wait_for_function('()=>!__wm.Gui.canonicalJobRenderTimer')
 for n in p.locator('.canonical-job-overlay').all():
  if n.is_visible():n.get_by_role('button',name='닫기',exact=True).click()
def create_page(browser,frozen=None):
 p=browser.new_page(viewport={'width':1440,'height':1100});p.set_default_timeout(15000);p.on('pageerror',lambda e:errors.append(str(e)))
 p.set_content('<html lang="ko"><body></body></html>');p.add_script_tag(content=(P/'tests/browser/libra_writer_host.js').read_text())
 p.evaluate('''({source,artifact})=>{__writerHost.chat.message=source.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));__writerHost.chat.messages=__writerHost.chat.message;__writerHost.artifact=artifact;const old=risuai.getArgument;risuai.getArgument=async k=>['enable_character_ito','enable_world_ito','enable_plot_ito'].some(x=>k.includes(x))?'false':old(k);risuai.runLLMModel=async()=>{__writerHost.calls.model++;return {type:'success',result:JSON.stringify(__writerHost.artifact)}};}''',{'source':source,'artifact':artifact})
 if frozen:
  p.evaluate('''f=>{Object.assign(__writerHost.chat,f.chat);__writerHost.chat.messages=__writerHost.chat.message;Object.assign(__writerHost.character,{id:'unified-char',chaId:'unified-char',name:'민아',chats:[__writerHost.chat]});for(const [k,v] of f.values)__writerHost.values.set(k,v);}''',frozen)
 p.add_script_tag(content=s);p.wait_for_function('!!window.__LIBRA__');return p

def settings(p,mode):p.evaluate('''async mode=>await __LIBRA__.saveLibraMemorySettings({...await __LIBRA__.getLibraMemorySettings(),memoryEngine:mode,stateTrackingEnabled:false,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false})''',mode)
def panel(p):
 p.evaluate('async()=>await __LIBRA__.openSettingsGui()');close_jobs(p)
 p.evaluate('()=>{__wm.Gui.settingsHubSection="memory";__wm.bookSelectSettingsWorkbench("settings");}')
 p.wait_for_selector('[data-unified-legacy-rebuild="true"]')
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  p=create_page(browser);settings(p,'unified');out=p.evaluate('async()=>await __LIBRA__.runManualColdStart()');check('typed baseline public job',out.get('completed')==1,out.get('failures'));close_jobs(p)
  p.evaluate('async()=>await __LIBRA__.openSettingsGui()');close_jobs(p);p.evaluate('__wm.bookSelectPeopleSection("characters")')
  p.locator('[data-open-identity-manager="characters"]').first.click();p.locator('#dlg-merge [data-identity-mode="split"]').click()
  split=p.locator('#dlg-merge [data-world-identity-split="characters"]')
  split.get_by_label('분리 인물 1 이름',exact=True).fill('민아');split.get_by_label('분리 인물 2 이름',exact=True).fill('민희')
  split.get_by_role('button',name='분리할 사실과 근거 확인',exact=True).click();p.wait_for_function('document.querySelectorAll("[data-split-occurrence]").length>0')
  check('split requires explicit allocation before save',split.get_by_role('button',name='현재 배정으로 분리 저장').is_disabled())
  for select in split.locator('[data-split-occurrence]').all():select.select_option('person_2' if select.get_attribute('data-split-fact') in ['f6','f9'] else 'person_1')
  p.evaluate('async()=>{__wm.Gui.invalidations.add("body");await __wm.renderSettingsGui();}')
  check('split names and role allocation survive background body refresh',split.get_by_label('분리 인물 2 이름',exact=True).input_value()=='민희' and all(n.input_value() for n in split.locator('[data-split-occurrence]').all()))
  for width in [1440,390]:
   p.set_viewport_size({'width':width,'height':1000});p.wait_for_timeout(80);p.screenshot(path=str(E/f'split_review_{width}.png'))
   check(f'split review fits {width}px',split.evaluate('(n)=>n.getBoundingClientRect().right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1'))
  p.set_viewport_size({'width':1440,'height':1100});split.get_by_role('button',name='현재 배정으로 분리 저장').click()
  p.wait_for_function('()=>__wm.LibraMemoryCore.peekSnapshot().continuityState.characters.some(c=>c.name==="민희")')
  h=p.evaluate('()=>__wm.LibraMemoryCore.peekSnapshot().continuityState');a=next(r for r in h['characters'] if r['name']=='민아');b=next(r for r in h['characters'] if r['name']=='민희');key=next(r for r in h['world'] if r['name']=='은빛 열쇠')
  check('GUI split saves independent owner/holder and knowledge',key['state']['ownerRef']==b['id'] and key['state']['holderRef']==a['id'] and b['state']['knowledge']==['상자의 암호'])
  check('GUI split does not call model',p.evaluate('__writerHost.calls.model')==1)
  p.evaluate('__wm.bookSelectPeopleSection("relationships")');p.wait_for_timeout(100)
  check('relationship choices no longer expose JSON state',not p.locator('[data-current-head-article="relationships"]').locator('xpath=..').inner_text().find('{"value"')>=0)
  p.close()

  frozen=json.loads((P/'tests/fixtures/legacy_v3_frozen_1_batches.json').read_text())
  p=create_page(browser,frozen);settings(p,'unified');panel(p)
  check('frozen baseline v3 is readable without old generator',p.evaluate('__writerHost.calls.model')==0)
  legacy=p.locator('[data-unified-legacy-rebuild="true"]');legacy.locator('summary').first.click();legacy.get_by_role('button',name='구간과 원문 증거 확인').click();p.wait_for_selector('[data-legacy-rebuild-key]')
  check('legacy selection initially empty',legacy.get_by_role('button',name='선택 구간의 재분석 승인·실행').is_disabled())
  legacy.get_by_text('저장된 승인 원문',exact=True).click();p.wait_for_function('document.querySelector("[data-unified-legacy-rebuild]").innerText.includes("T1 · 사용자")')
  check('legacy evidence preview displays full stored U+A',source['sourceRows'][0]['text'] in legacy.inner_text() and source['sourceRows'][-1]['text'] in legacy.inner_text())
  legacy.locator('[data-legacy-rebuild-key]').check()
  p.evaluate('async()=>{__wm.Gui.invalidations.add("body");await __wm.renderSettingsGui();}')
  check('legacy explicit selection survives body refresh',legacy.locator('[data-legacy-rebuild-key]').is_checked())
  before_conversion=p.evaluate('__writerHost.calls.model');p.evaluate('a=>__writerHost.artifact=a',artifact)
  legacy.get_by_role('button',name='선택 구간의 재분석 승인·실행').click();p.wait_for_function('document.querySelector("[data-unified-legacy-rebuild]").innerText.includes("전환 1개 완료")');close_jobs(p)
  check('GUI approved conversion calls one model for one selected span',p.evaluate('__writerHost.calls.model')-before_conversion==1,{'before':before_conversion,'after':p.evaluate('__writerHost.calls.model')})
  check('GUI conversion retains previous revision',p.evaluate('()=>[...__writerHost.values.values()].filter(v=>{try{return JSON.parse(v)?.schema==="libra.canonical_memory.v1"}catch{return false}}).length')==2)
  p.screenshot(path=str(E/'legacy_selected_result.png'))
  p.wait_for_timeout(150);close_jobs(p)
  k=p.evaluate('''()=>{const m=[...__writerHost.values.values()].map(v=>{try{return JSON.parse(v)}catch{return null}}).find(v=>v?.schema==='libra.manifest.v1');const key=`libra:v1:scope:${m.scopeKey}:entity-registry:v2:unified-basis:browser_orphan:1`;__writerHost.values.set(key,JSON.stringify({schema:'libra.unified_basis_snapshot.v1',scopeKey:m.scopeKey,createdAt:new Date(Date.now()-30*86400000).toISOString(),head:null,registry:null}));return key;}''')
  retention=p.locator('[data-unified-retention="true"]');retention.locator('summary').first.click();retention.get_by_role('button',name='보관 참조 점검').click();p.wait_for_selector('[data-retention-key]')
  check('maintenance does not preselect deletion',retention.get_by_role('button',name='선택한 임시 자료 삭제').is_disabled());retention.locator('[data-retention-key]').check()
  p.evaluate('async()=>{__wm.Gui.invalidations.add("body");await __wm.renderSettingsGui();}')
  check('maintenance exact selection survives body refresh',retention.locator('[data-retention-key]').is_checked())
  retention.get_by_role('button',name='선택한 임시 자료 삭제').click();p.wait_for_function('document.querySelector("[data-unified-retention]").innerText.includes("임시 자료 1개 삭제")')
  check('GUI maintenance deletes only approved transient snapshot',not p.evaluate('k=>__writerHost.values.has(k)',k) and p.evaluate('()=>[...__writerHost.values.values()].filter(v=>{try{return JSON.parse(v)?.schema==="libra.canonical_memory.v1"}catch{return false}}).length')==2)
  p.screenshot(path=str(E/'retention_result.png'))
  p.evaluate('async()=>await __LIBRA__.closeSettingsGui()');check('closing GUI releases scoped review nodes',p.evaluate('__wm.Gui.unifiedSixthForms===null'))
  p.close();check('zero unhandled browser errors',not errors,errors);completed=True;browser.close()
finally:
 report={'test':'libra_unified_sixth_browser','completed':completed,'boundary':'production JS + GUI in Chromium; synthetic external host/model/storage; not real RisuAI','passed':sum(r['ok'] for r in results),'total':len(results),'errors':errors,'results':results}
 (E/'RESULTS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False))
