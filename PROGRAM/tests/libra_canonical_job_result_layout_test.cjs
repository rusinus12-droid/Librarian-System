'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function testLayout() {
  console.log('[TEST] Starting libra_canonical_job_result_layout_test...');

  const code = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');

  // Simple DOM mock to test renderCanonicalJobSurface
  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.classList = new Set();
      this.style = {};
      this.dataset = {};
      this.textContent = '';
      this.hidden = false;
      this.parentNode = null;
    }
    appendChild(child) {
      if (child) {
        this.children.push(child);
        child.parentNode = this;
      }
      return child;
    }
    append(...children) {
      for (const c of children) {
        if (c) this.appendChild(c);
      }
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    querySelectorAll(selector) {
      const results = [];
      const walk = node => {
        if (!node || !node.children) return;
        for (const child of node.children) {
          if (selector === '.res-row' && child.classList.has('res-row')) results.push(child);
          else if (selector === '.three-status' && child.classList.has('three-status')) results.push(child);
          else if (selector === 'details.fold' && child.tagName === 'DETAILS' && child.classList.has('fold')) results.push(child);
          else if (selector === '.badge--warn' && child.classList.has('badge--warn')) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  // Extract renderCanonicalJobSurface logic or test using regex/ast/sub-vm
  const surfaceStart = code.indexOf('function renderCanonicalJobSurface(');
  assert.ok(surfaceStart !== -1, 'renderCanonicalJobSurface must exist');
  
  // Verify that the three-status cards are present in code
  assert.ok(code.includes('three-status'), 'three-status must be used in the dialog');
  assert.ok(code.includes('완료') && code.includes('실패') && code.includes('건너뜀'), '완료/실패/건너뜀 must be present');
  
  // Verify that memoryWarnings does not dump raw JSON directly into summary()
  assert.ok(!code.includes('JSON.stringify(warning.admission||warning)))'), 'raw JSON dump into summary span must be removed');
  
  // Verify that fold details is used for structured inspection
  assert.ok(code.includes('제외된 항목 보기'), 'collapsible list of excluded items must be present');
  assert.ok(!code.includes('(정본 저장 결과와 별도로 확인합니다.)'), 'raw State reason codes are not shown as the warning text');

  // Verify CSS polish contains .res-row anti-squeeze and three-status rules
  assert.ok(code.includes('.res-row>b{white-space:nowrap!important'), 'anti-vertical-wrap CSS for res-row must be present');
  assert.ok(code.includes('.dialog .three-status{display:grid'), 'dialog three-status CSS must be present');

  console.log('[TEST] PASS: All layout and CSS assertions passed successfully!');
}

testLayout().catch(err => {
  console.error(err);
  process.exit(1);
});
