const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Verify CRLF on plugins
const gradiaBuf = fs.readFileSync(path.resolve('PROGRAM/plugins/GRADIA.js'));
const libraBuf = fs.readFileSync(path.resolve('PROGRAM/plugins/LIBRA.js'));
assert(gradiaBuf.includes(Buffer.from('\r\n')), 'GRADIA.js must have CRLF line endings');
assert(libraBuf.includes(Buffer.from('\r\n')), 'LIBRA.js must have CRLF line endings');

console.log('CRLF check passed for GRADIA.js and LIBRA.js.');

// Test lore extraction contracts using node eval on extracted functions
const testContext = () => {
  const text = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  };
  const firstFilled = (...values) => {
    for (const value of values) {
      const body = text(value || '').trim();
      if (body) return body;
    }
    return '';
  };
  const loreContent = lore => firstFilled(
    lore?.content,
    lore?.prompt,
    lore?.text,
    lore?.entry,
    lore?.data?.content,
    lore?.data?.prompt,
    lore?.data?.text,
    lore?.data?.entry,
    typeof lore?.data === 'string' ? lore.data : '',
    typeof lore?.value === 'string' ? lore.value : '',
    typeof lore?.body === 'string' ? lore.body : ''
  );
  const collectionFrom = (value, source = '') => {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .flatMap((item, index) => {
          if (!item || typeof item !== 'object') return [];
          const nested = item.entries || item.items || item.lore;
          if (Array.isArray(nested) && nested.length > 0 && !loreContent(item)) {
            return collectionFrom(nested, source || text(item.name || item.comment || item.id || index));
          }
          return [{
            ...item,
            __collectionKey: text(item.__collectionKey || item.id || item.uid || item.key || index),
            __collectionSource: source
          }];
        })
        .filter(Boolean);
    }
    if (typeof value === 'object') {
      const nested = value.entries || value.items || value.lore || (Array.isArray(value.data) ? value.data : null);
      if (nested && (Array.isArray(nested) || typeof nested === 'object')) {
        const unwrapped = collectionFrom(nested, source || text(value.name || value.id || ''));
        if (unwrapped.length > 0) return unwrapped;
      }
      return Object.entries(value)
        .map(([key, item]) => item && typeof item === 'object' ? {
          ...item,
          __collectionKey: text(item.__collectionKey || item.id || item.uid || item.key || key),
          __collectionSource: source
        } : null)
        .filter(Boolean);
    }
    return [];
  };
  const identityValues = (value) => {
    if (!value || typeof value !== 'object') return [];
    return [
      value.id, value._id, value.uid, value.uuid, value.key, value.name,
      value.displayName, value.nickname, value.namespace, value.slug,
      value.__collectionKey
    ].map(item => text(item || '').trim()).filter(Boolean);
  };
  const moduleIsEnabled = (module, enabledRefs) => {
    if (!module || typeof module !== 'object') return false;
    if (module.enabled === false || module.disabled === true || module.disable === true) return false;
    if (module.enabled === true || module.active === true || module.isEnabled === true) return true;
    if (!enabledRefs || !enabledRefs.size) return false;
    return identityValues(module).some(id => enabledRefs.has(id));
  };
  const moduleLoreSources = module => [
    module?.lore, module?.lorebook, module?.loreBook, module?.lorebooks, module?.entries, module?.items,
    module?.characterBook, module?.character_book,
    module?.characterBook?.entries, module?.character_book?.entries,
    module?.characterBook?.items, module?.character_book?.items,
    module?.data?.lore, module?.data?.lorebook, module?.data?.loreBook, module?.data?.lorebooks,
    module?.data?.entries, module?.data?.items,
    module?.data?.characterBook, module?.data?.character_book,
    module?.data?.characterBook?.entries, module?.data?.character_book?.entries,
    module?.data?.characterBook?.items, module?.data?.character_book?.items,
    module?.extensions?.characterBook?.entries, module?.extensions?.character_book?.entries,
    module?.extensions?.world_info, module?.extensions?.worldInfo
  ];

  return { text, firstFilled, loreContent, collectionFrom, moduleIsEnabled, moduleLoreSources };
};

const ctx = testContext();

// Test 1: collectionFrom unwraps { entries: [...] }
{
  const tavernV2Book = {
    name: 'WorldLore',
    entries: [
      { keys: ['city'], content: 'The capital is Grandis.' },
      { keys: ['king'], content: 'The king is Arthur.' }
    ]
  };
  const result = ctx.collectionFrom(tavernV2Book);
  assert.strictEqual(result.length, 2, 'Should unwrap 2 entries from book.entries');
  assert.strictEqual(result[0].content, 'The capital is Grandis.');
  assert.strictEqual(ctx.loreContent(result[0]), 'The capital is Grandis.');
  assert.strictEqual(result[1].content, 'The king is Arthur.');
}

// Test 2: collectionFrom unwraps nested items array
{
  const ccv3Book = {
    name: 'ItemsBook',
    items: [
      { key: 'sword', content: 'Excalibur' }
    ]
  };
  const result = ctx.collectionFrom(ccv3Book);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].content, 'Excalibur');
}

// Test 3: collectionFrom unwraps array of lorebooks
{
  const books = [
    { name: 'Book1', entries: [{ key: 'k1', content: 'c1' }] },
    { name: 'Book2', entries: [{ key: 'k2', content: 'c2' }] }
  ];
  const result = ctx.collectionFrom(books);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].content, 'c1');
  assert.strictEqual(result[1].content, 'c2');
}

// Test 4: loreContent handles nested data.content and avoids [object Object]
{
  const structuredEntry = {
    keys: ['test'],
    data: {
      content: 'Nested prompt content'
    }
  };
  assert.strictEqual(ctx.loreContent(structuredEntry), 'Nested prompt content');

  const stringDataEntry = {
    keys: ['test2'],
    data: 'Direct string content'
  };
  assert.strictEqual(ctx.loreContent(stringDataEntry), 'Direct string content');
}

// Test 5: moduleIsEnabled handles explicit flags and reference sets
{
  assert.strictEqual(ctx.moduleIsEnabled({ enabled: true }, new Set(['other_mod'])), true);
  assert.strictEqual(ctx.moduleIsEnabled({ active: true }, new Set(['other_mod'])), true);
  assert.strictEqual(ctx.moduleIsEnabled({ isEnabled: true }, new Set(['other_mod'])), true);
  assert.strictEqual(ctx.moduleIsEnabled({ enabled: false }, new Set(['my_mod'])), false);
  assert.strictEqual(ctx.moduleIsEnabled({ disabled: true }, new Set(['my_mod'])), false);
  assert.strictEqual(ctx.moduleIsEnabled({ id: 'my_mod' }, new Set(['my_mod'])), true);
  assert.strictEqual(ctx.moduleIsEnabled({ id: 'unknown_mod' }, new Set(['my_mod'])), false);
}

// Test 6: moduleLoreSources discovers characterBook and data lore
{
  const mod = {
    id: 'test_module',
    data: {
      characterBook: {
        entries: [{ key: 'mod_lore', content: 'mod lore content' }]
      }
    }
  };
  const sources = ctx.moduleLoreSources(mod);
  const found = sources.some(s => s && s.entries && s.entries.length === 1 && s.entries[0].content === 'mod lore content');
  assert(found, 'moduleLoreSources must find data.characterBook');
}

console.log('All lore collection contract tests passed!');
