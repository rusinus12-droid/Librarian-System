'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const scenario = process.argv[2];
if (scenario) {
  process.env.LIBRA_CONTRACT_RUNTIME = 'node';
  (async () => {
    const { chromium } = require('./libra_contract_runtime.cjs').loadPlaywright();
    const browser = await chromium.launch(), page = await browser.newPage();
    await page.setContent('<!doctype html>');
    console.log('EVALUATE_STARTED');
    const result = await page.evaluate(async mode => {
      if (mode === 'unsettled') return new Promise(() => {});
      if (mode === 'reject') throw new Error('EXPECTED_CALLBACK_REJECTION');
      return 42;
    }, scenario);
    assert.equal(result, 42);
    console.log('ASSERTIONS_COMPLETED');
    await browser.close();
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  const results = [];
  for (const mode of ['resolve', 'reject', 'unsettled']) {
    const start = Date.now();
    const child = spawnSync(process.execPath, [__filename, mode], {
      env: { ...process.env, LIBRA_CONTRACT_RUNTIME: 'node' },
      encoding: 'utf8', timeout: mode === 'unsettled' ? 35000 : 5000
    });
    const observed = { mode, status: child.status, signal: child.signal, elapsedMs: Date.now() - start, stdout: child.stdout, stderr: child.stderr };
    results.push(observed);
    console.log(JSON.stringify(observed));
    assert.ifError(child.error);
    assert.equal(child.signal, null, mode + ': child must finish without external kill');
    assert.match(child.stdout, /EVALUATE_STARTED/);
    assert.equal(child.status, mode === 'resolve' ? 0 : 1, mode + ': incomplete evaluation must never look successful');
    if (mode === 'resolve') assert.match(child.stdout, /ASSERTIONS_COMPLETED/);
    else {
      assert.doesNotMatch(child.stdout, /ASSERTIONS_COMPLETED/);
      assert.match(child.stderr, mode === 'reject' ? /EXPECTED_CALLBACK_REJECTION/ : /CONTRACT_EVALUATE_TIMEOUT:30000ms/);
    }
  }
  console.log(JSON.stringify({ ok: true, contract: 'referenced-bounded-async-completion', scenarios: results.length }));
}
