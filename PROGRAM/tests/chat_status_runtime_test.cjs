'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const create = require('../tools/memory_suite_chat_status.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));

function host({ permission = true, delayWrite = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="outside">outside</button><main></main></body>');
  const document = dom.window.document, listeners = new Map(), panels = new Map();
  let serial = 0;
  const wrap = element => element && ({
    getBoundingClientRect: async () => element.isConnected ? { left:10, top:10, right:42, bottom:42, width:32, height:32 } : { width:0, height:0 },
    addEventListener: async (type, callback) => {
      const id = ++serial;
      const listener = event => callback({ clientX:event.clientX, clientY:event.clientY });
      // Exercise the older document-delegated host contract, including target stripping.
      document.addEventListener(type, listener); listeners.set(id, { type, listener });
      return id;
    },
    removeEventListener: async (type, id) => {
      const row = listeners.get(id);
      if (row) document.removeEventListener(row.type, row.listener);
      listeners.delete(id);
    }
  });
  const api = {
    requestPluginPermission: async () => permission,
    getRootDocument: async () => ({ getElementById:async id => wrap(document.getElementById(id)), querySelector:async selector => wrap(document.querySelector(selector)) }),
    setChatPanel: async (html, { id }) => {
      await delayWrite?.(html, id);
      document.querySelector(`[data-plugin-chat-panel="${id}"]`)?.remove();
      panels.delete(id);
      if (html) {
        const section = document.createElement('section'); section.dataset.pluginChatPanel = id;
        section.innerHTML = html; document.querySelector('main').appendChild(section); panels.set(id, html);
      }
    }
  };
  return { document, api:() => api, panels, listeners,
    click(x = 20, y = 20) { document.dispatchEvent(new dom.window.MouseEvent('click', { clientX:x, clientY:y })); } };
}

test('manual close survives stage and terminal updates, and a new operation restores the panel', async () => {
  const h = host(); let dismissed = 0;
  const panel = create({ id:'libra-test', brand:'LIBRA', api:h.api, onDismiss:() => dismissed++ });
  await panel.show({ message:'분석 중', state:'working' }); await settle();
  assert.equal(h.listeners.size, 1);
  h.click(200,200); await settle(); assert.equal(h.panels.size, 1, 'unrelated host click cannot dismiss');
  h.click(); await settle(); assert.equal(h.panels.size, 0);
  assert.equal(dismissed, 1); assert.equal(h.listeners.size, 0);
  await panel.show({ message:'다음 단계', state:'working' });
  await panel.show({ message:'저장 완료', state:'done' });
  assert.equal(h.panels.size, 0);
  panel.begin(); await panel.show({ message:'새 작업', state:'working' }); await settle();
  assert.equal(h.panels.size, 1); assert.equal(h.listeners.size, 1);
  await panel.dispose(); assert.equal(h.panels.size, 0); assert.equal(h.listeners.size, 0);
});

test('keyboard activation requires focus on the owned close button', async () => {
  const h = host(), panel = create({ id:'keyboard', brand:'GRADIA', api:h.api });
  await panel.show({ message:'진행 중' }); await settle();
  h.document.getElementById('outside').focus(); h.click(0,0); await settle();
  assert.equal(h.panels.size, 1);
  h.document.getElementById('keyboard-close').focus(); h.click(0,0); await settle();
  assert.equal(h.panels.size, 0); await panel.dispose();
});

test('each owner closes only its own panel, with no shared container CSS', async () => {
  const h = host(), a = create({ id:'libra', brand:'LIBRA', api:h.api }), b = create({ id:'gradia', brand:'GRADIA', api:h.api });
  await a.show({ message:'기억 작성' }); await b.show({ message:'초안 작성' }); await settle();
  await a.dismiss(); assert.equal(h.panels.size, 1); assert(h.panels.has('gradia'));
  assert.match(h.panels.get('gradia'), /section\[data-plugin-chat-panel="gradia"\]/);
  assert.doesNotMatch(h.panels.get('gradia'), /section\[data-plugin-chat-panel="libra"\]/);
  await a.dispose(); assert(h.panels.has('gradia')); await b.dispose(); assert.equal(h.listeners.size, 0);
});

test('a dismiss queued during a slow host write wins and cannot be revived by that write', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const h = host({ delayWrite:async html => { if (html) { entered(); await gate; } } });
  const panel = create({ id:'race', brand:'LIBRA', api:h.api });
  const paint = panel.show({ message:'늦게 도착한 단계' }); await started;
  const close = panel.dismiss(); release(); await Promise.all([paint,close]); await settle();
  assert.equal(h.panels.size, 0); assert.equal(h.listeners.size, 0);
  await panel.dispose();
});

test('dispose during a slow host write removes the panel and all bindings', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const h = host({ delayWrite:async html => { if (html) { entered(); await gate; } } });
  const panel = create({ id:'unload', brand:'GRADIA', api:h.api });
  const paint = panel.show({ message:'작업' }); await started;
  const dispose = panel.dispose(); release(); await Promise.all([paint,dispose]);
  assert.equal(h.panels.size, 0); assert.equal(h.listeners.size, 0);
  assert.equal(await panel.show({ message:'unloaded' }), false);
});

test('rendering escapes model text, preserves cancel controls and starts details collapsed', async () => {
  const h = host(), panel = create({ id:'markup', brand:'GRADIA', api:h.api });
  await panel.show({ message:'<img src=x onerror=alert(1)>', result:'<script>secret</script>', state:'done', cancelId:'writer-cancel' });
  assert.equal(h.document.querySelectorAll('img,script').length, 0);
  assert(h.document.getElementById('writer-cancel'));
  assert.equal(h.document.querySelector('details').hasAttribute('open'), false);
  assert.equal(h.document.querySelector('summary').title, '<img src=x onerror=alert(1)>');
  assert.match(h.document.querySelector('.mscs-body').textContent, /<script>secret<\/script>/);
  await panel.dispose();
});

test('repeated renders replace rather than accumulate close listeners', async () => {
  const h = host(), panel = create({ id:'listeners', brand:'LIBRA', api:h.api });
  for (let i = 0; i < 12; i++) {
    await panel.show({ message:`단계 ${i}` }); await settle(); assert.equal(h.listeners.size, 1);
  }
  await panel.dispose(); assert.equal(h.listeners.size, 0);
});

test('denied mainDom and hosts without DOM APIs retain readable status without throwing', async () => {
  const h = host({ permission:false }), panel = create({ id:'permission', brand:'LIBRA', api:h.api });
  await panel.show({ message:'작업' }); await settle(); assert.equal(h.panels.size, 1); assert.equal(h.listeners.size, 0);
  await panel.dispose();
  const headless = create({ id:'headless', brand:'GRADIA', api:() => ({}) });
  assert.equal(await headless.show({ message:'작업' }), false); await headless.dispose();
});
