from pathlib import Path
from playwright.sync_api import sync_playwright
import json,os,shutil,hashlib,re,subprocess
R=Path(__file__).resolve().parents[3]; OUT=Path(os.environ.get('HAYAKU_CAPTURE_OUTPUT','/tmp/hayaku-mockup-final'));OUT.mkdir(exist_ok=True)
source_path=R/'PROGRAM/plugins/HAYAKU_Locator_Continuity.js';source_bytes=subprocess.check_output(['git','show',os.environ['HAYAKU_CAPTURE_GIT']+':PROGRAM/plugins/HAYAKU_Locator_Continuity.js'],cwd=R) if os.environ.get('HAYAKU_CAPTURE_GIT') else source_path.read_bytes();source=source_bytes.decode(); anchor='  await install();'; assert source.count(anchor)==1
source=source.replace(anchor,"  globalThis.__hvg={Memory,viewerSetTab,viewerRenderOverview,viewerRenderContinuityLine};\n"+anchor)
host=(R/'PROGRAM/tests/browser/hayaku_browser_host.js').read_text()
ref=Path(os.environ.get('HAYAKU_REFERENCE_ROOT',R/'PROGRAM/docs/gui-redesign'))
html=(ref/'hayaku.html').read_text().replace('<link rel="stylesheet" href="assets/suite.css">', '<style>'+ (ref/'assets/suite.css').read_text()+'</style>').replace('<link rel="stylesheet" href="assets/themes.css">','<style>'+ (ref/'assets/themes.css').read_text()+'</style>')
# Reference alone uses the completed G2 mockup runtime. Product never imports suite.js.
# Inline only suite.js; keep original HTML/component style and suppress only prototype controls at capture.
html=html.replace('<script src="assets/suite.js"></script>', '<script>'+ (ref/'assets/suite.js').read_text()+'</script>')
results={'captureInputs':{'baseGitSha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip(),'pluginVersion':re.search(r'//@version\s+([^\r\n]+)',source).group(1).strip(),'pluginSourceSha256':hashlib.sha256(source_bytes).hexdigest(),'instrumentedBrowserSourceSha256':None,'sourcePath':str(source_path),'syntheticStateOnly':True},'reference':{},'product':{},'interactions':{},'hostCalls':None,'pageErrors':[]}
results['captureInputs']['instrumentedBrowserSourceSha256']=hashlib.sha256(source.encode()).hexdigest()
results['captureInputs']['gitSourceCommit']=os.environ.get('HAYAKU_CAPTURE_GIT')
with sync_playwright() as p:
 exe=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
 b=p.chromium.launch(**({'executable_path':exe} if exe else {}),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 errors=[]
 # Reference screenshot and measurements.
 refp=b.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1); refp.on('pageerror',lambda e:errors.append('ref:'+str(e))); refp.set_content(html,wait_until='load');refp.add_style_tag(content='.proto-bar{display:none!important}')
 # set device frame widths for identical app container sizes, original frame rules remain intact
 def measure(pg):
  return pg.evaluate('''()=>{let sel=['.app','.topbar','.sidebar','.main','.page-body','.metric-row','#hayakuOverviewRouteCard','#hayakuOverviewCards'];let o={};for(let q of sel){let n=document.querySelector(q);if(!n)continue;let r=n.getBoundingClientRect(),s=getComputedStyle(n);o[q]={x:r.x,y:r.y,w:r.width,h:r.height,display:s.display,padding:s.padding,gap:s.gap,cols:s.gridTemplateColumns,font:s.fontFamily};}let f=document.querySelector('.frame'),fr=f.getBoundingClientRect();o.frame={x:fr.x,y:fr.y,w:fr.width,h:fr.height};let a=document.querySelector('.app');o.appContainerWidth=a.getBoundingClientRect().width;return o}''')
 for label,width,height in [('desktop',1440,1000),('tablet',820,1000),('mobile',390,844),('901',901,1000),('900',900,1000),('641',641,1000),('640',640,1000)]:
  viewport=1440 if label in ('desktop','901','900','641','640') else width
  refp.set_viewport_size({'width':viewport,'height':height})
  if label in ('901','900','641','640'):refp.locator('.frame').evaluate('(n,w)=>n.style.width=w+"px"',width)
  else:refp.locator('.frame').evaluate('(n)=>n.style.removeProperty("width")')
  refp.wait_for_timeout(40)
  if label=='tablet':refp.screenshot(path=str(OUT/'mockup_tablet_820x1000.png'))
  if label=='mobile':refp.screenshot(path=str(OUT/'mockup_mobile390x844.png'))
  if label=='desktop':refp.screenshot(path=str(OUT/'mockup_1440x1000.png'))
  results['reference'][label]=measure(refp);results['reference'][label]['viewport']={'width':viewport,'height':height,'frameWidth':results['reference'][label]['frame']['w']}
  if label in ('tablet','mobile'):results['reference'][label]['overflow']=refp.evaluate("()=>({page:[document.querySelector('.page-body')?.scrollWidth,document.querySelector('.page-body')?.clientWidth],app:[document.querySelector('.app')?.scrollWidth,document.querySelector('.app')?.clientWidth],route:[document.querySelector('.route')?.scrollWidth,document.querySelector('.route')?.clientWidth],overflow:[...document.querySelectorAll('.page-body *')].filter(n=>{let r=n.getBoundingClientRect(),p=document.querySelector('.page-body').getBoundingClientRect();return r.width&&r.right>p.right+1&&!n.closest('.route')}).slice(0,4).map(n=>({tag:n.tagName,cls:n.className,text:n.innerText?.slice(0,40),right:n.getBoundingClientRect().right,parentRight:document.querySelector('.page-body').getBoundingClientRect().right}))})")
 # Product real plugin in network/model-blocked ephemeral host.
 prod=b.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1);prod.on('pageerror',lambda e:errors.append('prod:'+str(e)))
 prod.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"></body></html>');prod.add_script_tag(content=host);prod.add_script_tag(content=source);prod.wait_for_function('!!window.HAYAKU',timeout=30000);prod.evaluate('HAYAKU.showUi()');prod.wait_for_function('!!document.querySelector(".app[data-hayaku-mockup]") && !__hvg.Memory.ledgerViewer.busy',timeout=30000);prod.wait_for_timeout(200)
 # Inject a synthetic 147-turn state through the real adapter input only; no fixture values are shipped in product.
 prod.evaluate('''()=>{let m=__hvg.Memory,lv=m.ledgerViewer;lv.scope.chatTitle='아스텔';let records=Array.from({length:152},(_,i)=>({targetPairIndex:i+1,recordState:i<147?'active':'unbound',recordId:'synthetic-'+(i+1),packetType:'current_snapshot',packet:{state:'fixture-only'}}));lv.ledger={enabled:true,records,reason:''};let cov={scopeKey:lv.scope.key,completedTurns:147,coveredTurns:Array.from({length:147},(_,i)=>i+1),activeDebtCount:0,recoverableDebtCount:0,rows:Array.from({length:147},(_,i)=>({turn:i+1,state:'covered'}))};m.lastViewerRecall={at:Date.now(),rows:Array.from({length:6},(_,i)=>({score:[.947,.912,.881,.843,.801,.774][i],ref:['T128 은색 열쇠를 건넨 약속','T141 정원의 북쪽 문'][i%2],state:'synthetic preview',category:'entity'})),injectedRows:6,recallDataChars:2184};__hvg.viewerRenderContinuityLine(cov);__hvg.viewerRenderOverview();__hvg.viewerRenderContinuityLine(cov)}''');prod.wait_for_timeout(100)
 prod.mouse.move(0,0);prod.screenshot(path=str(OUT/'product_1440x1000.png'));results['product']['desktop']=measure(prod);results['product']['desktop']['routeStates']=prod.evaluate('''()=>({continuity:__hvg.Memory.ledgerViewer.continuitySnapshot?.coverage?.rows?.slice(-1),nodes:[...document.querySelectorAll('.stop')].slice(-2).map(n=>({cl:n.className,state:n.dataset.state,title:n.innerText,transform:getComputedStyle(n.querySelector('i')).transform,border:getComputedStyle(n.querySelector('i')).borderRadius}))})''')
 # Verify exact responsive breakpoints, tabs, menu, layout/no horizontal overflow.
 for label,width,height in [('tablet',820,1000),('mobile',390,844),('901',901,1000),('900',900,1000),('641',641,1000),('640',640,1000)]:
  viewport=1440 if label in ('901','900','641','640') else width
  prod.set_viewport_size({'width':viewport,'height':height})
  if label in ('901','900','641','640'):prod.locator('.frame').evaluate('(n,w)=>n.style.width=w+"px"',width)
  else:prod.locator('.frame').evaluate('(n)=>n.style.removeProperty("width")')
  prod.wait_for_timeout(50)
  results['product'][label]=measure(prod);results['product'][label]['viewport']={'width':viewport,'height':height,'frameWidth':results['product'][label]['frame']['w']}
  vis=prod.evaluate('''()=>({sidebar:getComputedStyle(document.querySelector('.sidebar')).display,tabbar:getComputedStyle(document.querySelector('.tabbar')).display,metricCols:getComputedStyle(document.querySelector('.metric-row')).gridTemplateColumns,routeScroll:document.querySelector('.route').scrollWidth>document.querySelector('.route').clientWidth,bodyOverflow:document.querySelector('.page-body').scrollWidth>document.querySelector('.page-body').clientWidth,rootOverflow:document.querySelector('.app').scrollWidth>document.querySelector('.app').clientWidth,overflowNodes:[...document.querySelectorAll('.page-body *')].filter(n=>{let r=n.getBoundingClientRect(),p=document.querySelector('.page-body').getBoundingClientRect();return r.width&&r.right>p.right+1&&!n.closest('.route')}).slice(0,12).map(n=>({tag:n.tagName,cls:n.className,id:n.id,right:n.getBoundingClientRect().right,pageRight:document.querySelector('.page-body').getBoundingClientRect().right,scroll:n.scrollWidth,client:n.clientWidth,text:n.innerText?.slice(0,50),path:(()=>{let a=n,p=[];for(let i=0;a&&i<5;i++,a=a.parentElement)p.push(a.tagName+'.'+a.className+'#'+a.id);return p})()})),navSvg:[...document.querySelectorAll('.sidebar .nav-item')].every(n=>n.firstElementChild?.tagName?.toLowerCase()==='svg'),oldView:!!document.querySelector('.hv-overview,.hv-header,.hv-sidebar')})''')
  results['product'][label]['responsive']=vis
  if label=='tablet':prod.mouse.move(0,0);prod.screenshot(path=str(OUT/'product_tablet_820x1000.png'))
  if label=='mobile':prod.mouse.move(0,0);prod.screenshot(path=str(OUT/'product_mobile390x844.png'))
 # mobile more-sheet interaction at exact 390 frame
 prod.set_viewport_size({'width':390,'height':844});prod.locator('.frame').evaluate('(n)=>n.style.removeProperty("width")');prod.wait_for_timeout(30)
 more=prod.locator('[data-hayaku-more]');more.click();prod.wait_for_timeout(30)
 results['interactions']['moreOpen']=prod.locator('#hayakuMoreSheet').evaluate('(n)=>getComputedStyle(n).display!=="none" && n.querySelectorAll("[data-more-list] .row").length===2')
 results['interactions']['moreRowsUseMockupArrow']=prod.locator('#hayakuMoreSheet [data-more-list] .row svg.ic--sm.faint').count()==2
 prod.keyboard.press('Escape');prod.wait_for_timeout(30);results['interactions']['escapeClosesMore']=prod.locator('#hayakuMoreSheet').get_attribute('aria-hidden')=='true'
 results['interactions']['noFixtureStoresOrTimers']=prod.evaluate("Array.from(document.scripts).every(s=>!s.src.includes('suite.js')) && __hostCalls.network===0 && __hostCalls.llm===0")
 results['hostCalls']=prod.evaluate('__hostCalls');results['pageErrors']=errors
 prod.evaluate('document.activeElement && document.activeElement.blur()')
 prod.mouse.move(0,0);prod.screenshot(path=str(OUT/'product_mobile390x844.png'))
 # Capture all six actual plugin routes on desktop, tablet, and physical mobile viewports.
 results['routeCaptures']={}
 for route in ['overview','packets','recovery','server','settings','logs']:
  results['routeCaptures'][route]={}
  for device,width,height in [('desktop',1440,1000),('tablet',820,1000),('mobile',390,844)]:
   prod.set_viewport_size({'width':width,'height':height});prod.locator('.frame').evaluate('(n)=>n.style.removeProperty("width")')
   prod.evaluate('(id)=>document.querySelector(`[data-hayaku-viewer-tab="${id}"]`)?.click()',route)
   prod.wait_for_function('(id)=>document.querySelector(`[data-hayaku-viewer-tab="${id}"]`)?.getAttribute("aria-selected")==="true"',arg=route,timeout=5000)
   prod.wait_for_timeout(120)
   path=OUT/f'route_{route}_{device}_{width}x{height}.png';prod.mouse.move(0,0);prod.screenshot(path=str(path))
   results['routeCaptures'][route][device]={'file':path.name,'viewport':{'width':width,'height':height},'panel':prod.evaluate('(id)=>({active:document.querySelector(`[data-hayaku-viewer-panel="${id}"]`)?.classList.contains("is-active"),hidden:document.querySelector(`[data-hayaku-viewer-panel="${id}"]`)?.hidden,scrollWidth:document.querySelector(`[data-hayaku-viewer-panel="${id}"]`)?.scrollWidth,clientWidth:document.querySelector(`[data-hayaku-viewer-panel="${id}"]`)?.clientWidth})',route)}
   results['routeCaptures'][route][device]['panel']['overflow']=prod.evaluate('''(id)=>{let p=document.querySelector(`[data-hayaku-viewer-panel="${id}"]`),pr=p.getBoundingClientRect();return [...p.querySelectorAll('*')].map(n=>({n,r:n.getBoundingClientRect()})).filter(x=>x.r.width&&x.r.right>pr.right+1&&!x.n.closest('.route')).slice(0,6).map(x=>({tag:x.n.tagName,cl:x.n.className,id:x.n.id,right:x.r.right,pageRight:pr.right,text:x.n.innerText?.slice(0,55),path:(()=>{let e=x.n,a=[];for(let i=0;e&&i<5;i++,e=e.parentElement)a.push(e.tagName+'.'+e.className+'#'+e.id);return a})()}))}''',route)
   if route=='packets':
    results['routeCaptures'][route][device]['panel']['pkLayout']=prod.evaluate('''()=>{let a=document.querySelector('.app'),p=document.querySelector('.pk-layout'),l=document.querySelector('#hayakuViewerRecords'),r=document.querySelector('#hayakuViewerRecords .pk-row'),m=document.querySelector('#hayakuViewerRecords .pk-row span');return {app:[a.clientWidth,getComputedStyle(a).containerType,getComputedStyle(a).containerName],layout:[p.clientWidth,p.scrollWidth,getComputedStyle(p).gridTemplateColumns],list:[l.clientWidth,l.scrollWidth,getComputedStyle(l).width],row:[r.clientWidth,r.scrollWidth,getComputedStyle(r).gridTemplateColumns],span:[m.clientWidth,m.scrollWidth,getComputedStyle(m).minWidth]}}''')
 prod.evaluate('document.querySelector(`[data-hayaku-viewer-tab="overview"]`)?.click()')
 (OUT/'geometry.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
 print(json.dumps({'out':str(OUT),'appDesktopRef':results['reference']['desktop']['.app'],'appDesktopProduct':results['product']['desktop']['.app'],'responsive':{k:v.get('responsive') for k,v in results['product'].items() if isinstance(v,dict) and 'responsive'in v},'interactions':results['interactions'],'hostCalls':results['hostCalls'],'pageErrors':errors},ensure_ascii=False,indent=2))
 b.close()
