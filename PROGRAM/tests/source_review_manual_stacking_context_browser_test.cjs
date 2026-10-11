'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { resolveChromeExecutable } = require('./fixtures/browser_resolver.cjs');

const program = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || process.env.SOURCE_REVIEW_TEST_ARTIFACTS || path.join(os.tmpdir(), 'source-review-history-browser'));
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(out, 'chrome-'));
// Chromium's Unix singleton socket must fit sun_path even when the
// campaign TMPDIR is a deeply nested evidence directory.
const socketTmp=fs.mkdtempSync(path.join(process.platform==='win32'?os.tmpdir():'/tmp','ms-chrome-'));
const stderrFile=path.join(profile,'chromium.stderr.log');
fs.mkdirSync(path.join(profile,'config'),{recursive:true});fs.mkdirSync(path.join(profile,'cache'),{recursive:true});
const chrome = spawn(resolveChromeExecutable(), [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
], { windowsHide: true, env:{...process.env,TMPDIR:socketTmp,XDG_CONFIG_HOME:path.join(profile,'config'),XDG_CACHE_HOME:path.join(profile,'cache')},stdio:['ignore','ignore',fs.openSync(stderrFile,'a')] });
let chromeExit = null;
chrome.on('error',error=>{chromeExit={error:error.message}});
chrome.on('exit', (code, signal) => { chromeExit = { code, signal }; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
const watchdog = setTimeout(() => { console.error('Browser test timed out'); chrome.kill(); process.exit(1); }, 45000);

(async () => {
  let port;
  for (let i = 0; i < 120; i += 1) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch (_) {}
    if (chromeExit) break;
    await pause(100);
  }
  if (!port && chromeExit) {
    console.log(JSON.stringify({ test: 'source_review_dock_browser', result: 'NOT_RUN', reason: 'Chrome exited before exposing DevTools', chromeExit, stderrFile }));
    process.exitCode = 77;
    return;
  }
  assert.ok(port, 'Chrome DevTools endpoint starts');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const result = pending.get(message.id);
    pending.delete(message.id);
    message.error ? result.reject(new Error(JSON.stringify(message.error))) : result.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };


  await call('Emulation.setDeviceMetricsOverride', { width: 380, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.body.innerHTML='<main id="host"><button id="hostButton">채팅 계속하기</button><div id="settings"></div></main>';document.body.style='margin:0;padding:16px;font:16px system-ui;background:#eef2f4;color:#243442';document.getElementById('host').style='transform:translateZ(0);isolation:isolate;position:relative;z-index:1;max-width:100%';document.getElementById('hostButton').focus();window.xss=0;`);
  await evaluate(fs.readFileSync(path.join(program,'sdk/MemorySuiteSourceInput.libra.source.js'),'utf8'));
  for(const owner of ['libra','hayaku','flashback']){
    await evaluate(`(async()=>{
      document.getElementById('settings').replaceChildren();window.reads=0;window.writes=0;
      window.raw='Alice <draft>signed.</draft> <img src=x onerror="window.xss=1"><script>window.xss=2</script>';
      window.stored=JSON.stringify({sourceRules:{version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]}});
      window.policy=createMemorySuiteSourceInputPolicy({owner:${JSON.stringify(owner)},read:async()=>stored,write:async body=>{writes++;stored=body;return true},readSample:async()=>{reads++;return{text:raw,label:'T32'}}});
      policy.mountControls(document.getElementById('settings'));await policy.ready();await Promise.resolve();policy.mountControls(document.getElementById('settings'));
    })()`);
    const initial=await evaluate(`({owner:document.querySelector('[data-source-input-controls]')?.dataset.sourceInputControls,count:document.querySelectorAll('[data-source-input-controls]').length,reads,writes,focus:document.activeElement.id,history:document.querySelectorAll('.ms-source-event').length,dialog:!!document.querySelector('#memorySuiteSourceReview'),dock:!!document.querySelector('[x-memory-suite-source-review-dock]'),hidden:document.querySelector('[data-source-input-output]').hidden})`);
    assert.equal(initial.owner,owner);assert.equal(initial.count,1,'mount is idempotent');assert.equal(initial.reads,0,'opening settings does not observe source');assert.equal(initial.writes,0);assert.equal(initial.focus,'hostButton');assert.equal(initial.history,0);assert.equal(initial.dialog,false);assert.equal(initial.dock,false);assert.equal(initial.hidden,true);
    await evaluate(`document.querySelector('[data-source-input-preview]').onclick()`);
    const viewed=await evaluate(`({text:document.querySelector('[data-source-input-output]').textContent,raw,reads,writes,executable:document.querySelector('[data-source-input-output]').querySelectorAll('img,script').length,xss,stored})`);
    assert.equal(viewed.text,viewed.raw,'raw preview is exact literal text');assert.equal(viewed.reads,1);assert.equal(viewed.writes,0);assert.equal(viewed.executable,0);assert.equal(viewed.xss,0);assert.equal(viewed.stored.includes('Alice'),false,'preview source is not persisted');
    await evaluate(`(()=>{const input=document.querySelector('[data-rule-value]');input.value='draft';input.oninput();return true})()`);
    await evaluate('new Promise(resolve=>setTimeout(resolve,25))');
    const draft=await evaluate(`({text:document.querySelector('[data-source-input-output]').textContent,reads,writes,apply:document.querySelector('[data-source-input-apply]').disabled,status:document.querySelector('[data-source-input-preview-status]').textContent})`);
    assert.equal(draft.text.includes('signed.'),false);assert.ok(draft.text.includes('<img'));assert.equal(draft.reads,1,'warm draft preview uses only the explicitly selected sample');assert.equal(draft.writes,0);assert.equal(draft.apply,false);assert.ok(draft.status.includes('아직 적용하지 않은 규칙'));
    await evaluate(`document.querySelector('[data-source-input-apply]').onclick()`);
    const saved=await evaluate(`({rules:JSON.parse(stored).sourceRules,writes,raw,executable:document.querySelectorAll('#settings img,#settings script').length,xss,scroll:document.documentElement.scrollWidth,width:window.innerWidth})`);
    assert.deepEqual(saved.rules.ignoredTags,['draft']);assert.equal(saved.writes,1);assert.equal(saved.raw,viewed.raw);assert.equal(saved.executable,0);assert.equal(saved.xss,0);assert.ok(saved.scroll<=saved.width,'inline source controls fit viewport');
    await evaluate(`policy.dispose();document.getElementById('hostButton').focus()`);
  }
  console.log(JSON.stringify({test:'source_review_manual_stacking_context_browser_test',result:'pass',browser:'Chromium',owners:3,viewport:380,contract:'explicit local source input preview, durable owner rules, literal markup, inline host surface',artifacts:out}));
  await call('Browser.close');
})().catch(error=>{console.error(error);process.exitCode=1})
 .finally(()=>{clearTimeout(watchdog);ws?.close();chrome.kill()});
