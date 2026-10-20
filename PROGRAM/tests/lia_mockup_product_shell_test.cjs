'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins/LIA_Persona_Linker.js'), 'utf8');
function readConst(name) {
  const match = source.match(new RegExp(`^  const ${name} = (".*");$`, 'm'));
  assert.ok(match, `${name} exists in product source`);
  return JSON.parse(match[1]);
}
const markup = readConst('LIA_MOCKUP_APP_HTML');
assert.match(markup, /data-lia-close/, 'the main window has a dedicated close action');
assert.match(markup, /data-lia-refresh/, 'the More menu exposes a real refresh action');
assert.doesNotMatch(markup, /data-page="assets"|이미지 AI|job-neutral|job-emo/, 'retired image workspaces are absent');
assert.match(readConst('LIA_MOCKUP_CSS'), /background:transparent!important/, 'the fullscreen host canvas stays transparent');
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
assert.doesNotMatch(source, /function (?:requestIllustrationImage|generatePersonaVisualEmotion|handlePersonaEmotionAssetAfterRequest)\s*\(/, 'image provider calls and realtime emotion attachment are removed');
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
assert.match(source, /function hydrateLiaMockupUpdate\(/, 'five-pair update route reads the current binding and plan');
assert.match(source, /runManualLivePersonaAnalysis\(\{\.\.\.fresh,manualAnalysisRange:plan\.range\}\)/, 'manual update fixes the current scope and range before running');
assert.match(source, /runPersonaEvolution\(\)/, 'full User conversation review uses the existing evolution analysis');
assert.match(source, /applySelectedPersonaEvolution\(\)/, 'selected evolution applies to draft through product logic');

console.log('lia_mockup_product_shell_test: PASS');
