'use strict';
// Shared readable-ink contract for the approved GUI identity themes.
//
// The pre-GUI per-product paper scope (":is(.libra-book-page,.libra-book-drawer)" with
// sga-* literal colours) was retired when the approved GUI landed (5e1db38). Contrast
// contracts therefore read the design's own tokens (docs/gui-redesign/assets/themes.css)
// and require the product to embed the approved stylesheet verbatim, instead of asserting
// literal colours of a removed layer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assetDirectory = path.resolve(__dirname, '../../docs/gui-redesign/assets');
const readAsset = name => fs.readFileSync(path.join(assetDirectory, name), 'utf8');
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Tokens of one product identity block, e.g. .t-libra.
const productTokens = product => {
  const block = new RegExp(`\\.t-${escape(product)}\\{([^}]*)\\}`).exec(readAsset('themes.css'));
  assert.ok(block, `approved ${product} theme block exists`);
  return new Map([...block[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
};

// Exact approved rule text, so the product can be checked for an embedded copy.
const assetRule = (name, selector) => {
  const rule = new RegExp(`${escape(selector)}\\{([^}]*)\\}`).exec(readAsset(name));
  assert.ok(rule, `approved ${name} declares ${selector}`);
  return rule[0];
};

const hasLiteralColour = text => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text);
const embedded = (productSource, text, label) => assert.ok(productSource.includes(text), `product embeds approved ${label}`);

const rgb = value => {
  const hex = String(value).trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map(char => char + char).join('') : hex;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `parseable colour: ${value}`);
  return [0, 2, 4].map(at => parseInt(full.slice(at, at + 2), 16));
};
const luminance = value => {
  const channel = part => { const c = part / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(value).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (foreground, background) => {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

// The token pair must be embedded by the product and must stay readable in the theme.
const assertTokenContrast = (productSource, tokens, foreground, background, minimum = 4.5) => {
  for (const name of [foreground, background]) {
    assert.ok(tokens.has(name), `approved theme exposes ${name}`);
    assert.match(productSource, new RegExp(`${escape(name)}:\\s*${escape(tokens.get(name))}`), `product embeds ${name}`);
  }
  const ratio = contrast(tokens.get(foreground), tokens.get(background));
  assert.ok(ratio >= minimum, `${foreground} on ${background} keeps ${minimum}:1 (measured ${ratio.toFixed(2)}:1)`);
  return ratio;
};

module.exports = { readAsset, productTokens, assetRule, hasLiteralColour, embedded, contrast, assertTokenContrast };
