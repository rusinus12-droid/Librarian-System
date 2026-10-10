'use strict';
// A failed minifier must refuse the artifact and fail the release gate, even with empty stderr.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-refusal-exit-'));
try {
  // The builder launches the pinned Terser package with process.execPath. Supply
  // a package with the same declared version so this test faults that real path,
  // rather than the former npx command which the builder no longer calls.
  const modulesDir = path.join(dir, 'node_modules');
  const packageDir = path.join(modulesDir, 'terser');
  const binDir = path.join(packageDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'terser', version: '5.51.2', main: 'index.js', bin: { terser: 'bin/terser.js' }
  }));
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {};\n');
  const shim = path.join(binDir, 'terser.js');
  const nodePath = [modulesDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  for (const [name, stderr] of [['silent', false], ['diagnostic', true]]) {
    const script = `${stderr ? "process.stderr.write('simulated_failure\\n');\n" : ''}process.exit(23);\n`;
    fs.writeFileSync(shim, script);
    const outDir = path.join(dir, name);
    const resolver = spawnSync(process.execPath, ['-e', [
      `const build = require(${JSON.stringify(path.join(__dirname, '../tools/build_plugins.cjs'))});`,
      "process.stdout.write(build.resolveNpmPackageBin('terser', 'terser', '5.51.2') || '');"
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, NODE_PATH: nodePath } });
    assert.equal(resolver.status, 0, `${name}: pinned Terser resolver must run`);
    assert.equal(path.resolve(resolver.stdout.trim()), shim, `${name}: injected minifier must be selected`);
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../tools/build_plugins.cjs'), '--plugin', 'hayaku', '--out', outDir
    ], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, NODE_PATH: nodePath }
    });
    assert.equal(result.error, undefined, `${name}: ${String(result.error)}`);
    const report = JSON.parse(fs.readFileSync(path.join(outDir, 'ultralight-build-report.json'), 'utf8'));
    assert.equal(report.rows.length, 1, name);
    assert.equal(report.rows[0].wrote, false, `${name}: a failed minifier must not produce an artifact`);
    assert.match(report.rows[0].refused, /minify failed/, name);
    assert.notEqual(result.status, 0, `${name}: a refused build must not return success`);
    assert.match(result.stdout, /0\/1 built artifacts within their measured floor/, name);
  }
  console.log('build_plugins_refusal_exit_test: PASS');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
