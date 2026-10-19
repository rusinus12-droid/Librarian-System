'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

let cachedModulesDir = null;

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

function findCacacheContentDir() {
  for (const root of npmCacheRoots()) {
    const contentDir = path.join(root, '_cacache', 'content-v2', 'sha512');
    if (fs.existsSync(contentDir)) return contentDir;
  }
  return null;
}

function ensureBuildSupportDependencies(options = {}) {
  const programDir = options.programDir ? path.resolve(options.programDir) : path.resolve(__dirname, '..');
  
  // 1. Check if jsdom is already resolvable
  if (process.env.GRADIA_TOOLCHAIN_ROOT && fs.existsSync(path.join(process.env.GRADIA_TOOLCHAIN_ROOT, 'jsdom', 'package.json'))) {
    cachedModulesDir = path.resolve(process.env.GRADIA_TOOLCHAIN_ROOT);
    return { modulesDir: cachedModulesDir, source: 'GRADIA_TOOLCHAIN_ROOT' };
  }
  try {
    const direct = require.resolve('jsdom/package.json', { paths: [programDir, __dirname] });
    cachedModulesDir = path.dirname(path.dirname(direct));
    return { modulesDir: cachedModulesDir, source: 'existing_node_modules' };
  } catch (_) {}

  if (cachedModulesDir && fs.existsSync(path.join(cachedModulesDir, 'jsdom', 'package.json'))) {
    return { modulesDir: cachedModulesDir, source: 'cached' };
  }

  // 2. Locate package-lock.json in build-support
  const lockPath = path.join(programDir, 'build-support', 'package-lock.json');
  if (!fs.existsSync(lockPath)) return null;

  const lockContent = fs.readFileSync(lockPath);
  const lockHash = crypto.createHash('sha256').update(lockContent).digest('hex').slice(0, 16);
  const targetModulesDir = path.join(os.tmpdir(), `librarian-build-support-${lockHash}`, 'node_modules');

  // If already extracted, return it
  if (fs.existsSync(path.join(targetModulesDir, 'jsdom', 'package.json')) &&
      fs.existsSync(path.join(targetModulesDir, 'acorn', 'package.json')) &&
      fs.existsSync(path.join(targetModulesDir, 'terser', 'package.json'))) {
    cachedModulesDir = targetModulesDir;
    applyEnvironment(targetModulesDir);
    return { modulesDir: targetModulesDir, source: 'extracted_cache' };
  }

  // 3. Find cacache
  const cacacheDir = findCacacheContentDir();
  if (!cacacheDir) return null;

  const lock = JSON.parse(lockContent.toString('utf8'));
  const packages = lock.packages || {};

  fs.mkdirSync(targetModulesDir, { recursive: true });

  const tarCmd = process.platform === 'win32' ? (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar.exe') : '/usr/bin/tar';

  let extractedCount = 0;
  for (const [pkgKey, pkgInfo] of Object.entries(packages)) {
    if (!pkgKey || !pkgKey.startsWith('node_modules/') || !pkgInfo.integrity) continue;
    const relName = pkgKey.replace(/^node_modules\//, '');
    const match = String(pkgInfo.integrity).match(/^sha512-(.+)$/);
    if (!match) continue;

    const hex = Buffer.from(match[1], 'base64').toString('hex');
    const cacheFile = path.join(cacacheDir, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    if (!fs.existsSync(cacheFile)) continue;

    const destDir = path.join(targetModulesDir, relName);
    if (fs.existsSync(path.join(destDir, 'package.json'))) {
      extractedCount += 1;
      continue;
    }

    fs.mkdirSync(destDir, { recursive: true });
    const res = cp.spawnSync(tarCmd, ['-xzf', cacheFile, '-C', destDir, '--strip-components=1'], {
      stdio: 'pipe',
      timeout: 30000
    });
    if (res.status === 0) {
      extractedCount += 1;
    }
  }

  if (fs.existsSync(path.join(targetModulesDir, 'jsdom', 'package.json'))) {
    cachedModulesDir = targetModulesDir;
    applyEnvironment(targetModulesDir);
    return { modulesDir: targetModulesDir, source: 'freshly_extracted', extractedCount };
  }

  return null;
}

function applyEnvironment(modulesDir) {
  if (!process.env.GRADIA_TOOLCHAIN_ROOT) {
    process.env.GRADIA_TOOLCHAIN_ROOT = modulesDir;
  }
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
