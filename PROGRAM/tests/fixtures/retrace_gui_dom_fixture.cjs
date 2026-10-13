'use strict';

// Minimal DOM host for the real RE:TRACE render/bind/callback path. This fixture
// implements elements and events; it never substitutes a plugin UI function.
const assert = require('node:assert/strict');
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => this.classList.toggle(name, true),
      remove: name => this.classList.toggle(name, false),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const add = force === undefined ? !names.has(name) : force;
        if (add) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
        return add;
      }
    };
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get isConnected() { return this === this.ownerDocument.documentElement || Boolean(this.parentNode?.isConnected); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'checked') this.checked = true;
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name.startsWith('data-')) delete this.dataset[dataKey(name)]; }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    const stack = [this];
    const html = String(value).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
      const tag = token.match(/^<([a-z][\w-]*)/i)?.[1];
      if (!tag) continue;
      const node = this.ownerDocument.createElement(tag);
      const attrs = token.slice(tag.length + 1, -1).replace(/\/$/, '');
      for (const match of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
        node.setAttribute(match[1], match[2] ?? match[3] ?? match[4] ?? '');
      }
      stack.at(-1).appendChild(node);
      if (!voidTags.has(tag.toLowerCase()) && !token.endsWith('/>')) stack.push(node);
    }
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    for (const match of selector.matchAll(/:not\(([^)]+)\)/g)) if (this.matches(match[1])) return false;
    selector = selector.replace(/:not\([^)]+\)/g, '');
    const parts = selector.trim().split(/\s+/);
    if (parts.length > 1) {
      if (!this.matches(parts.pop())) return false;
      let ancestor = this.parentNode;
      while (ancestor && !ancestor.matches(parts.join(' '))) ancestor = ancestor.parentNode;
      return Boolean(ancestor);
    }
    const tag = selector.match(/^[\w-]+/)?.[0];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (const match of selector.matchAll(/#([\w-]+)|\.([\w-]+)|\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
      if (match[1] && this.id !== match[1]) return false;
      if (match[2] && !this.classList.contains(match[2])) return false;
      if (match[3] && (this.getAttribute(match[3]) === null || (match[4] !== undefined && this.getAttribute(match[3]) !== match[4]))) return false;
    }
    return !selector.includes(':checked') || this.checked;
  }
  querySelectorAll(selector) {
    const results = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) results.push(child); visit(child); } };
    visit(this);
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  addEventListener(type, handler) {
    const rows = this.listeners.get(type) || [];
    rows.push(handler);
    this.listeners.set(type, rows);
  }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(row => row !== handler)); }
  async emit(type, values = {}) {
    assert.equal(this.disabled, false, `${this.id || this.tagName}: action is enabled`);
    const event = { type, target: this, preventDefault() {}, ...values };
    const actions = [...(this.listeners.get(type) || [])];
    if (typeof this['on' + type] === 'function') actions.push(this['on' + type]);
    assert.ok(actions.length > 0, `${this.id || this.tagName}: production event handler is bound`);
    return await Promise.all(actions.map(action => action(event)));
  }
  focus() { this.ownerDocument.activeElement = this; }
}

const createDocument = () => {
  const document = { createElement: tag => new Element(tag, document), activeElement: null };
  document.documentElement = new Element('html', document);
  document.body = document.documentElement.appendChild(new Element('body', document));
  document.querySelector = selector => document.documentElement.querySelector(selector);
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.addEventListener = (...args) => document.documentElement.addEventListener(...args);
  document.removeEventListener = (...args) => document.documentElement.removeEventListener(...args);
  return document;
};

module.exports = { createDocument };
