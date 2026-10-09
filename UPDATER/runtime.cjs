'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname,'..');
function detectPlatform(env = process.env, platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'android' || (platform === 'linux' && (env.TERMUX_VERSION || env.ANDROID_ROOT || /com\.termux/.test(env.PREFIX || '')))) return 'android';
  return platform;
}
function validateRoot(root, env = process.env, platform = process.platform) {
  const name = detectPlatform(env,platform);
  if (!['windows','macos','linux','android'].includes(name)) throw new Error(`updater_unsupported_platform:${name}`);
  return require(`./platform/${name}.cjs`).validateRoot(root);
}
function assertRuntime() {
  const [major,minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('updater_node_22_13_or_newer_required');
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try { db.exec('SELECT 1'); } finally { db.close(); }
}
function stageRuntime(root = ROOT, executablePath = process.execPath) {
  const canonical = validateRoot(root);
  const exe = fs.realpathSync.native(path.resolve(executablePath));
  const rel = path.relative(canonical,exe).split(path.sep).join('/');
  if (!/^(?:PROGRAM|\.rollback|\.update)\//.test(rel)) return exe;
  // Bootstrap exits before the independent executable is started. In
  // particular, Windows must not keep node.exe open inside renamed PROGRAM.
  const cache = path.join(canonical,'UPDATER','_runtime');
  fs.mkdirSync(cache,{recursive:true,mode:0o700});
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error('updater_runtime_cache_symlink_rejected');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const digest = hash(exe);
  const destination = path.join(cache,`node-${digest}${process.platform === 'win32' ? '.exe' : ''}`);
  if (fs.existsSync(destination)) {
    if (fs.lstatSync(destination).isSymbolicLink() || hash(destination) !== digest) throw new Error('updater_cached_runtime_invalid');
  } else {
    const tmp = destination + `.${process.pid}.tmp`;
    try {
      fs.copyFileSync(exe,tmp,fs.constants.COPYFILE_EXCL);
      if (hash(tmp) !== digest) throw new Error('updater_runtime_copy_mismatch');
      fs.chmodSync(tmp,0o700);
      // Windows FlushFileBuffers requires a handle opened with write access; a
      // read-only handle raises EPERM. r+ preserves the copied bytes and still
      // provides a real durability barrier before the staging rename.
      const fd = fs.openSync(tmp,'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp,destination);
    } finally { fs.rmSync(tmp,{force:true}); }
  }
  return destination;
}
if (require.main === module) {
  try {
    assertRuntime();
    if (process.argv[2] === '--check') process.stdout.write(process.versions.node+'\n');
    else if (process.argv[2] === '--stage-runtime') process.stdout.write(stageRuntime(process.argv[3] || ROOT)+'\n');
    else throw new Error('updater_runtime_argument_invalid');
  } catch (error) { console.error('[Librarian Updater] '+error.message);process.exitCode=22; }
}
module.exports={detectPlatform,validateRoot,assertRuntime,stageRuntime};
