'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const updater = require('../../UPDATER/updater.cjs');

(async () => {
  const parsed = updater.parseArgs(['--user-update']);
  assert.equal(parsed.userUpdate, true, 'user-facing updater mode must be a first-class CLI mode');

  assert.match(updater.friendlyErrorMessage(new Error('prepared_candidate_missing')), /업데이트.*준비|다시.*시작/);
  assert.match(updater.friendlyErrorMessage(new Error('release_sha256_mismatch')), /무결성|손상|검증/);
  assert.match(updater.friendlyErrorMessage(new Error('download_http_503')), /다운로드|인터넷|GitHub/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian updater ux '));
  try {
    fs.mkdirSync(path.join(temp, 'PROGRAM'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'DATA'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'UPDATER'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'PROGRAM', 'VERSION.txt'), '0.3.52\n');
    const calls = [];
    const messages = [];
    const result = await updater.runUserUpdate({
      rootDir: temp,
      logger: message => messages.push(String(message)),
      deps: {
        checkLatest: async ({ currentVersion }) => {
          calls.push(['check', currentVersion]);
          return {
            available: true,
            currentVersion,
            latestVersion: '0.3.53',
            officialAsset: {
              name: 'Librarian-System-0.3.53.zip',
              url: 'https://example.invalid/Librarian-System-0.3.53.zip',
              sha256: 'a'.repeat(64)
            }
          };
        },
        downloadRelease: async (_url, destination, expectedSha256) => {
          calls.push(['download', path.basename(destination), expectedSha256]);
          return { path: destination, sha256: expectedSha256, bytes: 123 };
        },
        prepareReleaseCandidate: async options => {
          calls.push(['prepare', options.targetVersion]);
          return { updatePolicy: 'migration_required', targetVersion: '0.3.53' };
        },
        applyReceipt: async ({ receipt }) => {
          calls.push(['apply', receipt.updatePolicy]);
          return { status: 'complete' };
        }
      }
    });
    assert.equal(result.applied, true);
    assert.deepEqual(calls.map(row => row[0]), ['check', 'download', 'prepare', 'apply']);
    assert.ok(messages.some(line => /업데이트.*완료/.test(line)), 'success must be written for normal users');
    assert.ok(messages.some(line => /RisuAI.*자동.*변경|자동.*교체.*않/.test(line)), 'server updater must explain that RisuAI plugins are separate');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const bat = fs.readFileSync(path.join(root, '업데이트.bat'), 'utf8');
  assert.match(bat, /--user-update/i);
  assert.match(bat, /기존.*설치/i);
  assert.match(bat, /--target-root/i);
  assert.match(bat, /pause/i, 'double-click mode must keep the result visible on Windows');

  const sh = fs.readFileSync(path.join(root, '업데이트.sh'), 'utf8');
  assert.match(sh, /--user-update/);
  assert.match(sh, /기존.*설치/);
  assert.match(sh, /--target-root/);

  const command = fs.readFileSync(path.join(root, '업데이트.command'), 'utf8');
  assert.match(command, /업데이트\.sh/);
  assert.match(command, /read/);

  for (const guide of ['0_설치_안내.txt', 'PROGRAM/처음_읽어주세요.txt', 'PROGRAM/PACKAGE_CONTENTS.txt']) {
    const text = fs.readFileSync(path.join(root, guide), 'utf8');
    assert.match(text, /업데이트\.bat/);
    assert.match(text, /RisuAI/);
    assert.doesNotMatch(text, /새 패키지의 PROGRAM으로 기존 PROGRAM을 교체합니다/,
      `${guide} must not instruct manual PROGRAM replacement anymore`);
  }

  console.log('updater_user_experience_test: PASS');
})().catch(error => {
  console.error('updater_user_experience_test: FAIL');
  console.error(error.stack || error);
  process.exitCode = 1;
});
