'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
(async()=>{
 const out=process.env.LIA_SCOPE_CAPTURE_DIR||path.join(os.tmpdir(),'lia-scope-persona-browser');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 try{
  await page.goto('about:blank');
  await page.evaluate(()=>{
   const personas=[{id:'p1',name:'하린',personaPrompt:'별빛을 기록하는 신중한 도서관 사서.'},{id:'p2',name:'유나',personaPrompt:'은빛 나침반을 지닌 호기심 많은 탐험가.'},{id:'lia-live-persona::foreign',name:'다른 채팅 Live',personaPrompt:'외부 복사본',note:'Managed by LIA Live Persona Sync.'}];
   const chats=Array.from({length:31},(_,i)=>({id:'chat-'+i,name:i===0?'현재 채팅':'여정 '+i,bindedPersona:i%3?'p1':'',message:[],custom:'preserved'}));
   chats[2].name='<img src=x onerror=alert(1)>';
   const db={characters:[{id:'character',chaId:'character',name:'별빛 서재',chats,chatPage:0}],personas,selectedPersona:0,plugins:[]},values=new Map();
   const store={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);return true;},removeItem:async k=>{values.delete(k);return true;},keys:async()=>[...values.keys()]};
   window.__scopeTest={db,values,calls:0};
   window.risuai={pluginStorage:store,safeLocalStorage:store,getLocalPluginStorage:async()=>store,
    getArgument:async()=>'',setArgument:async()=>true,getDatabase:async()=>structuredClone(db),setDatabase:async patch=>{Object.assign(db,structuredClone(patch));return true;},
    getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async i=>structuredClone(db.characters[i]),getCharacter:async()=>structuredClone(db.characters[0]),
    getChatFromIndex:async(i,j)=>structuredClone(db.characters[i]?.chats[j]),setChatToIndex:async(i,j,next)=>{db.characters[i].chats[j]=structuredClone(next);return true;},
    showContainer:async()=>true,hideContainer:async()=>true,registerSetting:async(_name,fn)=>{window.__liaOpen=fn;return true;},registerButton:async()=>true,onUnload:async()=>true,
    addPluginChannelListener:async()=>true,postPluginChannelMessage:async()=>true,
    nativeFetch:async()=>{window.__scopeTest.calls++;throw Error('No LLM expected');}};
   window.confirm=()=>true;
  });
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../../plugins/LIA_Persona_Linker.js'),'utf8')});
  await page.waitForFunction(()=>typeof window.__liaOpen==='function');await page.evaluate(()=>window.__liaOpen());
  await page.locator('.sidebar [data-go="settings"]').click();
  await page.locator('#lia-model').fill('SCOPE_UNSAVED_MODEL');
  await page.locator('.sidebar [data-go="scopes"]').click();
  const panel=page.locator('.page[data-page="scopes"]');
  await page.waitForFunction(()=>document.querySelector('[data-lia-scope-status]')?.textContent.includes('전체 31개'));
  assert.equal(await panel.locator('[data-lia-scope-row]').count(),24);
  assert.equal(await panel.locator('[data-lia-scope-row] img').count(),0,'host names are escaped');
  assert.equal(await panel.locator('option').filter({hasText:'다른 채팅 Live'}).count(),0);
  await panel.locator('[data-lia-scope-next]').click();assert.equal(await panel.locator('[data-lia-scope-row]').count(),7);
  await panel.locator('[data-lia-scope-prev]').click();
  await panel.locator('[data-lia-scope-query]').fill('여정 1');
  assert.equal(await panel.locator('[data-lia-scope-row]').count(),11);
  await panel.locator('[data-lia-scope-query]').fill('여정 10');
  const card=panel.locator('[data-lia-scope-row]');assert.equal(await card.count(),1);
  await card.locator('[data-lia-scope-choice]').selectOption('p2');
  await page.evaluate(()=>{window.confirm=()=>false;});
  await card.locator('[data-lia-scope-apply]').click();
  assert.equal(await page.evaluate(()=>window.__scopeTest.db.characters[0].chats[10].bindedPersona),'p1','cancelled confirmation preserves the binding');
  await page.evaluate(()=>{window.confirm=()=>true;});
  await card.locator('[data-lia-scope-apply]').click();
  await page.waitForFunction(()=>window.__scopeTest.db.characters[0].chats[10].bindedPersona==='p2');
  await page.waitForFunction(()=>document.querySelector('[data-lia-scope-status]')?.textContent.includes('전체 31개'));
  assert.equal(await page.evaluate(()=>window.__scopeTest.db.selectedPersona),0);
  assert.equal(await page.evaluate(()=>window.__scopeTest.db.characters[0].chats[0].bindedPersona),'');
  assert.equal(await page.evaluate(()=>window.__scopeTest.db.characters[0].chats[10].custom),'preserved');
  assert.equal(await page.evaluate(()=>window.__scopeTest.calls),0);
  assert.equal(await page.locator('#lia-model').inputValue(),'SCOPE_UNSAVED_MODEL','binding change preserves unsaved settings');
  await page.screenshot({path:path.join(out,'lia-scope-desktop.png')});
  for(const [width,label] of [[820,'tablet'],[390,'mobile']]){
   await page.setViewportSize({width,height:900});
   assert.equal(await panel.isVisible(),true);
   const overflow=await panel.evaluate(el=>el.scrollWidth>el.clientWidth+2);assert.equal(overflow,false,`${label} scope panel fits`);
   assert.equal(await card.locator('[data-lia-scope-apply]').isVisible(),true);
   await page.screenshot({path:path.join(out,`lia-scope-${label}.png`)});
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({test:'lia_scope_persona_mounted_browser',passed:true,captureDir:out}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
