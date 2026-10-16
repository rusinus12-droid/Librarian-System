'use strict';
// LIBRA zero-touch attention: one chat button only while the user has something
// to do; clicking opens a screen that shows targets and calls before anything runs.
// Manual cold start asks for confirmation with the expected call count.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const L = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const slice = (a, b) => { const i = L.indexOf(a), j = L.indexOf(b, i + a.length); assert(i >= 0 && j > i, `${a}/${b}`); return L.slice(i, j); };

const make = (overrides = {}) => {
  const log = { registered: [], removed: [], drawers: [], dialogs: [], appended: [], coldStarts: 0, statuses: [] };
  const ctx = {
    log, SETTINGS_UI_ID: 'libra-v1-settings', PUBLIC_DISPLAY_NAME: 'LIBRA',
    guiAsArray: v => Array.isArray(v) ? v : [], warn: () => {},
    settings: { enableLibrarian: true, librarianPolicy: { reviewRequired: false } },
    ranges: [],
    LibraMemoryCore: { state: { disposed: false, canonicalJob: null }, listCanonicalBatchRanges: async () => ({ scopeKey: 's', ranges: ctx.ranges }),
      startManualColdStart: async () => { log.coldStarts += 1; return { ok: true }; } },
    getLiveApi: () => ({
      registerButton: async spec => { log.registered.push(spec); return true; },
      unregisterUIPart: async id => { log.removed.push(id); return true; },
      getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0
    }),
    showSettingsGui: async () => true, showCanonicalRangeDrawer: async mode => { log.drawers.push(mode); },
    buildLibrarianConfigurationReviewPanel: () => ({ review: true }),
    guiEl: (tag, attrs = {}, children = []) => ({ tag, attrs, children: [].concat(children), append(...nodes) { this.children.push(...nodes); }, addEventListener() {}, remove() {} }),
    Gui: { app: { querySelector: () => null, appendChild: node => log.appended.push(node) }, visible: true }, queueGuiRender: () => {}, bindApprovedOverlayKeyboard: () => {},
    guiSetStatus: message => log.statuses.push(message),
    confirmApprovedOperation: async (question, options) => { log.dialogs.push({ question, options }); return ctx.confirm; }, confirm: true,
    runCanonicalGuiCommand: async (message, command) => command(),
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    ...overrides
  };
  ctx.loadSettings = async () => ctx.settings;
  const c = vm.createContext(ctx);
  vm.runInContext(slice('  const LIBRA_ATTENTION_BUTTON_ID =', '  const showSettingsGui = async () => {')
    + slice('  const runLibraColdStartWithConfirm = async () => {', '  const closeCanonicalRangeDrawer = () => {')
    + '\nObject.assign(globalThis,{libraAttentionDecision,computeLibraAttention,refreshLibraAttention,startLibraAttention,stopLibraAttention,openLibraAttention,LibraAttention,runLibraColdStartWithConfirm});', c);
  return c;
};
const range = (startTurn, status) => ({ startTurn, endTurn: startTurn + 4, status });

