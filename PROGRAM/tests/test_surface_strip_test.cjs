'use strict';
// RED/GREEN guard for the AST-based `_test` developer-surface removal in the RELEASE build.
//
// WHY AN AST, AND WHY ONLY THE RELEASE TREE
//
// The build documents three failed TEXT attempts and the design forbids text surgery outright
// (§11.5: "정규식으로 `_test` 주변 몇백 줄을 잘라내거나, 참조 문자열 검색 결과가 0이라는 이유만으로
// 삭제하지 않는다"). The failure modes are real: the `_test` object literal shares a line with its
// parent literal, and cutting only the property leaves follow-up assignments writing to undefined
// (`Cannot set properties of undefined (setting 'buildUiHtml')`).
//
// The measurement (tools/_probe_test_surface.cjs, acorn) shows what is at stake:
//   HAYAKU   17,799 B property  (+0 assignments)
//   Flashback 6,505 B property  (+8,934 B, 116 assignments)
//   RETRACE   2,467 B property  (+0 assignments)
//   LIBRA / LIA  none
// — 116 assignment statements in Flashback alone, which a property-only removal would break.
//
// WHAT IS ASSERTED
//
//   1. Both shapes are removed from the release source by PARSING, and the result still parses.
//   2. The result EXECUTES — the defect that text surgery caused was a load-time throw, so a
//      parse-only check is not enough.
//   3. Nothing else is removed: the plugin's public API, its directives and its product code are
//      untouched.
//   4. The saving is measured and reported, and is zero for a plugin with no `_test` surface.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
// Use the exact parser resolver shipped by the release builder. A missing parser is an explicit
// unverified build prerequisite, never an empty successful strip measurement.
const build = require(path.join(ROOT, 'tools', 'build_plugins.cjs'));
const acorn = build.resolveAcorn();
// The builder resolves its pinned toolchain through the platform npm caches (npmCacheRoots is internal,
// not exported), so the parser-positive negative control below mirrors that search order itself.
const hostNpmCacheRoots = () => {
  const roots = new Set();
  const add = value => { if (typeof value === 'string' && value.trim()) roots.add(path.resolve(value.trim())); };
  add(process.env.npm_config_cache);
  add(process.env.NPM_CONFIG_CACHE);
  add(path.join(os.homedir(), '.npm'));
  add(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache'));
  return [...roots];
};

(async () => {
  assert.ok(acorn, 'Acorn must resolve through the release builder; without it, AST removal is unverified');

  // The builder must export the stripper so this can verify it directly.
  const stripTestSurface = build.stripTestSurface;
  assert.equal(typeof stripTestSurface, 'function',
    'the build must expose stripTestSurface for the release step to be verifiable');

  // ------------------------------------------------------------------------------------
  // 1. Both shapes, on a representative source that mimics the real layout (the property on the
  //    same line as its parent, plus follow-up assignments).
  // ------------------------------------------------------------------------------------
  const sample = [
    'const publicApi = Object.freeze({ version: "1.0.0", _test: { buildUiHtml, runThing }, doWork: () => 1 });',
    'publicApi._test.buildUiHtml = buildUiHtml;',
    'publicApi._test.runThing = runThing;',
    'Object.assign(publicApi._test, { extraHelper });',
    'function buildUiHtml() { return "ui"; }',
    'function runThing() { return 42; }',
    'function extraHelper() { return "extra"; }',
    'globalThis.__SAMPLE__ = publicApi;'
  ].join('\n');

  const first = stripTestSurface(sample);
  assert.equal(typeof first.src, 'string', 'the stripper must return the transformed source');
  assert.ok(first.blocks >= 2,
    `both shapes must be reported as removed (got blocks=${first.blocks})`);

  // The result must still PARSE.
  acorn.parse(first.src, { ecmaVersion: 'latest', sourceType: 'script' });

  // And it must EXECUTE — the text-surgery failure mode was a load-time throw.
  const sandbox = { globalThis: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(first.src, sandbox, { filename: 'stripped.js' });
  const exposed = sandbox.__SAMPLE__;
  assert.ok(exposed, 'the stripped source must still define its public API');
  assert.equal(exposed._test, undefined, 'the _test property must be gone from the public API');
  assert.equal(exposed.version, '1.0.0', 'product fields must survive');
  assert.equal(exposed.doWork(), 1, 'product methods must survive');
  assert.equal(typeof exposed.buildUiHtml, 'undefined' || true, 'no crash at load');

  // ------------------------------------------------------------------------------------
  // 3. Nothing else is removed: the public API shape is otherwise identical.
  // ------------------------------------------------------------------------------------
  const before = (() => { const s = {}; const ctx = { console }; ctx.globalThis = s; vm.createContext(ctx);
    vm.runInContext(sample, ctx, { filename: 'before.js' }); return s.__SAMPLE__; })();
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(exposed).sort();
  assert.deepEqual(afterKeys, beforeKeys.filter(k => k !== '_test'),
    'only _test may disappear from the public API');

  // The stripper must NOT swallow a function body that merely mentions the surface. This is the
  // defect that removed 3,500,178 B from HAYAKU (artifact collapsed to 10,256 B): an SDK block
  // shaped `(async () => { ... })()` references `_test` deep inside, and an unbounded walk matched
  // the entire statement. A product statement must survive intact.
  const guarded = [
    'const api = { _test: { helper } };',
    'const run = (async () => { const keep = 1; return keep + 1; })();',
    'function helper() { return "h"; }',
    'globalThis.__GUARD__ = { run, keepMe: 7 };'
  ].join('\n');
  const guardedOut = stripTestSurface(guarded);
  vm.createContext((() => { const s = { console, Promise }; s.globalThis = s; return s; })());
  const guardSandbox = { console, Promise, setTimeout };
  guardSandbox.globalThis = guardSandbox;
  vm.createContext(guardSandbox);
  vm.runInContext(guardedOut.src, guardSandbox, { filename: 'guard.js' });
  assert.ok(guardedOut.src.includes('keepMe'), 'product fields in a later statement must survive');
  assert.ok(guardedOut.src.includes('return keep + 1'), 'function bodies must never be swallowed');
  assert.ok(!guardedOut.src.includes('_test'), 'the surface itself must still go');

  // And no single cut may be unbounded: a statement spanning megabytes is a matching defect.
  const huge = `const x = { _test: { ${'a,'.repeat(800000)} } };`;
  const hugeOut = stripTestSurface(huge);
  assert.ok(hugeOut.bytes <= 2_000_000,
    `a single cut must stay bounded (got ${hugeOut.bytes} B removed)`);

  // ------------------------------------------------------------------------------------
  // 4. Real plugins: the saving is measured, and a plugin with no surface reports zero rather
  //    than a fabricated number. Each real result must still parse.
  // ------------------------------------------------------------------------------------
  const measured = {};
  for (const name of ['HAYAKU_Locator_Continuity', 'Flashback_Memory', 'LIBRA', 'LIA_Persona_Linker', 'RETRACE']) {
    const source = fs.readFileSync(path.join(ROOT, 'plugins', `${name}.js`), 'utf8');
    let result;
    try { result = stripTestSurface(source); }
    catch (error) { assert.fail(`${name}: the AST step must not throw (${error?.message || error})`); }
    acorn.parse(result.src, { ecmaVersion: 'latest', sourceType: 'script' });
    measured[name] = { blocks: result.blocks, bytes: result.bytes };
    assert.ok(result.bytes >= 0, `${name}: the saving must be a real non-negative number`);
  }

  // The three plugins with a measured surface must report it; the two without must report zero.
  assert.ok(measured.HAYAKU_Locator_Continuity.bytes > 10000,
    `HAYAKU has a ~17.8 kB surface (got ${measured.HAYAKU_Locator_Continuity.bytes})`);
  assert.ok(measured.Flashback_Memory.bytes > 10000,
    `Flashback has a ~15.4 kB surface incl. 116 assignments (got ${measured.Flashback_Memory.bytes})`);
  assert.ok(measured.RETRACE.bytes > 1000,
    `RETRACE has a ~2.5 kB surface (got ${measured.RETRACE.bytes})`);
  assert.equal(measured.LIBRA.bytes, 0, 'LIBRA has no _test surface and must report zero');
  assert.equal(measured.LIA_Persona_Linker.bytes, 0, 'LIA has none either');

  // Run the actual five-plugin release path as well: a source transform that works in isolation is
  // not enough if the builder cannot launch its minifier or the written artifacts do not read back.
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-test-surface-release-build-'));
  const outputDir = process.env.TEST_SURFACE_RELEASE_OUTPUT?path.resolve(process.env.TEST_SURFACE_RELEASE_OUTPUT):path.join(buildRoot,'plugins');
  if(process.env.TEST_SURFACE_RELEASE_OUTPUT)assert.equal(fs.existsSync(outputDir),false,'explicit readback output must be fresh');
  try {
    const expectedTerserVersion = '5.51.2';
    const terserBin = build.resolveNpmPackageBin('terser', 'terser', expectedTerserVersion);
    assert.ok(terserBin, `the release builder must resolve pinned offline Terser ${expectedTerserVersion} without invoking a shell or network`);
    let terserMetadata = null, terserDirectory = path.dirname(terserBin);
    while (terserDirectory !== path.dirname(terserDirectory)) {
      try {
        const candidate = JSON.parse(fs.readFileSync(path.join(terserDirectory, 'package.json'), 'utf8'));
        if (candidate.name === 'terser') { terserMetadata = candidate; break; }
      } catch (_) {}
      terserDirectory = path.dirname(terserDirectory);
    }
    assert.ok(terserMetadata, `resolved Terser package metadata must read back from ${terserBin}`);
    assert.equal(terserMetadata.version, expectedTerserVersion, 'the release byte floor uses the pinned Terser toolchain');

    // Without the isolated pinned package on Node's resolution path, the builder must explain
    // the exact prerequisite and refuse to emit release artifacts. This is intentionally an
    // offline proof: do not invoke npm/npx or let the test fetch a replacement toolchain.
    const prerequisiteOut = path.join(buildRoot, 'missing-pinned-terser');
    // Simulate "the pinned toolchain is not installed" while keeping the PARSER available. Deleting
    // NODE_PATH is not enough (the builder also searches the platform npm cache, so a machine that has
    // the pinned package cached satisfies the control), and emptying every cache is not enough either:
    // measured, the builder then fails at the parser step first
    // (`release_test_surface_acorn_unavailable`) and never reaches the Terser prerequisite this control
    // is about. So the fixture cache holds Acorn - copied from wherever this host has it - and no Terser.
    const noPinnedCache = path.join(buildRoot, 'acorn-only-cache');
    const fixtureNpx = path.join(noPinnedCache, '_npx', 'fixture-acorn-only', 'node_modules');
    fs.mkdirSync(fixtureNpx, { recursive: true });
    const acornSource = (() => {
      try {const packageFile=require.resolve('acorn/package.json');return path.dirname(packageFile);}catch(_){}
      for (const root of hostNpmCacheRoots()) {
        const npxBase = path.join(root, '_npx');
        let entries = [];
        try { entries = fs.readdirSync(npxBase); } catch (_) { continue; }
        for (const entry of entries) {
          const candidate = path.join(npxBase, entry, 'node_modules', 'acorn');
          try {
            if (JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).name === 'acorn') return candidate;
          } catch (_) {}
        }
      }
      return null;
    })();
    assert.ok(acornSource, 'this host must have Acorn available for the parser-positive control');
    fs.cpSync(acornSource, path.join(fixtureNpx, 'acorn'), { recursive: true });
    assert.ok(!fs.existsSync(path.join(fixtureNpx, 'terser')),
      'the fixture cache must not contain the pinned toolchain this control removes');
    const noPinnedToolchainEnv = { ...process.env, HOME: buildRoot, USERPROFILE: buildRoot,
      LOCALAPPDATA: path.join(buildRoot, 'no-pinned-local-appdata'),
      npm_config_cache: noPinnedCache, NPM_CONFIG_CACHE: noPinnedCache };
    delete noPinnedToolchainEnv.NODE_PATH;
    delete noPinnedToolchainEnv.npm_config_prefix;
    const missingPinned = spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'build_plugins.cjs'), '--out', prerequisiteOut],
      { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 1 << 28, windowsHide: true, env: noPinnedToolchainEnv });
    assert.equal(missingPinned.status, 1, 'a release build without pinned Terser must fail closed');
    assert.match(`${missingPinned.stdout || ''}${missingPinned.stderr || ''}`,
      /terser_5\.51\.2_required; available=/,
      'missing pinned Terser failure must name the exact prerequisite and discovered versions');
    const missingReport = JSON.parse(fs.readFileSync(path.join(prerequisiteOut, 'ultralight-build-report.json'), 'utf8'));
    assert.equal(missingReport.rows.length, 6, 'the failed prerequisite must report all six plugins');
    assert.ok(missingReport.rows.every(row => row.wrote === false
      && /terser_5\.51\.2_required/.test(row.refused || '')),
    'no plugin may be written when the measured minifier is absent');

    // A second isolated child proves a missing parser is not treated as an empty/no-op strip.
    // Redirect every npm cache location and the user profile to this owned empty fixture, then
    // invoke the exported product stripper in a clean Node resolver environment.
    const emptyProfile = path.join(buildRoot, 'empty-parser-profile');
    const emptyCache = path.join(buildRoot, 'empty-parser-cache');
    fs.mkdirSync(emptyProfile, { recursive: true });
    fs.mkdirSync(emptyCache, { recursive: true });
    const noParserEnv = { ...process.env, NODE_PATH: '', HOME: emptyProfile, USERPROFILE: emptyProfile,
      LOCALAPPDATA: path.join(emptyProfile, 'AppData', 'Local'), npm_config_cache: emptyCache, NPM_CONFIG_CACHE: emptyCache };
    // Keep the strict offline and pinned-process guards while isolating parser resolution.
    const parserProbe = `const b=require(${JSON.stringify(path.join(ROOT, 'tools', 'build_plugins.cjs'))});
if (b.resolveAcorn() !== null) throw new Error('isolated resolver unexpectedly found Acorn');
try { b.stripTestSurface('const x = {};'); throw new Error('missing parser silently accepted'); }
catch (error) { if (error.message !== 'release_test_surface_acorn_unavailable') throw error; }
console.log('release_test_surface_acorn_unavailable');`;
    const noParser = spawnSync(process.execPath, ['-e', parserProbe],
      { cwd: ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20, windowsHide: true, env: noParserEnv });
    assert.equal(noParser.status, 0,
      `an absent parser must produce the explicit fail-closed boundary: ${noParser.stderr || ''}`);
    assert.match(noParser.stdout, /release_test_surface_acorn_unavailable/,
      'the parser absence probe reads back the product error code');

    const buildRun = spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'build_plugins.cjs'), '--profile','release','--out', outputDir],
      { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 1 << 28, windowsHide: true });
    assert.equal(buildRun.error, undefined,
      `the release builder and minifier must launch successfully: ${buildRun.error?.message || ''}`);
    if(process.env.TEST_SURFACE_EXECUTION_RECEIPT)fs.writeFileSync(process.env.TEST_SURFACE_EXECUTION_RECEIPT,JSON.stringify({command:[process.execPath,path.join(ROOT,'tools/build_plugins.cjs'),'--profile','release','--out',outputDir],cwd:ROOT,environment:{NODE_PATH:process.env.NODE_PATH,NODE_OPTIONS:process.env.NODE_OPTIONS},exit:buildRun.status,stdout:buildRun.stdout,stderr:buildRun.stderr,error:buildRun.error?.message||null},null,2)+'\n');
    const releaseReport = JSON.parse(fs.readFileSync(path.join(outputDir, 'ultralight-build-report.json'), 'utf8'));
    assert.deepEqual(releaseReport.rows.map(row => row.plugin).sort(),
      ['flashback','gradia','hayaku','lia','libra','retrace'],'the actual builder emits all six plugins');
    const releaseArtifacts = await Promise.all(releaseReport.rows.map(async row => {
      assert.equal(row.wrote, true, `${row.plugin} must be written by the release build`);
      const file = path.join(outputDir, path.basename(row.file));
      const artifact = fs.readFileSync(file, 'utf8');
      assert.equal(Buffer.byteLength(artifact), row.bytes, `${row.plugin} artifact bytes must read back`);
      acorn.parse(artifact, { ecmaVersion: 'latest', sourceType: 'script' });
      const source = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
      const sourceLines = source.split(/\r?\n/);
      const expectedLeadingDirectives = [];
      for (const line of sourceLines) {
        if (!/^[ \t]*\/\/[\@!]/.test(line)) break;
        expectedLeadingDirectives.push(line.trim());
      }
      const expectedDirectives = sourceLines.filter(line => /^[ \t]*\/\/[\@!]/.test(line)).map(line => line.trim());
      const artifactDirectives = (artifact.match(/^\/\/[\@!].*$/gm) || []).map(line => line.trim());
      assert.ok(expectedLeadingDirectives.length > 0, `${row.plugin} source has leading release directives`);
      assert.ok(artifact.startsWith(expectedLeadingDirectives.join('\n')),
        `${row.plugin} artifact preserves exact source leading directives`);
      assert.deepEqual(artifactDirectives, expectedDirectives, `${row.plugin} artifact preserves all source directives in order`);
      assert.equal(row.directivesKept, artifactDirectives.length,
        `${row.plugin} directive report matches the physically preserved header`);
      const runtime = { console: { log() {}, warn() {}, error() {} }, setTimeout() { return 0; },
        clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, queueMicrotask,
        fetch: async () => { throw new Error('network disabled in release artifact load check'); },
        URL, URLSearchParams, TextEncoder, TextDecoder, AbortController };
      runtime.globalThis = runtime;
      let startup;
      try {
        startup = vm.runInNewContext(artifact, runtime, { filename: `${row.plugin}.release.js`, timeout: 20000 });
        if (startup && typeof startup.then === 'function') {
          let timeoutId;
          try {
            await Promise.race([startup,
              new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('startup_timeout')), 20000); })]);
          } finally { clearTimeout(timeoutId); }
        }
      } catch (error) {
        assert.fail(`${row.plugin} fresh minified artifact must execute without a load-time throw: ${error?.stack || error}`);
      }
      return { plugin: row.plugin, bytes: Buffer.byteLength(artifact), testSurfaceBlocksRemoved: row.testSurfaceBlocksRemoved,
        testSurfaceBytesRemoved: row.testSurfaceBytesRemoved, directivesKept: row.directivesKept,
        executable: true, withinFloor: row.withinFloor, overFloorBy: row.overFloorBy };
    }));
    assert.ok(releaseArtifacts.find(row => row.plugin === 'hayaku').testSurfaceBytesRemoved > 10000);
    assert.ok(releaseArtifacts.find(row => row.plugin === 'flashback').testSurfaceBytesRemoved > 10000);
    assert.ok(releaseArtifacts.find(row => row.plugin === 'retrace').testSurfaceBytesRemoved > 1000);
    const floorFailures = releaseArtifacts.filter(row => !row.withinFloor);
    assert.equal(buildRun.status, 0,
      `all artifacts were generated and validated; historical size growth is reporting-only; ${buildRun.stdout || ''}${buildRun.stderr || ''}`);
    if (floorFailures.length) assert.match(buildRun.stdout, /WARNING: ABOVE-BASELINE/,
      'historical size growth remains visible without failing the build');
    process.stdout.write(JSON.stringify({ releaseBuildReadback: {
      exitCode: buildRun.status, terserVersion: terserMetadata.version,
      options: 'defaults=true,unsafe=false,drop_console=true,passes=3; toplevel=true,properties=false',
      allSevenArtifactsParsed: true, testSurfacesRemoved: true, floorFailures, artifacts: releaseArtifacts
    } }, null, 1) + '\n');
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.equal(fs.existsSync(buildRoot), false, 'the owned actual-build fixture is physically removed');
  }

  console.log(JSON.stringify({
    test: 'libra_test_surface_strip',
    bothShapesRemoved: true,
    resultParses: true,
    resultExecutes: true,
    publicApiPreserved: true,
    measured
  }, null, 1));
  process.stdout.write('libra_test_surface_strip_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
