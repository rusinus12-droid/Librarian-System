'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const extractConst = name => {
  const marker = `const ${name} =`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing helper: ${name}`);
  let quote = '';
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ';' && round === 0 && square === 0 && curly === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated helper: ${name}`);
};

assert.match(source, /const finalizeMemoryPromptProvenance = \(compiled, effectiveSystemPrompt\) => \{[\s\S]*?safeClone\(compiled\?\.provenance \|\| \{\}\)[\s\S]*?String\(base\.stage \|\| ''\)/,
  'memory prompt provenance must use outer-scope helpers');
const coreStart = source.indexOf('const LibraMemoryCore = (() =>');
assert.ok(coreStart > 0, 'memory core boundary exists');
// Source-wide literal scans falsely counted the accounting helper's local `string`.
// Execute the actual outer-scope provenance compiler with only its public dependencies.
const provenanceContext = {
  safeClone: value => JSON.parse(JSON.stringify(value)),
  PROMPT_PROFILE_DEFAULT_NAME: 'default',
  PROMPT_PROFILE_COMPILER_VERSION: 'test.compiler.v1',
  promptProfileHash: value => `hash:${JSON.stringify(value)}`
};
vm.createContext(provenanceContext);
vm.runInContext(`${extractConst('finalizeMemoryPromptProvenance')}\nthis.finalize = finalizeMemoryPromptProvenance;`, provenanceContext);
for (const stage of ['ariadne', 'character_ito', 'world_ito', 'plot_ito']) {
  const result = provenanceContext.finalize({ provenance: { stage, profileName: 'default', compiledPromptHash: `body:${stage}` } }, `system:${stage}`);
  assert.equal(result.stage, stage);
  assert.equal(result.profileBodyHash, `body:${stage}`);
  assert.match(result.effectiveSystemHash, /^hash:/);
}

const progressContext = {
  Runtime: { pipelineWorkStatus: {} },
  RISU_ENGINE_STAGE: 'risu_engine',
  pipelineWorkStageLabel: stage => stage,
  calls: [],
  updatePipelineWorkPanel: async (message, phase, options) => {
    progressContext.calls.push({ message, phase, options });
    Object.assign(progressContext.Runtime.pipelineWorkStatus, options);
    return progressContext.Runtime.pipelineWorkStatus.requestId;
  }
};
vm.createContext(progressContext);
vm.runInContext(`${extractConst('reportPipelineStageProgress')}\nthis.report = reportPipelineStageProgress;`, progressContext);

const exerciseStages = async stages => {
  progressContext.calls.length = 0;
  progressContext.Runtime.pipelineWorkStatus = {
    requestId: 41,
    busy: true,
    stagePlan: stages.slice(),
    startedStages: [],
    completedStages: [],
    currentStage: ''
  };
  for (const stage of stages) assert.equal(await progressContext.report(stage, stage.includes('aide') ? 'patch' : 'analysis', 41), true);
  assert.deepEqual(progressContext.Runtime.pipelineWorkStatus.startedStages, stages);
  assert.deepEqual(progressContext.Runtime.pipelineWorkStatus.completedStages, stages.slice(0, -1));
};

const run = async () => {
  await exerciseStages(['librarian']);
  const previousCalls=progressContext.calls.length;
  assert.equal(await progressContext.report('librarian','analysis',99),false,'stale operation progress must not repaint the current operation');
  assert.equal(progressContext.calls.length,previousCalls);

  require('./helpers/libra_active_book_routes.cjs')(source);
  for (const route of ['memory', 'characters', 'relationships', 'world', 'narrative', 'pipeline', 'ai', 'embedding', 'logs', 'settings']) {
    assert.match(source, new RegExp(`id: '${route}'`), `shared sidebar must expose ${route}`);
  }
  const sharedSidebarRegistry = (source.match(/const SHARED_SIDEBAR_PAGE_REGISTRY = Object\.freeze\(\[[\s\S]*?\n  \]\);/) || [''])[0];
  assert.ok(sharedSidebarRegistry, 'shared sidebar registry must be present');
  assert.doesNotMatch(sharedSidebarRegistry, /id: '(?:agents|custom)'/,
    'advanced editing is consolidated in the workbench rather than duplicate sidebar entries');
  assert.match(source, /SHARED_SIDEBAR_SECTIONS = Object\.freeze\(\[\.\.\.SHARED_SIDEBAR_PAGE_REGISTRY\.map\(page => page\.id\), 'custom', 'agents'\]\)/,
    'retired sidebar entries remain valid compatibility routes');
  assert.doesNotMatch(sharedSidebarRegistry, /id: 'home'/,
    'the shared sidebar must not restore the retired dashboard Home');
  assert.doesNotMatch(sharedSidebarRegistry, /id: 'convenience'/,
    'Input Writer configuration must not consume a top-level page');
  assert.match(source, /\['home','overview'\]\.includes\(requested\).*pageId:'memory'.*memoryHubSection:'read'/,
    'legacy Home navigation must land on the Memory reader workspace');
  assert.match(source, /\['continuity_state','world_manager'\]\.includes\(requested\).*pageId:'world'/,
    'legacy continuity-state navigation must land on the actual World workspace');
  assert.match(source, /requested==='memory_pipeline'.*pageId:'pipeline'.*pipelineHubSection:'memory_pipeline'/,
    'legacy memory-pipeline navigation must land on the shared pipeline page');
  const navigationRender = (source.match(/const queueGuiNavigationRender = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert.match(navigationRender, /Gui\.invalidations\.add\('body'\)/,
    'navigation must replace the requested main workspace');
  assert.doesNotMatch(navigationRender, /invalidations\.add\(['"](?:sidebar|mobile-navigation|rail)['"]\)/,
    'persistent navigation controls must stay mounted during page changes');
  assert.match(navigationRender, /syncGuiNavigationFeedback\(\);[\s\S]*setTimeout\(\(\) => \{[\s\S]*void renderSettingsGui\(\)\.finally/,
    'navigation selection feedback must be visible before deferred page hydration');
  assert.doesNotMatch(navigationRender, /if \(Gui\.visible\) void renderSettingsGui\(\);/,
    'navigation must not synchronously rebuild the page in the click task');
  assert.match(source, /'aria-current': active === page\.id \? 'page' : null/,
    'the selected shared sidebar item must be announced immediately');

  assert.match(source, /if \(ok === false\) \{[\s\S]*?setPipelineWorkPanel\('', 'working', 0, terminalRequestId\)/,
    'a terminal pipeline failure must explicitly close the shared host dashboard');
  assert.match(source, /const failedTerminal = String\(job\.state \|\| ''\) === 'failed'[\s\S]*?Gui\.canonicalJobDismissedId = job\.jobId/,
    'the central canonical dashboard and minimized chip must auto-dismiss on terminal failure');
  assert.match(source, /canonical_failed_run_delete_terminal_failure_only/,
    'the storage API must reject deletion of non-failed execution records');
  assert.match(source, /text: '실패 구간 새 분석'/,
    'canonical management must retain the explicit failed-batch recovery action');
  assert.doesNotMatch(source, /const buildLibraRunsPanel =/,
    'the deleted legacy execution-card panel must not be restored just to expose old controls');

  process.stdout.write('libra_pipeline_scope_navigation_quick_settings_test: PASS\n');
};

run().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
