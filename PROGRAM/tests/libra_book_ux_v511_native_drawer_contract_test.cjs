'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'..','plugins','LIBRA.js'),'utf8');
const between=(a,b)=>{const i=source.indexOf(a);assert.notEqual(i,-1,`missing ${a}`);const j=source.indexOf(b,i+a.length);assert.notEqual(j,-1,`missing ${b}`);return source.slice(i,j)};
// GRADIA and Input Writer were deliberately retired; active drawer behavior remains covered.
assert.doesNotMatch(source, /const buildBookQuick(?:Gradia|InputWriter)Panel\s*=/, 'retired helper drawers stay absent');
const quick=between('const buildBookQuickSettingsDrawer =','const buildBookExecutionFlowTab =');
for(const nativeFn of ['buildBookQuickLibraResponsePanel','buildBookQuickMemoryAgentsPanel']) assert.match(source,new RegExp(`const ${nativeFn} =`),`missing ${nativeFn}`);
for(const forbidden of ['buildInputAssistSettingsPanel','buildMemoryPipelinePanel','buildGradiaDraftSettingsPanel','buildLibraResponseModeSettingsPanel']) assert.doesNotMatch(quick,new RegExp(`${forbidden}\\(`),`${forbidden} must not render directly inside Book Quick Settings`);
assert.match(quick,/const definitions = \[/);
assert.doesNotMatch(quick,/id: 'ai'|id: 'embedding'|id: 'server'/,
  'AI, Embedding and Server connections are available from the sidebar Settings pages, not Quick Settings');
assert.doesNotMatch(quick,/buildBookTechnicalQuickPanel\(/,
  'technical connection panels must not be duplicated inside Quick Settings');
const flow=between('const buildBookExecutionFlowTab =','const buildBookSidebar =');
assert.doesNotMatch(flow,/buildBookQuickSettingsDrawer\(/,'Quick Settings drawer must not live inside main render region');
const render=between('async function renderSettingsGuiOnce()','const hideSettingsGui =');
assert.match(render,/data-render-region: 'book-drawer'|renderRegion: 'book-drawer'/);
assert.match(render,/const drawerRender = !previousApp \|\| requestedRegions\.has\('book-drawer'\) \|\| requestedRegions\.has\('family'\)/);
assert.doesNotMatch(render,/implicitBodyRender && Gui\.bookQuickOpen === true/,'implicit main refresh must not remount an open Book drawer');
assert.match(render,/const implicitBodyRender = !!previousApp && requestedRegions\.size === 0/);
assert.match(render,/app\.appendChild\(buildBookDrawerRegion\(\)\)/);
assert.match(render,/if \(drawerRender\).*book-drawer/);
const server=between('const buildLibraServerConnectionPanel =','const scheduleLibraPortableMemoryBackupMount =');
// Both Settings Room and Quick Settings now share the same BOOK_UX server panel.
assert.match(server,/const bookTheme = true/);
assert.doesNotMatch(server,/const bookTheme = Gui\.bookQuickOpen/);
assert.match(server,/theme: bookTheme \? 'book' : 'default'/);
assert.match(source,/const bookTheme = String\(panelOptions\.theme \|\| ''\)\.toLowerCase\(\) === 'book'/);
const settings=between('const BOOK_NATIVE_SETTINGS_SECTIONS =','const bookQuickChoiceCard =');
assert.match(settings,/buildBookNativeSettingsRoom/);
assert.match(settings,/libra-book-settings-room-shell/);
assert.match(settings,/buildBookSettingsNativeInnerPanel/);
const settingsPanel=between('const buildBookSettingsPanel =','const bookQuickChoiceCard =');
assert.match(settingsPanel,/buildBookNativeSettingsRoom\(\{ showIndex: false \}\)/,'restored sidebar owns the settings index');
assert.doesNotMatch(settingsPanel,/buildSharedSettingsShellPanel\(\)/,'visible Book Settings Room must not embed legacy shared settings shell');
assert.match(quick,/libra-book-drawer-tab/);
assert.match(quick,/libra-book-drawer-action/);
process.stdout.write('libra_book_ux_v511_native_drawer_contract_test: PASS\n');
