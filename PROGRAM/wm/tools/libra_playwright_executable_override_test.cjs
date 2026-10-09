'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, 'libra_playwright_loader.cjs'), 'utf8');
const checks = [];
function load(configured = '') {
  const calls = [];
  const chromium = { async launch(options) { assert.equal(this, chromium); calls.push(options); return 'browser'; } };
  const playwright = { chromium, marker: 'unchanged' };
  const ctx = vm.createContext({ module: { exports: {} }, process: { env: { LIBRA_PLAYWRIGHT_EXECUTABLE_PATH: configured } },
    require(name) { if (name === 'fs') return fs; if (name === 'path') return path; if (name === 'playwright') return playwright; throw new Error('unexpected dependency'); } });
  vm.runInContext(code, ctx);
  return { result: ctx.module.exports.loadPlaywright(), calls, playwright };
}
async function test(name, run) { try { await run(); checks.push({name,ok:true}); } catch(error) { checks.push({name,ok:false,error:error.message}); process.exitCode=1; } }
(async () => {
  await test('default behavior returns original Playwright', () => { const {result,playwright}=load(); assert.equal(result,playwright); });
  await test('explicit existing executable is used without changing launch security flags', async () => {
    const {result,calls}=load(process.execPath); await result.chromium.launch({ headless:true, args:['fixture-argument'], chromiumSandbox:true });
    assert.equal(calls[0].executablePath,process.execPath); assert.equal(calls[0].headless,true); assert.equal(calls[0].chromiumSandbox,true); assert.deepEqual(calls[0].args,['fixture-argument']);
  });
  await test('per-call executable keeps existing caller precedence', async () => { const {result,calls}=load(process.execPath); await result.chromium.launch({executablePath:process.execPath}); assert.equal(calls[0].executablePath,process.execPath); });
  await test('relative executable is rejected', () => assert.throws(()=>load('./chromium'),/absolute/));
  await test('nonexistent executable is rejected', () => assert.throws(()=>load('/tmp/wm-browser-does-not-exist'),/executable/));
  await test('directory is rejected', () => assert.throws(()=>load('/tmp'),/executable/));
  console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,checks},null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
