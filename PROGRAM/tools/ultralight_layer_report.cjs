'use strict';
// Ultralight layer decomposition — answer "WHERE do the bytes live?" for a plugin.
//
// The design's §7.2 claim (repeated orchestration in HAYAKU's recovery paths) was
// measured and largely refuted: the four sibling orchestrators share ZERO identical
// lines, already delegate to each other, and their scaffolding is only 2–33% of their
// bodies. So before cutting anything, the byte budget must be attributed to LAYERS.
//
// Method: scan the source with a string/template/regex/comment-aware scanner, find
// every top-level declaration and its exact extent, size it, then assign it to a layer
// by (a) the enclosing named section region and (b) the identifier's role tokens.
// Everything is reported as UNCOMPRESSED BYTES, the only metric the size gate accepts.
//
// Usage:
//   node tools/ultralight_layer_report.cjs                       # HAYAKU (default)
//   node tools/ultralight_layer_report.cjs --plugin flashback
//   node tools/ultralight_layer_report.cjs --plugin libra --json
//   node tools/ultralight_layer_report.cjs --top 40              # biggest declarations
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const PLUGINS = Object.freeze({
  hayaku: 'plugins/HAYAKU_Locator_Continuity.js',
  flashback: 'plugins/Flashback_Memory.js',
  libra: 'plugins/LIBRA.js'
});

// ---------------------------------------------------------------------------
// Scanner: build a "masked" copy where string/template/regex/comment contents are
// replaced by spaces of identical length, so brace/paren depth counting is reliable
// while byte offsets still map 1:1 onto the original source.
// ---------------------------------------------------------------------------
const maskSource = src => {
  const out = new Array(src.length);
  let i = 0;
  let state = 'code'; // code | line | block | ' | " | `
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '"' || c === "'") { state = c; out[i] = c; i += 1; continue; }
      if (c === '`') { state = '`'; out[i] = c; i += 1; continue; }
      if (c === '/') {
        // A '/' begins a REGEX literal unless the previous significant character can
        // end an expression (identifier, digit, ')', ']', quote, backtick).
        let k = i - 1;
        while (k >= 0 && /\s/.test(src[k])) k -= 1;
        const prev = k >= 0 ? src[k] : '';
        const regexAllowed = !/[\w$)\]'"`]/.test(prev);
        if (regexAllowed) {
          let j = i + 1;
          let inClass = false;
          let closed = false;
          while (j < src.length) {
            const rj = src[j];
            if (rj === '\\') { j += 2; continue; }
            if (rj === '\n') break;               // unterminated: treat as division
            if (rj === '[') inClass = true;
            else if (rj === ']') inClass = false;
            else if (rj === '/' && !inClass) { closed = true; break; }
            j += 1;
          }
          if (closed) {
            // Blank the whole literal INCLUSIVE of its flags.
            let k2 = j + 1;
            while (k2 < src.length && /[a-z]/i.test(src[k2])) k2 += 1;
            for (let t = i; t < k2; t += 1) out[t] = src[t] === '\n' ? '\n' : ' ';
            i = k2; continue;
          }
        }
      }
      out[i] = c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out[i] = '\n'; i += 1; continue; }
      out[i] = ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      out[i] = c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // inside a string / template
    if (c === '\\') { out[i] = ' '; out[i + 1] = n === '\n' ? '\n' : ' '; i += 2; continue; }
    if (c === state) { state = 'code'; out[i] = c; i += 1; continue; }
    if (state === '`' && c === '$' && n === '{') {
      // Template interpolation: keep it as code so nested braces are counted, and
      // resume template state when its matching '}' closes.
      let depth = 0;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
        else if (src[j] === '"' || src[j] === "'") {
          const q = src[j]; j += 1;
          while (j < src.length && src[j] !== q) { if (src[j] === '\\') j += 1; j += 1; }
        }
        j += 1;
      }
      for (let k = i; k <= j && k < src.length; k += 1) out[k] = src[k] === '\n' ? '\n' : ' ';
      i = j + 1; continue;
    }
    out[i] = c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out.join('');
};

const lineIndex = src => {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  return {
    starts,
    lineOf: off => {
      let lo = 0; let hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
      return lo + 1;
    }
  };
};

