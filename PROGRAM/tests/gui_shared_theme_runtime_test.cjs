'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
execFileSync(process.execPath,[path.join(root,'tools/sync_gui_shared.cjs'),'--check']);
const source=JSON.parse(fs.readFileSync(path.join(root,'sdk/MemorySuiteGuiShared.source.json'),'utf8'));
const attrs={},context={document:{documentElement:{style:{setProperty(){}},setAttribute(k,v){attrs[k]=v;},removeAttribute(k){delete attrs[k];}}}};
vm.createContext(context);vm.runInContext(source.theme,context);
const bridge=context.__memorySuiteTheme;
const scheme=Object.fromEntries(['bgcolor','darkbg','borderc','selected','draculared','textcolor','textcolor2','darkBorderc','darkbutton'].map(k=>[k,'#123456']));
for(const type of ['light','dark']){assert.equal(bridge.apply({...scheme,type}),true);assert.equal(attrs['data-risu-theme-type'],type);assert.equal(attrs['data-risu-theme-colors'],undefined);}
bridge.setFollowColors(true);bridge.apply({...scheme,type:'light'});assert.equal(attrs['data-risu-theme-colors'],'1');
bridge.setFollowColors(false);assert.equal(attrs['data-risu-theme-colors'],undefined,'disable must work without a host response');
const hayaku=fs.readFileSync(path.join(root,'plugins/HAYAKU_Locator_Continuity.js'),'utf8');
// Those selectors targeted the retired HAYAKU owner palette. The approved
// product now embeds the exact suite/theme/page CSS; SDK host-mode and color
// bridge behavior above stays covered independently of that visual replacement.
assert.equal(require('../tools/lib/approved_gui_css.cjs').verifyApprovedCss(root,'HAYAKU_Locator_Continuity.js',hayaku),true);
// A substituted canonical stylesheet must fail the same adoption gate. This
// checks rejection without rewriting any source, SDK input, or design asset.
const approvedSuite=fs.readFileSync(path.join(root,'docs/gui-redesign/assets/suite.css'),'utf8');
const changedSuite=approvedSuite.replace('--font-sans:', '--test-drift-font-sans:');
assert.notEqual(changedSuite,approvedSuite,'negative control changes a real design token');
const drifted=hayaku.split(JSON.stringify(approvedSuite)).join(JSON.stringify(changedSuite));
assert.notEqual(drifted,hayaku,'negative control changes the embedded suite CSS');
assert.throws(()=>require('../tools/lib/approved_gui_css.cjs').verifyApprovedCss(root,'HAYAKU_Locator_Continuity.js',drifted),/approved CSS drift/);
assert.match(source.tokens,/--ms-motion:\.2s;/);assert.ok(!source.tokens.includes('--risu-animation-speed'));
assert.match(source.tokens,/prefers-reduced-motion:reduce/);
console.log('GUI shared source and theme runtime PASS');
