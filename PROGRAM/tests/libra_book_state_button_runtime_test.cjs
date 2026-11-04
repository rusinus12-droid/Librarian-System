'use strict';
// The people, world and story pages say how far the saved memory reached the current state.
const assert = require('node:assert/strict');
const {create, pause, until} = require('./fixtures/libra_gui_memory_dom_host.cjs');

(async () => {
  let fixture;
  try {
    fixture = await create('LIBRA', 'Full', {});
    const {doc} = fixture;
    await fixture.open();
    const go = async page => { doc.querySelector(`.sidebar [data-go="${page}"]`).click(); await pause(300); };
    const button = page => doc.querySelector(`.page[data-page="${page}"] > .page-head > .page-actions > [data-book-state-progress="${page}"]`);

    for (const page of ['people', 'world', 'story']) {
      await go(page);
      await until(() => button(page), `${page} state button`);
      assert.match(button(page).querySelector('button').getAttribute('aria-label'), /^현재 상태 · (정상|확인 필요|조회 실패|확인 중)$/);
      assert.ok(button(page).querySelector('button .badge'), `${page} shows its verdict as a badge`);
      assert.equal(button(page).classList.contains('menu'), true);
      assert.equal(doc.querySelectorAll(`.page[data-page="${page}"] [data-book-state-progress]`).length, 1, `${page} has one button after rendering`);
    }
    await go('desk');
    assert.equal(doc.querySelector('.page[data-page="desk"] [data-book-state-progress]'), null, 'pages without a state domain have no button');

    // Refreshing replaces the button; the panel the user opened stays open.
    await go('people');
    const first = await until(() => button('people'), 'people button');
    first.querySelector('button').click();
    assert.equal(first.classList.contains('is-open'), true, 'the button opens its panel');
    assert.equal(first.querySelector('button').getAttribute('aria-expanded'), 'true');
    const check = [...first.querySelectorAll('.menu__panel button')].find(node => node.textContent === '다시 확인');
    assert.ok(check, 'the panel offers a read-only check');
    check.click();
    await until(() => button('people') && button('people') !== first, 'refreshed state button');
    assert.equal(button('people').classList.contains('is-open'), true, 'open state survives a refresh');
    doc.querySelector('.page[data-page="people"] .page-title').click();
    assert.equal(button('people').classList.contains('is-open'), false, 'clicking elsewhere closes the panel');
    button('people').querySelector('button').click();
    button('people').dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    assert.equal(button('people').classList.contains('is-open'), false, 'Escape closes the panel');
    assert.deepEqual(fixture.errors, []);
    console.log('PASS book pages show the current state button');
  } finally { await fixture?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
