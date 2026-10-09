'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),css=require('rrweb-cssom');
test('the active WM settings stylesheet parses completely, including narrow-screen media rules',()=>{
 const source=fs.readFileSync(process.env.WM_GUI_CSS_SOURCE||path.join(__dirname,'../src/parts/15-gui-and-exports.js'),'utf8');
 const marker='const GUI_CSS = `',from=source.indexOf(marker);assert.notEqual(from,-1,'actual stylesheet declaration exists');
 const end=source.indexOf('`;',from+marker.length);assert.notEqual(end,-1,'actual stylesheet terminates');
 const stylesheet=source.slice(from+marker.length,end);assert.equal(stylesheet.includes('${'),false,'no unevaluated template substitutions');
 const parsed=css.parse(stylesheet);assert(parsed.cssRules.length>100,'complete populated stylesheet parsed');
 const rules=[...parsed.cssRules];assert(rules.some(r=>r.selectorText==='.hdr-brand'),'rules after narrow-screen media block remain present');
 assert(rules.some(r=>r.media&&r.media.mediaText.includes('780px')),'narrow-screen media rule retained');
});
