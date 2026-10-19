'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const read = relative => fs.readFileSync(path.join(programDir, relative));
const text = relative => read(relative).toString('utf8');

const requiredUtf8Paths = [
  '0_설치_안내.txt',
  'DATA/이_DATA_폴더를_통째로_백업하세요.txt',
  'PROGRAM/1_서버_실행.bat',
  'PROGRAM/2_서버_종료.bat',
  'PROGRAM/서버_백그라운드_실행.bat',
  'PROGRAM/서버_상태_확인.bat',
  'PROGRAM/memory-suite.sh',
  'PROGRAM/1_서버_실행.sh',
  'PROGRAM/2_서버_종료.sh',
  'PROGRAM/서버_백그라운드_실행.sh',
  'PROGRAM/서버_상태_확인.sh',
  'PROGRAM/macOS_서버_실행.command',
  'PROGRAM/안드로이드_Termux_준비.sh',
  'PROGRAM/DATA_폴더_열기.bat',
  'PROGRAM/RisuAI_플러그인_폴더_열기.bat',
  'PROGRAM/처음_읽어주세요.txt',
  'PROGRAM/docs/사용설명서.md',
  'PROGRAM/docs/보안과_복구.md',
  'PROGRAM/docs/데이터_구조와_마이그레이션.md',
  'PROGRAM/관리도구/백업_건강도_검사.bat',
  'PROGRAM/관리도구/백업_건강도_검사.sh',
  'PROGRAM/관리도구/연결된_플러그인_보기.bat',
  'PROGRAM/관리도구/연결된_플러그인_보기.sh',
  'PROGRAM/관리도구/데이터_무결성_검사.bat',
  'PROGRAM/관리도구/데이터_무결성_검사.sh',
  'PROGRAM/관리도구/백업_목록_보기.bat',
  'PROGRAM/관리도구/백업_목록_보기.sh',
  'PROGRAM/관리도구/지금_백업_만들기.bat',
  'PROGRAM/관리도구/지금_백업_만들기.sh',
  'PROGRAM/관리도구/전체_자동시험.bat',
  'PROGRAM/관리도구/전체_자동시험.sh',
  'PROGRAM/관리도구/복구_전용_오프라인_복원.bat',
  'PROGRAM/관리도구/복구_전용_오프라인_복원.sh',
  'PROGRAM/관리도구/포터블_Node_런타임_설치.bat',
  'PROGRAM/관리도구/복원_계획_미리보기.bat',
  'PROGRAM/관리도구/복원_계획_미리보기.sh',
  'PROGRAM/관리도구/백업에서_복원.bat',
  'PROGRAM/관리도구/백업에서_복원.sh'
];

