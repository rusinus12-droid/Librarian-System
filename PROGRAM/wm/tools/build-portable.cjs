'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function loadPinnedTerser(wmRoot = path.resolve(__dirname, '..')) {
 const dir=process.env.WM_TOOLCHAIN;
 if(!dir)throw Error('WM_PINNED_TOOLCHAIN_REQUIRED: set WM_TOOLCHAIN to existing locked node_modules; no auto-install');
 const toolchain=path.resolve(dir), lock=JSON.parse(fs.readFileSync(wmRoot+'/build-support/package-lock.json','utf8'));
 for(const [location,entry] of Object.entries(lock.packages||{})){
  if(!location)continue;
  if(!location.startsWith('node_modules/'))throw Error('unsupported_locked_path:'+location);
  const p=path.join(toolchain,location.slice('node_modules/'.length),'package.json');
  if(!fs.existsSync(p)||JSON.parse(fs.readFileSync(p,'utf8')).version!==entry.version)throw Error('WM_LOCKED_PACKAGE_MISMATCH:'+location+' expected '+entry.version);
 }
 return require(path.join(toolchain,'terser'));
}

// The immutable factory is evaluated with the existing source overlay. Assembly
// returns bytes in memory; historical dist files are verified fixtures only.
async function assemblePortableSource({ wmRoot = path.resolve(__dirname, '..'), verifyPins = true } = {}) {
  const root = path.resolve(wmRoot);
  if (verifyPins !== true) throw Error('WM_PIN_VERIFICATION_REQUIRED');
  const inputBytes = new Map();
  const relativePath = file => {
    const relative = path.relative(root, path.resolve(file));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Error('WM_INPUT_OUTSIDE_SOURCE_ROOT:' + relative);
    return relative.split(path.sep).join('/');
  };
  const readInput = (file, encoding) => {
    const relative = relativePath(file);
    if (!inputBytes.has(relative)) inputBytes.set(relative, fs.readFileSync(path.join(root, relative)));
    const bytes = inputBytes.get(relative);
    return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
  };
  const pinManifestBytes = readInput(path.join(root, 'BASE-PINS.json'));
  if (hash(pinManifestBytes) !== 'af1d28638bc53dfb1c8e184f2886d9c802c49811cba75718acae04089cf6ac2f') throw Error('WM_PIN_MANIFEST_MISMATCH');
  const pins = JSON.parse(pinManifestBytes.toString('utf8'));
  if (!Array.isArray(pins.files) || !pins.files.length || typeof pins.base !== 'string') throw Error('WM_PIN_MANIFEST_INVALID');
  const base = path.resolve(root, pins.base);
  relativePath(base);
  for (const item of pins.files) {
    const file = path.resolve(base, item.file);
    const relative = path.relative(base, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('WM_PIN_PATH_INVALID:' + item.file);
    let bytes;
    try { bytes = readInput(file); } catch (error) {
      if (error.code === 'ENOENT') throw Error('WM_PIN_MISSING:' + item.file);
      throw error;
    }
    if (hash(bytes) !== item.sha256) throw Error('WM_PIN_MISMATCH:' + item.file);
  }
  // A complete active overlay is the editable source of truth. A missing active
  // file cannot quietly substitute its historical immutable-base counterpart.
  const requiredInput = relative => {
    try { return readInput(path.join(root, relative), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw Error('WM_REQUIRED_INPUT_MISSING:' + relative);
      throw error;
    }
  };
  const activeManifest = JSON.parse(requiredInput('src/build-manifest.json'));
  for (const item of activeManifest.parts) requiredInput('src/' + item.file);
  for (const relative of ['tools/factory-edits.cjs', 'tools/runtime-factory-baseline-owner.source.js',
    'tools/runtime-factory-detached-entry.source.js', 'tools/runtime-factory-controller.source.js',
    'tools/runtime-factory-health-orchestrator.source.js', 'src/MemorySuiteSnapshotCache.cjs',
    'src/wm-versioned-snapshot.cjs', 'src/versioned-canonical-bridge.source.js',
    'src/wm-common-derived-cache.source.js', 'src/wm-native-derived-cache.source.js',
    'src/wm-storage-contracts.source.js','src/wm-storage-inventory.source.js','src/wm-storage-router.source.js',
    'src/wm-native-portability.source.js','src/wm-native-storage.source.js','src/wm-server-storage.source.js','src/wm-native-host-gate.source.js','src/wm-writer-routing.source.js','src/wm-storage-migration.source.js','src/wm-server-connection.source.js','src/wm-manual-storage.source.js','src/wm-storage-ui.source.js']) requiredInput(relative);
  // Frozen source fixtures are part of the portable test closure, never outputs.
  const auditFixtures = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) auditFixtures(file);
      else if (entry.isFile()) readInput(file);
      else throw Error('WM_FIXTURE_TYPE_INVALID:' + relativePath(file));
    }
  };
  auditFixtures(path.join(root, 'references/frozen-B'));
  readInput(path.join(root, 'tools/build-portable.cjs'));
  const virtualFs = { ...fs, readFileSync(file, options) {
    const relative = path.relative(base, String(file));
    const overlay = path.join(root, relative);
    const selected = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && fs.existsSync(overlay) ? overlay : file;
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return readInput(selected, encoding);
  } };
  const compile = (filename, code) => {
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = mod.require.bind(mod);
    mod.require = name => name === 'node:fs' || name === 'fs' ? virtualFs : originalRequire(name);
    mod._compile(code, filename);
    return mod.exports;
  };
  const factoryPath = path.join(base, 'tools/build-libra-runtime-factory.cjs');
  let source = readInput(factoryPath, 'utf8');
  const edits = path.join(root, 'tools/factory-edits.cjs');
  if (fs.existsSync(edits)) source = compile(edits, readInput(edits, 'utf8'))(source);
  const factory = compile(factoryPath, source);
  const coreRaw = readInput(path.join(root, 'src/MemorySuiteSnapshotCache.cjs'), 'utf8');
  if (hash(coreRaw) !== 'f3f08f23ef873a5c0bf561b85c3271459cf908275a7d6e19f0448fa00ce3e1cc' || coreRaw.split('module.exports =').length !== 2) throw Error('common_core_pin_changed');
  const coreLexical = coreRaw.replace('module.exports =', 'const MemorySuiteSnapshotCache =');
  let code = await factory();
  const bridgePath = path.join(root, 'src/versioned-canonical-bridge.source.js');
  if (!fs.existsSync(bridgePath)) throw Error('WM_REQUIRED_INPUT_MISSING:src/versioned-canonical-bridge.source.js');
  {
    const seam = '    const requireLoadedCharacter = async () => {';
    if (code.split(seam).length !== 2) throw Error('bridge_seam_changed');
    const storageModules=activeManifest.storageModules.map(file=>requiredInput('src/'+file)).join('\n');
    code = code.replace(seam, storageModules+'\n    const WmSnapshotAuthorityModule = (()=>{const module={exports:{}};\n'
      + readInput(path.join(root, 'src/wm-versioned-snapshot.cjs'), 'utf8')
      + '\nreturn module.exports;})();\n'
      + readInput(path.join(root, 'src/versioned-canonical-bridge.source.js'), 'utf8')
      + '\n    const WmSharedCacheFactory = () => {\n' + coreLexical
      + '\nreturn MemorySuiteSnapshotCache; };\n'
      + readInput(path.join(root, 'src/wm-common-derived-cache.source.js'), 'utf8') + '\n'
      + readInput(path.join(root, 'src/wm-native-derived-cache.source.js'), 'utf8') + '\n' + seam);
  }
  return {
    code,
    inputs: [...inputBytes].map(([relative, bytes]) => ({ path: relative, sha256: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path)),
    sourceSha256: hash(code)
  };
}
async function runCli() {
  if (process.env.WM_BUILD_MIN === '1') throw Error('WM_RELEASE_PROFILE_REQUIRED: use the separate LIB release build; development output is Full');
  const { writeWmDevelopmentSource } = require('../../tools/build_wm_source.cjs');
  const programDir = path.resolve(__dirname, '../..');
  const receipt = await writeWmDevelopmentSource({ programDir, fullOutputDir: process.env.WM_FULL_OUTPUT_DIR || path.join(programDir, 'plugins') });
  console.log(JSON.stringify(receipt));
}
module.exports = { assemblePortableSource, loadPinnedTerser, runCli };
if (require.main === module) runCli().catch(error => { console.error(error); process.exitCode = 1; });
