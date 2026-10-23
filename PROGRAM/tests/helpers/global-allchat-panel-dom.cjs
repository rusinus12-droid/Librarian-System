'use strict';
const makeElement = (tag = 'div') => {
  const element = {
    tagName: String(tag).toUpperCase(),
    innerHTML: '', textContent: '', disabled: false, hidden: false, className: '',
    style: {}, dataset: {}, children: [], attributes: {}, value: '', checked: false, isConnected: true,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    classList: {
      _set: new Set(),
      add(...names) { names.forEach(name => this._set.add(name)); },
      remove(...names) { names.forEach(name => this._set.delete(name)); },
      toggle(name, force) { const on = force === undefined ? !this._set.has(name) : !!force; if (on) this._set.add(name); else this._set.delete(name); return on; },
      contains(name) { return this._set.has(name); }
    },
    appendChild(child) { this.children.push(child); return child; },
    remove() {}, focus() {}, select() {}, closest() { return null },
    querySelector() { return null }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}
  };
  return element;
};

const makePanelDom = () => {
  const nodesById = new Map();
  const nodesByAttr = new Map();
  const buttonAttributes = new Set();
  const radios = [];

  const container = makeElement('div');
  Object.defineProperty(container, 'innerHTML', {
    get() { return container._html || ''; },
    set(markup) {
      container._html = String(markup);
      nodesById.clear(); nodesByAttr.clear(); buttonAttributes.clear(); radios.length = 0;
      for (const match of String(markup).matchAll(/id="([^"]+)"/g)) nodesById.set(match[1], makeElement('div'));
      for (const match of String(markup).matchAll(/(data-[a-z-]+)/g)) if (!nodesByAttr.has(match[1])) nodesByAttr.set(match[1], makeElement('div'));
      for (const button of String(markup).matchAll(/<button\b[^>]*>/g)) for (const attribute of button[0].matchAll(/\b(data-[a-z-]+)/g)) buttonAttributes.add(attribute[1]);
      for (const value of ['plugin_only', 'mirror', 'server_only']) {
        if (String(markup).includes(`value="${value}"`)) radios.push(Object.assign(makeElement('input'), { value, checked: false }));
      }
    }
  });

  // A selector the markup does not provide must not masquerade as a benign null: several call sites
  // guard with `if (node)` while others dereference immediately, so a silent null would fail far from
  // the real cause. This marker throws at first use and names the selector.
  const missing = selector => new Proxy({}, {
    get(_, property) {
      if (property === Symbol.toPrimitive || property === 'toString' || property === 'valueOf') return () => `MISSING(${selector})`;
      throw new Error(`panel_selector_missing:${selector}`);
    },
    set() { throw new Error(`panel_selector_missing:${selector}`); }
  });

  const query = selector => {
    const sel = String(selector);
    const buttonAttribute = sel.match(/^button\[(data-[a-z-]+)\]$/);
    if (buttonAttribute && buttonAttributes.has(buttonAttribute[1])) return nodesByAttr.get(buttonAttribute[1]);
    for (const [attribute, element] of nodesByAttr) if (sel === `[${attribute}]`) return element;
    // `input[name="…-mode"][value="…"]` — the panel restores the checked radio on mount.
    const radioMatch = sel.match(/^input\[name="[^"]*-mode"\]\[value="([^"]+)"\]$/);
    if (radioMatch) {
      const found = radios.find(radio => radio.value === radioMatch[1]);
      return found || missing(sel);
    }
    if (sel.startsWith('input[')) {
      // A bare mode query such as `input[name$="-mode"]:checked`.
      // Imported mirror settings intentionally have no checked endpoint. This
      // recognized state selector may return null; absent control hooks still throw.
      if (/:checked/.test(sel)) return radios.find(radio => radio.checked) || null;
      return radios[0] || missing(sel);
    }
    const idMatch = sel.match(/^#(.+)$/);
    if (idMatch) {
      if (nodesById.has(idMatch[1])) return nodesById.get(idMatch[1]);
      const suffix = idMatch[1].replace(/^[^-]+-/, '');
      for (const [id, element] of nodesById) if (id.endsWith(suffix)) return element;
      return missing(sel);
    }
    return missing(sel);
  };

  const queryAll = selector => {
    const sel = String(selector);
    if (sel.includes('-mode')) return /:checked/.test(sel) ? radios.filter(radio => radio.checked) : radios;
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const attribute = sel.slice(1, -1);
      return nodesByAttr.has(attribute) ? [nodesByAttr.get(attribute)] : [];
    }
    return [];
  };

  const root = makeElement('section');
  root.querySelector = query;
  root.querySelectorAll = queryAll;

  container.querySelector = selector => {
    const sel = String(selector);
    // The panel asks the container for its own root id; every other lookup happens inside that root.
    if (!sel.startsWith('[')) return root;
    return query(sel);
  };
  container.querySelectorAll = queryAll;

  const byAttr = attribute => {
    if (!nodesByAttr.has(attribute)) nodesByAttr.set(attribute, makeElement('div'));
    return nodesByAttr.get(attribute);
  };
  return { container, root, query, queryAll, byAttr, radios };
};

module.exports={makePanelDom};