(async () => {
  {
    const c = make();
    const d = c.libraAttentionDecision;
    assert.equal(d({ ranges: [] }).kind, '');
    assert.equal(d({ ranges: [range(1, 'saved'), range(6, 'missing')] }).kind, '', 'the newest range is left to the automatic scan');
    const missing = d({ ranges: [range(1, 'missing'), range(6, 'missing'), range(11, 'saved'), range(16, 'missing')] });
    assert.equal(missing.kind, 'missing'); assert.equal(missing.count, 2); assert.match(missing.name, /지난 대화 2구간 기억 만들기/);
    const failed = d({ ranges: [range(1, 'missing'), range(6, 'failed'), range(11, 'missing')] });
    assert.equal(failed.kind, 'failed'); assert.match(failed.name, /기억 실패 1구간/);
    assert.equal(d({ reviewRequired: true, ranges: [range(1, 'failed')] }).kind, 'review', 'a blocking upgrade review comes first');
    assert.equal(d({ enabled: false, reviewRequired: true }).kind, '');
    assert.equal(d({ jobActive: true, ranges: [range(1, 'failed')] }).kind, '', 'no button while a job is running');
  }
  {
    // Installed into a long chat: button in the chat area, click opens the range picker with every missing range.
    const c = make();
    c.ranges = [range(1, 'missing'), range(6, 'missing'), range(11, 'missing')];
    c.startLibraAttention();
    const state = await c.refreshLibraAttention();
    assert.equal(state.kind, 'missing');
    assert.equal(c.log.registered.at(-1).location, 'chat');
    assert.equal(c.log.registered.at(-1).id, 'libra-v1-settings-attention');
    await c.refreshLibraAttention();
    assert.equal(c.log.registered.length, 1, 'same state is not re-registered');
    await c.openLibraAttention();
    assert.deepEqual(c.log.drawers, ['missing_all'], 'opens the picker; nothing runs without the user submitting it');
    assert.equal(c.log.coldStarts, 0);
    // Failure outranks missing; resolving everything removes the button.
    c.ranges = [range(1, 'failed'), range(6, 'saved'), range(11, 'missing')];
    assert.equal((await c.refreshLibraAttention()).kind, 'failed');
    await c.openLibraAttention();
    assert.equal(c.log.drawers.at(-1), 'failed');
    c.ranges = [range(1, 'saved'), range(6, 'saved'), range(11, 'missing')];
    assert.equal((await c.refreshLibraAttention()).kind, '');
    assert.equal(c.log.removed.at(-1), 'libra-v1-settings-attention');
    // Upgrade review opens its own dialog.
    c.settings.librarianPolicy.reviewRequired = true;
    assert.equal((await c.refreshLibraAttention()).kind, 'review');
    assert.equal(await c.openLibraAttention(), true);
    const flat = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(flat)] : [];
    const dialogNodes = flat(c.log.appended.at(-1));
    assert.ok(dialogNodes.some(node => node.attrs?.text === '이전 기억 지침 확인'), 'review dialog titled');
    assert.ok(dialogNodes.some(node => node.review === true), 'the existing review panel is shown in the dialog');
    await c.stopLibraAttention();
    assert.equal(c.LibraAttention.buttonSignature, '');
  }
  {
    // Manual cold start: count and calls first; cancel runs nothing.
    const c = make();
    c.ranges = [range(1, 'missing'), range(6, 'failed'), range(11, 'saved')];
    c.confirm = false;
    await c.runLibraColdStartWithConfirm();
    assert.equal(c.log.coldStarts, 0);
    assert.match(c.log.dialogs[0].question, /2개 구간/);
    assert.match(c.log.dialogs[0].options.cost, /약 2회/);
    c.confirm = true;
    await c.runLibraColdStartWithConfirm();
    assert.equal(c.log.coldStarts, 1);
    c.ranges = [range(1, 'saved')];
    await c.runLibraColdStartWithConfirm();
    assert.equal(c.log.coldStarts, 1, 'nothing to do, nothing runs');
  }
  // Classifier, cleanup and wiring.
  assert.ok(L.includes("['CONFIGURATION_REVIEW', /LIBRARIAN_CONFIGURATION_REVIEW_REQUIRED/i, '이전 기억 지침 확인 필요'"), 'upgrade review is no longer a generic failure');
  assert.ok(L.includes("text: '지난 대화 기억 만들기…', onClick: () => { void runLibraColdStartWithConfirm()"), 'empty memory page asks first');
  assert.ok(!L.includes("text: '수동 콜드스타트', onClick: () => { void runCanonicalGuiCommand("), 'manual cold start no longer starts without confirmation');
  assert.ok(L.includes("if (typeof scheduleLibraAttentionRefresh === 'function') scheduleLibraAttentionRefresh('chat_output');"));
  for (const arg of ['story_arc_preset', 'character_ito_preset', 'world_ito_preset', 'plot_ito_preset'])
    assert.ok(L.includes(`//@arg ${arg} string Retired and ignored;`), arg);
  assert.ok(L.includes('PERSISTED_AGENT_STAGE_DEFS.filter(def=>!LEGACY_MEMORY_STAGE_DEFS.some('), 'retired stages are not reported as orphan connections');
  console.log('PASS libra_zero_touch_attention_test');
})().catch(error => { console.error(error); process.exit(1); });
