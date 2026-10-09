'use strict';
// Does the delimiter/noise repair accept only what it should?
//
// MEASURED (2026-09-20, real Gemma-4): a length-correction answer ended `"...draft..."}.'` — the JSON
// object was COMPLETE, a single period followed it, and the strict parse rejected the whole answer
// ("Extra data: line 1 column 1840"). The 1,749-character draft inside was fine.
//
// The repair must fix that WITHOUT accepting a genuinely broken answer. The cases below pin both sides:
// a closed object followed by punctuation-only noise is accepted; a closed object followed by more JSON,
// prose or a second value is not.
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const src = fs.readFileSync(PLUGIN, 'utf8');

// Extract the helper from the shipped file by locating its end with a brace-aware scan that ignores
// braces inside strings and regular expressions (a plain brace count cuts the function at the `/}/`
// inside its own regex, which is exactly the trap this codebase already hit once).
// The helper's own source lines, taken verbatim. Extracting by brace balance is unsafe here: the
// function contains regex literals with braces (`/[}\]"]$/`), and a brace count cuts it short — the
// exact trap this codebase hit once before. The known end marker is the next top-level const.
const grabArrow = name => {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`helper not found: ${name}`);
  const end = src.indexOf('\n    const parseStrictSgaArtifactJson', start);
  if (end < 0) throw new Error(`helper end not found: ${name}`);
  return src.slice(start, end).trim();
};

const mod = { exports: {} };
new Function('module', 'exports', `
const string = value => (value === null || value === undefined ? '' : String(value));
${grabArrow('closeOpenJsonDelimiters')}
module.exports = { closeOpenJsonDelimiters };
`)(mod, mod.exports);
const { closeOpenJsonDelimiters } = mod.exports;

const cases = [];
const probe = (name, input, expectRepairable) => {
  const out = closeOpenJsonDelimiters(input);
  let parses = false;
  if (out) { try { JSON.parse(out); parses = true; } catch (_) { parses = false; } }
  cases.push({ name, inputChars: input.length, repairedChars: out ? out.length : 0, parses,
               accepted: Boolean(out) && parses, expected: expectRepairable });
};

// ── MUST be repaired (a real answer was thrown away over these) ───────────────────────────────
probe('accept_trailing_period', '{"schema":"libra.sga_length_correction.v2","ok":true,"draft":"가나다"}.' , true);
probe('accept_trailing_punct_run', '{"schema":"x","ok":true,"draft":"가"}!!', true);
probe('accept_missing_brace', '{"schema":"x","ok":true,"draft":"가"', true);
probe('accept_missing_two_braces', '{"schema":"x","packet":{"draft":"가"', true);

// ── MUST NOT be accepted (the repair would invent or misread content) ─────────────────────────
probe('refuse_second_value', '{"schema":"x","ok":true}{"schema":"y"}', false);
probe('refuse_trailing_prose', '{"schema":"x","ok":true} and then more text', false);
probe('refuse_mid_string', '{"schema":"x","draft":"잘린 문장', false);
probe('refuse_mid_escape', '{"schema":"x","draft":"가\\', false);
probe('refuse_dangling_token', '{"schema":"x","ok":tru', false);
probe('refuse_trailing_comma', '{"schema":"x","ok":true},', false);

const wrong = cases.filter(row => row.accepted !== row.expected);
process.stdout.write(JSON.stringify({
  cases,
  summary: {
    repaired: cases.filter(r => r.name.startsWith('accept_') && r.accepted).length,
    mustAccept: cases.filter(r => r.name.startsWith('accept_')).length,
    wronglyAccepted: wrong.filter(r => r.expected === false).map(r => r.name),
    wronglyRefused: wrong.filter(r => r.expected === true).map(r => r.name),
    verdict: wrong.length ? 'repair_needs_work' : 'repair_is_sound'
  }
}, null, 1) + '\n');
process.exit(wrong.length ? 1 : 0);
