'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(process.env.LIBRARIAN_PACKAGE_ROOT || path.resolve(__dirname, '..', '..'));
const outputPath = path.join(packageRoot, 'SHA256SUMS.txt');
const distributionMode = process.argv.includes('--distribution');
const unknownArgs = process.argv.slice(2).filter(arg => arg !== '--distribution');
if (unknownArgs.length) throw new Error(`unknown_checksum_argument:${unknownArgs.join(',')}`);
const files = [];
const forbiddenDistributionData = /(?:^|\/)(?:runtime-token\.txt|compute-(?:signing|pairing)-key\.txt|scope-catalog(?:\.[^/]*)?\.json|[^/]+\.(?:sqlite(?:-(?:wal|shm))?|db|jsonl|log))(?:$|\/)/i;
const CHECKSUM_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', '.development']);
// A linked worktree has `.git` as a FILE (a `gitdir:` pointer), not a directory, so the directory rule
// above does not cover it: the pointer was recorded as a checksum row whose bytes depend on where the
// checkout lives, making the artifact differ per machine. Exclude the name in both shapes.
const CHECKSUM_EXCLUDED_FILES = new Set(['.git']);
const isChecksumEphemeralFile = name => (
  /^\.test-output-/i.test(name)
  || /^FULL_TEST/i.test(name)
  || /\.pyc$/i.test(name)
  || /\.(?:tmp|log)$/i.test(name)
);

const walk = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (absolute === outputPath) continue;
    const relative = path.relative(packageRoot, absolute).split(path.sep).join('/');
    if (!distributionMode && (relative === 'DATA' || relative.startsWith('DATA/'))) continue;
    if (entry.isSymbolicLink()) throw new Error(`checksum_symbolic_link_is_not_allowed:${relative}`);
    if (entry.isDirectory()) {
      if (!CHECKSUM_EXCLUDED_DIRECTORIES.has(entry.name)) walk(absolute);
    } else if (entry.isFile() && !CHECKSUM_EXCLUDED_FILES.has(entry.name) && !isChecksumEphemeralFile(entry.name)) {
      if (distributionMode && relative.startsWith('DATA/') && forbiddenDistributionData.test(relative.slice('DATA/'.length))) {
        throw new Error(`distribution_checksum_private_data_rejected:${relative}`);
      }
      files.push(absolute);
    }
  }
};

walk(packageRoot);
files.sort((left, right) => left.localeCompare(right, 'en'));
const rows = files.map(file => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const relative = `./${path.relative(packageRoot, file).split(path.sep).join('/')}`;
  return `${digest}  ${relative}`;
});
const tempPath = `${outputPath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
let fd = null;
try {
  fd = fs.openSync(tempPath, 'wx', 0o600);
  const bytes = Buffer.from(`${rows.join('\n')}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = null;
  fs.renameSync(tempPath, outputPath);
} catch (error) {
  if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
  throw error;
}
process.stdout.write(`[LIBRARIAN SYSTEM] SHA256SUMS.txt updated: ${rows.length} files · DATA ${distributionMode ? 'clean distribution included' : 'excluded as mutable private state'}\n`);
