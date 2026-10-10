'use strict';
// Ultralight architecture feasibility — can a REBUILD (not just minify) reach <1,000,000B?
//
// The layer report proved where the bytes are; this answers whether an architectural
// rebuild can actually move them. It measures the four levers the design names, each
// independently, and reports the best-case outcome honestly:
//
//   L1 comment/header removal      (design strategy 1: release-only waste)
//   L2 embedded-SDK closure        (design strategy 2: owner-specific dependency closure)
//   L3 minify                      (measured with terser in the calling shell, recorded here)
//   L4 dead/duplicate elimination  (design strategy 3: only what reference analysis PROVES)
//
// It deliberately does NOT claim a lever works. Each is either measured or marked
// UNMEASURED with the reason. The design's rule is explicit: "a size win that breaks a
// preservation test is a failure" and "do not claim completion from minification alone".
//
// Usage: node tools/ultralight_feasibility.cjs --plugin hayaku [--json]
const fs = require('node:fs');
const path = require('node:path');
const { readSource, discoverTopDeclarations, countIdentifier } = require('./lib/ultralight_scan.cjs');

const root = path.resolve(__dirname, '..');
const PLUGINS = Object.freeze({
  hayaku: 'plugins/HAYAKU_Locator_Continuity.js',
  flashback: 'plugins/Flashback_Memory.js',
  libra: 'plugins/LIBRA.js'
});
const HARD_CAP = 1_000_000;

