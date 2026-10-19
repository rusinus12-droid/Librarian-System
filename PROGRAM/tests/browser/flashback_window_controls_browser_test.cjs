'use strict';
// Exact plugin in a real fullscreen iframe; only the host API/storage are supplied.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { resolveChromeExecutable } = require('../fixtures/browser_resolver.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = process.env.FLASHBACK_WINDOW_OUTPUT || path.join(os.tmpdir(), 'flashback-window-controls');
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-window-'));
const stderr = fs.openSync(path.join(out, 'chromium.stderr.log'), 'a');
const child = spawn(resolveChromeExecutable(), ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'], { stdio: ['ignore', 'ignore', stderr] });
fs.closeSync(stderr);
let ws, exit;
child.on('error', error => { exit = error.message; });
child.on('exit', (code, signal) => { exit = { code, signal }; });
const watchdog = setTimeout(() => { child.kill('SIGKILL'); process.exitCode = 1; }, 60000);
(async () => {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(temp, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch (_) {}
    if (exit) break;
    await pause(50);
  }
  assert.ok(port, 'Chromium starts: ' + JSON.stringify(exit));
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const inside = code => ev(`document.querySelector('#plugin').contentWindow.eval(${JSON.stringify(code)})`);
  const wait = async predicate => {
    for (let i = 0; i < 120; i++) { if (await predicate()) return; await pause(25); }
    throw new Error('Browser condition timed out');
  };
  const click = async selector => {
    const point = await inside(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing control');const r=n.getBoundingClientRect();if(!n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('unreachable control: '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const shot = async name => {
    const image = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  };
  await ev(`document.body.innerHTML='<main style="padding:48px;font:20px system-ui;color:#ddd"><h1>Chat workspace</h1><p>The host remains visible around Flashback.</p><button id="hostButton">Continue chat</button></main><iframe id="plugin" title="Flashback"></iframe>';document.body.style.cssText='margin:0;background:#283344';document.querySelector('#plugin').style.cssText='position:fixed;inset:0;width:100%;height:100%;border:0;z-index:1000;display:none';`);
  await inside(`(()=>{
    const values=new Map(),args=new Map([['memory_suite_server_mode','plugin_only'],['enable_gui','true']]);
    const store={getItem:async k=>values.get(String(k))??null,setItem:async(k,v)=>{values.set(String(k),v);return true},removeItem:async k=>{values.delete(String(k));return true},keys:async()=>[...values.keys()]};
    const chat={id:'window-chat',chatId:'window-chat',name:'Current chat',message:[],messages:[],localLore:[]};
    const character={id:'window-owner',chaId:'window-owner',name:'Cosmic Princess Kaguya! A long character title',chats:[chat],chatPage:0,globalLore:[]};
    window.calls={show:0,hide:0,models:0};window.unloads=[];
    const blocked=async()=>{calls.models++;throw Error('Unexpected model/network request')};
    window.risuai={pluginStorage:store,safeLocalStorage:store,getLocalPluginStorage:async()=>store,getArgument:async k=>args.get(String(k))??'',getArg:async k=>args.get(String(k))??'',setArgument:async(k,v)=>{args.set(k,v);return true},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getCharacterFromIndex:async()=>character,getChar:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,getDatabase:async fields=>{const db={characters:[character],personas:[],selectedPersona:'',plugins:[],modules:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db},setDatabase:async()=>true,getRuntimeInfo:async()=>({apiVersion:'3.0',platform:'web',saveMethod:'local'}),getColorScheme:async()=> 'light',showContainer:async mode=>{if(mode!=='fullscreen')throw Error('Unsupported container mode');calls.show++;parent.document.querySelector('#plugin').style.display='block'},hideContainer:async()=>{calls.hide++;parent.document.querySelector('#plugin').style.display='none'},getRootDocument:async()=>null,getRootContainer:async()=>null,getPluginRoot:async()=>null,onUnload:async fn=>{unloads.push(fn);return true},nativeFetch:blocked,fetch:blocked,runLLMModel:blocked};
    for(const name of ['registerSetting','registerButton','unregisterUIPart','unregisterSetting','unregisterButton','addRisuReplacer','removeRisuReplacer','addRisuChatListener','removeRisuChatListener','addRisuScriptHandler','removeRisuScriptHandler','addPluginChannelListener','removePluginChannelListener','postPluginChannelMessage','registerBodyIntercepter','unregisterBodyIntercepter'])risuai[name]=async()=>true;
  })()`);
  const source = fs.readFileSync(process.env.FLASHBACK_GUI_SOURCE || path.resolve(__dirname, '../../plugins/Flashback_Memory.js'), 'utf8');
  await inside(source);
  await wait(() => inside('!!window.__FlashbackMemory'));
  const records = [];
  for (const [width, height] of [[2556,1363],[1280,900],[900,1024],[641,900],[390,844],[320,640],[844,390],[1280,360]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await inside('__FlashbackMemory.showUi()');
    await wait(() => inside('!!document.querySelector("#closeBtn") || !!document.querySelector("#topMoreBtn")'));
    await click('#topMoreBtn');
    const state = await inside(`(()=>{const app=document.querySelector('.app'),r=app.getBoundingClientRect(),panel=document.querySelector('#topMoreMenu'),close=document.querySelector('#closeBtn'),more=document.querySelector('#topMoreBtn');const bounds=n=>n?{x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right,y:n.getBoundingClientRect().y,bottom:n.getBoundingClientRect().bottom}:null;return {x:r.x,y:r.y,width:r.width,height:r.height,backgrounds:[document.documentElement,document.body,document.querySelector('#vector-rag-memory-root'),document.querySelector('.stage')].map(n=>getComputedStyle(n).backgroundColor),menuVisible:getComputedStyle(panel).display!=='none'&&!panel.hidden&&panel.getBoundingClientRect().height>0,expanded:more.getAttribute('aria-expanded'),close:bounds(close),more:bounds(more),lastControl:close===document.querySelector('.topbar').lastElementChild,headerOverflow:document.querySelector('.topbar').scrollWidth-document.querySelector('.topbar').clientWidth}})()`);
    records.push({ viewport: { width, height }, ...state });
    fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(records, null, 2));
    if (width === 2556) await shot('desktop-menu');
    assert.equal(state.menuVisible, true, 'real click reveals rendered menu, beyond aria-expanded');
    assert.equal(state.expanded, 'true');
    assert.ok(state.backgrounds.every(color => color === 'rgba(0, 0, 0, 0)'), 'iframe and window exterior stay transparent');
    assert.ok(Math.abs(state.x + state.width / 2 - width / 2) <= 1, 'window centered horizontally');
    assert.ok(Math.abs(state.y + state.height / 2 - height / 2) <= 1, 'window centered vertically');
    assert.ok(state.width <= width - 30 && state.height <= height - 30, 'window fits viewport with exterior margin');
    assert.ok(state.close && state.lastControl && state.close.x >= state.more.right && state.close.right <= width && state.close.bottom <= height, 'dedicated close is rightmost and in view');
    assert.ok(state.headerOverflow <= 1, 'header controls do not overflow');
    const hides = await inside('calls.hide');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await inside('document.querySelector("#topMoreBtn").getAttribute("aria-expanded")'), 'false');
    assert.equal(await inside('calls.hide'), hides, 'Escape closes menu first');
    await click('#topMoreBtn');
    await click('#topMenuRefreshBtn');
    await wait(() => inside('document.querySelector("#topMoreBtn")?.getAttribute("aria-expanded")==="false"'));
    await click('#topMoreBtn');
    await click('.brand__mark');
    assert.equal(await inside('document.querySelector("#topMoreMenu").hidden'), true, 'outside click dismisses menu');
    if (width === 390) await shot('mobile-window');
    if (width === 2556) await shot('desktop-window');
    await click('#closeBtn');
    await wait(() => ev('document.querySelector("#plugin").style.display==="none"'));
    assert.equal(await inside('calls.hide'), hides + 1, 'dedicated close calls host hide exactly once');
    assert.equal(await ev('document.elementFromPoint(60,60).closest("iframe")===null'), true, 'host becomes reachable after close');
  }
  await inside('__FlashbackMemory.showUi()');
  await click('#topMoreBtn');
  const beforeMenuClose = await inside('calls.hide');
  await click('#topMenuCloseBtn');
  await wait(() => ev('document.querySelector("#plugin").style.display==="none"'));
  assert.equal(await inside('calls.hide'), beforeMenuClose + 1, 'existing menu close also hides the container');
  assert.equal(await inside('calls.models'), 0);
  await inside('(async()=>{for(const fn of unloads)await fn()})()');
  console.log('PASS real Chromium: transparent fullscreen iframe; centered window and rendered menu/refresh/outside/Escape/dedicated close/reopen at 8 viewport sizes; zero model/network calls; evidence ' + out);
  await call('Browser.close');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog); ws?.close(); child.kill(); await pause(150);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
