'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const failures = [];
const check = (name, body) => {
  try {
    body();
  } catch (error) {
    failures.push(`${name}: ${error?.message || error}`);
  }
};

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

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

const readAllowedDomains = (helperName, options) => {
  const helper = extractConst(helperName);
  const declaration = helper.match(/const allowedDomains\s*=\s*[\s\S]*?;/);
  assert.ok(declaration, `${helperName} must expose an allowedDomains view policy`);
  const instrumented = helper.replace(declaration[0], `${declaration[0]}\n    return allowedDomains;`);
  const context = {
    PUBLIC_DISPLAY_NAME: 'LIBRA',
    GRADIA_PROMPT_DOMAINS: ['sga', 'input_writer'],
    PROMPT_STUDIO_OOC_DOMAIN_IDS: ['memory', 'planner', 'sga', 'input_writer']
  };
  vm.createContext(context);
  vm.runInContext(`${instrumented}\nthis.readPolicy = ${helperName};`, context);
  return Array.from(context.readPolicy(options || {}));
};

check('LIBRA Custom Prompt Studio filters to memory only after embedded Planner retirement', () => {
  assert.deepEqual(readAllowedDomains('buildLibraPromptStudioPanel', { family: 'libra' }), ['memory']);
});

check('GRADIA Custom Prompt Studio filters to memory only after embedded SGA retirement', () => {
  assert.deepEqual(readAllowedDomains('buildLibraPromptStudioPanel', { family: 'gradia' }), ['memory']);
});

check('Prompt Studio import and export honor the visible domain boundary', () => {
  const promptStudio = extractConst('buildLibraPromptStudioPanel');
  assert.match(promptStudio, /importPromptStudioJson\(\{ allowedDomains \}\)/,
    'JSON import must not reach hidden family domains');
  assert.match(promptStudio, /allowedDomains\.length < PROMPT_STUDIO_OOC_DOMAIN_IDS\.length \? null/,
    'all-domain export must be hidden on a filtered Custom or Convenience surface');
});

check('LIBRA Custom OOC filters to memory only after embedded Planner retirement', () => {
  assert.deepEqual(readAllowedDomains('renderPromptStudioOocBuilder', { family: 'libra' }), ['memory']);
});

check('GRADIA Custom OOC filters to memory only after embedded SGA retirement', () => {
  assert.deepEqual(readAllowedDomains('renderPromptStudioOocBuilder', { family: 'gradia' }), ['memory']);
});

check('Custom OOC keeps the selected domain when it is visible in the active family', () => {
  const ooc = extractConst('renderPromptStudioOocBuilder');
  assert.match(ooc, /const preferredDomain = allowedDomains\.includes\(Gui\.promptStudioDomain\)/,
    'preferred target selection must use the same family-filtered domain list');
  assert.doesNotMatch(ooc, /const preferredDomain = GRADIA_PROMPT_DOMAINS\.includes\(Gui\.promptStudioDomain\)/,
    'LIBRA Planner and common Memory must not be treated as invalid OOC selections');
});

