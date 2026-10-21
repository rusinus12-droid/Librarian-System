'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PICKER_TIMEOUT_MS = 10 * 60 * 1000;

// Each command prints the chosen path on stdout and exits non-zero (or prints
// nothing) when the dialog is cancelled. Arguments are fixed strings: the
// updater never interpolates user input into a shell command.
const POWERSHELL_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.OpenFileDialog',
  "$d.Title = 'Librarian System 업데이트 ZIP 선택'",
  "$d.Filter = 'Librarian System 업데이트 (*.zip)|*.zip'",
  '$d.Multiselect = $false',
  "if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }"
].join('; ');

const PICKERS = Object.freeze({
  windows: [{ command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', POWERSHELL_SCRIPT] }],
  macos: [{
    command: 'osascript',
    args: ['-e', 'POSIX path of (choose file with prompt "Librarian System 업데이트 ZIP 선택" of type {"zip", "public.zip-archive"})']
  }],
  linux: [
    { command: 'zenity', args: ['--file-selection', '--title=Librarian System 업데이트 ZIP 선택', '--file-filter=Librarian System 업데이트 | *.zip'] },
    { command: 'kdialog', args: ['--getopenfilename', '.', '*.zip|Librarian System 업데이트 (*.zip)'] },
    { command: 'yad', args: ['--file', '--title=Librarian System 업데이트 ZIP 선택', '--file-filter=*.zip'] }
  ],
  // Termux has no desktop dialog; the caller falls back to a typed path.
  android: []
});

function cleanPath(value) {
  return String(value || '').replace(/\r?\n.*$/s, '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

// Returns { path } for a chosen file, { cancelled: true } when a dialog was shown
// and dismissed, or { unavailable: true } when this machine cannot show one.
function pickReleaseZip({ platform, spawn = spawnSync, env = process.env } = {}) {
  const candidates = PICKERS[platform] || [];
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { unavailable: true, reason: 'no_display' };
  for (const candidate of candidates) {
    const result = spawn(candidate.command, candidate.args, { encoding: 'utf8', timeout: PICKER_TIMEOUT_MS, windowsHide: false });
    if (result.error) continue; // command missing
    const chosen = cleanPath(result.stdout);
    if (result.status === 0 && chosen) return { path: chosen };
    return { cancelled: true };
  }
  return { unavailable: true, reason: candidates.length ? 'no_picker_installed' : 'platform_has_no_picker' };
}

function describeZip(zipPath) {
  const resolved = path.resolve(zipPath);
  const stat = fs.statSync(resolved);
  return { path: resolved, name: path.basename(resolved), bytes: stat.size };
}

module.exports = { pickReleaseZip, describeZip, cleanPath, PICKERS };
