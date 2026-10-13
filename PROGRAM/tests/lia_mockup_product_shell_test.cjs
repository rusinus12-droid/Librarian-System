'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins/LIA_Persona_Linker.js'), 'utf8');
const mockupPath = path.join(program, 'docs/gui-redesign');
const mockup = fs.readFileSync(path.join(mockupPath, 'lia.html'), 'utf8');
function readConst(name) {
  const match = source.match(new RegExp(`^  const ${name} = (".*");$`, 'm'));
  assert.ok(match, `${name} exists in product source`);
  return JSON.parse(match[1]);
}
function appMarkup(html) {
  const start = html.indexOf('<div class="app">');
  assert.notEqual(start, -1, 'original mockup app root exists');
  let cursor = start, depth = 0;
  while (cursor < html.length) {
    const open = html.indexOf('<div', cursor), close = html.indexOf('</div>', cursor);
    assert.notEqual(close, -1, 'mockup app markup closes');
    if (open >= 0 && open < close) { depth++; cursor = open + 4; }
    else { depth--; cursor = close + 6; if (depth === 0) return html.slice(start, cursor); }
  }
  throw new Error('unclosed app markup');
}

const expectedCss = fs.readFileSync(path.join(mockupPath, 'assets/suite.css'), 'utf8')
  + fs.readFileSync(path.join(mockupPath, 'assets/themes.css'), 'utf8')
  + mockup.match(/<style>([\s\S]*?)<\/style>/)[1];
assert.equal(readConst('LIA_MOCKUP_CSS'), expectedCss, 'product CSS is byte-identical to the approved shared/theme/LIA CSS');
assert.equal(readConst('LIA_MOCKUP_APP_HTML'), appMarkup(mockup).replace(/<!--[\s\S]*?-->/g, ''), 'product DOM is the approved mockup DOM without explanatory comments');
assert.doesNotMatch(readConst('LIA_MOCKUP_APP_HTML'), /<script\b|suite\.js/i, 'mockup demo runtime is excluded');

for (const name of ['Click', 'Change', 'Input', 'Keydown'])
  assert.match(source, new RegExp(`function handleLiaMockup${name}\\s*\\(`), `delegated ${name.toLowerCase()} handler exists`);
for (const legacy of ['renderPocketHome', 'renderPocketHeader', 'syncPocketPersonaDialog', 'renderPersonaSidePanel'])
  assert.doesNotMatch(source, new RegExp(`function ${legacy}\\s*\\(`), `${legacy} legacy view generator was removed`);
for (const legacy of ['renderProviderSettings','renderIllustrationProviderSettings','renderAssetStudioPanel','renderAssetPromptEditor','renderAssetGalleryCards','renderVaultCards','renderVaultOptions'])
  assert.doesNotMatch(source,new RegExp(`function ${legacy}\\s*\\(`),`${legacy} obsolete view template was removed`);
assert.doesNotMatch(source, /data-persona-apply=/, 'opening the Persona manager cannot immediately bind a Persona');
assert.match(source, /data-lia-bind-confirm/, 'Persona binding is a separate explicit action');
assert.match(source, /data-lia-generated-cleanup/, 'generated Persona cleanup is a separate route action with a fresh confirmation and readback');
assert.match(source, /PersonaSelectionManager\.applyCard\(runtimeCtx,choice\)/, 'explicit binding uses the product owner/safety path');
assert.match(source, /saveLoreCharacterLimit\(/, 'lore length uses the ARG readback writer');
assert.match(source, /generateRandomCandidates\(\)/, 'random candidate action uses the product generator');
assert.match(source, /generateCharacterCandidates\(\)/, 'character candidate action uses the product generator');
assert.match(source, /runLLMRewrite\(\)/, 'candidate completion uses the product generator');
assert.match(source, /confirmPersonaVisualGenerationLock\(target\)/, 'Visual Lock uses the product store/API');
assert.match(source, /function updateLiaMockupPersonaDraft\(/, 'mockup field edits update the in-memory Persona draft');
assert.match(source, /rerollPersonaFields\(\[field\]\)/, 'mockup per-field regeneration uses the product reroll');
assert.match(source, /saveCurrentResultToVault\(\)/, 'editor save uses the product vault writer');
assert.match(source, /data-lia-editor-writer="vault"/, 'editor exposes an explicit local-only vault save');
assert.match(source, /data-lia-editor-writer="current"/, 'editor exposes an explicit current-chat Persona save');
assert.match(source, /data-lia-editor-writer="new"/, 'editor exposes an explicit new RisuAI Persona save');
assert.match(source, /saveEditedResultToCurrentPersona\(\)/, 'current Persona save uses existing owner/default protection and readback');
assert.match(source, /saveEditedResultAsNewPersona\(\)/, 'new Persona save uses existing DB writer and readback');
assert.match(source, /function updateLiaMockupTranslation\(/, 'translation draft has an independent state writer');
assert.match(source, /adoptPersonaFromPane\(source\)/, 'adoption uses the explicit original/translation product operation');
assert.match(source, /function hydrateLiaMockupSettings\(/, 'settings route hydrates persisted provider values, not sample values');
assert.match(source, /writeStoredLLMConfig\(/, 'text provider save uses the existing durable writer');
assert.match(source, /writeStoredIllustrationConfig\(/, 'image provider save uses the existing writer');
assert.match(source, /function hydrateLiaMockupUpdate\(/, 'five-pair update route reads the current binding and plan');
assert.match(source, /runManualLivePersonaAnalysis\(\{\.\.\.fresh,manualAnalysisRange:plan\.range\}\)/, 'manual update fixes the current scope and range before running');
assert.match(source, /runPersonaEvolution\(\)/, 'full User conversation review uses the existing evolution analysis');
assert.match(source, /applySelectedPersonaEvolution\(\)/, 'selected evolution applies to draft through product logic');
assert.match(source, /importPersonaVisualAssetImage\(target,emotion,file\)/, 'per-emotion upload targets the pinned Persona and actual asset writer');
assert.match(source, /generatePersonaVisualEmotion\(fresh,emotion,\{config:cfg,expectedPersonaKey:resolved\.personaKey,expectedTargetSelection:targetSelection\}\)/, 'per-emotion regeneration uses configured provider and pins target identity');
assert.match(source, /removePersonaVisualAsset\(target,emotion\)/, 'per-emotion deletion uses actual asset store and backup cleanup');
assert.match(source, /ensurePersonaVisualAssetAvailable\(entry,\{personaKey:key,emotion,backupId:entry\.backupId,mime:entry\.mime\}\)/, 'per-emotion recovery uses the restore-aware product API and pinned target');
assert.match(source, /exportPersonaVisualAssetBundleZip\(target\)/, 'asset ZIP export uses the product export routine');
assert.match(source, /importPersonaVisualAssetBundleZip\(target,file\)/, 'asset ZIP import uses the product validated import routine');
assert.match(source, /saveVisualAssetPreset\(/, 'visual presets use the product-owned local store');
assert.match(source, /deleteVisualAssetPreset\(id\)/, 'visual preset deletion uses the product writer');
assert.match(source, /readVisualAssetPresetStore\(\)/, 'visual preset view reads actual persisted presets');
assert.match(source, /liaSelectedVisualAssetPersonaKey/, 'asset actions are pinned to the selected persona identity');

console.log('lia_mockup_product_shell_test: PASS');
