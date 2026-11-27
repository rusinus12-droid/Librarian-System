'use strict';
// HAYAKU phone layout: page headers stack instead of squeezing the title column,
// nothing spills past the app edge, touch controls stay tappable and text inputs
// stay at 16px so mobile browsers do not zoom on focus. Synthetic host only.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const ROOT=path.join(__dirname,'../..');
const anchor='  await install();';
let source=fs.readFileSync(process.env.HAYAKU_TEST_PLUGIN||path.join(ROOT,'plugins/HAYAKU_Locator_Continuity.js'),'utf8');
assert.equal(source.split(anchor).length,2);
source=source.replace(anchor,'  globalThis.__layoutTest = {Memory};\n'+anchor);
const host=fs.readFileSync(path.join(__dirname,'hayaku_browser_host.js'),'utf8');
const measure=()=>{const app=document.querySelector('.app'),edge=app.getBoundingClientRect().right,page=document.querySelector('.page.is-active');
  const head=page&&page.querySelector('.page-head'),copy=head&&head.querySelector('.page-head__copy'),title=head&&head.querySelector('.page-title');
  const spill=[];for(const n of app.querySelectorAll('*')){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden')continue;const r=n.getBoundingClientRect();if(!r.width||r.right<=edge+1)continue;let clipped=false;for(let a=n.parentElement;a&&a!==app;a=a.parentElement){if(getComputedStyle(a).overflowX!=='visible'){clipped=a.getBoundingClientRect().right<=edge+1;break;}}if(!clipped)spill.push(n.tagName+'.'+n.className);}
  const seg=[...page.querySelectorAll('.page-actions .seg button')].filter(n=>n.getBoundingClientRect().width).map(n=>n.getBoundingClientRect().height);
  const inputs=[...page.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea')].filter(n=>n.getBoundingClientRect().width).map(n=>parseFloat(getComputedStyle(n).fontSize));
  return {appWidth:app.getBoundingClientRect().width,copyWidth:copy?copy.getBoundingClientRect().width:null,headWidth:head?head.getBoundingClientRect().width:null,titleHeight:title?title.getBoundingClientRect().height:null,spill:spill.slice(0,8),seg,inputs};};
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true});const errors=[];
  try{const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"></body></html>');
    await page.addScriptTag({content:host});await page.addScriptTag({content:source});await page.waitForFunction('!!window.HAYAKU');await page.evaluate('HAYAKU.showUi()');
    await page.waitForFunction(()=>!!document.querySelector('.app')&&!__layoutTest.Memory.ledgerViewer.busy);
    for(const width of [320,390,414]){await page.setViewportSize({width,height:844});
      for(const tab of ['overview','packets','recovery','settings']){await page.evaluate(t=>document.querySelector(`[data-go="${t}"]`).click(),tab);await page.waitForTimeout(250);
        const m=await page.evaluate(measure);
        assert.ok(m.copyWidth>=m.headWidth-1,`${width}/${tab}: page title column must span the header (${JSON.stringify(m)})`);
        assert.ok(m.titleHeight<60,`${width}/${tab}: page title must not wrap per character (${JSON.stringify(m)})`);
        assert.deepEqual(m.spill,[],`${width}/${tab}: content spills past the app edge`);
        assert.ok(m.seg.every(h=>h>=40),`${width}/${tab}: segmented buttons below 40px (${m.seg})`);
        assert.ok(m.inputs.every(s=>s>=16),`${width}/${tab}: inputs below 16px zoom on focus (${m.inputs})`);}}
    // Wide frames keep the desktop header row.
    await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>document.querySelector('[data-go="packets"]').click());await page.waitForTimeout(250);
    const wide=await page.evaluate(measure);assert.ok(wide.copyWidth<wide.headWidth-100,`desktop header should keep actions beside the title (${JSON.stringify(wide)})`);
    assert.deepEqual(errors,[]);assert.ok(await page.evaluate('__hostCalls.llm===0&&__hostCalls.network===0'));
    console.log('hayaku_mobile_page_layout_browser_test passed');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
