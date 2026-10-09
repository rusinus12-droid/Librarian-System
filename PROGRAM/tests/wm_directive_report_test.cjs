'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const build=require('../tools/build_plugins.cjs');
test('wm_directive_report_does_not_invent_a_partial_512_byte_header_line',async t=>{const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'wm-directives-'));t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));const report=await build.buildPlugins({profile:'source',only:'wm',outDir});const text=fs.readFileSync(path.join(outDir,'LIBRA_World_Manager.js'),'utf8');assert.equal(report.rows[0].directivesKept,(text.match(/^[ \t]*\/\/(?:@|!)[^\r\n]*$/gm)||[]).length)});
