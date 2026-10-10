'use strict';
// Shared static scanner for the ultralight tooling.
//
// Both `ultralight_layer_report.cjs` and `ultralight_feasibility.cjs` need the same
// trustworthy primitives:
//
//   maskSource()      — a copy of the source where string/template/regex/comment
//                       CONTENTS are blanked (offsets preserved 1:1). Brace/paren depth
//                       counting is only reliable on this masked form: a regex literal
//                       such as /<(\w+)[^>]*>[\s\S]*?<\/\1>/gi otherwise corrupts depth
//                       accounting and can inflate a declaration's extent to megabytes.
//   lineIndex()       — byte offset -> line number.
//   findBodyEnd()     — end of a braced body from a declaration's start.
//   discoverTopDeclarations() — every outermost top-level declaration with its exact
//                       extent, including nested-declaration counts.
//
// Everything here is read-only and deterministic.
const fs = require('node:fs');

const maskSource = (src, options = {}) => {
  const onLineComment = typeof options.onLineComment === 'function' ? options.onLineComment : null;
  const out = new Array(src.length);
  let commentStart = -1;
  let i = 0;
  let state = 'code'; // code | line | block | ' | " | `
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; commentStart = i; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '"' || c === "'") { state = c; out[i] = c; i += 1; continue; }
      if (c === '`') { state = '`'; out[i] = c; i += 1; continue; }
      if (c === '/') {
        // A '/' begins a REGEX literal unless the previous significant character can end
        // an expression (identifier, digit, ')', ']', quote, backtick).
        let k = i - 1;
        while (k >= 0 && /\s/.test(src[k])) k -= 1;
        const prev = k >= 0 ? src[k] : '';
        if (!/[\w$)\]'"`]/.test(prev)) {
          let j = i + 1;
          let inClass = false;
          let closed = false;
          while (j < src.length) {
            const rj = src[j];
            if (rj === '\\') { j += 2; continue; }
            if (rj === '\n') break;
            if (rj === '[') inClass = true;
            else if (rj === ']') inClass = false;
            else if (rj === '/' && !inClass) { closed = true; break; }
            j += 1;
          }
          if (closed) {
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
      if (c === '\n') {
        if (onLineComment && commentStart >= 0) onLineComment(commentStart, i);
        commentStart = -1; state = 'code'; out[i] = '\n'; i += 1; continue;
      }
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
      // Template interpolation: keep it opaque here — nested braces inside `${}` would
      // otherwise be counted as code, but for the purposes of declaration extents it is
      // sufficient (and safer) to blank the whole literal including interpolations.
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
  if (onLineComment && commentStart >= 0) onLineComment(commentStart, src.length);
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

// Matching close for a PAREN-delimited call. `findBodyEnd` counts braces only, so using it
// on `Object.assign(…)` silently returned the wrong offset and produced unparsable output.
const findParenEnd = (masked, from) => {
  let p = from;
  let depth = 0;
  let started = false;
  while (p < masked.length) {
    const ch = masked[p];
    if (ch === '(') { depth += 1; started = true; }
    else if (ch === ')') { depth -= 1; if (started && depth === 0) return p; }
    p += 1;
  }
  return null;
};

const findBodyEnd = (masked, from) => {
  let p = from;
  let depth = 0;
  let started = false;
  while (p < masked.length) {
    const ch = masked[p];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') { depth -= 1; if (started && depth === 0) return p; }
    else if (!started && ch === ';') return p;
    p += 1;
  }
  return null;
};

const DECL_PATTERNS = [
  { kind: 'async', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*async[ \t]*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?[ \t]*=>/gm },
  { kind: 'arrow', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>/gm },
  { kind: 'func', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*function\b/gm },
  { kind: 'decl', re: /^[ \t]*(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/gm },
  { kind: 'object', re: /^[ \t]*const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*\{[ \t]*$/gm },
  { kind: 'class', re: /^[ \t]*class[ \t]+([A-Za-z_$][\w$]*)/gm }
];

// Every outermost top-level declaration, sized in bytes.
const discoverTopDeclarations = (src, masked) => {
  const { lineOf } = lineIndex(src);
  const candidates = [];
  for (const { kind, re } of DECL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const name = m[1];
      const declStart = masked.indexOf(name, m.index);
      const end = findBodyEnd(masked, declStart);
      const stop = end === null ? Math.min(masked.length, declStart + 1) : end + 1;
      candidates.push({ name, kind, start: m.index, declStart, stop });
    }
  }
  candidates.sort((a, b) => a.declStart - b.declStart || b.stop - a.stop);
  const outer = [];
  for (const c of candidates) {
    const parent = outer.find(o => c.declStart > o.declStart && c.stop <= o.stop);
    if (parent) { parent.nested = (parent.nested || 0) + 1; continue; }
    outer.push(c);
  }
  return outer.map(c => ({
    name: c.name,
    kind: c.kind,
    start: c.start,
    stop: c.stop,
    from: lineOf(c.start),
    to: lineOf(c.stop),
    lines: lineOf(c.stop) - lineOf(c.start) + 1,
    bytes: Buffer.byteLength(src.slice(c.start, c.stop)),
    nested: c.nested || 0
  }));
};

const readSource = file => {
  const src = fs.readFileSync(file, 'utf8');
  return { src, masked: maskSource(src), bytes: Buffer.byteLength(src) };
};

// Identifier occurrences in the MASKED source (strings are blanked, so a name that only
// appears inside a string literal — i.e. dynamic dispatch — will NOT be counted; callers
// must treat "zero references" as a review candidate, never as proof of dead code).
const countIdentifier = (masked, name, { excludeStart = -1, excludeStop = -1 } = {}) => {
  const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g');
  let count = 0;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (m.index >= excludeStart && m.index < excludeStop) continue;
    count += 1;
  }
  return count;
};

module.exports = {
  maskSource,
  lineIndex,
  findBodyEnd,
  findParenEnd,
  discoverTopDeclarations,
  readSource,
  countIdentifier
};
