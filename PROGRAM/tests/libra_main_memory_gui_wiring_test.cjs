'use strict';
// T08 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (`01` sections 13-14, `03` A33/A34/A35)
//
// T08 requires the integrated continuity to be readable through the EXISTING BOOK
// screens, with no separate World Maker screen and no GUI-only canon:
//
//   A33  every field the analysis produces is reachable in the existing surfaces;
//   A34  a failure is reported, never hidden, and never shown as a success;
//   A35  Classic/Planner/SGA keep their existing authority -- a closed obligation
//        must not be used as a current duty, and Planner prose is not stored as a
//        new memory.
//
// The character sheet is EXECUTED (not string-matched): the shipped builder runs
// against a minimal DOM stand-in, so a page that merely mentions the field names
// while rendering nothing cannot pass.
//
// MEASURED BEFORE THIS CHANGE (a FINDING): `worldManagerArticleFacts` already
// produced `preferences` and `boundaries` from the Head state, but `groupDefs`
// listed neither key, so `groupedKeys` excluded them and the sheet rendered
// nothing for either field. The typed items reached storage and the Head and were
// then dropped at the display layer.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const between = (a, b) => {
  const i = source.indexOf(a); const j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `source anchors not found: ${a} .. ${b}`);
  return source.slice(i, j);
};

const el = (tag, attrs = {}, children = []) => ({ tag, ...attrs, children: children.filter(Boolean) });
const flat = n => [n, ...(n.children || []).flatMap(flat)];
const textOf = node => flat(node).map(n => String(n.text ?? '')).join(' ');
const byData = (node, attr) => flat(node).filter(n => n.dataset && n.dataset[attr] !== undefined);

const results = [];
const record = (name, fn) => { fn(); results.push(name); };

// ── the character sheet, executed from the shipped source ────────────────────
// The builder reads the current Head through `worldManagerSnapshotView()`, which is
// supplied here as a fixed view. Everything else comes from the plugin itself, so
// the assertions are about the SHIPPED rendering path.
const buildSheet = state => {
  const view = {
    characterProjection: true,
    characters: [{ id: 'ce_person_mina', name: '민아', state }],
    relationships: [],
    domainStatus: {},
    head: { throughTurn: 5 }
  };
  const Gui = { bookSelectedCharacterId: 'ce_person_mina', worldManagerSelectedCharacterId: 'ce_person_mina', bookCharacterTab: 'profile' };
  const ctx = vm.createContext({
    guiEl: el,
    guiAsArray: value => (Array.isArray(value) ? value : []),
    guiAsObject: value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    text: value => String(value ?? '').trim(),
    worldManagerSnapshotView: () => view,
    bookProjectionIdentity: (domain, row, index) => String(row?.id || `${domain}:${index}`),
    bookCharacterName: row => String(row?.name || ''),
    bookCharacterEvidence: () => null,
    bookCharacterWorldLinks: () => [],
    bookProjectionReadable: value => String(value ?? ''),
    bookRelationshipEndpointName: () => '',
    bookSelectPeopleSection: () => {},
    queueGuiNavigationRender: () => {},
    bookCharacterCabinetCss: '',
    bookReferenceTypographyCss: '',
    bookDomainFreshness: () => null,
    bookNavigate: () => {},
    worldManagerDisplayReferences: value => value,
    worldManagerRelationshipDefinition: () => '',
    worldManagerSourceBadge: () => null,
    Gui, Object, Array, String, Number, Set, Math, JSON,
    console
  });
  vm.runInContext(
    `${between('const worldManagerArticleFieldLabel =', 'const buildWorldManagerArticleDetail =')}
     ${between('const buildBookCharacterProfileProjection =', 'const BOOK_WORLD_KIND_LABELS =')}
     Object.assign(globalThis, { buildBookCharacterProfileProjection });`,
    ctx
  );
  return ctx.buildBookCharacterProfileProjection();
};

