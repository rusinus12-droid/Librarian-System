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
const chrome = spawn(resolveChromeExecutable(), [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
let chromeExit = null;
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
    console.log(JSON.stringify({ test: 'source_review_dock_browser', result: 'NOT_RUN', reason: 'Chrome exited before exposing DevTools', chromeExit }));
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

  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.body.innerHTML='<main><h2>원문 수정 내역 테스트</h2><button id="hostButton">채팅 계속하기</button><div id="settings"></div></main>';document.body.style='margin:0;padding:24px;font:16px system-ui;background:#eef2f4;color:#243442';document.getElementById('hostButton').focus();window.xss=0;`);
  await call('Runtime.evaluate', {
    expression: fs.readFileSync(path.join(program, 'sdk/MemorySuiteSourceEditConsent.source.js'), 'utf8'),
    awaitPromise: true, returnByValue: true
  });
  await evaluate(`(async()=>{
    window.units=[
      {key:'32',start:32,end:32,label:'T32',identity:'pair-32',digest:'new-32',sourceDigest:'new-32',originalDigest:'old-32',basis:'basis-32',changed:true,current:false},
      {key:'33',start:33,end:33,label:'T33',identity:'pair-33',digest:'new-33',sourceDigest:'new-33',originalDigest:'old-33',basis:'basis-33',changed:true,current:false}
    ];window.calls=[];window.prompts=0;window.evidenceReads=[];window.storage=new Map();
    window.controller=createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,externalObserver:true,preserveUntilReplacement:true,
      read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
      collect:async()=>({scopeKey:'chat-32',units:units.map(unit=>({...unit})),completedTurnIds:['logical-u32']}),
      prompt:async()=>{prompts++;throw Error('request-boundary work must not prompt');},
      execute:async(task,permit)=>{await permit.assertCurrent();calls.push(task.key);units=units.map(unit=>unit.key===task.key?{...unit,changed:false,current:true}:unit);return{ok:true};},
      loadReview:async(tasks,scopeKey)=>{evidenceReads.push({scopeKey,keys:tasks.map(task=>task.key)});return{scopeKey,rows:tasks.map(task=>task.key==='32'?{key:'32',previousUnavailable:false,beforeText:'old source <img src=x onerror="window.xss=1">',afterText:'new source <img src=x onerror="window.xss=2">'}:{key:'33',previousUnavailable:true,afterText:'current source only <script>window.xss=3</script>'})};}
    });await controller.beforeRequest();controller.mountControls(document.getElementById('settings'));return true;
  })()`);
  await evaluate('new Promise(resolve=>setTimeout(resolve,25))');

  const history = await evaluate(`({owner:document.querySelector('[data-source-tracking-controls]')?.getAttribute('data-source-tracking-controls'),mode:document.querySelector('[data-source-tracking-controls] select')?.value,items:document.querySelectorAll('.ms-source-event').length,focus:document.activeElement.id,calls:window.calls,prompts:window.prompts,modal:!!document.querySelector('#memorySuiteSourceReview'),dock:!!document.querySelector('[x-memory-suite-source-review-dock]')})`);
  assert.equal(history.owner, 'libra', 'the inline history retains the originating owner');
  assert.equal(history.mode, 'auto');
  assert.equal(history.items, 2, 'both detected edits appear in recent history');
  assert.equal(history.focus, 'hostButton', 'automatic reconciliation leaves host focus alone');
  assert.deepEqual(history.calls, ['32', '33']);
  assert.equal(history.prompts, 0);
  assert.equal(history.modal, false, 'automatic work opens no consent modal');
  assert.equal(history.dock, false, 'the history stays inside the GUI instead of adding a floating dock');
  const automaticReads = await evaluate('evidenceReads');
  assert.deepEqual(automaticReads, [{ scopeKey: 'chat-32', keys: ['32', '33'] }], 'automatic cause detection reads both newly edited turns');

  await evaluate(`(()=>{const item=[...document.querySelectorAll('.ms-source-event')].find(node=>node.querySelector('strong').textContent.startsWith('T32'));[...item.querySelectorAll('button')].find(button=>button.textContent==='원문 비교').click();return true})()`);
  const available = await evaluate(`(()=>{const item=[...document.querySelectorAll('.ms-source-event')].find(node=>node.querySelector('strong').textContent.startsWith('T32'));return{body:item.querySelector('pre')?.textContent,images:item.querySelectorAll('img,script').length,xss:window.xss,requests:evidenceReads.slice(${automaticReads.length})}})()`);
  assert.ok(available.body.includes('old source <img src=x onerror="window.xss=1">'));
  assert.ok(available.body.includes('new source <img src=x onerror="window.xss=2">'));
  assert.equal(available.images, 0, 'source markup is rendered as text, never as executable DOM');
  assert.equal(available.xss, 0);
  assert.deepEqual(available.requests, [{ scopeKey: 'chat-32', keys: ['32'] }], 'the user-selected compare reads only that owner task');

  await evaluate(`(()=>{const item=[...document.querySelectorAll('.ms-source-event')].find(node=>node.querySelector('strong').textContent.startsWith('T33'));[...item.querySelectorAll('button')].find(button=>button.textContent==='원문 비교').click();return true})()`);
  const missing = await evaluate(`(()=>{const item=[...document.querySelectorAll('.ms-source-event')].find(node=>node.querySelector('strong').textContent.startsWith('T33'));return{body:item.querySelector('pre')?.textContent,requests:evidenceReads.slice(${automaticReads.length})}})()`);
  assert.ok(missing.body.includes('이전 전체 원문 없음'));
  assert.ok(missing.body.includes('current source only <script>window.xss=3</script>'));
  assert.equal(missing.body.includes('old source'), false, 'unavailable history never fabricates old text');
  assert.deepEqual(missing.requests, [{ scopeKey: 'chat-32', keys: ['32'] }, { scopeKey: 'chat-32', keys: ['33'] }], 'each user-selected comparison reads only its selected turn');
  assert.equal((await evaluate('window.xss')), 0);

  await evaluate(`(()=>{const item=[...document.querySelectorAll('.ms-source-event')].find(node=>node.querySelector('strong').textContent.startsWith('T32'));[...item.querySelectorAll('button')].find(button=>button.textContent==='예외 지정').click();return true})()`);
  assert.equal(await evaluate(`controller.status().tasks.find(task=>task.key==='32').excluded`), true, 'the history exception is attached to the detected revision');
  await evaluate(`(()=>{const item=[...document.querySelectorAll('.ms-source-event')].find(node=>node.querySelector('strong').textContent.startsWith('T33'));[...item.querySelectorAll('button')].find(button=>button.textContent==='내역 삭제').click();return true})()`);
  const afterDelete = await evaluate(`({events:controller.status().events.length,taskCount:controller.status().tasks.length,excluded:controller.status().tasks.find(task=>task.key==='32').excluded,secondState:controller.status().tasks.find(task=>task.key==='33').state})`);
  assert.equal(afterDelete.events, 1, 'deletion removes only the selected visible event');
  assert.equal(afterDelete.taskCount, 2, 'deleting an event does not delete its reconciliation receipt');
  assert.equal(afterDelete.excluded, true, 'deleting another event does not remove the exception');
  assert.equal(afterDelete.secondState, 'applied');
  console.log(JSON.stringify({ test: 'source_review_dock_browser', result: 'pass', browser: 'Chromium', assertions: 25, artifacts: out }));
  await call('Browser.close');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { clearTimeout(watchdog); ws?.close(); chrome.kill(); });
