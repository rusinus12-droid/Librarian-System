'use strict';
// Gate: the shipped plugin identity (name / display name / version / update URL) must be
// consistent across every layer that declares or serves it, and must match the build
// manifest's output paths. Rationale: a rename touches the plugin header, the GUI brand,
// the registration label, the manifest, package metadata, ~30 test paths and the build
// script. Without this gate any one of those can drift silently — the `check` script
// pointing at a renamed artifact is exactly the kind of miss this catches.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Stable plugin identity; release versions are compared with current package metadata.
const EXPECT_ID = 'libra_world_manager';
const EXPECT_DISPLAY = 'LIBRA World Manager';
const EXPECT_UPDATE_URL = 'https://raw.githubusercontent.com/rusinus12-droid/Librarian-System/refs/heads/main/PROGRAM/plugins/LIBRA_World_Manager.js';

function check(name, ok, details = {}) { return { name, ok: !!ok, details }; }

const assertions = [];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'build-manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECT_VERSION = typeof pkg.version === 'string' ? pkg.version.trim() : '';
const versionIsValid = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(EXPECT_VERSION);
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

const fullPath = path.join(ROOT, manifest.output);
const minPath = path.join(ROOT, manifest.minifiedOutput);

assertions.push(check('manifest_outputs_use_current_name',
  /World Manager/.test(manifest.output) && /World Manager/.test(manifest.minifiedOutput),
  { output: manifest.output, minifiedOutput: manifest.minifiedOutput }));

assertions.push(check('both_artifacts_exist',
  fs.existsSync(fullPath) && fs.existsSync(minPath),
  { fullExists: fs.existsSync(fullPath), minExists: fs.existsSync(minPath) }));

if (!fs.existsSync(fullPath) || !fs.existsSync(minPath)) {
  console.log(JSON.stringify({ ok: false, assertions }, null, 2));
  process.exit(1);
}

const fullCode = fs.readFileSync(fullPath, 'utf8');
const minCode = fs.readFileSync(minPath, 'utf8');
const header = (code) => {
  // display-name contains spaces ("LIBRA World Manager v6.0.0"), so capture to end of line.
  const grabLine = (key) => {
    const m = code.match(new RegExp(`^//@${key}[ \\t]+(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const grabToken = (key) => {
    const m = code.match(new RegExp(`^//@${key}\\s+(\\S+)`, 'm'));
    return m ? m[1] : null;
  };
  return {
    name: grabToken('name'),
    display: grabLine('display-name'),
    version: grabToken('version'),
    updateUrl: grabToken('update-url')
  };
};
const fullH = header(fullCode);
const minH = header(minCode);

// ── 1. Plugin identity in both artifacts ──
assertions.push(check('plugin_id_is_libra_world_manager',
  fullH.name === EXPECT_ID && minH.name === EXPECT_ID,
  { full: fullH.name, min: minH.name }));

assertions.push(check('display_name_declares_world_manager',
  Boolean(fullH.display && fullH.display.includes(EXPECT_DISPLAY)),
  { full: fullH.display }));

assertions.push(check('artifact_versions_match_package',
  versionIsValid && fullH.version === EXPECT_VERSION && minH.version === EXPECT_VERSION,
  { full: fullH.version, min: minH.version }));

assertions.push(check('display_names_carry_current_version',
  fullH.display === `${EXPECT_DISPLAY} v${EXPECT_VERSION}` && minH.display === fullH.display,
  { full: fullH.display, min: minH.display, expected: EXPECT_VERSION }));

assertions.push(check('update_url_points_at_the_shipped_filename',
  fullH.updateUrl === EXPECT_UPDATE_URL && minH.updateUrl === EXPECT_UPDATE_URL,
  { full: fullH.updateUrl, min: minH.updateUrl }));

// The first line must stay the plugin id (RisuAI reads the header from the top).
assertions.push(check('plugin_id_is_first_line', minCode.startsWith('//@name '),
  { firstLine: minCode.split('\n')[0] }));

// ── 2. No stale name anywhere in the shipped bundles ──
const staleInFull = (fullCode.match(/LIBRA World Maker/g) || []).length;
const staleInMin = (minCode.match(/LIBRA World Maker/g) || []).length;
assertions.push(check('no_stale_old_name_in_bundles', staleInFull === 0 && staleInMin === 0,
  { staleInFull, staleInMin }));

// ── 3. Build/check tooling must target the CURRENT artifact paths ──
const checkScript = String(pkg.scripts?.check || '');
assertions.push(check('check_script_targets_current_artifacts',
  checkScript.includes('World Manager Full.js') && checkScript.includes('World Manager.js') &&
  !checkScript.includes('World Maker'),
  { check: checkScript }));

const buildScriptPath = path.join(ROOT, 'tools', 'build-libra-world-manager.cjs');
const buildSrc = fs.readFileSync(buildScriptPath, 'utf8');
assertions.push(check('build_script_reads_manifest_paths',
  buildSrc.includes("manifest.output") && buildSrc.includes("manifest.minifiedOutput") &&
  !/LIBRA World Maker/.test(buildSrc),
  { hardcodedOldName: /LIBRA World Maker/.test(buildSrc) }));

// ── 4. Package metadata agrees ──
assertions.push(check('package_json_name_matches',
  pkg.name === 'libra-world-manager',
  { name: pkg.name }));

assertions.push(check('package_json_version_matches',
  versionIsValid && pkg.version === fullH.version,
  { version: pkg.version }));

assertions.push(check('package_lock_matches_package_json',
  lock.name === pkg.name && lock.version === pkg.version &&
  (lock.packages?.['']?.name === pkg.name) && (lock.packages?.['']?.version === pkg.version),
  { lockName: lock.name, lockVersion: lock.version, rootName: lock.packages?.['']?.name, rootVersion: lock.packages?.['']?.version }));

// ── 5. User-visible surfaces carry the new name ──
assertions.push(check('gui_brand_shows_new_name_and_version',
  fullCode.includes('LIBRA World Manager') && /class="brand"/.test(fullCode) &&
  fullCode.includes(`<span class="ver">v${EXPECT_VERSION}</span>`),
  { brandMatch: (fullCode.match(/<div class="brand">[^<]*<h1>[^<]*/) || [])[0] || null }));

assertions.push(check('registration_uses_new_name',
  fullCode.includes("registerSetting('LIBRA World Manager'"),
  { found: (fullCode.match(/registerSetting\('[^']*'/) || [])[0] || null }));

// ── 6. Test tooling must not read a stale artifact path ──
const toolsDir = path.join(ROOT, 'tools');
const staleTools = [];
for (const f of fs.readdirSync(toolsDir)) {
  if (!f.endsWith('.cjs')) continue;
  if (f === path.basename(__filename)) continue;  // this gate names the old name in its own rationale
  const t = fs.readFileSync(path.join(toolsDir, f), 'utf8');
  // Only a DIST ARTIFACT PATH is a defect; prose mentions are fine.
  if (/['"`]LIBRA World Maker(?: Full)?\.js['"`]/.test(t) || /dist['"]?,\s*['"]LIBRA World Maker/.test(t)) staleTools.push(f);
}
assertions.push(check('no_test_reads_a_stale_artifact_path', staleTools.length === 0,
  { staleTools }));

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, identity: { ...fullH }, assertions }, null, 2));
process.exit(ok ? 0 : 1);