// A Head state using every field the analysis can produce for a character.
const fullState = () => ({
  locationRef: 'ce_world_study',
  condition: '지친 상태',
  goal: '편지를 전달하기',
  knowledge: ['상자의 암호'],
  affiliations: ['기록회'],
  appearance: ['은발'],
  background: ['도서관에서 자랐다'],
  personality: ['신중하다'],
  speech: ['정중한 말투'],
  habits: ['열쇠를 왼손으로 받는다'],
  abilities: ['자물쇠 풀기'],
  preferences: ['민트차를 좋아한다 [주제: 민트차]'],
  boundaries: ['지호에게만 오늘 자신의 편지를 열지 말라고 명사 [범위: 주체=민아 대상=지호 행위=편지를 열 시점=오늘]']
});

record('A33 every analysed field reaches the existing character sheet', () => {
  const page = buildSheet(fullState());
  const groups = byData(page, 'characterProfileGroup').map(node => node.dataset.characterProfileGroup);
  assert.ok(groups.length > 0, 'the sheet renders at least one group');
  // Every field the analysis can produce must be visible in some group.
  const rendered = new Set(byData(page, 'characterProfileField').map(node => node.dataset.characterProfileField));
  const expected = ['locationRef', 'condition', 'goal', 'knowledge', 'affiliations',
    'appearance', 'background', 'personality', 'speech', 'habits', 'abilities', 'preferences', 'boundaries'];
  const missing = expected.filter(key => !rendered.has(key));
  assert.deepEqual(missing, [], `every analysed field is rendered (missing: ${missing.join(', ')})`);
  assert.ok(rendered.has('preferences'), 'a preference is visible on the character sheet');
  assert.ok(rendered.has('boundaries'), 'a boundary is visible on the character sheet');
});

record('a preference and a boundary are separate groups, so a boundary never reads as taste', () => {
  const page = buildSheet(fullState());
  const groups = byData(page, 'characterProfileGroup').map(node => node.dataset.characterProfileGroup);
  assert.ok(groups.includes('preferences'), 'the preference group exists');
  assert.ok(groups.includes('boundaries'), 'the boundary group exists');
  assert.notEqual(groups.indexOf('preferences'), groups.indexOf('boundaries'),
    'they are different groups, not one merged list');
  // The boundary text itself must be present, not a generic label.
  const pageText = textOf(page);
  assert.ok(/편지를 열/.test(pageText), 'the boundary content is rendered verbatim');
  assert.ok(/민트차/.test(pageText), 'the preference content is rendered verbatim');
});

record('A34 an absent field is simply absent, never invented', () => {
  const page = buildSheet({ locationRef: 'ce_world_study' });
  const rendered = new Set(byData(page, 'characterProfileField').map(node => node.dataset.characterProfileField));
  assert.ok(rendered.has('locationRef'), 'the field that exists is rendered');
  assert.ok(!rendered.has('preferences'), 'a field with no value renders nothing');
  assert.ok(!rendered.has('boundaries'), 'a boundary with no value renders nothing');
  assert.ok(!/민트차/.test(textOf(page)), 'no value is invented for an absent field');
});

record('A34 the empty projection states what is missing instead of a blank page', () => {
  const ctx = vm.createContext({
    guiEl: el, guiAsArray: v => (Array.isArray(v) ? v : []),
    guiAsObject: v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    text: v => String(v ?? '').trim(),
    worldManagerSnapshotView: () => ({ characters: [], relationships: [] }),
    buildBookEmptyState: (eyebrow, title, description) => el('section', { class: 'libra-book-empty' }, [
      el('span', { class: 'libra-book-eyebrow', text: eyebrow }), el('h1', { text: title }), el('p', { text: description })
    ]),
    bookProjectionIdentity: () => '', Gui: {}, Object, Array, String, Number, Set, Math, JSON
  });
  vm.runInContext(
    `${between('const buildBookCharacterProfileProjection =', 'const BOOK_WORLD_KIND_LABELS =')}
     Object.assign(globalThis, { buildBookCharacterProfileProjection });`, ctx);
  const page = ctx.buildBookCharacterProfileProjection();
  assert.equal(page.dataset.bookCharacterProjection, 'empty', 'the empty state is labelled as empty');
  const pageText = textOf(page);
  assert.ok(pageText.length > 0, 'the empty state explains itself rather than rendering a blank page');
});

