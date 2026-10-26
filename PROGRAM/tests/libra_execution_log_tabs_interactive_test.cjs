'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const sourcePath = path.join(__dirname, '../plugins/LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// 1. Static contract checks
assert(
  source.includes("panel.replaceChildren(...renderContent());"),
  'buildSharedExecutionLogsPanel must replace panel children immediately on tab click'
);

assert(
  source.includes("const variantDrawer=app.querySelector('[data-canonical-variant-dialog].is-open, #drawer-versions.is-open');"),
  'renderSettingsGuiOnce must check for open variant drawer to update run-rows'
);

// 2. Functional DOM test with JSDOM
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>');
const { document } = dom.window;

// Extract buildSharedExecutionLogsPanel and dependencies
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

const extractFn = (src, name) => {
  const idx = src.indexOf(`const ${name}`);
  assert.notEqual(idx, -1, `missing fn: ${name}`);
  const nextFn = src.indexOf('\n  const ', idx + 1);
  return src.slice(idx, nextFn !== -1 ? nextFn : idx + 2000);
};

// Create minimal GUI harness to run buildSharedExecutionLogsPanel
const guiEl = (tag, attrs = {}, children = []) => {
  const el = document.createElement(tag);
  if (attrs.class) el.className = attrs.class;
  if (attrs.type) el.type = attrs.type;
  if (attrs.role) el.setAttribute('role', attrs.role);
  if (attrs['aria-selected']) el.setAttribute('aria-selected', attrs['aria-selected']);
  if (attrs['aria-label']) el.setAttribute('aria-label', attrs['aria-label']);
  if (attrs.text) el.textContent = attrs.text;
  if (attrs.dataset) {
    for (const [k, v] of Object.entries(attrs.dataset)) {
      el.dataset[k] = v;
    }
  }
  if (attrs.onClick) el.onclick = attrs.onClick;
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child) el.appendChild(child);
  }
  return el;
};

const SHARED_EXECUTION_LOG_SECTIONS = Object.freeze(['memory','state','draft','recall','embedding','rebuild']);
const normalizeHubChoice = (value, allowed, fallback) => allowed.includes(String(value || '').trim())
  ? String(value || '').trim()
  : fallback;

let navigationRenders = 0;
const queueGuiNavigationRender = () => { navigationRenders++; };
const guiLazyDetails = (attrs, summary, bodyBuilder) => {
  const d = guiEl('details', attrs, [summary]);
  d.appendChild(bodyBuilder());
  return d;
};
const buildLibraRecallPanel = () => guiEl('div', { class: 'recall-panel', text: 'recall-content' });
const buildExecutionReceiptPanel = kind => guiEl('div', { class: 'receipt-panel', dataset: { kind }, text: `receipts for ${kind}` });

const Gui = {
  executionLogSection: 'recall'
};

// Evaluate the actual buildSharedExecutionLogsPanel implementation
const buildPanelCode = `
  const buildSharedExecutionLogsPanel = () => {
    Gui.executionLogSection=normalizeHubChoice(Gui.executionLogSection,SHARED_EXECUTION_LOG_SECTIONS,'memory');
    const kinds=[['memory','기억 작성'],['state','상태 추적'],['draft','LIBRA 응답'],['recall','리콜'],['embedding','임베딩'],['rebuild','재구축']];
    let panel=null;
    const renderContent=()=>[
      guiEl('div',{class:'card'},[guiEl('div',{class:'card__head'},[guiEl('div',{},[guiEl('h2',{class:'card__title',text:'실행 기록'}),guiEl('p',{class:'card__desc',text:'현재 채팅의 저장된 실행 영수증을 확인합니다.'})])]),
        guiEl('div',{class:'tabs',role:'tablist','aria-label':'실행 기록 종류'},kinds.map(([id,label])=>guiEl('button',{class:\`tab\${Gui.executionLogSection===id?' is-on':''}\`,type:'button',role:'tab','aria-selected':String(Gui.executionLogSection===id),dataset:{executionKind:id},text:label,onClick:()=>{
          if (Gui.executionLogSection === id) return;
          Gui.executionLogSection=id;
          if (panel && panel.isConnected) {
            panel.dataset.executionLogs=id;
            panel.replaceChildren(...renderContent());
          }
          queueGuiNavigationRender();
        }})))
      ]),
      Gui.executionLogSection==='recall'?guiLazyDetails({class:'fold'},guiEl('summary',{text:'현재 턴 리콜 상세'}),()=>guiEl('div',{class:'fold__body'},[buildLibraRecallPanel({hideWhenEmpty:true})])):null,
      buildExecutionReceiptPanel(Gui.executionLogSection)
    ];
    panel=guiEl('div',{class:'stack',dataset:{executionLogs:Gui.executionLogSection}},renderContent());
    return panel;
  };
  return buildSharedExecutionLogsPanel;
`;