// ---------------------------------------------------------------------------
// Declaration discovery on the masked source.
// ---------------------------------------------------------------------------
const DECL_PATTERNS = [
  // const NAME = async (args) => { / async args => {
  { kind: 'async', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*async[ \t]*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?[ \t]*=>/gm },
  // const NAME = (args) => { / NAME => {
  { kind: 'arrow', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>/gm },
  // const NAME = function
  { kind: 'func', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*function\b/gm },
  // async function NAME() / function NAME()
  { kind: 'decl', re: /^[ \t]*(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/gm },
  // const NAME = {  (object literal)
  { kind: 'object', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*\{[ \t]*$/gm },
  // class NAME
  { kind: 'class', re: /^[ \t]*class[ \t]+([A-Za-z_$][\w$]*)/gm }
];

// Find the end of a braced body starting at/after `from`, using the masked source.
const findBodyEnd = (masked, from) => {
  let p = from;
  let depth = 0;
  let started = false;
  while (p < masked.length) {
    const ch = masked[p];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return p;
    } else if (!started && ch === ';') return p; // no body: `const x = y;`
    p += 1;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Layer assignment.
// ---------------------------------------------------------------------------
// Identifier-role tokens, applied when no banner is available.
const ROLE_TOKENS = [
  // Host entry points and lifecycle hooks come first: they are the plugin's public
  // contract and must never be mistaken for an internal layer.
  ['host-entry', /^(handle|on|process|register|install|expose|bootstrap|init|mount|start|stop|boot|bind)/i],
  ['host-entry', /(RisuCompat|RequestKind|OutputEvent|beforeRequest|afterRequest|RisuReplacer|ChatListener|Hook)/i],
  ['host-entry', /(Expose|Api$|^api$)/],
  ['gui-render', /(viewer|render|panel|card|dialog|form|button|menu|html|element|css|style|guit|ui)/i],
  ['recall', /(recall|retriev|search|sparse|hybrid|bm25|rank|score|token|anchor|query)/i],
  ['capture', /(packet|capture|ingest|ledger|record|turn|pair|u\+a|completePair)/i],
  ['recovery', /(recover|repair|debt|lease|vault|consent|resync|missing|cold|regenerat|retry|resume)/i],
  ['embedding', /(embed|vector|compute|provider|llm|model|callOpenAI|callRisu)/i],
  ['storage', /(storage|commit|fence|journal|sidecar|persist|save|load|migrat|backup|import|export|scope|worldline|epoch)/i],
  ['prompt', /(prompt|skill|instruct|template|skeleton|guide)/i],
  ['sdk', /(MemorySuite|StorageClient|ComputeClient|HostLineage|bridge)/i],
  ['settings', /(setting|config|arg|option|preference)/i],
  ['diagnostics', /(diagnos|debug|trace|log|status|report|health)/i]
];

const layerFor = (name, kind) => {
  for (const [layer, re] of ROLE_TOKENS) if (re.test(name)) return layer;
  if (kind === 'object') return 'data-tables';
  return 'unclassified';
};

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const main = () => {
  const argv = process.argv.slice(2);
  let plugin = 'hayaku';
  let top = 25;
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--plugin') plugin = String(argv[++i]);
    else if (a === '--top') top = Number(argv[++i]) || 25;
    else if (a === '--json') asJson = true;
    else throw new Error(`unknown_argument:${a}`);
  }
  const rel = PLUGINS[plugin];
  if (!rel) throw new Error(`unknown_plugin:${plugin}`);
  const file = path.join(root, rel);
  const src = fs.readFileSync(file, 'utf8');
  const totalBytes = Buffer.byteLength(src);
  const masked = maskSource(src);
  const { lineOf } = lineIndex(src);

  // Collect declarations, skipping ones nested inside another declaration's body.
  const candidates = [];
  for (const { kind, re } of DECL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const name = m[1];
      const declStart = masked.indexOf(name, m.index);
      const bodyStart = masked.indexOf('{', declStart);
      const end = findBodyEnd(masked, declStart);
      const stop = end === null ? Math.min(masked.length, declStart + 1) : end + 1;
      candidates.push({ name, kind, start: m.index, declStart, stop });
    }
  }
  candidates.sort((a, b) => a.declStart - b.declStart || b.stop - a.stop);

  // Keep only outermost declarations (a declaration that starts inside another's body
  // is a nested helper; it is still part of the outer declaration's byte cost).
  const outer = [];
  for (const c of candidates) {
    const parent = outer.find(o => c.declStart > o.declStart && c.stop <= o.stop);
    if (parent) { parent.nested = (parent.nested || 0) + 1; continue; }
    outer.push(c);
  }

  const rows = outer.map(c => {
    const text = src.slice(c.start, c.stop);
    const bytes = Buffer.byteLength(text);
    return {
      name: c.name,
      kind: c.kind,
      from: lineOf(c.start),
      to: lineOf(c.stop),
      lines: lineOf(c.stop) - lineOf(c.start) + 1,
      bytes,
      nested: c.nested || 0,
      layer: layerFor(c.name, c.kind)
    };
  });

  const layerTotals = {};
  for (const r of rows) layerTotals[r.layer] = (layerTotals[r.layer] || 0) + r.bytes;
  const covered = rows.reduce((s, r) => s + r.bytes, 0);

  // Bytes NOT inside any top-level declaration: header, banners, embedded SDK region
  // (the SDK is itself one big IIFE/object), and loose statements.
  const uncovered = totalBytes - covered;

  // Embedded SDK regions carry their own banners.
  const sdkRegions = [];
  const SDK_PATTERNS = [
    ['storage-sdk', /\/\* LIBRARIAN SYSTEM STORAGE SDK[\s\S]*?\r?\n  return bridge;\r?\n\r?\n?\};/g],
    ['compute-sdk', /\/\* LIBRARIAN SYSTEM COMPUTE SDK[\s\S]*?\r?\n  return bridge;\r?\n\};/g],
    ['host-lineage-sdk', /\/\* LIBRARIAN HOST LINEAGE SDK[\s\S]*?\/\* END LIBRARIAN HOST LINEAGE SDK \*\//g],
    ['source-edit-consent', /\/\* LIBRARIAN SYSTEM SOURCE EDIT CONSENT[\s\S]*?\/\* END LIBRARIAN SYSTEM SOURCE EDIT CONSENT \*\//g],
    ['execution-contract', /\/\* LIBRARIAN SYSTEM EXECUTION CONTRACT[\s\S]*?\/\* END LIBRARIAN SYSTEM EXECUTION CONTRACT \*\//g],
    ['portable-backup', /\/\* LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP[\s\S]*?(?=\n\s*\/\* |\Z)/g]
  ];
  for (const [name, re] of SDK_PATTERNS) {
    re.lastIndex = 0;
    let m; let bytes = 0; let count = 0;
    while ((m = re.exec(src)) !== null) { bytes += Buffer.byteLength(m[0]); count += 1; }
    if (bytes) sdkRegions.push({ name, count, bytes });
  }
  const sdkBytes = sdkRegions.reduce((s, r) => s + r.bytes, 0);

  const report = {
    schema: 'librarian.ultralight.layer.report.v1',
    plugin,
    file: rel,
    totalBytes,
    declarations: rows.length,
    outsideDeclarations: uncovered,
    outsideBreakdown: (() => {
      const headerMatch = src.match(/^(?:\s*\/\/[^\n]*\n)+/);
      const headerBytes = headerMatch ? Buffer.byteLength(headerMatch[0]) : 0;
      const bannerRe = /^[ \t]*\/\*(?![^*]*LIBRARIAN SYSTEM (?:STORAGE|COMPUTE) SDK)(?![^*]*HOST LINEAGE SDK)[^*]*\*\/[ \t]*\n/gm;
      let bannerBytes = 0; let m2;
      while ((m2 = bannerRe.exec(src)) !== null) bannerBytes += Buffer.byteLength(m2[0]);
      const lineComments = (src.match(/^[ \t]*\/\/.*$/gm) || []).reduce((a, x) => a + Buffer.byteLength(x), 0);
      const blockComments = (src.match(/\/\*[\s\S]*?\*\//g) || []).reduce((a, x) => a + Buffer.byteLength(x), 0);
      return {
        header: headerBytes,
        bannerBlockComments: bannerBytes,
        allLineComments: lineComments,
        allBlockComments: blockComments,
        embeddedSdkInsideDeclarations: sdkBytes,
        note: 'Remainder is loose top-level statements plus nested-declaration bodies already counted inside their parent declaration.'
      };
    })(),
    embeddedSdk: { total: sdkBytes, regions: sdkRegions },
    layers: Object.entries(layerTotals)
      .map(([layer, bytes]) => ({ layer, bytes, percentOfFile: Number(((bytes / totalBytes) * 100).toFixed(2)) }))
      .sort((a, b) => b.bytes - a.bytes),
    largest: rows.slice().sort((a, b) => b.bytes - a.bytes).slice(0, top)
  };

  if (asJson) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }

  const kb = b => `${(b / 1000).toFixed(1)}KB`;
  console.log(`\n=== ${plugin} — ${rel}`);
  console.log(`total ${totalBytes.toLocaleString()} B (${(totalBytes / 1000000).toFixed(2)}MB) | ${rows.length} top-level declarations`);
  console.log(`outside declarations: ${uncovered.toLocaleString()} B (${((uncovered / totalBytes) * 100).toFixed(1)}%)`);
  console.log(`\n-- embedded SDK / banner regions`);
  for (const r of sdkRegions) console.log(`   ${r.name.padEnd(22)} ${String(r.count).padStart(2)}x  ${r.bytes.toLocaleString().padStart(9)} B  (${((r.bytes / totalBytes) * 100).toFixed(1)}%)`);
  console.log(`   ${'TOTAL'.padEnd(22)}     ${sdkBytes.toLocaleString().padStart(9)} B  (${((sdkBytes / totalBytes) * 100).toFixed(1)}%)`);
  console.log(`\n-- layers (by identifier role; declarations only, SDK counted separately)`);
  for (const l of report.layers) console.log(`   ${l.layer.padEnd(16)} ${l.bytes.toLocaleString().padStart(9)} B  ${String(l.percentOfFile).padStart(5)}%`);
  console.log(`\n-- largest ${top} declarations`);
  for (const r of report.largest) console.log(`   ${r.name.padEnd(44)} ${String(r.lines).padStart(5)}L ${r.bytes.toLocaleString().padStart(9)} B  [${r.kind}] ${r.layer}${r.nested ? ` (+${r.nested} nested)` : ''}`);
  console.log();
};

try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