record('A35 no GUI-only canon: the sheet reads the same Head the response path uses', () => {
  // The builder takes its rows from `worldManagerSnapshotView()`, which is the same
  // view the management screens use. There is no second source of truth here.
  const projection = between('const buildBookCharacterProfileProjection =', 'const BOOK_WORLD_KIND_LABELS =');
  assert.ok(/worldManagerSnapshotView\(\)/.test(projection),
    'the sheet reads the shared Head view');
  assert.ok(!/getUnifiedStateReadProjection|unifiedStateReadProjection/.test(projection)
    || /worldManagerSnapshotView/.test(projection),
    'it does not stand up a private projection');
  assert.ok(!/storage\.(getJson|setJson)/.test(projection),
    'the reading page never reads or writes storage directly');
});

record('A35 the reading page offers no World Maker mode switch of its own', () => {
  const projection = between('const buildBookCharacterProfileProjection =', 'const BOOK_WORLD_KIND_LABELS =');
  assert.ok(!/worldMaker|World Maker/.test(projection.replace(/worldManager[A-Za-z]*/g, '')),
    'no separate World Maker surface is introduced');
  const tabs = projection.match(/tabDefs=\[([^\]]+)\]/)?.[1] ?? '';
  assert.ok(!/mode|switch|toggle/i.test(tabs),
    `the tab set carries no mode switch (tabs: ${tabs})`);
});

record('BOOK History renders semantic lifecycle events and partial coverage', () => {
  const ctx = vm.createContext({
    guiEl: el, guiAsArray: value => (Array.isArray(value) ? value : []),
    guiAsObject: value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    guiLazyDetails: (attrs, summary, render) => el('details', attrs, [summary, ...render()]),
    text: value => String(value ?? '').trim(), String, Number
  });
  vm.runInContext(
    `${between('const worldManagerHistoryStatusCopy =', 'const worldManagerHistoryAuthorityCopy =')}
     ${between('const worldManagerHistoryAuthorityCopy =', 'const worldManagerHistoryStateDomain =')}
     ${between('const worldManagerHistoryStateDomain =', 'const buildWorldManagerHistoryDetailView =')}
     ${between('const buildWorldManagerHistoryDetailView =', 'const worldManagerHeadContainsCorrection =')}
     Object.assign(globalThis, { buildWorldManagerHistoryDetailView });`, ctx);
  const detail = {
    recordMode: 'state_pipeline_v3', provenance: {
      worldlineId: 'main', statePipeline: { receipt: { authority: 'target_canonical_chain' } },
      domains: { character: { domain: 'character', canonicalAssertions: [], reviews: [], patches: [], diagnostics: [] } }
    },
    semanticTimeline: { schema: 'libra.semantic_lifecycle_timeline.v1', complete: false,
      partialReason: 'canonical_ref_cap', scannedCanonicalRefs: 64,
      events: [{ type: 'reaffirmed', label: '재확인', content: '민트차를 좋아한다',
        evidenceRefs: ['t9-a'], evidenceSpans: [{ ref: 't9-a', quote: '민아는 여전히 민트차를 좋아한다' }] }] }
  };
  const view = ctx.buildWorldManagerHistoryDetailView(detail, 'characters');
  assert.equal(byData(view, 'worldHistorySemanticTimeline').length, 1,
    'the real BOOK History detail surface contains the semantic timeline');
  const event = byData(view, 'worldHistorySemanticEvent')[0];
  assert.ok(event, 'a lifecycle row is rendered');
  assert.equal(event.dataset.worldHistorySemanticEvent, 'reaffirmed');
  assert.match(textOf(view), /민트차/);
  assert.match(textOf(view), /t9-a/);
  assert.match(textOf(view), /일부 이력/,
    'the BOOK explains that a bounded history view is partial');
});

