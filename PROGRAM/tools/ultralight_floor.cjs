'use strict';
// Ultralight achievable floor — what is the SMALLEST this plugin can be today?
//
// The earlier feasibility work established that the design's 1,000,000 B target is not
// reachable for any of the three plugins: LIBRA's minified STRING LITERALS alone
// (1.53 MB) exceed it, and HAYAKU would need 71% of surviving code removed. This tool
// answers the follow-up question: "what IS reachable, and with which levers?"
//
// It measures only levers that are available NOW and do not change product behavior:
//
//   L1  comments/headers      — free (already gone after minify)
//   L2  embedded SDK regions   — additive text; the owner's dependency closure can be
//                                reduced without touching any product feature
//   L3  minify                 — whitespace/identifier compression
//   L4  developer-only surface — `_test` export blocks (excluded from release per
//                                design §11.5, but they must be removed by a BUILDER,
//                                never by regex on the source of truth)
//
// Everything is reported in uncompressed bytes. Nothing is claimed as a saving unless
// the artifact was actually rebuilt and re-minified.
//
// Usage:
//   node tools/ultralight_floor.cjs                # all three target plugins
//   node tools/ultralight_floor.cjs --plugin libra
//   node tools/ultralight_floor.cjs --json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const PLUGINS = Object.freeze({
  hayaku: 'plugins/HAYAKU_Locator_Continuity.js',
  flashback: 'plugins/Flashback_Memory.js',
  libra: 'plugins/LIBRA.js'
});
const TARGETS = ['hayaku', 'flashback', 'libra'];
const HARD_CAP = 1_000_000;

