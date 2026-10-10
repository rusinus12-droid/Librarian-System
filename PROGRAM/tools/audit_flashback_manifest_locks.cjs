'use strict';
// Re-derive the exact line numbers of every saveScopeManifest / saveScopeRecords
// call site that lies OUTSIDE a withScopeWriteLock block body. Line numbers drift
// whenever the plugin is edited, so this is the authoritative way to regenerate
// the list a handoff document cites.
const fs = require('node:fs'), path = require('node:path');
const src = fs.readFileSync(path.resolve(__dirname, "..", "plugins", "Flashback_Memory.js"), 'utf8');
const lines = src.split('\n');
const strip = s => s.replace(/\/\/.*$/, '')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');

const stack = [], ranges = [];
for (let i = 0; i < lines.length; i++) {
  for (const ch of strip(lines[i])) {
    if (ch === '{') stack.push(i + 1);
    else if (ch === '}') { const o = stack.pop(); if (o !== undefined) ranges.push({ start: o, end: i + 1 }); }
  }
}
const lockHeads = [];
lines.forEach((line, i) => { if (/(?<![A-Za-z0-9_])withScopeWriteLock\(/.test(line)) lockHeads.push(i + 1); });
const lockBodies = lockHeads.map(hl => {
  const c = ranges.filter(r => r.start === hl);
  const w = c.length ? c.reduce((a, b) => ((b.end - b.start) > (a.end - a.start) ? b : a)) : { start: hl, end: hl };
  const m = /withScopeWriteLock\(([^,]+),/.exec(lines[hl - 1].trim());
  return { hl, start: w.start, end: w.end, key: m ? m[1].trim() : '?' };
});
const encl = t => lockBodies.filter(b => b.start <= t && t <= b.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;

// Enclosing 2-space-indented function for a line.
const funcAt = lineNo => {
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = /^\s{2}const ([A-Za-z0-9_]+) = (?:async )?\(/.exec(lines[i]);
    if (m) return m[1];
  }
  return '?';
};

const REPORT = [];
for (const [name, re] of [['saveScopeManifest', /(?<![A-Za-z0-9_.])saveScopeManifest\(/], ['saveScopeRecords', /(?<![A-Za-z0-9_.])saveScopeRecords\(\s*(?!Core)/]]) {
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!re.test(line)) return;
    if (new RegExp(`const ${name}`).test(line)) return;
    const lock = encl(n);
    REPORT.push({ kind: name, line: n, locked: !!lock, lockLine: lock ? lock.hl : null, fn: funcAt(n) });
  });
}

const unprotected = REPORT.filter(r => !r.locked);
console.log(`total call sites: ${REPORT.length}  (saveScopeManifest ${REPORT.filter(r => r.kind === 'saveScopeManifest').length}, saveScopeRecords ${REPORT.filter(r => r.kind === 'saveScopeRecords').length})`);
console.log(`UNPROTECTED: ${unprotected.length}\n`);
console.log('kind              line    enclosing function');
for (const r of unprotected) {
  console.log(`${r.kind.padEnd(17)} ${String(r.line).padStart(6)}  ${r.fn}`);
}
console.log('\n--- by function ---');
const byFn = {};
for (const r of unprotected) { byFn[r.fn] = byFn[r.fn] || []; byFn[r.fn].push(r.line); }
for (const [fn, ls] of Object.entries(byFn)) console.log(`  ${fn}: ${ls.join(', ')}`);
