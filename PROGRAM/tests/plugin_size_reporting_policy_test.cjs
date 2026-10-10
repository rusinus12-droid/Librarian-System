'use strict';
// Reverting reporting-only size policy must fail these real CLI assertions.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{test}=require('node:test');
const program=path.resolve(__dirname,'..');
const files=['HAYAKU_Locator_Continuity.js','Flashback_Memory.js','LIBRA.js','LIA_Persona_Linker.js','RETRACE.js','GRADIA.js'];
const run=(file,args)=>spawnSync(process.execPath,[path.join(program,'tools',file),...args],{encoding:'utf8',timeout:120000});
test('growth is visible but does not fail a successfully generated artifact',()=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'size-policy-build-'));
 try { const r=run('build_plugins.cjs',['--plugin','hayaku','--profile','source','--no-minify','--out',out]);
 const report=JSON.parse(fs.readFileSync(path.join(out,'ultralight-build-report.json')));assert.equal(report.rows[0].wrote,true);assert.ok(report.rows[0].overFloorBy>0);assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/WARNING/);
 } finally { fs.rmSync(out,{recursive:true,force:true}); }
});
test('standalone size report warns about growth and still fails missing artifacts',()=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'size-policy-check-'));
 try { for(const file of files)fs.writeFileSync(path.join(out,file),' '.repeat(4_000_000));
 const r=run('check_plugin_size.cjs',['--dir',out,'--json']);const report=JSON.parse(r.stdout);assert.equal(report.rows.length,6);assert.ok(report.totalOverFloor>0);assert.equal(r.status,0,r.stderr);assert.equal(report.passed,true);assert.equal(report.warnings.length,6);
 fs.unlinkSync(path.join(out,files[0]));const missing=run('check_plugin_size.cjs',['--dir',out,'--json']);assert.notEqual(missing.status,0);assert.equal(JSON.parse(missing.stdout).passed,false);
 } finally { fs.rmSync(out,{recursive:true,force:true}); }
});
test('invalid source remains a refused build with nonzero exit',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'size-policy-syntax-'));
 try {fs.mkdirSync(path.join(root,'tools'));fs.mkdirSync(path.join(root,'plugins'));fs.cpSync(path.join(program,'tools/lib'),path.join(root,'tools/lib'),{recursive:true});fs.copyFileSync(path.join(program,'tools/build_plugins.cjs'),path.join(root,'tools/build_plugins.cjs'));fs.writeFileSync(path.join(root,'plugins/HAYAKU_Locator_Continuity.js'),'//@name HAYAKU\nfunction broken( {');
 const r=spawnSync(process.execPath,[path.join(root,'tools/build_plugins.cjs'),'--plugin','hayaku','--profile','source','--no-minify','--out',path.join(root,'out')],{encoding:'utf8',timeout:120000});assert.notEqual(r.status,0);assert.ok(!fs.existsSync(path.join(root,'out/HAYAKU_Locator_Continuity.js')));assert.match(r.stdout+r.stderr,/artifact failed --check|SyntaxError/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('build and standalone report use identical unchanged historical baselines',()=>{
 const {PLUGINS}=require('../tools/build_plugins.cjs');const r=run('check_plugin_size.cjs',['--dir',path.join(program,'plugins'),'--json']);const report=JSON.parse(r.stdout);assert.deepEqual(report.floors,Object.fromEntries(Object.entries(PLUGINS).map(([id,p])=>[id,p.floor])));assert.equal(report.floors.hayaku,1788914);
});
