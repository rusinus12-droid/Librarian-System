'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');

const sourceBetween = (startStr, endStr) => {
  const i = source.indexOf(startStr);
  const j = source.indexOf(endStr, i);
  assert.ok(i >= 0 && j > i, `Anchors not found: ${startStr} ... ${endStr}`);
  return source.slice(i, j);
};

const el = (tag, attrs = {}, children = []) => ({
  tag,
  ...attrs,
  children: (Array.isArray(children) ? children : [children]).filter(Boolean)
});
const flat = n => [n, ...(Array.isArray(n?.children) ? n.children.flatMap(flat) : [])];

const helpers = require('./helpers/libra_approved_gui_contract.cjs');
const lineageSrc = helpers.extract(source, 'buildBookHostLineagePanel');
const deskSrc = sourceBetween('  const bookReceiptRecoveryScopeKey =', '  const BOOK_NATIVE_SETTINGS_SECTIONS =');

function makeContext(snapshot, recoveryStatus) {
  const c = {
    globalThis: {},
    console,
    clearTimeout: () => {},
    setTimeout: (cb, ms) => ({ unref: () => {} }),
    guiEl: el,
    queueGuiNavigationRender: () => {},
    MemorySuiteHostLineage: {
      normalize: value => value || null
    },
    LibraMemoryCore: {
      peekSnapshot: () => snapshot,
      getReceiptRecoveryStatus: async () => recoveryStatus,
      recheckReceiptRecovery: async () => ({ status: 'verified' }),
      repairMicroPublication: async () => ({ status: 'verified' }),
      retryMicroAnalysis: async () => ({ status: 'verified' }),
      state: { worldManagerRuntimeMetaGeneration: 1 }
    },
    Gui: {
      receiptDesk: null,
      receiptDeskSerial: 0,
      visible: true,
      bookPage: 'desk'
    },
    showLibraSourceReanalysisDrawer: options => {
      c.drawerOptions = options;
    },
    openApprovedRecoveryDialog: (kind, row) => {
      c.dialogOpened = { kind, row };
    }
  };
  c.globalThis = c;
  const script = `${lineageSrc}\n${deskSrc}\nObject.assign(this, { buildBookHostLineagePanel, buildBookReceiptRecoveryPanel, bookReceiptRecoveryState, loadBookReceiptRecoveryStatus });`;
  vm.runInContext(script, vm.createContext(c));
  return c;
}

