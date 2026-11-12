'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const PAYLOAD = 'tools/updater-payload';
const WAIT_MS = 300000;
const terminalFailure = new Set(['rolled_back', 'aborted']);

function readCandidate(root) {
  const program = path.join(root, 'PROGRAM');
  const payload = path.join(program, PAYLOAD);
  const updater = path.join(root, 'UPDATER');
  const journalPath = path.join(updater, 'update-state.json');
  if (!fs.existsSync(payload) || !fs.existsSync(journalPath)) return null;
  for (const directory of [program, path.join(program, 'tools'), payload, updater]) {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('updater_refresh_directory_invalid');
  }
  const version = fs.readFileSync(path.join(program, 'VERSION.txt'), 'utf8').trim();
  const journalApi = require(path.join(updater, 'core', 'journal.cjs'));
  const journal = journalApi.readJournal(journalPath);
  if (!journal || journal.policy !== 'program_only' || journal.toVersion !== version || !journal.operationId
    || journal.updaterRefreshedAt || terminalFailure.has(journal.status)) return null;
  return { program, payload, updater, journalPath, journalApi, journal, version };
}

function verifyPayload(candidate, files) {
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate.program, 'program-manifest.json'), 'utf8'));
  const prefix = `${PAYLOAD}/`;
  const pinned = Object.keys(manifest.files || {}).filter(file => file.startsWith(prefix)).sort();
  const actual = files.map(file => prefix + file).sort();
  if (manifest.packageVersion !== candidate.version || JSON.stringify(pinned) !== JSON.stringify(actual)) {
    throw new Error('updater_refresh_manifest_mismatch');
  }
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(candidate.payload, ...file.split('/')));
    const row = manifest.files[prefix + file];
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (row.bytes !== bytes.length || row.sha256 !== digest) throw new Error(`updater_refresh_payload_mismatch:${file}`);
  }
}

async function refreshUpdater(root, operationId, { timeoutMs = WAIT_MS, pollMs = 500, logger = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const candidate = readCandidate(root);
    if (!candidate || candidate.journal.operationId !== operationId) return false;
    if (candidate.journal.status === 'complete') {
      const { withUpdateLock } = require(path.join(candidate.updater, 'core', 'lock.cjs'));
      try {
        return await withUpdateLock(root, async () => {
          const current = readCandidate(root);
          if (!current || current.journal.operationId !== operationId || current.journal.status !== 'complete'
            || current.journal.decision !== 'commit' || !current.journal.flags?.candidateVerified) return false;
          const { installUpdaterIntoTarget, listStaticFiles } = require(path.join(current.updater, 'core', 'updater-bootstrap.cjs'));
          verifyPayload(current, listStaticFiles(current.payload));
          await installUpdaterIntoTarget({ sourceUpdaterDir: current.payload, targetRoot: root, logger });
          await current.journalApi.writeJournal(current.journalPath, current.journal, { updaterRefreshedAt: new Date().toISOString() });
          return true;
        });
      } catch (error) {
        if (error.code !== 'UPDATER_ALREADY_RUNNING') throw error;
      }
    }
    await delay(pollMs);
  } while (Date.now() < deadline);
  return false;
}

function scheduleUpdaterRefresh(root, { afterIntegrity = false } = {}) {
  const candidate = readCandidate(root);
  if (!candidate) return false;
  if (!afterIntegrity && candidate.journal.status !== 'complete') return false;
  const child = spawn(process.execPath, ['--no-warnings', __filename, candidate.journal.operationId], {
    cwd: root, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.on('error', error => logRefresh(root, error.message));
  child.unref();
  return true;
}

function logRefresh(root, message) {
  try {
    fs.appendFileSync(path.join(root, 'UPDATER', 'logs', 'updater-refresh.log'), `${new Date().toISOString()} ${message}\n`);
  } catch (_) {}
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  refreshUpdater(root, process.argv[2], { logger: message => logRefresh(root, message) }).catch(error => {
    logRefresh(root, error.message);
    process.exitCode = 1;
  });
}

module.exports = { PAYLOAD, verifyPayload, refreshUpdater, scheduleUpdaterRefresh };
