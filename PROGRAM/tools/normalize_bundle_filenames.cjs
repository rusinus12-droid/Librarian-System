'use strict';
// One-shot: rewrite the NFD-named bundle entries as NFC.
//
// Root cause (proven, see STORAGE_MODE_REMEDIATION_BACKLOG.md):
//   The live tree holds 43 Korean-named entries in NFD (decomposed jamo) while git
//   stores NFC. macOS APFS is a normalisation-insensitive filesystem, so
//   `exists(NFC_PATH)` returns true and `samefile(NFD, NFC)` is true even though the
//   directory holds only the NFD entry -- do NOT use exists() as a proxy for
//   "the NFC entry is present". Confirmed by a raw readdir: 23/23 Hangul entries in
//   PROGRAM/ are NFD, 0 are NFC.
//
//   Consequence: the real release builder aborts in release_smoke with
//   `missing cross-platform script: 1_서버_실행.sh`, and `program_data_layout_test`
//   fails, because those tools compare against the NFC literal from git.
//
// Why a copy+unlink rather than renameSync:
//   A rename preserves the original directory-entry spelling, so it does not fix
//   anything. Writing the file under its NFC name makes APFS store NFC, which was
//   verified against a scratch directory before this tool was written.
//
// Safety model:
//   * Content bytes are never transformed. SHA-256 is verified before and after.
//   * Mode bits and mtime are preserved via copyFileSync + utimesSync.
//   * Every entry is verified: NFC name exists, NFD name is gone, hash matches,
//     and a raw readdir no longer reports an NFD spelling.
//   * Refuses to run while a regression process is active (it would invalidate it).
//   * Dry-run by default. Pass --apply to write.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');
const toNfc = text => text.normalize('NFC');
const hasHangulJamo = text => Array.from(text).some(char => {
  const code = char.codePointAt(0);
  return code >= 0x1100 && code <= 0x11ff;
});
const isNfd = text => hasHangulJamo(text) && toNfc(text) !== text;
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Deepest-first so child paths stay valid while parents are rewritten.
const walk = dir => {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    found.push({ full, name: entry.name, isDir: entry.isDirectory() });
  }
  return found;
};

const refuseIfRegressionRunning = () => {
  try {
    const out = execFileSync('pgrep', ['-fl', 'run_regression_batch'], { encoding: 'utf8' });
    if (out.trim()) {
      console.error('refusing to run: a regression process is active and this would invalidate it');
      console.error(out.trim());
      process.exit(2);
    }
  } catch { /* pgrep exits non-zero when nothing matches, which is the good case */ }
};

refuseIfRegressionRunning();

const entries = walk(ROOT).filter(entry => isNfd(entry.name));
entries.sort((left, right) => right.full.split(path.sep).length - left.full.split(path.sep).length
  || right.full.length - left.full.length);

console.log(`root=${ROOT}`);
console.log(`mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`NFD entries: ${entries.length}`);

const done = [];
const failures = [];
for (const entry of entries) {
  const nfcName = toNfc(entry.name);
  const source = entry.full;
  const target = path.join(path.dirname(source), nfcName);
  const label = { from: path.relative(ROOT, source), to: path.relative(ROOT, target), isDir: entry.isDir };

  if (!entry.isDir) {
    let before;
    try { before = { hash: sha256(source), mode: fs.statSync(source).mode, times: fs.statSync(source) }; }
    catch (error) { failures.push({ ...label, problem: `stat/read failed: ${error.message}` }); continue; }

    if (APPLY) {
      try {
        // APFS resolves both spellings to the same file, so copy to a temp name in
        // the same directory, then place it under the NFC name via the raw path.
        const temp = path.join(path.dirname(source), `.nfc-rewrite-${process.pid}-${done.length}`);
        fs.copyFileSync(source, temp);
        fs.unlinkSync(source);
        fs.renameSync(temp, path.join(path.dirname(source), nfcName));
      } catch (error) { failures.push({ ...label, problem: `rewrite failed: ${error.message}` }); continue; }
      try {
        fs.chmodSync(target, before.mode);
        fs.utimesSync(target, before.times.atime, before.times.mtime);
      } catch { /* metadata preservation is best effort */ }
    }
    if (APPLY) {
      if (!fs.existsSync(target)) { failures.push({ ...label, problem: 'NFC target missing' }); continue; }
      const rawNames = fs.readdirSync(path.dirname(source));
      if (rawNames.includes(entry.name)) { failures.push({ ...label, problem: 'NFD spelling still reported by readdir' }); continue; }
      if (!rawNames.includes(nfcName)) { failures.push({ ...label, problem: 'NFC spelling not reported by readdir' }); continue; }
      if (sha256(target) !== before.hash) { failures.push({ ...label, problem: 'content hash changed' }); continue; }
    }
  } else if (APPLY) {
    // Directory entries are created by their children; handle the leaf rename too.
    try { fs.renameSync(source, path.join(path.dirname(source), nfcName)); }
    catch (error) { failures.push({ ...label, problem: `dir rewrite failed: ${error.message}` }); continue; }
  }

  done.push(label);
}

for (const item of done) console.log(`${item.isDir ? 'DIR ' : 'FILE'} ${item.from}  ->  ${item.to}`);
for (const failure of failures) console.error(`FAIL ${failure.from} -> ${failure.to} :: ${failure.problem}`);
console.log(`rewritten: ${done.length}, failures: ${failures.length}`);

if (!APPLY) {
  console.log('\nre-run with --apply to perform the rewrite');
} else {
  const remaining = walk(ROOT).filter(entry => isNfd(entry.name));
  console.log(`remaining NFD entries: ${remaining.length}`);
  for (const entry of remaining) console.error(`  STILL NFD: ${path.relative(ROOT, entry.full)}`);
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    console.log(`git status entries: ${status.length}`);
    for (const line of status.slice(0, 60)) console.log(`  ${line}`);
  } catch (error) { console.error(`git status failed: ${error.message}`); }
  if (failures.length || remaining.length) process.exitCode = 1;
}
