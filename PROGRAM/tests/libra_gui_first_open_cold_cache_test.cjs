'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source, releasePattern("^\\/\\/@display-name LIBRA v{libra}\\s*$", "m"));
assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));

// Execute the actual current opening function. Removed GRADIA unread routing must not return.
const vm=require('node:vm'),{declaration}=require('./helpers/libra_navigation_contract.cjs');
const opening=declaration(source,'showSettingsGui');
assert.doesNotMatch(opening,/routeUnreadGradiaResult|gradiaGuiRuntime/,'retired response-family cold-cache dependency stays absent');
(async()=>{for(const warm of [false,true]){
 const events=[],Gui={state:warm?{runtime:{}}:null,root:{},openSerial:0,visible:false,confirmationVisible:false},context={
  Gui,LibraMemoryCore:{state:{disposed:false}},document:{getElementById:()=>Gui.root},Date,GUI_LIST_PAGE_SIZES:{},clearTimeout,
  beginLibraUiLaunch:()=>events.push('launch'),guiNowMs:()=>Date.now(),
  initSettingsGui:async()=>{throw Error('existing root should be used')},primeGuiStateFromRuntimeCache:()=>events.push('prime'),
  renderSettingsGui:async()=>events.push('cached'),renderGuiOpeningShell:()=>events.push('shell'),guiSetStatus:()=>{},forceTransparentGuiSurface:()=>events.push('surface'),
  scheduleSettingsGuiContainerShow:serial=>{assert(Gui.openPerf.firstPaintAt>0);assert.equal(serial,Gui.openSerial);events.push('show');return new Promise(()=>{})},
  scheduleSettingsGuiHydration:serial=>{assert.equal(serial,Gui.openSerial);events.push('hydrate');return new Promise(()=>{})}
 };vm.createContext(context);vm.runInContext(opening+'\nthis.open=showSettingsGui;',context);
 assert.equal(await context.open(),true,'opening returns without waiting on host show/hydration');assert.equal(Gui.visible,true);assert.equal(Gui.openPerf.firstPaintMode,warm?'cached_gui':'opening_shell');
 assert.deepEqual(events,warm?['launch','cached','surface','show','hydrate']:['launch','prime','shell','surface','show','hydrate']);
 Gui.confirmationVisible=true;const count=events.length;assert.equal(await context.open(),false);assert.equal(events.length,count,'pending confirmation cannot be replaced');
 }console.log('libra_gui_first_open_cold_cache_test: PASS actual cold/warm opening and confirmation isolation');})().catch(e=>{console.error(e);process.exitCode=1});
