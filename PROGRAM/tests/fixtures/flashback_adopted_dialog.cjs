'use strict';
// Canonical suite dialog identities. Supports real DOM and the small synthetic
// node hosts used by operation tests; no legacy CSS aliases are introduced.
const selectors = Object.freeze({
  box: '.overlay.is-open .dialog',
  message: '.overlay.is-open .dialog [id$="-message"]',
  title: '.overlay.is-open .dialog [id$="-title"]',
  ok: '.overlay.is-open .dialog .dialog__actions button:last-child',
  cancel: '.overlay.is-open .dialog .dialog__actions button:first-child'
});
function dialogElements(doc) {
  if (typeof doc.querySelector === 'function') return Object.fromEntries(
    Object.entries(selectors).map(([key, selector]) => [key, doc.querySelector(selector)]));
  const nodes = doc.all();
  const message = nodes.find(node => /^vrm-dialog-.*-message$/.test(node.id));
  if (!message) return { message: null, title: null, ok: null, cancel: null };
  const actions = nodes.find(node => String(node.className).split(/\s+/).includes('dialog__actions'));
  const buttons = (actions?.children || []).filter(node => String(node.tagName).toLowerCase() === 'button');
  return { message, title: nodes.find(node => node.id === message.id.replace(/-message$/, '-title')),
    ok: buttons.at(-1), cancel: buttons.length > 1 ? buttons[0] : null };
}
module.exports = { selectors, dialogElements };