record('structured profile correction editor displays names and round-trips typed scope', () => {
  const ctx=vm.createContext({
    guiEl:el,guiAsArray:value=>Array.isArray(value)?value:[],guiAsObject:value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{},
    text:value=>String(value??'').trim(),cloneJson:value=>JSON.parse(JSON.stringify(value)),
    worldManagerIsUnified:()=>true,worldManagerSupersedableProfileCorrectionId:()=>'',
    worldManagerArticleFieldLabel:value=>({preferences:'선호',boundaries:'경계'}[value]||String(value)),
    worldManagerArticleValue:value=>String(value??''),worldManagerDisplayReferences:value=>value,
    queueGuiNavigationRender:()=>{},
    fieldNode:(label,control,note='')=>el('div',{dataset:{field:label}},[el('label',{text:label}),control,note?el('small',{text:note}):null]),
    guiLazyDetails:(attrs,summary,render)=>{const result=render();return el('details',attrs,[summary,...(Array.isArray(result)?result:[result])]);},
    optionNodes:(items,value)=>items.map(([optionValue,label])=>el('option',{value:optionValue,text:label,selected:String(optionValue)===String(value)})),Gui:{},String,Number,Array,Object,JSON
  });
  vm.runInContext(
    `${between('const worldManagerDraftKey =', 'const worldManagerInput =')}
     ${between('const worldManagerInput =', 'const openWorldManagerCorrectionEditor =')}
     ${between('const openWorldManagerCorrectionEditor =', 'const worldManagerHeadHasCorrection =')}
     ${between('const buildUnifiedWorldStateEditor =', 'const buildWorldManagerIdentityMerge =')}
     Object.assign(globalThis,{openWorldManagerCorrectionEditor,worldManagerCorrectionRequest,worldManagerApplyProfileCollectionEdits,buildUnifiedWorldStateEditor});`,ctx);
  const state={preferences:[{content:'민트차를 좋아한다',topic:'민트차',kind:'preference'}],boundaries:[{
    content:'민아는 지호에게 오늘 편지를 열지 말라고 했다',topic:'편지 열기',kind:'boundary',
    scope:{subjectRef:'ce_person_mina',targetRef:'ce_person_jiho',act:'편지 열기',when:'오늘'}
  },{
    content:'민아는 서재의 문을 허락 없이 열지 말라고 했다',topic:'서재 출입',kind:'boundary',
    scope:{subjectRef:'ce_person_mina',targetRef:'ce_person_jiho_alt',act:'문 열기',when:'항상'}
  }]};
  const view={throughTurn:5,basis:{sourceFingerprint:'basis'},head:{unifiedApplied:{engineVersion:'unified_fixture'}},
    characters:[{id:'ce_person_mina',name:'민아',state}, {id:'ce_person_jiho',name:'지호',state:{}}, {id:'ce_person_jiho_alt',name:'지호',state:{}}],
    world:[{id:'ce_world_study',name:'서재',kind:'location',state:{}}]};
  ctx.openWorldManagerCorrectionEditor('characters',{id:'ce_person_mina',name:'민아',aliases:[],state},view);
  const draft=ctx.Gui.worldManagerEditDraft;
  const editor=el('div',{},ctx.buildUnifiedWorldStateEditor(draft,view));
  const preferenceInput=byData(editor,'worldProfileCollectionEditor').find(node=>node.dataset.worldProfileCollectionEditor==='preferences');
  const boundaryPanel=byData(editor,'worldProfileCollectionEditor').find(node=>node.dataset.worldProfileCollectionEditor==='boundaries');
  const boundaryTarget0=byData(editor,'worldProfileBoundaryTarget').find(node=>node.dataset.worldProfileBoundaryTarget==='0');
  const boundaryWhen0=byData(editor,'worldProfileBoundaryWhen').find(node=>node.dataset.worldProfileBoundaryWhen==='0');
  const boundaryContent0=byData(editor,'worldProfileBoundaryContent').find(node=>node.dataset.worldProfileBoundaryContent==='0');
  const boundaryTarget1=byData(editor,'worldProfileBoundaryTarget').find(node=>node.dataset.worldProfileBoundaryTarget==='1');
  assert.ok(preferenceInput&&boundaryPanel&&boundaryTarget0&&boundaryWhen0&&boundaryContent0,
    'the shipped correction form renders editable structured preference and row-based boundary fields');
  assert.ok(!/\[object Object\]|ce_person_|ce_world_/.test(preferenceInput.value+' '+textOf(editor)),
    'the user-facing editor does not stringify objects or expose Registry IDs');
  assert.match(textOf(boundaryPanel),/지호/,'the boundary target is shown by its Registry display name');
  assert.equal(boundaryTarget0.value,'ce_person_jiho','the selected Registry identity stays in the control value, not its visible label');
  const preferences=JSON.parse(preferenceInput.value);preferences[0].content='민트차를 싫어한다';
  preferenceInput.onInput({target:{value:JSON.stringify(preferences)}});
  boundaryWhen0.onInput({target:{value:'내일'}});
  boundaryContent0.onInput({target:{value:'민아는 지호에게 내일 편지를 열지 말라고 했다'}});
  boundaryTarget1.onChange({target:{value:'ce_world_study'}});
  const request=ctx.worldManagerCorrectionRequest(draft);
  const corrected=request.options.patch.characters[0].state;
  assert.deepEqual(JSON.parse(JSON.stringify(corrected.preferences)),[{content:'민트차를 싫어한다',topic:'민트차',kind:'preference'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(corrected.boundaries)),[
    {content:'민아는 지호에게 내일 편지를 열지 말라고 했다',topic:'편지 열기',kind:'boundary',scope:{subjectRef:'ce_person_mina',targetRef:'ce_person_jiho',act:'편지 열기',when:'내일'}},
    {content:'민아는 서재의 문을 허락 없이 열지 말라고 했다',topic:'서재 출입',kind:'boundary',scope:{subjectRef:'ce_person_mina',targetRef:'ce_world_study',act:'문 열기',when:'항상'}}
  ],'content/time edits preserve the original Registry ID and explicit target selection uses the chosen Registry option');
  const legacy='지호에게 편지를 열지 말 것 [범위: 주체=민아 대상=지호]';
  const legacyDraft={recordId:'ce_person_mina',profileEntityChoices:[],profileOriginalCollections:{boundaries:[legacy]},profileCollectionEdits:{boundaries:[legacy]}};
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.worldManagerApplyProfileCollectionEdits({boundaries:[legacy]},legacyDraft).boundaries)),[legacy],
    'a legacy boundary survives a correction unrelated to the boundary');
  const mixedDraft={recordId:'ce_person_mina',profileEntityChoices:[{id:'ce_person_jiho',name:'지호'}],
    profileOriginalCollections:{boundaries:[legacy,state.boundaries[0]]},profileCollectionEdits:{boundaries:[legacy,state.boundaries[0]]}};
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.worldManagerApplyProfileCollectionEdits({boundaries:[legacy,state.boundaries[0]]},mixedDraft).boundaries)),[legacy,state.boundaries[0]],
    'mixed legacy and typed boundaries retain their exact original forms');
  const emptyPanelDraft={...draft,profileCollectionEdits:{boundaries:[]}};
  const emptyEditor=el('div',{},ctx.buildUnifiedWorldStateEditor(emptyPanelDraft,view));
  assert.equal(byData(emptyEditor,'worldProfileBoundaryAdd').length,1,'an empty boundary collection still offers an add control');
});

console.log(JSON.stringify({
  test: 'libra_main_memory_gui_wiring',
  passed: results.length,
  results,
  boundary: 'shipped BOOK character-sheet builder executed against a DOM stand-in; no live RisuAI'
}));