check('Retired workshop delegates to agent settings without changing persistence', () => {
  const custom=extractConst('buildSharedCustomShellPanel');
  assert.match(custom,/migrateCustomWorkshopSelection/);
  assert.match(custom,/buildSharedAgentShellPanel/);
  assert.match(custom,/buildSharedSettingsShellPanel/);
  for(const registry of ['SHARED_SIDEBAR_PAGE_REGISTRY','BOOK_NATIVE_SETTINGS_SECTIONS','BOOK_EXTERNAL_SETTINGS_ITEMS']) {
    assert.doesNotMatch(extractConst(registry),/id: 'custom'/,registry+' must not expose the removed workshop');
  }
  const agent=extractConst('buildSharedAgentShellPanel');
  assert.match(agent,/buildMemoryPromptStudioDisclosure/);
  assert.match(extractConst('buildMemoryPromptStudioDisclosure'),/buildLibraPromptStudioPanel/);
  assert.doesNotMatch(agent,/saveGuiState\s*\(|pluginStorage|setItem\s*\(/);
});

check('Advanced prompts stay lazy, family scoped, and accessible through old workshop routes', () => {
  for(const family of ['libra','gradia']) for(const oldSection of ['memory','state','active_draft','ooc']) {
    const calls=[];
    const node=(tag,attrs={},children=[])=>({tag,attrs,children:children.filter(Boolean)});
    const context={
      Gui:{customHubSection:oldSection,bookSettingsWorkbenchSection:'custom'},
      SHARED_AGENT_HUB_SECTIONS:['memory','draft'],
      SHARED_CUSTOM_HUB_SECTIONS:['memory','state','active_draft','ooc'],
      normalizeHubChoice:(v,allowed,fallback)=>allowed.includes(v)?v:fallback,
      activeGuiResponseFamily:()=>family,
      guiEl:node,
      guiLazyDetails:(attrs,summary,open)=>({...node('details',attrs,[summary]),open,addEventListener(){}}),
      buildLibraHubTabs:()=>node('tabs'),
      buildStateTrackingAvailabilityPanel:()=>node('state'),
      buildSharedSettingsShellPanel:()=>node('settings-state'),
      buildDraftWorkspacePanel:()=>node('draft'),
      buildMemoryPipelinePanel:()=>node('memory'),
      setSharedCustomPromptDomain:domain=>calls.push(['domain',domain]),
      buildLibraPromptStudioPanel:options=>{calls.push(['prompt',JSON.parse(JSON.stringify(options))]);return node('prompt');},
      renderPromptStudioOocBuilder:options=>{calls.push(['ooc',options.family]);return node('ooc');}
    };
    vm.createContext(context);
    vm.runInContext(extractConst('buildMemoryPromptStudioDisclosure')+'\n'+extractConst('buildSharedAgentShellPanel')+'\n'+extractConst('migrateCustomWorkshopSelection')+'\n'+extractConst('buildSharedCustomShellPanel')+'\nthis.render=buildSharedCustomShellPanel;',context);
    const tree=context.render();
    assert.equal(context.Gui.bookSettingsWorkbenchSection,oldSection==='state'?'settings':'pipeline');
    assert.equal(context.Gui.agentHubSection,oldSection==='state'?undefined:'memory');
    assert.equal(calls.length,0,'rendering settings must not eagerly read or overwrite prompts');
    if(oldSection==='state'){
      assert.equal(tree.tag,'settings-state');
      assert.equal(context.Gui.settingsHubSection,'state');
      continue;
    }
    const disclosures=tree.children.filter(n=>n.tag==='details');
    for(const disclosure of disclosures) disclosure.open();
    const domain='memory';
    assert.deepEqual(calls[0],['domain',domain]);
    assert.deepEqual(calls[1],['prompt',{allowedDomains:[domain]}]);
    assert.equal(calls.length,2,'legacy draft links must not resurrect embedded OOC drafting');
  }
});

check('General diagnostics loads analysis history only after disclosure opens', () => {
  // §34 consolidated the four stacked panels into one screen whose body is built lazily. The
  // contract is unchanged and is now enforced more strongly: NO diagnostic section is built at
  // render time, and opening the body builds only the SELECTED section.
  let reads = 0;
  const node = (tag, attrs = {}, children = []) => ({ tag, attrs, children });
  const context = {
    Object, Array, String, Set,
    Gui: { diagnosticLogSection: 'state_reflection' },
    guiEl: node,
    guiLazyDetails: (attrs, summary, build) => ({ tag: 'details', attrs, children: [summary], open: () => build() }),
    buildLibraSectionLayout: (definitions, selected, onSelect, ariaLabel, panel) =>
      node('div', { class: 'layout' }, [node('rail', { selected }, []), panel]),
    buildSwallowedDiagPanel: () => { reads += 1; return node('swallowed'); },
    buildOperationalHealthPanel: () => { reads += 1; return node('health'); },
    buildDebugTab: () => { reads += 1; return node('debug'); },
    buildWorldManagerDiagnosticsPanel: () => { reads += 1; return node('history'); }
  };
  vm.createContext(context);
  vm.runInContext(
    extractConst('DIAGNOSTIC_LOG_SECTIONS') + '\n' +
    extractConst('buildDiagnosticLogSection') + '\n' +
    extractConst('buildDiagnosticLogPanel') + '\n' +
    'this.render=buildDiagnosticLogPanel;', context);
  const tree = context.render();
  assert.equal(reads, 0, 'rendering the diagnostics screen must not build any diagnostic panel');
  const disclosure = tree.children[0].children.find(n => n.tag === 'details');
  assert.ok(disclosure, 'diagnostics must remain reachable under general settings');
  disclosure.open();
  assert.equal(reads, 1, 'opening the body must build exactly the selected section');
});

check('Retired composer remains absent from settings while Book settings remain reachable',()=>{
 require('./helpers/libra_active_book_routes.cjs')(source);
 const context={Gui:{settingsHubSection:'memory'},SHARED_SETTINGS_HUB_SECTIONS:['memory'],normalizeHubChoice:(v)=>v,activeGuiResponseFamily:()=> 'libra',buildLibraMemorySettingsPanel:()=>({owner:'memory'}),guiEl:(_tag,_attrs,children)=>({children}),buildLibraSectionLayout:(_defs,_selected,_onChange,_label,panel)=>panel};
 vm.createContext(context);vm.runInContext(extractConst('buildSharedSettingsShellPanel')+'\nthis.render=buildSharedSettingsShellPanel;',context);
 assert.equal(context.render().children[0].owner,'memory','shared memory Settings dispatch must reach the retained builder');
});

check('Settings groups Input Writer, references, memory, storage, recovery, state, and diagnostics', () => {
  const settings = between('const buildSharedSettingsShellPanel =', 'const renderActiveTab =');
  for (const subsection of ['references', 'memory', 'server', 'recovery', 'transfer', 'state', 'general']) {
    assert.ok(settings.includes(`id: '${subsection}'`), `missing Settings subsection: ${subsection}`);
  }
  for (const builder of [
    'buildLibraReferenceHubPanel', 'buildLibraMemorySettingsPanel',
    'buildLibraServerConnectionPanel', 'buildLibraRecoveryPanel', 'buildTransferTab',
    'buildStateTrackingAvailabilityPanel', 'buildGeneralSettingsPanel'
  ]) assert.ok(settings.includes(`${builder}(`), `Settings must reuse ${builder}`);
  assert.doesNotMatch(settings,/buildLibraProviderPanel|buildLibraEmbeddingPanel/,'connection pages are dispatched by Book native settings');

  const general = extractConst('buildGeneralSettingsPanel');
  // §34: the diagnostics builder moved one level down into the consolidated log's dispatcher, so the
  // check follows it there. The requirement — the existing debug builder is retained — is unchanged.
  assert.match(general, /buildDiagnosticLogPanel\(\)/, 'Diagnostics must mount the consolidated log');
  const dispatcher = extractConst('buildDiagnosticLogSection');
  assert.match(dispatcher, /buildDebugTab\(\)/, 'Diagnostics must retain the existing debug builder');
});

const buildNavigationHarness = () => {
  const registryBlock = between('const SHARED_SIDEBAR_PAGE_REGISTRY =', 'const normalizeHubChoice =');
  const navigation = between('const normalizeHubChoice =', 'const normalizeBookPage =');
  const context = {
    Object,
    Array,
    String,
    Gui: {},
    LIBRA_MEMORY_PIPELINE_STAGES: ['ariadne', 'character_ito', 'world_ito', 'plot_ito'],
    LIBRA_REFERENCE_HUB_SECTIONS: ['modules', 'character_lore_exclusions', 'response_materials'],
    LIBRA_CONNECTION_HUB_SECTIONS: ['providers', 'embedding'],
    LIBRA_SETTINGS_HUB_SECTIONS: ['memory_settings', 'transfer', 'debug'],
    GRADIA_STAGE_ALIAS_MAP: { sga_shadow: 'sga_shadow' },
    refreshModuleLoreCatalog() {},
    refreshCharacterLoreCatalog() {},
    queueGuiNavigationRender() {}
  };
  vm.createContext(context);
  vm.runInContext(`${registryBlock}\n${navigation}\nthis.resolve = resolveSharedNavigationTarget; this.apply = applySharedNavigationTarget;`, context);
  return context;
};

for (const [route, target] of [
  ['prompt', { pageId: 'custom', customHubSection: 'memory' }],
  ['gradia_input', { pageId: 'memory', memoryHubSection: 'read' }],
  ['references', { pageId: 'settings', settingsHubSection: 'references' }],
  ['connections', { pageId: 'ai' }],
  ['server', { pageId: 'settings', settingsHubSection: 'server' }],
  ['recovery', { pageId: 'settings', settingsHubSection: 'recovery' }]
]) {
  check(`Legacy deep link ${route} lands in its exact shared subsection`, () => {
    const context = buildNavigationHarness();
    assert.deepEqual(JSON.parse(JSON.stringify(context.resolve(route))), target, `legacy route mismatch: ${route}`);
  });
}

check('Legacy Custom OOC deep link is consumed by the shared Custom shell state', () => {
  const context = buildNavigationHarness();
  context.Gui.promptHubSection = 'injection';
  context.Gui.customHubSection = 'memory';
  context.apply(context.resolve('prompt_studio_ooc'));
  assert.equal(context.Gui.sharedSidebarSection, 'custom');
  assert.equal(context.Gui.customHubSection, 'memory');
});

if (failures.length) {
  process.stderr.write(`libra_custom_convenience_settings_rc2_test: RED (${failures.length})\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('libra_custom_convenience_settings_rc2_test: PASS\n');
}