// Embedded regions, in the exact shapes tools/sync_embedded_sdk.cjs writes them.
const REGIONS = Object.freeze([
  ['storage-sdk', /\/\* LIBRARIAN SYSTEM STORAGE SDK[\s\S]*?return bridge;\r?\n\r?\n\};/g],
  ['compute-sdk', /\/\* LIBRARIAN SYSTEM COMPUTE SDK[\s\S]*?scheduleProbe\(\);\r?\n\s*return bridge;\r?\n\};/g],
  ['host-lineage-sdk', /\/\* LIBRARIAN HOST LINEAGE SDK[\s\S]*?\/\* END LIBRARIAN HOST LINEAGE SDK \*\//g],
  ['source-edit-consent', /\/\* LIBRARIAN SYSTEM SOURCE EDIT CONSENT[\s\S]*?\/\* END LIBRARIAN SYSTEM SOURCE EDIT CONSENT \*\//g],
  ['execution-contract', /\/\* LIBRARIAN SYSTEM EXECUTION CONTRACT[\s\S]*?\/\* END LIBRARIAN SYSTEM EXECUTION CONTRACT \*\//g],
  ['portable-backup', /\/\* LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: \w+ START \*\/[\s\S]*?\/\* LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: \w+ END \*\//g]
]);

const TERSER_FLAGS = [
  '-c', 'defaults=true,unsafe=false,drop_console=true,passes=3',
  '-m', 'toplevel=true,properties=false',
  '--format', 'comments=false'
];

// Minify through a real temp FILE: this terser build does not accept '-' as stdin.
// Returns bytes, or null when terser refused the input — which is itself a finding,
// because a rewrite that breaks parsing must never be shipped.
let minifySeq = 0;
const minifyBytes = (src, scratchDir) => {
  const inFile = path.join(scratchDir, `in_${minifySeq}.js`);
  const outFile = path.join(scratchDir, `out_${minifySeq}.js`);
  minifySeq += 1;
  fs.writeFileSync(inFile, src);
  const result = spawnSync('npx', ['--yes', 'terser', inFile, '-o', outFile, ...TERSER_FLAGS], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.status !== 0) return { bytes: null, error: String(result.stderr || '').slice(0, 300) };
  if (!fs.existsSync(outFile)) return { bytes: null, error: 'terser produced no output file' };
  const bytes = fs.statSync(outFile).size;
  fs.rmSync(inFile, { force: true });
  fs.rmSync(outFile, { force: true });
  return { bytes, error: '' };
};

// Count the developer-only `_test:` export block without removing it from the source of
// truth. Only an object-literal property named `_test` counts.
const measureTestSurface = src => {
  const matches = [...src.matchAll(/^[ \t]*_test[ \t]*:[ \t]*\{/gm)];
  if (!matches.length) return { blocks: 0, bytes: 0 };
  let bytes = 0;
  for (const m of matches) {
    let p = m.index;
    let depth = 0;
    let started = false;
    while (p < src.length) {
      const c = src[p];
      if (c === '{') { depth += 1; started = true; }
      else if (c === '}') { depth -= 1; if (started && depth === 0) break; }
      p += 1;
    }
    bytes += Buffer.byteLength(src.slice(m.index, p + 1));
  }
  return { blocks: matches.length, bytes };
};

const analyze = (plugin, scratchDir) => {
  const rel = PLUGINS[plugin];
  const file = path.join(root, rel);
  const src = fs.readFileSync(file, 'utf8');
  const sourceBytes = Buffer.byteLength(src);

  // L3: minify the source as-is.
  const asIs = minifyBytes(src, scratchDir);

  // L2: strip embedded regions, then minify.
  let stripped = src;
  const regionRows = [];
  for (const [name, re] of REGIONS) {
    re.lastIndex = 0;
    const found = [...stripped.matchAll(re)];
    const bytes = found.reduce((sum, m) => sum + Buffer.byteLength(m[0]), 0);
    if (bytes) regionRows.push({ name, count: found.length, bytes });
    stripped = stripped.replace(re, '');
  }
  const regionBytes = regionRows.reduce((sum, r) => sum + r.bytes, 0);
  const withoutRegions = regionBytes ? minifyBytes(stripped, scratchDir) : { bytes: asIs.bytes, error: '' };

  // L4: developer-only export surface (measured, never regex-removed here).
  const testSurface = measureTestSurface(src);

  // The floor is the best of the levers that are proven to work today. A lever whose
  // artifact failed to parse is recorded as unavailable, not as a saving.
  const candidates = [
    { lever: 'minify only', bytes: asIs.bytes, available: asIs.bytes !== null },
    { lever: 'minify + embedded-SDK strip', bytes: withoutRegions.bytes, available: withoutRegions.bytes !== null }
  ].filter(c => c.available);
  const floor = candidates.length ? Math.min(...candidates.map(c => c.bytes)) : null;

  return {
    plugin,
    file: rel,
    sourceBytes,
    hardCap: HARD_CAP,
    minify: { bytes: asIs.bytes, error: asIs.error, reductionPercent: asIs.bytes ? Number((((sourceBytes - asIs.bytes) / sourceBytes) * 100).toFixed(2)) : null },
    embeddedRegions: { total: regionBytes, regions: regionRows, minifiedAfterStrip: withoutRegions.bytes, error: withoutRegions.error },
    developerSurface: testSurface,
    candidates,
    floor,
    floorOverCapBy: floor === null ? null : Math.max(0, floor - HARD_CAP),
    percentOverCap: floor === null ? null : Number(((Math.max(0, floor - HARD_CAP) / floor) * 100).toFixed(2))
  };
};

const main = () => {
  const argv = process.argv.slice(2);
  let plugin = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--plugin') plugin = String(argv[++i]);
    else if (a === '--json') asJson = true;
    else throw new Error(`unknown_argument:${a}`);
  }
  const list = plugin ? [plugin] : TARGETS;
  for (const p of list) if (!PLUGINS[p]) throw new Error(`unknown_plugin:${p}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ultralight-floor-'));
  let rows;
  try {
    rows = list.map(p => analyze(p, scratch));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (asJson) { process.stdout.write(`${JSON.stringify({ schema: 'librarian.ultralight.floor.v1', rows }, null, 2)}\n`); return; }

  console.log('');
  for (const r of rows) {
    console.log(`=== ${r.plugin} (${r.file})`);
    console.log(`  source                 ${r.sourceBytes.toLocaleString().padStart(10)} B`);
    console.log(`  L3 minify              ${(r.minify.bytes ?? 0).toLocaleString().padStart(10)} B  (${r.minify.reductionPercent}% off source)`);
    for (const reg of r.embeddedRegions.regions) console.log(`     embedded ${reg.name.padEnd(20)} ${reg.bytes.toLocaleString().padStart(10)} B`);
    if (r.embeddedRegions.minifiedAfterStrip) console.log(`  L2+L3 floor            ${r.embeddedRegions.minifiedAfterStrip.toLocaleString().padStart(10)} B`);
    console.log(`  developer _test surface ${r.developerSurface.bytes.toLocaleString().padStart(9)} B in ${r.developerSurface.blocks} block(s)  (release-excludable, measured only)`);
    console.log(`  achievable floor       ${(r.floor ?? 0).toLocaleString().padStart(10)} B   -> over ${r.hardCap.toLocaleString()} cap by ${(r.floorOverCapBy ?? 0).toLocaleString()} B (${r.percentOverCap}% of floor)`);
    console.log('');
  }
  if (rows.length > 1) {
    const sum = rows.reduce((s, r) => s + (r.floor || 0), 0);
    const cap = rows.length * HARD_CAP;
    console.log(`TOTAL floor ${sum.toLocaleString()} B vs ${cap.toLocaleString()} B of caps (over by ${(sum - cap).toLocaleString()} B)`);
  }
};

try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
