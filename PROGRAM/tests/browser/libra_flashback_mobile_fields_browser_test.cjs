'use strict';
// LIBRA and Flashback on phones: every visible text field is 16px so mobile
// browsers do not zoom on focus, small controls stay touch-sized, and
// Flashback's archive search keeps its own row. Synthetic hosts only.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {boot}=require('./libra_approved_browser.cjs');
const ROOT=path.join(__dirname,'../..');
const fieldSizes=()=>{const app=document.querySelector('.app'),vis=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden';};
  const fields=[...app.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]),select,textarea')].filter(vis);
  return {small:fields.filter(n=>parseFloat(getComputedStyle(n).fontSize)<16).map(n=>n.id||n.className||n.tagName),count:fields.length};};

async function libra(){const{browser,page,errors}=await boot({page:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}});
  try{const routes=await page.evaluate(()=>[...new Set([...document.querySelectorAll('[data-go]')].map(n=>n.dataset.go))]);
    for(const route of routes){await page.evaluate(g=>([...document.querySelectorAll(`[data-go="${g}"]`)].find(n=>n.getBoundingClientRect().width)||document.querySelector(`[data-go="${g}"]`)).click(),route);await page.waitForTimeout(300);
      const tabs=await page.evaluate(()=>document.querySelectorAll('.page.is-active [role=tablist] [role=tab]').length);
      for(let i=0;i<Math.max(tabs,1);i++){if(tabs&&!await page.evaluate(i=>{const t=document.querySelectorAll('.page.is-active [role=tablist] [role=tab]')[i];if(t)t.click();return !!t;},i))break;await page.waitForTimeout(200);
        const m=await page.evaluate(fieldSizes);assert.deepEqual(m.small,[],`LIBRA ${route}/${i}: fields below 16px zoom on focus`);
        const tiny=await page.evaluate(()=>[...document.querySelectorAll('.page.is-active .linkbtn,.page.is-active .seg button,.page.is-active .lore-filter-pill,.page.is-active .chip.wchip')].filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height<36;}).map(n=>n.textContent.trim()));
        assert.deepEqual(tiny,[],`LIBRA ${route}/${i}: controls below touch size`);}}
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}}

async function flashback(){const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true});
  try{const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"></body></html>');
    await page.evaluate(()=>{const values=new Map(),args=new Map([['memory_suite_server_mode','plugin_only'],['enable_gui','true']]);
      const store={getItem:async k=>values.get(String(k))??null,setItem:async(k,v)=>{values.set(String(k),v);return true},removeItem:async k=>{values.delete(String(k));return true},keys:async()=>[...values.keys()]};
      const chat={id:'c',chatId:'c',name:'chat',message:[],messages:[],localLore:[]},character={id:'o',chaId:'o',name:'owner',chats:[chat],chatPage:0,globalLore:[]};
      window.__calls={models:0};const blocked=async()=>{__calls.models++;throw Error('blocked');};
      window.risuai={pluginStorage:store,safeLocalStorage:store,getLocalPluginStorage:async()=>store,getArgument:async k=>args.get(String(k))??'',getArg:async k=>args.get(String(k))??'',setArgument:async(k,v)=>{args.set(k,v);return true},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getCharacterFromIndex:async()=>character,getChar:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,getDatabase:async f=>{const db={characters:[character],personas:[],selectedPersona:'',plugins:[],modules:[]};return Array.isArray(f)?Object.fromEntries(f.map(k=>[k,db[k]??null])):db},setDatabase:async()=>true,getRuntimeInfo:async()=>({apiVersion:'3.0',platform:'web',saveMethod:'local'}),getColorScheme:async()=>'light',showContainer:async()=>true,hideContainer:async()=>true,getRootDocument:async()=>null,getRootContainer:async()=>null,getPluginRoot:async()=>null,onUnload:async()=>true,nativeFetch:blocked,fetch:blocked,runLLMModel:blocked};
      for(const n of ['registerSetting','registerButton','unregisterUIPart','unregisterSetting','unregisterButton','addRisuReplacer','removeRisuReplacer','addRisuChatListener','removeRisuChatListener','addRisuScriptHandler','removeRisuScriptHandler','addPluginChannelListener','removePluginChannelListener','postPluginChannelMessage','registerBodyIntercepter','unregisterBodyIntercepter'])risuai[n]=async()=>true;
      window.confirm=()=>false;window.alert=()=>{};});
    await page.addScriptTag({content:fs.readFileSync(process.env.FLASHBACK_GUI_SOURCE||path.join(ROOT,'plugins/Flashback_Memory.js'),'utf8')});
    await page.waitForFunction('!!window.__FlashbackMemory');await page.evaluate('__FlashbackMemory.showUi()');await page.waitForSelector('.app .tabbar');await page.waitForTimeout(500);
    const count=await page.evaluate(()=>document.querySelectorAll('.tabbar > button').length);
    for(let i=0;i<count;i++){await page.evaluate(i=>document.querySelectorAll('.tabbar > button')[i].click(),i);await page.waitForTimeout(400);
      if(await page.evaluate(()=>!!document.querySelector('[aria-hidden="false"] .sheet, .sheet.is-open')))continue;
      const m=await page.evaluate(fieldSizes);assert.deepEqual(m.small,[],`Flashback tab ${i}: fields below 16px zoom on focus`);}
    await page.evaluate(()=>document.querySelectorAll('.tabbar > button')[1].click());await page.waitForTimeout(400);
    const search=await page.evaluate(()=>{const n=document.querySelector('#manualEditorSearch'),c=n.closest('.cluster');return {search:n.getBoundingClientRect().width,row:c.getBoundingClientRect().width};});
    assert.ok(search.search>=search.row*0.9,`Flashback archive search should take its own row (${JSON.stringify(search)})`);
    assert.deepEqual(errors,[]);assert.equal(await page.evaluate('__calls.models'),0);
  }finally{await browser.close();}}

(async()=>{await libra();await flashback();console.log('libra_flashback_mobile_fields_browser_test passed');})().catch(e=>{console.error(e);process.exitCode=1;});
