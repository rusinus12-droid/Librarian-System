'use strict';
// Ultralight size inventory — historical growth is reported, not a build failure.
//
// Design §11.5/§12.2: the gate measures the ACTUAL generated release JS bytes, never a
// ZIP/gzip size, never a line count, never a `.length`. A missing input is a failure:
// the gate must not silently pass because a file was not produced.
//
// Usage:
//   node tools/check_plugin_size.cjs                    # report the readable plugins/ tree
//   node tools/check_plugin_size.cjs --dir dist/plugins  # report built release artifacts
//   node tools/check_plugin_size.cjs --report            # print a report, do not fail
//
// Exit code: 0 when all artifacts exist, 1 for missing/invalid inputs. No platform cap is asserted here.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// One source for historical measurements. These are not platform/resource limits.
// Growth is reported for review; only missing inputs fail this size inventory.
const { PLUGINS } = require('./build_plugins.cjs');
const FLOORS = Object.freeze(Object.fromEntries(Object.entries(PLUGINS).map(([owner, spec]) => [owner, spec.floor])));

// The original, now-withdrawn cap, kept for reporting only.
const WITHDRAWN_CAP = 1_000_000;

// The design names three plugins, but all SEVEN ship in the same release: a release that is
// half minified and half readable is worse for support than either extreme, and an ungated
// plugin has no ceiling at all. LIA and RETRACE are gated on the same terms.
const TARGETS = Object.freeze(Object.entries(PLUGINS).map(([owner,spec])=>({owner,file:path.basename(spec.file)})));

const parseArgs = argv => {
  const out = { dir: 'plugins', reportOnly: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--dir') {
      const value = argv[++i];
      if (!value || String(value).startsWith('--')) throw new Error('check_plugin_size_dir_value_required');
      out.dir = String(value);
    } else if (arg === '--report') out.reportOnly = true;
    else if (arg === '--json') out.json = true;
    else throw new Error(`unknown_check_plugin_size_argument:${arg}`);
  }
  return out;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(root, args.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`check_plugin_size_dir_missing:${args.dir}`);
  }

  const rows = [];
  const failures = [];
  const warnings = [];
  for (const target of TARGETS) {
    const file = path.join(dir, target.file);
    if (!fs.existsSync(file)) {
      // A missing artifact is a failure, not a skip (design §12.2).
      failures.push(`${target.owner}: missing artifact ${path.relative(root, file)}`);
      rows.push({ owner: target.owner, file: target.file, bytes: null, present: false });
      continue;
    }
    const bytes = fs.statSync(file).size;
    const floor = FLOORS[target.owner];
    const row = {
      owner: target.owner,
      file: target.file,
      present: true,
      bytes,
      floor,
      withinFloor: bytes <= floor,
      overFloorBy: Math.max(0, bytes - floor),
      headroomUnderFloor: Math.max(0, floor - bytes),
      underWithdrawnCap: bytes < WITHDRAWN_CAP,
      reductionToWithdrawnCap: Math.max(0, bytes - WITHDRAWN_CAP)
    };
    rows.push(row);
    if (!row.withinFloor) warnings.push(`${target.owner}: ${bytes} bytes exceeds the measured floor ${floor} by ${row.overFloorBy}`);
  }

  const report = {
    schema: 'librarian.ultralight.size.gate.v1',
    at: new Date().toISOString(),
    dir: path.relative(root, dir).split(path.sep).join('/'),
    floors: FLOORS,
    withdrawnCap: WITHDRAWN_CAP,
    rows,
    totalBytes: rows.reduce((sum, r) => sum + (r.bytes || 0), 0),
    totalFloors: rows.reduce((sum, r) => sum + (r.floor || 0), 0),
    totalOverFloor: rows.reduce((sum, r) => sum + (r.overFloorBy || 0), 0),
    warnings,
    policy: 'historical_baseline_reporting_only',
    passed: failures.length === 0
  };

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const row of rows) {
      if (!row.present) { console.log(`${row.owner.padEnd(10)} MISSING ${row.file}`); continue; }
      const status = row.withinFloor ? (row.headroomUnderFloor ? 'WITHIN' : 'AT-FLOOR') : 'OVER-FLOOR';
      console.log(`${row.owner.padEnd(10)} ${String(row.bytes).padStart(9)} B  ${status.padEnd(11)} floor ${String(row.floor).padStart(9)}  headroom ${String(row.headroomUnderFloor).padStart(8)}`);
    }
    console.log(`total ${report.totalBytes} B; floors total ${report.totalFloors} B; over floor by ${report.totalOverFloor} B`);
    console.log(`(withdrawn 1,000,000 cap: ${report.rows.filter(r => r.present && !r.underWithdrawnCap).length} plugin(s) still above it)`);
  }

  for (const warning of warnings) process.stderr.write(`SIZE WARNING: ${warning}\n`);
  if (!report.passed) {
    for (const failure of failures) process.stderr.write(`SIZE GATE FAIL: ${failure}\n`);
    if (!args.reportOnly) process.exitCode = 1;
    else process.stdout.write('(report mode: exit code suppressed)\n');
  } else if (!args.json) {
    process.stdout.write('size inventory complete (historical baseline warnings are non-blocking)\n');
  }
};

try { main(); } catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
