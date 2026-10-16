'use strict';
// Load both real plugins on an icon-only shared chat-button host. Check visible
// identity, independent dispatch, and cleanup when the other plugin is still active.
const assert = require('node:assert/strict'), { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const { create, until } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const profile = process.env.ATTENTION_TEST_PROFILE || 'Full';
const messages = n => Array.from({ length: n }, (_, i) => [
  { role: 'user', chatId: `u${i}`, data: `I ask about the library ${i}.` },
  { role: 'char', chatId: `a${i}`, data: `The librarian answers question ${i}.` }
]).flat();

for (const order of [['LIBRA', 'HAYAKU'], ['HAYAKU', 'LIBRA']]) {
  test(`${profile}: shared icon-only chat buttons remain distinct (${order.join(' first, ')})`, { timeout: 30000 }, async () => {
    const dom = new JSDOM('<!doctype html><div id="chat-buttons"></div>');
    const parts = new Map(), fixtures = {}, closed = new Set();
    const root = dom.window.document.getElementById('chat-buttons');
    try {
      for (const owner of order) {
        const f = fixtures[owner] = await create(owner, profile);
        const chat = await f.host.getChat(); chat.message = messages(owner === 'LIBRA' ? 10 : 2); chat.messages = chat.message;
        const register = f.host.registerButton.bind(f.host), unregister = f.host.unregisterUIPart.bind(f.host);
        f.host.registerButton = async (spec, callback) => {
          if (spec.location !== 'chat') return await register(spec, callback);
          assert.equal(parts.has(spec.id), false, 'one plugin cannot overwrite another registered button');
          const button = dom.window.document.createElement('button');
          button.title = spec.name; button.innerHTML = spec.icon; root.append(button);
          parts.set(spec.id, { spec, callback, button }); return { id: spec.id };
        };
        f.host.unregisterUIPart = async id => {
          parts.get(id)?.button.remove(); parts.delete(id); return await unregister(id);
        };
      }
      await until(() => parts.size === 2, 'both native attention buttons', 15000);
      const libra = [...parts.values()].find(p => p.button.querySelector('[data-memory-owner="libra"]'));
      const hayaku = [...parts.values()].find(p => p.button.querySelector('[data-memory-owner="hayaku"]'));
      assert.ok(libra && hayaku); assert.notEqual(libra.spec.id, hayaku.spec.id);
      assert.equal(libra.button.querySelector('svg text').textContent, 'L');
      assert.equal(hayaku.button.querySelector('svg text').textContent, 'H');
      assert.match(libra.button.querySelector('svg').getAttribute('aria-label'), /^LIBRA ·/);
      assert.match(hayaku.button.querySelector('svg').getAttribute('aria-label'), /^HAYAKU ·/);
      assert.match(libra.spec.name, /LIBRA.*지난 대화/); assert.match(hayaku.spec.name, /HAYAKU.*지난/);
      assert.notEqual(libra.spec.icon, hayaku.spec.icon, 'equal status badges cannot hide the owner');
      assert.equal(root.querySelectorAll('[id]').length, 0, 'SVGs introduce no shared DOM IDs');
      assert.equal(fixtures.LIBRA.wire.length + fixtures.HAYAKU.wire.length, 0, 'display does not submit a model request');
      if (process.env.ATTENTION_PREVIEW_DIR && order[0] === 'LIBRA') {
        const output = path.resolve(process.env.ATTENTION_PREVIEW_DIR); fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'registered-icons.json'), JSON.stringify({ profile, buttons: [libra.spec, hayaku.spec] }, null, 2));
      }
      // Each actual callback opens its own plugin. No paid action is confirmed.
      const beforeLibra = fixtures.LIBRA.calls.show, beforeHayaku = fixtures.HAYAKU.calls.show;
      hayaku.callback(); await until(() => fixtures.HAYAKU.calls.show > beforeHayaku, 'HAYAKU button dispatch');
      assert.equal(fixtures.LIBRA.calls.show, beforeLibra);
      libra.callback(); await until(() => fixtures.LIBRA.calls.show > beforeLibra, 'LIBRA button dispatch');
      // Unloading HAYAKU must preserve LIBRA's icon and handler.
      await fixtures.HAYAKU.close(); closed.add('HAYAKU');
      assert.equal(parts.has(hayaku.spec.id), false); assert.equal(parts.get(libra.spec.id)?.button, libra.button);
      assert.equal(root.querySelector('svg text').textContent, 'L');
      await fixtures.LIBRA.close(); closed.add('LIBRA'); assert.equal(parts.size, 0);
      assert.equal(fixtures.LIBRA.wire.length + fixtures.HAYAKU.wire.length, 0, 'opening either notification does not approve model work');
    } finally {
      for (const [owner, f] of Object.entries(fixtures)) if (!closed.has(owner)) await f.close();
      dom.window.close();
    }
  });
}