(async () => {
  console.log('Testing unified Worldline + Conversation Storage + Micro Analysis Board...');

  // Scenario 1: Branched worldline with 3 turns (forkTurn = 2)
  const branchSnapshot = {
    scope: { scopeKey: 'scope-branch', chatId: 'branch-chat', chatTitle: '지하 서고 분기' },
    hostLineage: {
      hostChatId: 'branch-chat',
      kind: 'native_branch',
      status: 'verified',
      parentChatId: 'parent-chat',
      parentName: '대도서관 본관',
      commonPrefixPairs: 2,
      path: ['parent-chat', 'branch-chat']
    },
    manifest: {
      worldlineMeta: { parentWorldlineId: 'parent-chat', forkTurn: 2 },
      memories: {}
    }
  };
  const recoveryStatus = {
    scopeKey: 'scope-branch',
    receiptStages: [
      { scopeKey: 'scope-branch', turn: 1, status: 'verified', receiptKey: 'rcpt_1', sourceDigest: 'dig_1' },
      { scopeKey: 'scope-branch', turn: 2, status: 'verified', receiptKey: 'rcpt_2', sourceDigest: 'dig_2' },
      { scopeKey: 'scope-branch', turn: 3, status: 'verified', receiptKey: 'rcpt_3', sourceDigest: 'dig_3' }
    ],
    microJobs: [
      { scopeKey: 'scope-branch', turn: 1, status: 'succeeded', receiptRef: 'rcpt_1' },
      { scopeKey: 'scope-branch', turn: 2, status: 'failed', receiptRef: 'rcpt_2' },
      { scopeKey: 'scope-branch', turn: 3, status: 'never_started', receiptRef: 'rcpt_3' }
    ]
  };

  const c1 = makeContext(branchSnapshot, recoveryStatus);
  await c1.loadBookReceiptRecoveryStatus();
  
  // 1. Host Lineage panel visual branch check
  const lineagePanel = c1.buildBookHostLineagePanel();
  const lineageNodes = flat(lineagePanel);
  const lineageTexts = lineageNodes.map(n => n.text || '').join(' ');
  assert.ok(lineageTexts.includes('상위: 대도서관 본관'), 'Lineage panel must show parent name in branch diagram');
  assert.ok(lineageTexts.includes('↳ T2 분기점'), 'Lineage panel must show fork turn in branch diagram');
  assert.ok(lineageTexts.includes('현재 분기: 지하 서고 분기'), 'Lineage panel must show active branch name');
  console.log('✓ Lineage panel renders visual branch diagram correctly');

  // 2. Receipt & Micro Recovery unified desk panel check
  const deskPanel = c1.buildBookReceiptRecoveryPanel();
  const deskNodes = flat(deskPanel);
  const deskTexts = deskNodes.map(n => n.text || '').join(' ');

  assert.ok(deskTexts.includes('WORLDLINE CONTINUITY & STORAGE'), 'Desk panel must include unified header');
  assert.ok(deskTexts.includes('총 3턴'), 'Desk panel must report total 3 turns');
  assert.ok(deskTexts.includes('영수증 저장 3/3'), 'Desk panel must report verified receipts');
  assert.ok(deskTexts.includes('Micro 완료 1/3'), 'Desk panel must report completed micro analyses');
  assert.ok(deskTexts.includes('누락 2턴'), 'Desk panel must report 2 missing/failed turns');
  assert.ok(deskTexts.includes('↳ T2 분기점'), 'Desk panel must display visual fork turn divider');
  assert.ok(deskTexts.includes('상위 승계'), 'Desk panel must identify inherited turn region');
  assert.ok(deskTexts.includes('고유 진행'), 'Desk panel must identify unique turn progression');
  console.log('✓ Unified desk summary and branch flow verified');

  // 3. Turn Timeline and Inspector check
  assert.ok(deskTexts.includes('TURN INSPECTOR'), 'Turn inspector must be mounted');
  assert.ok(deskTexts.includes('T3 보존 및 분석 상세'), 'Default active turn is T3');
  assert.ok(deskTexts.includes('원문 저장 영수증 (T3)'), 'Inspector shows T3 receipt');
  assert.ok(deskTexts.includes('Micro 기억 분석 (T3)'), 'Inspector shows T3 micro memory');

  // 4. Reanalysis button interaction check
  const reanalyzeBtn = deskNodes.find(n => n.tag === 'button' && n.text === 'T3 미크로 바로 재분석');
  assert.ok(reanalyzeBtn, 'Reanalyze button must be present in inspector');
  reanalyzeBtn.onClick();
  assert.equal(c1.drawerOptions?.kind, 'micro');
  assert.equal(c1.drawerOptions?.scopeKey, 'scope-branch');
  assert.equal(c1.drawerOptions?.startTurn, 3);
  assert.equal(c1.drawerOptions?.endTurn, 3);
  console.log('✓ Turn inspector reanalysis trigger verified');

  // 5. Selecting another turn (T2 - which has failed micro)
  c1.Gui.receiptDesk.selectedTurn = 2;
  const deskPanelT2 = c1.buildBookReceiptRecoveryPanel();
  const deskNodesT2 = flat(deskPanelT2);
  const deskTextsT2 = deskNodesT2.map(n => n.text || '').join(' ');
  assert.ok(deskTextsT2.includes('T2 보존 및 분석 상세'), 'Inspector switches to T2');
  assert.ok(deskTextsT2.includes('부모 세계선 승계 원문'), 'T2 is correctly marked as parent inherited');
  console.log('✓ Turn switching and inheritance tagging verified');

  // 6. Batch reanalysis of missing turns
  const batchBtn = deskNodes.find(n => n.tag === 'button' && n.text?.includes('누락된 2개 턴 재분석'));
  assert.ok(batchBtn, 'Batch reanalysis button must be present for missing turns');
  batchBtn.onClick();
  assert.equal(c1.drawerOptions?.kind, 'micro');
  assert.equal(c1.drawerOptions?.scopeKey, 'scope-branch');
  assert.equal(c1.drawerOptions?.startTurn, 2);
  assert.equal(c1.drawerOptions?.endTurn, 3);
  console.log('✓ Batch missing turns reanalysis trigger verified');

  // Scenario 2: Root (independent) worldline
  const rootSnapshot = {
    scope: { scopeKey: 'scope-root', chatId: 'main-chat', chatTitle: '본편 이야기' },
    hostLineage: { hostChatId: 'main-chat', kind: 'host', status: 'independent' },
    manifest: { worldlineMeta: {}, memories: {} }
  };
  const rootStatus = {
    scopeKey: 'scope-root',
    receiptStages: [{ scopeKey: 'scope-root', turn: 1, status: 'verified', receiptKey: 'r1' }],
    microJobs: [{ scopeKey: 'scope-root', turn: 1, status: 'succeeded', receiptRef: 'r1' }]
  };
  const c2 = makeContext(rootSnapshot, rootStatus);
  await c2.loadBookReceiptRecoveryStatus();
  const rootDeskPanel = c2.buildBookReceiptRecoveryPanel();
  const rootTexts = flat(rootDeskPanel).map(n => n.text || '').join(' ');
  assert.ok(rootTexts.includes('기본 세계선') && rootTexts.includes('본편 이야기'), 'Root worldline displays basic worldline indicator');
  assert.ok(rootTexts.includes('단일 연속성 · 분기 없는 독립 세계선'), 'Root worldline explains single continuity');
  assert.ok(!rootTexts.includes('상위 세계선에서 갈라진 지점'), 'Root worldline does not show branch divider');
  console.log('✓ Root worldline single continuity verified');

  console.log('\nALL UNIFIED WORLDLINE + STORAGE + MICRO ANALYSIS TESTS PASSED!');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
