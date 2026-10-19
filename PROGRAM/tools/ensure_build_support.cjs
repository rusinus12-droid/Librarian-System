'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

let cachedModulesDir = null;
const REQUIRED_MODULES = ['jsdom', 'acorn', 'terser', 'fake-indexeddb'];

function npmCacheRoots() {
  const roots = new Set();
  const add = val => {
    if (typeof val === 'string' && val.trim()) roots.add(path.resolve(val.trim()));
  };
  add(process.env.npm_config_cache);
  add(process.env.NPM_CONFIG_CACHE);
  try {
    const home = os.homedir();
    add(path.join(home, '.npm'));
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      add(path.join(localAppData, 'npm-cache'));
    }
  } catch (_) {}
  return [...roots];
}

function findCacacheContentDirs() {
  return npmCacheRoots().map(root => path.join(root, '_cacache', 'content-v2', 'sha512')).filter(dir => fs.existsSync(dir));
}

function modulesLoadable(modulesDir) {
  try {
    const entrypoints = REQUIRED_MODULES.map(name => require.resolve(name, { paths: [modulesDir] }));
    // A fresh process also detects missing files hidden by Node's require cache.
    const result = cp.spawnSync(process.execPath, ['--no-warnings', '-e',
      `for (const entry of ${JSON.stringify(entrypoints)}) require(entry);`], { stdio: 'pipe', timeout: 30000 });
    return result.status === 0;
  } catch (_) { return false; }
}

function lockedTreeComplete(modulesDir, packages) {
  try {
    for (const [key, info] of packages) {
      const metadata = JSON.parse(fs.readFileSync(path.join(modulesDir, key.slice('node_modules/'.length), 'package.json'), 'utf8'));
      if (metadata.version !== info.version) return false;
    }
    return modulesLoadable(modulesDir);
  } catch (_) { return false; }
}

function ensureBuildSupportDependencies(options = {}) {
  const programDir = options.programDir ? path.resolve(options.programDir) : path.resolve(__dirname, '..');
  const lockPath = path.join(programDir, 'build-support', 'package-lock.json');
  const lockContent = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;
  const packages = lockContent ? Object.entries(JSON.parse(lockContent.toString('utf8')).packages || {}).filter(([key]) => key) : [];
  for (const [key] of packages) {
    if (!key.startsWith('node_modules/') || key.includes('\\') || key.split('/').some(part => !part || part === '..')) {
      throw new Error('build_support_lock_package_path_invalid');
    }
  }
  const lockHash = lockContent ? crypto.createHash('sha256').update(lockContent).digest('hex').slice(0, 16) : null;
  const cacheRoot = lockHash ? path.join(os.tmpdir(), `librarian-build-support-${lockHash}`) : null;
  const complete = modulesDir => {
    const relative = cacheRoot && path.relative(cacheRoot, path.resolve(modulesDir));
    const managed = cacheRoot && (relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative));
    return managed ? lockedTreeComplete(modulesDir, packages) : modulesLoadable(modulesDir);
  };
  const activate = (modulesDir, source, extra = {}) => {
    cachedModulesDir = path.resolve(modulesDir);
    applyEnvironment(cachedModulesDir);
    return { modulesDir: cachedModulesDir, source, ...extra };
  };

  if (process.env.GRADIA_TOOLCHAIN_ROOT && complete(process.env.GRADIA_TOOLCHAIN_ROOT)) {
    return activate(process.env.GRADIA_TOOLCHAIN_ROOT, 'GRADIA_TOOLCHAIN_ROOT');
  }
  try {
    const direct = require.resolve('jsdom/package.json', { paths: [programDir, __dirname] });
    const modulesDir = path.dirname(path.dirname(direct));
    if (complete(modulesDir)) return activate(modulesDir, 'existing_node_modules');
  } catch (_) {}

  if (cachedModulesDir && complete(cachedModulesDir)) {
    return activate(cachedModulesDir, 'cached');
  }
  if (!cacheRoot || !packages.length) return null;

  // Accept an older extraction only when its entire locked dependency tree works.
  const legacyModulesDir = path.join(cacheRoot, 'node_modules');
  if (lockedTreeComplete(legacyModulesDir, packages)) return activate(legacyModulesDir, 'extracted_cache');
  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('ready-')) continue;
      const modulesDir = path.join(cacheRoot, entry.name, 'node_modules');
      if (lockedTreeComplete(modulesDir, packages)) return activate(modulesDir, 'extracted_cache');
    }
  }

  // Check every tarball before extraction; missing or damaged entries cannot
  // activate a partial toolchain or prevent a later retry with a complete cache.
  const contentDirs = findCacacheContentDirs(), archives = [];
  for (const [key, info] of packages) {
    const match = String(info.integrity || '').match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return null;
    const hash = Buffer.from(match[1], 'base64');
    if (hash.length !== 64) return null;
    const hex = hash.toString('hex');
    let archive = null;
    for (const dir of contentDirs) {
      const file = path.join(dir, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
      try {
        if (crypto.createHash('sha512').update(fs.readFileSync(file)).digest().equals(hash)) { archive = file; break; }
      } catch (_) {}
    }
    if (!archive) return null;
    archives.push([key, archive]);
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(cacheRoot, '.extract-'));
  let published = false;
  try {
    const modulesDir = path.join(stagingRoot, 'node_modules');
    const tarCmd = process.platform === 'win32' ? (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar.exe') : 'tar';
    for (const [key, archive] of archives) {
      const destDir = path.join(stagingRoot, key);
      fs.mkdirSync(destDir, { recursive: true });
      const result = cp.spawnSync(tarCmd, ['-xzf', archive, '-C', destDir, '--strip-components=1'], { stdio: 'pipe', timeout: 30000 });
      if (result.status !== 0) return null;
    }
    if (!lockedTreeComplete(modulesDir, packages)) return null;
    // Only verified immutable directories are discoverable. Concurrent builders
    // publish separate generations and never replace a directory in active use.
    const readyRoot = path.join(cacheRoot, 'ready-' + path.basename(stagingRoot).slice('.extract-'.length));
    fs.renameSync(stagingRoot, readyRoot);
    published = true;
    return activate(path.join(readyRoot, 'node_modules'), 'freshly_extracted', { extractedCount: archives.length });
  } finally {
    if (!published) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function applyEnvironment(modulesDir) {
  process.env.GRADIA_TOOLCHAIN_ROOT = modulesDir;
  const currentPath = process.env.NODE_PATH || '';
  if (!currentPath.split(path.delimiter).includes(modulesDir)) {
    process.env.NODE_PATH = modulesDir + (currentPath ? path.delimiter + currentPath : '');
    try {
      require('node:module').Module._initPaths();
    } catch (_) {}
  }
}

module.exports = {
  ensureBuildSupportDependencies,
  applyEnvironment
};
