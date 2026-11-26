'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PRESET_PATH = path.resolve(__dirname, '..', 'prompt', 'Leave_RisuAI_Preset.json');
const HTML_PATH = path.resolve(__dirname, '..', 'prompt', 'Leave_RisuAI_Preset.html');

// Minimal balanced-block evaluator matching Leave's RisuAI CBS subset.
const evalLeaveCbs = (template, vars = {}) => {
  const getVar = name => String(vars[name] ?? '0');
  const evalCond = expr => {
    const trimmed = expr.trim();
    if (trimmed.startsWith('{{equal::')) {
      const m = /^\{\{equal::\{\{getglobalvar::([a-z0-9_]+)\}\}::([^}]*)\}\}$/.exec(trimmed);
      if (!m) throw new Error(`Unsupported equal cond: ${trimmed}`);
      return getVar(m[1]) === m[2];
    }
    if (trimmed.startsWith('{{notequal::')) {
      const m = /^\{\{notequal::\{\{getglobalvar::([a-z0-9_]+)\}\}::([^}]*)\}\}$/.exec(trimmed);
      if (!m) throw new Error(`Unsupported notequal cond: ${trimmed}`);
      return getVar(m[1]) !== m[2];
    }
    if (trimmed.startsWith('{{any::')) {
      const inner = trimmed.slice('{{any::'.length, -2);
      const parts = inner.split('::{{').map((p, idx) => (idx === 0 ? p : `{{${p}`));
      return parts.some(evalCond);
    }
    throw new Error(`Unsupported CBS cond: ${trimmed}`);
  };

  let out = String(template || '');
  const openRe = /\{\{#if(?:_pure)?\s+/g;
  while (true) {
    openRe.lastIndex = 0;
    const match = openRe.exec(out);
    if (!match) break;
    const tagStart = match.index;
    const condStart = tagStart + match[0].length;
    let depth = 1;
    let pos = condStart;
    while (pos < out.length && depth > 0) {
      if (out.startsWith('{{', pos)) { depth += 1; pos += 2; continue; }
      if (out.startsWith('}}', pos)) { depth -= 1; pos += 2; continue; }
      pos += 1;
    }
    assert.equal(depth, 0, `Unclosed {{#if condition near ${out.slice(tagStart, tagStart + 80)}`);
    const condExpr = out.slice(condStart, pos - 2);
    const bodyStart = pos;
    let blockDepth = 1;
    let scan = bodyStart;
    let closeStart = -1;
    while (scan < out.length && blockDepth > 0) {
      const nextOpen = out.indexOf('{{#if', scan);
      const nextClose = out.indexOf('{{/if}}', scan);
      assert.ok(nextClose >= 0, `Missing {{/if}} for block at ${tagStart}`);
      if (nextOpen >= 0 && nextOpen < nextClose) {
        blockDepth += 1;
        scan = nextOpen + 5;
      } else {
        blockDepth -= 1;
        if (blockDepth === 0) closeStart = nextClose;
        scan = nextClose + '{{/if}}'.length;
      }
    }
    const innerBody = out.slice(bodyStart, closeStart);
    const replacement = evalCond(condExpr) ? evalLeaveCbs(innerBody, vars) : '';
    out = out.slice(0, tagStart) + replacement + out.slice(closeStart + '{{/if}}'.length);
  }
  return out;
};

const applyStatusRegexes = (text, regexes, stateTrackerValue) => {
  let out = text;
  for (const r of regexes) {
    const jsFlags = String(r.flag || '').replace(/<cbs>/g, '');
    const re = new RegExp(r.in, jsFlags);
    const evaluatedOut = evalLeaveCbs(r.out, { toggle_state_tracker: stateTrackerValue });
    out = out.replace(re, evaluatedOut);
  }
  return out;
};

test('Leave preset preserves 21-slot structure, adds DeepSeek adapter, and supports 3-tier Bianca toggle without duplicate NSFW bloat', () => {
  const preset = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  assert.equal(preset.promptTemplate.length, 21, 'promptTemplate retains exact 21-item layout');
  assert.ok(preset.promptTemplate[0].name.startsWith('01.'), 'block 01 at index 0');
  assert.ok(preset.promptTemplate[20].name.startsWith('09.'), 'block 09 at index 20');

  assert.match(preset.customPromptTemplateToggle, /bianca_inject=비앙카 투입 \(기본: 꺼짐\)=select=꺼짐 \(기본 · Off\),집필 규율 투입 \(추천 · 경량 · 문체·점검·성인 규율\),원본 전문 투입 \(BIANCA 페르소나 §0~§11\)/);
  assert.match(preset.customPromptTemplateToggle, /model_adapter=모델 어댑터 \(기본: 범용\)=select=범용 \(Auto · 기본\),Claude 계열,Gemini 계열,GPT 계열,DeepSeek 계열/);
  assert.match(html, /DeepSeek/);
  assert.match(html, /경량 집필 규율/);

  const baseVars = { toggle_ooc_mode: '0', toggle_gradia_compat_mode: '0', toggle_output_lang: '0', toggle_nsfw_mode: '3' };

  const b0 = evalLeaveCbs(preset.promptTemplate[8].text, { ...baseVars, toggle_bianca_inject: '0' }).trim();
  const b1 = evalLeaveCbs(preset.promptTemplate[8].text, { ...baseVars, toggle_bianca_inject: '1' });
  const b2 = evalLeaveCbs(preset.promptTemplate[8].text, { ...baseVars, toggle_bianca_inject: '2' });
  assert.equal(b0, '', 'bianca_inject=0 emits nothing');
  assert.ok(b1.length > 1500 && b1.length < 7000, `lightweight Bianca length (${b1.length}) stays compact (<7000)`);
  assert.doesNotMatch(b1, /Scrivener|대표님|의뢰인|New York/, 'lightweight Bianca excludes workspace meta-persona');
  assert.match(b1, /Checks Before Committing a Scene \(§8\)/);
  assert.match(b1, /Mature Material \(§9 Core Invariants & Registers\)/);
  assert.match(b1, /Editorial Failure Modes to Avoid \(§11\)/);
  assert.ok(b2.length > 18000, 'bianca_inject=2 preserves full original workspace persona');
  assert.match(b2, /Leave HUD & Character-Card Status Exception/);
  assert.match(b2, /Post-Prose Output Contract Preservation/);

  const nsfw0 = evalLeaveCbs(preset.promptTemplate[7].text, { ...baseVars, toggle_bianca_inject: '0' });
  const nsfw1 = evalLeaveCbs(preset.promptTemplate[7].text, { ...baseVars, toggle_bianca_inject: '1' });
  const nsfw2 = evalLeaveCbs(preset.promptTemplate[7].text, { ...baseVars, toggle_bianca_inject: '2' });
  assert.ok(nsfw0.length > 600, 'NSFW block emits full rules when Bianca is off');
  assert.ok(nsfw1.length < 300 && nsfw2.length < 300, 'NSFW block compacts to short selector when Bianca is on');
  assert.match(nsfw1, /보지 · 자지/);

  const ds01 = evalLeaveCbs(preset.promptTemplate[0].text, { ...baseVars, toggle_model_adapter: '4' });
  assert.match(ds01, /\[MODEL ADAPTER — DEEPSEEK\]/);
  assert.match(ds01, /plain-text <statusdata> block \(zero HTML\/CSS/);
});

test('Leave preset 09 anchor uses plain-text HUD, enforces Bianca override for modes 1 & 2, and auto-renders/hides <statusdata> via regex', () => {
  const preset = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
  const block09 = preset.promptTemplate[20].text;

  for (const biancaVal of ['1', '2']) {
    const out09 = evalLeaveCbs(block09, {
      toggle_ooc_mode: '0',
      toggle_gradia_compat_mode: '0',
      toggle_state_tracker: '0',
      toggle_output_lang: '0',
      toggle_bianca_inject: biancaVal
    });
    assert.match(out09, /BIANCA MODULE OVERRIDE/, `mode ${biancaVal} emits BIANCA MODULE OVERRIDE`);
    assert.match(out09, /STEP 2 — LEAVE HUD/, `mode ${biancaVal} emits STEP 2`);
    assert.doesNotMatch(out09, /<details style=/, 'STEP 2 template emits zero HTML/CSS');
    assert.match(out09, /<statusdata>\n📖 Leave HUD · \[시각\] · \[장소\]/);
    assert.match(out09, /\[☀️\]\[7°C\]/);
  }

  const statusRegexes = (preset.regex || []).filter(r => String(r?.in || '').includes('<statusdata>'));
  assert.equal(statusRegexes.length, 2, 'two <statusdata> editdisplay regex rules exist');

  const multiLineSample = '본문 마지막 문장.\n\n<statusdata>\n📖 Leave HUD · 17:20 · 음악실\n• 현장: 다인 | 묶인 팔\n• 다음 씨앗: 정문 약속\n</statusdata>\n\n[☀️][7°C][2025.03.03][PM 05:20][음악실][대화]';
  const renderedCard = applyStatusRegexes(multiLineSample, statusRegexes, '0');
  assert.match(renderedCard, /<details style=/);
  assert.match(renderedCard, /<summary [^>]*>📖 Leave HUD · 17:20 · 음악실<\/summary>/);
  assert.match(renderedCard, /• 현장: 다인 \| 묶인 팔/);
  assert.match(renderedCard, /\[☀️\]\[7°C\]\[2025\.03\.03\]\[PM 05:20\]\[음악실\]\[대화\]/);

  const hiddenTextMode = applyStatusRegexes(multiLineSample, statusRegexes, '2');
  assert.doesNotMatch(hiddenTextMode, /<statusdata>|<details/);
  assert.equal(hiddenTextMode.trim(), '본문 마지막 문장.\n\n[☀️][7°C][2025.03.03][PM 05:20][음악실][대화]');

  const legacyDetailsSample = '본문.\n\n<statusdata><details><summary>📖 Leave HUD · 14:00</summary><div>• 현장: 테스트</div></details></statusdata>';
  assert.equal(applyStatusRegexes(legacyDetailsSample, statusRegexes, '0'), legacyDetailsSample, 'legacy <details> HUD remains untouched');

  const singleLineSample = '본문.\n<statusdata>현장: 음악실</statusdata>';
  const singleCard = applyStatusRegexes(singleLineSample, statusRegexes, '0');
  assert.match(singleCard, /<summary [^>]*>📖 Leave HUD<\/summary>.*현장: 음악실/);
  assert.equal(applyStatusRegexes(singleLineSample, statusRegexes, '2').trim(), '본문.');
});