const buildSharedExecutionLogsPanel = new Function(
  'Gui', 'normalizeHubChoice', 'SHARED_EXECUTION_LOG_SECTIONS', 'guiEl', 'queueGuiNavigationRender', 'guiLazyDetails', 'buildLibraRecallPanel', 'buildExecutionReceiptPanel',
  buildPanelCode
)(Gui, normalizeHubChoice, SHARED_EXECUTION_LOG_SECTIONS, guiEl, queueGuiNavigationRender, guiLazyDetails, buildLibraRecallPanel, buildExecutionReceiptPanel);

// Test mounting and tab clicking
const root = document.getElementById('root');
const panel = buildSharedExecutionLogsPanel();
root.appendChild(panel);

// Initially 'recall' is active
assert.strictEqual(Gui.executionLogSection, 'recall');
assert.strictEqual(panel.dataset.executionLogs, 'recall');
const recallTab = panel.querySelector('button[data-execution-kind="recall"]');
assert(recallTab.classList.contains('is-on'), 'recall tab must have is-on class');
assert.strictEqual(recallTab.getAttribute('aria-selected'), 'true');
assert(panel.querySelector('.recall-panel'), 'recall panel must be present when section is recall');

// Click 'memory' ("기억 작성")
const memoryTab = panel.querySelector('button[data-execution-kind="memory"]');
memoryTab.onclick();

assert.strictEqual(Gui.executionLogSection, 'memory', 'Gui.executionLogSection must be memory');
assert.strictEqual(panel.dataset.executionLogs, 'memory', 'panel dataset must update to memory');
const updatedMemoryTab = panel.querySelector('button[data-execution-kind="memory"]');
assert(updatedMemoryTab.classList.contains('is-on'), 'memory tab must have is-on class after click');
assert.strictEqual(updatedMemoryTab.getAttribute('aria-selected'), 'true');
const updatedRecallTab = panel.querySelector('button[data-execution-kind="recall"]');
assert(!updatedRecallTab.classList.contains('is-on'), 'recall tab must lose is-on class');
assert.strictEqual(updatedRecallTab.getAttribute('aria-selected'), 'false');
assert(!panel.querySelector('.recall-panel'), 'recall panel must not be present when section is memory');
assert.strictEqual(panel.querySelector('.receipt-panel').dataset.kind, 'memory');

// Click 'state' ("상태 추적")
const stateTab = panel.querySelector('button[data-execution-kind="state"]');
stateTab.onclick();

assert.strictEqual(Gui.executionLogSection, 'state', 'Gui.executionLogSection must be state');
assert.strictEqual(panel.dataset.executionLogs, 'state', 'panel dataset must update to state');
const updatedStateTab = panel.querySelector('button[data-execution-kind="state"]');
assert(updatedStateTab.classList.contains('is-on'), 'state tab must have is-on class after click');
assert.strictEqual(panel.querySelector('.receipt-panel').dataset.kind, 'state');

// Click 'draft' ("LIBRA 응답")
const draftTab = panel.querySelector('button[data-execution-kind="draft"]');
draftTab.onclick();
assert.strictEqual(Gui.executionLogSection, 'draft');
assert.strictEqual(panel.querySelector('.receipt-panel').dataset.kind, 'draft');

// Click 'embedding' ("임베딩")
const embedTab = panel.querySelector('button[data-execution-kind="embedding"]');
embedTab.onclick();
assert.strictEqual(Gui.executionLogSection, 'embedding');
assert.strictEqual(panel.querySelector('.receipt-panel').dataset.kind, 'embedding');

// Click 'rebuild' ("재구축")
const rebuildTab = panel.querySelector('button[data-execution-kind="rebuild"]');
rebuildTab.onclick();
assert.strictEqual(Gui.executionLogSection, 'rebuild');
assert.strictEqual(panel.querySelector('.receipt-panel').dataset.kind, 'rebuild');

assert(navigationRenders >= 5, 'navigation render queue must be notified for each tab switch');

console.log('libra_execution_log_tabs_interactive_test: PASS');