// Embedded-region patterns, mirroring tools/sync_embedded_sdk.cjs and the consent sync.
const REGIONS = Object.freeze([
  ['storage-sdk', /\/\* LIBRARIAN SYSTEM STORAGE SDK[\s\S]*?\r?\n  return bridge;\r?\n\r?\n?\};/g],
  ['compute-sdk', /\/\* LIBRARIAN SYSTEM COMPUTE SDK[\s\S]*?\r?\n  return bridge;\r?\n\};/g],
  ['host-lineage-sdk', /\/\* LIBRARIAN HOST LINEAGE SDK[\s\S]*?\/\* END LIBRARIAN HOST LINEAGE SDK \*\//g],
  ['source-edit-consent', /\/\* LIBRARIAN SYSTEM SOURCE EDIT CONSENT[\s\S]*?\/\* END LIBRARIAN SYSTEM SOURCE EDIT CONSENT \*\//g],
  ['execution-contract', /\/\* LIBRARIAN SYSTEM EXECUTION CONTRACT[\s\S]*?\/\* END LIBRARIAN SYSTEM EXECUTION CONTRACT \*\//g],
  ['portable-backup', /\/\* LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP[\s\S]*?(?=\n\s*\/\* |\Z)/g]
]);

const stripRegions = (src, names) => {
  let out = src;
  for (const [name, re] of REGIONS) {
    if (!names.includes(name)) continue;
    re.lastIndex = 0;
    out = out.replace(re, '');
  }
  return out;
};

const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const main = () => {
  const argv = process.argv.slice(2);
  let plugin = 'hayaku';
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--plugin') plugin = String(argv[++i]);
    else if (a === '--json') asJson = true;
    else throw new Error(`unknown_argument:${a}`);
  }
  const rel = PLUGINS[plugin];
  if (!rel) throw new Error(`unknown_plugin:${plugin}`);
  const file = path.join(root, rel);
  const { src, masked, bytes: totalBytes } = readSource(file);
  const decls = discoverTopDeclarations(src, masked);
  const cap = HARD_CAP;

  // --- L1: comments / banners -------------------------------------------------
  let commentBytes = 0;
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) commentBytes += Buffer.byteLength(m[0]);
  for (const m of src.matchAll(/^[ \t]*\/\/[^\n]*$/gm)) commentBytes += Buffer.byteLength(m[0]);
  const l1 = { bytes: commentBytes, percent: Number(((commentBytes / totalBytes) * 100).toFixed(2)) };

  // --- L2: embedded regions ---------------------------------------------------
  const regionRows = [];
  for (const [name, re] of REGIONS) {
    re.lastIndex = 0;
    let count = 0;
    let bytes = 0;
    let m;
    while ((m = re.exec(src)) !== null) { count += 1; bytes += Buffer.byteLength(m[0]); }
    if (count) regionRows.push({ name, count, bytes });
  }
  const regionBytes = regionRows.reduce((s, r) => s + r.bytes, 0);

  // Which regions are only reachable through a proxy factory? Those are the tree-shake
  // candidates: the design says to "tree-shake embedded SDKs to owner-specific dependency
  // closures", i.e. keep the code the owner actually calls.
  const treeShakeCandidates = regionRows.map(r => {
    // Conservative lower bound: the region banner comment + the exported surface that no
    // identifier in the plugin references. Without a real module graph this is a REVIEW
    // FIGURE, not a saving.
    return { ...r, reviewedAsCandidate: true };
  });

  // --- L3: minify -------------------------------------------------------------
  // Measured outside this script (terser needs its own process). The caller passes the
  // measured minified size so the report stays a single artifact.
  const measuredMin = Number(process.env.ULTRALIGHT_MINIFIED_BYTES || 0) || null;

  // --- L4: reference topology -------------------------------------------------
  // Which declarations are referenced only inside their own body? Those are the only ones
  // even eligible for consideration, and the design forbids regex-based deletion, so this
  // list is a REVIEW QUEUE, never a saving.
  const selfOnly = [];
  for (const d of decls) {
    const refs = countIdentifier(masked, d.name, { excludeStart: d.start, excludeStop: d.stop });
    if (refs === 0) selfOnly.push({ name: d.name, bytes: d.bytes, lines: d.lines, kind: d.kind });
  }
  selfOnly.sort((a, b) => b.bytes - a.bytes);

  const report = {
    schema: 'librarian.ultralight.feasibility.v1',
    plugin,
    file: rel,
    totalBytes,
    hardCap: cap,
    gapToHardCap: Math.max(0, totalBytes - cap),
    declarations: decls.length,
    levers: {
      L1_comments: l1,
      L2_embeddedRegions: { total: regionBytes, percentOfFile: Number(((regionBytes / totalBytes) * 100).toFixed(2)), regions: regionRows, candidates: treeShakeCandidates },
      L3_minify: {
        measuredMinifiedBytes: measuredMin,
        reductionBytes: measuredMin ? totalBytes - measuredMin : null,
        note: measuredMin
          ? 'Measured with terser (compress + toplevel mangle, comments dropped). This is the ceiling for a rebuild that changes no code.'
          : 'UNMEASURED — set ULTRALIGHT_MINIFIED_BYTES to record the terser result.'
      },
      L4_selfReferencedDeclarations: {
        count: selfOnly.length,
        bytes: selfOnly.reduce((s, d) => s + d.bytes, 0),
        note: 'Names with zero references outside their own body in the MASKED source. Strings are blanked, so dynamically dispatched names are NOT counted. This is a review queue, not a saving: the design forbids regex-based deletion and requires an AST/builder to remove anything.'
      }
    },
    bestCase: (() => {
      // Honest arithmetic: minify already removes comments and collapses whitespace, so
      // L1 must NOT be added on top of L3. The only additive lever on top of minify is
      // deleting code the product does not need — which is exactly what is unmeasured.
      const after = measuredMin || totalBytes;
      return {
        afterMinify: after,
        stillOverCapBy: Math.max(0, after - cap),
        additiveLeversMeasured: false,
        explanation: [
          'L1 (comments) is already inside L3 (minify): they are not additive.',
          'L2 (embedded regions) reduces SOURCE bytes, but the region code that survives is still minified, so its net effect must be measured by rebuilding, not by subtraction.',
          'L4 is a review queue: no bytes are claimed until a replacement path exists and preservation tests pass.',
          `After minify the file is ${after.toLocaleString()}B, i.e. ${Math.max(0, after - cap).toLocaleString()}B over the hard cap.`
        ]
      };
    })(),
    reviewQueue: selfOnly.slice(0, 30)
  };

  if (asJson) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }

  const pct = b => `${((b / totalBytes) * 100).toFixed(2)}%`;
  console.log(`\n=== ${plugin} — architecture feasibility`);
  console.log(`total ${totalBytes.toLocaleString()} B | hard cap ${cap.toLocaleString()} B | gap ${(totalBytes - cap).toLocaleString()} B (${pct(totalBytes - cap)} of file)`);
  console.log(`\nL1 comments/headers      ${l1.bytes.toLocaleString().padStart(9)} B  ${pct(l1.bytes)}  (already inside minify)`);
  console.log(`L2 embedded regions      ${regionBytes.toLocaleString().padStart(9)} B  ${pct(regionBytes)}`);
  for (const r of regionRows) console.log(`     ${r.name.padEnd(20)} ${r.bytes.toLocaleString().padStart(9)} B`);
  console.log(`L3 minify                ${measuredMin ? `${measuredMin.toLocaleString().padStart(9)} B` : '       UNMEASURED'}  ${measuredMin ? pct(totalBytes - measuredMin) + ' reduction' : ''}`);
  console.log(`L4 self-referenced decls ${String(report.levers.L4_selfReferencedDeclarations.count).padStart(9)}    ${report.levers.L4_selfReferencedDeclarations.bytes.toLocaleString()} B total (review queue)`);
  console.log(`\nbest case after minify: ${report.bestCase.afterMinify.toLocaleString()} B -> still over cap by ${report.bestCase.stillOverCapBy.toLocaleString()} B`);
  console.log(`\ntop self-referenced declarations (review queue, NOT a saving):`);
  for (const d of report.reviewQueue.slice(0, 10)) console.log(`   ${d.name.padEnd(44)} ${String(d.lines).padStart(5)}L ${d.bytes.toLocaleString().padStart(9)} B [${d.kind}]`);
  console.log();
};

try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