function batchFiles(root) {
  const out = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:bat|cmd)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function main() {
  for (const relative of requiredUtf8Paths) {
    assert.ok(fs.existsSync(path.join(packageRoot, relative)), `Missing UTF-8 distribution path: ${relative}`);
  }
  const distributionPaths = [];
  const walkDistribution = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      distributionPaths.push(path.relative(packageRoot, full));
      if (entry.isDirectory()) walkDistribution(full);
    }
  };
  walkDistribution(packageRoot);
  for (const relative of distributionPaths) {
    assert.doesNotMatch(relative, /[∞δΩφ╕╖╣▒▓░]/u, `Mojibake remains in distribution path: ${relative}`);
  }

  const finder = text('_find_node.bat');
  const common = text('_common.cmd');
  const start = text('1_서버_실행.bat');
  const foreground = text('_server_foreground.cmd');
  const background = text('서버_백그라운드_실행.bat');
  const status = text('서버_상태_확인.bat');
  const stop = text('2_서버_종료.bat');
  const integrity = text('관리도구/데이터_무결성_검사.bat');
  const installer = text('tools/install_runtime.ps1');

  assert.match(finder, /tools\\check_node\.cjs/i);
  assert.doesNotMatch(finder, /for\s+\/f[^\r\n]+process\.versions/i,
    'Node version must not be parsed through a nested FOR /F command.');
  assert.match(finder, /NODE_CANDIDATE_SOURCE=portable/i);
  assert.match(finder, /NODE_SOURCE=%NODE_CANDIDATE_SOURCE%/i);

  assert.match(common, /for %%I in \("%~dp0\."\) do set "MEMORY_SUITE_PROGRAM_DIR=%%~fI"/i);
  assert.doesNotMatch(common, /set "MEMORY_SUITE_PROGRAM_DIR=%~dp0"/i);
  assert.match(common, /MEMORY_SUITE_NODE_RETRY/i);
  assert.match(common, /\[1\/4\][\s\S]*\[4\/4\]/);
  assert.match(common, /startup-error\.log/i);
  assert.match(common, /--program-dir "%MEMORY_SUITE_PROGRAM_DIR%" --data-dir "%MEMORY_SUITE_DATA_DIR%"/i);
  assert.doesNotMatch(common, /prepare_data\.cjs[^\r\n]*>\s*nul/i);
  assert.match(common, /Do not touch DATA before prepare_data verifies/i);
  assert.match(common, /MEMORY_SUITE_NODE_ONLY[\s\S]*goto :node_only_ready/i);
  assert.ok(common.indexOf('MEMORY_SUITE_NODE_ONLY') < common.indexOf('prepare_data.cjs'),
    'Node-only commands must branch before DATA preparation.');
  assert.match(common, /:node_only_ready[\s\S]*DATA는 변경하지 않았습니다/);

  assert.match(start, /_server_foreground\.cmd/i);
  assert.match(start, /call "%MEMORY_SUITE_RUNNER%"/i,
    'Explorer launcher must run the foreground server in the same console.');
  assert.doesNotMatch(start, /\bstart\s+"Librarian System Server"/i,
    'launcher must not detach through the cmd/start quoting path that can close immediately.');
  assert.match(start, /pause\s*\r?\n\s*exit \/b %MEMORY_SUITE_EXIT_CODE%/i,
    'the outer launcher must retain every success or failure result on screen.');
  assert.match(start, /ZIP 안에서 직접 실행하지 말고 전체 폴더를 먼저 압축 해제하세요/);
  assert.match(foreground, /위에 표시된 단계와 원인을 확인하세요/);
  assert.match(foreground, /MEMORY_SUITE_NODE_ONLY=1/i);
  assert.match(foreground, /platform_launcher\.cjs" serve --data-dir/i);
  assert.match(foreground, /exit \/b %EXIT_CODE%/i,
    'foreground runner must return the real server exit code to the persistent outer launcher.');
  for (const [label, body, command] of [
    ['background', background, 'background'],
    ['status', status, 'status'],
    ['stop', stop, 'stop'],
    ['integrity', integrity, 'integrity']
  ]) {
    assert.match(body, /MEMORY_SUITE_NODE_ONLY=1/i, `${label} must skip DATA preparation in _common.cmd.`);
    assert.match(body, new RegExp(`platform_launcher\\.cjs" ${command} --data-dir`, 'i'),
      `${label} must use the unified identity-aware launcher.`);
  }
  assert.match(installer, /StagedNode/i);
  assert.match(installer, /Unblock-File/i);
  assert.match(installer, /check_node\.cjs/i);
  assert.match(installer, /PROCESSOR_ARCHITEW6432/);
  assert.match(installer, /ValidateSet\("22\.16\.0"\)/,
    'the installer must reject unverified runtime versions instead of reusing a different pinned digest');
  assert.match(installer, /node-v\$Version-win-\$Architecture\.zip/);
  assert.match(installer, /31e885dcd06355f67b4be8cca86464270d83d0f5b8d4e3d4369c16ed22a5f4fa/,
    'the official Node.js 22.16.0 Windows ARM64 ZIP digest must be pinned');
  assert.match(installer, /21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd/,
    'the official Node.js 22.16.0 Windows x64 ZIP digest must remain pinned');

  const server = text('server/server.cjs');
  assert.match(server, /startup-error\.log[\s\S]*SERVER_FATAL/,
    'fatal server startup errors must be persisted before the process exits.');

  // PROGRAM뿐 아니라 루트 업데이트.bat와 UPDATER의 Windows 실행 파일도 같은 규칙을 따른다.
  const bundleRoot = path.resolve(programDir, '..');
  const rootBatches = fs.readdirSync(bundleRoot).filter(name => /\.(?:bat|cmd)$/i.test(name)).map(name => path.join(bundleRoot, name));
  const updaterDir = path.join(bundleRoot, 'UPDATER');
  const updaterBatches = fs.existsSync(updaterDir) ? batchFiles(updaterDir) : [];
  for (const filePath of [...rootBatches, ...updaterBatches]) {
    const body = fs.readFileSync(filePath).toString('binary');
    assert.equal((body.match(/\n/g) || []).length, (body.match(/\r\n/g) || []).length,
      `Windows command file must use CRLF only: ${path.relative(bundleRoot, filePath)}`);
    if (/[^\x00-\x7f]/.test(body)) assert.match(body, /chcp 65001/i, `Korean Windows command file must select UTF-8: ${path.relative(bundleRoot, filePath)}`);
  }
  for (const filePath of batchFiles(programDir)) {
    const body = read(path.relative(programDir, filePath)).toString('binary');
    assert.equal((body.match(/\n/g) || []).length, (body.match(/\r\n/g) || []).length,
      `Windows command file must use CRLF only: ${path.relative(programDir, filePath)}`);
  }

  const result = spawnSync(process.execPath, [path.join(programDir, 'tools', 'check_node.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^v\d+\.\d+\.\d+/);
  process.stdout.write('windows_bootstrap_contract_test: PASS\n');
}

try { main(); }
catch (error) {
  process.stderr.write(`windows_bootstrap_contract_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
}
