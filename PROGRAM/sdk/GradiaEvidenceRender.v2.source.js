'use strict';
// Shared deterministic complete-item renderer and the existing LIBRA MMR policy.
// Integrity/currentness is the caller's responsibility; this module mints no authority.
function createGradiaEvidenceRender({ protocol }) {
  if (!protocol || typeof protocol.checkedAdd !== 'function') throw new TypeError('GRADIA_V2_RENDER_DEPENDENCY');
  const fail = reason => { throw new TypeError('GRADIA_V2_RENDER_' + reason); };
  const add = protocol.checkedAdd, mul = protocol.checkedMultiply;
  const integer = (n, positive = false) => { if (!Number.isSafeInteger(n) || Object.is(n, -0) || n < (positive ? 1 : 0)) fail('INTEGER'); return n; };
  const profiles = new Set(['libra.canonical.memory-text.v1', 'libra.micro.claims-text.v1', 'libra.micro.source-span.v1']);
  // Measure escaped JSON text without allocating the escaped copy. Escape HTML
  // delimiters as well: source content can never close the evidence wrapper.
  function stringMeasure(text, cap = 33554432) {
    if (typeof text !== 'string' || text.length > cap) fail('TEXT');
    let raw = 0, bytes = 2, units = 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i); let b, u = 1;
      if (c >= 0xd800 && c <= 0xdbff) {
        const low = text.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) fail('UNSUPPORTED_TEXT'); b = 4; u = 2;
      } else if (c >= 0xdc00 && c <= 0xdfff) fail('UNSUPPORTED_TEXT');
      else b = c < 128 ? 1 : c < 2048 ? 2 : 3;
      raw = add(raw, b); if (raw > cap) fail('TEXT_BYTES');
      if (c === 60 || c === 62 || c === 38 || c === 0x2028 || c === 0x2029) { bytes = add(bytes, 6); units = add(units, 6); }
      else if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) { bytes = add(bytes, 2); units = add(units, 2); }
      else if (c < 32) { bytes = add(bytes, 6); units = add(units, 6); }
      else { bytes = add(bytes, b); units = add(units, u); }
    }
    return Object.freeze({ rawUtf8Bytes: raw, utf8Bytes: bytes, utf16Bytes: mul(units, 2) });
  }
  const escaped = text => JSON.stringify(text).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const id = value => { if (!value || typeof value !== 'string') fail('ID'); stringMeasure(value, 256); return value; };
  function validateItems(items) {
    if (!Array.isArray(items) || items.length > 8192) fail('ITEMS');
    const map = new Map();
    for (const item of items) {
      if (!item || map.has(id(item.itemId)) || !profiles.has(item.profile)) fail('ITEM');
      id(item.sourceHandle); if (item.groupId !== null && item.groupId !== undefined) id(item.groupId);
      if (!/^[a-f0-9]{64}$/.test(item.contentHash)) fail('HASH');
      integer(item.contentBytes, true);
      const measure = stringMeasure(item.content);
      if (measure.rawUtf8Bytes !== item.contentBytes) fail('CONTENT_BYTES');
      map.set(item.itemId, item);
    }
    return map;
  }
  function prepare({ corpusId, items, selectedItemIds, byteLimit }) {
    id(corpusId); integer(byteLimit, true); if (byteLimit > 4194304) fail('RENDERED_BYTES');
    const map = validateItems(items);
    if (!Array.isArray(selectedItemIds) || selectedItemIds.length > items.length) fail('SELECTION');
    const seen = new Set(), selected = [];
    for (const key of selectedItemIds) { if (seen.has(key) || !map.has(key)) fail('SELECTION'); seen.add(key); selected.push(map.get(key)); }
    // A named semantic group is a complete unit, never an arbitrary text slice.
    const groups = new Set(selected.filter(item => item.groupId).map(item => item.groupId));
    for (const item of items) if (groups.has(item.groupId) && !seen.has(item.itemId)) fail('INCOMPLETE_GROUP');
    const prefix = '<lib_evidence_v2 corpus=' + escaped(corpusId) + '>\n';
    const suffix = '</lib_evidence_v2>';
    let utf8Bytes = stringMeasure(prefix).rawUtf8Bytes + suffix.length, utf16Bytes = (prefix.length + suffix.length) * 2;
    for (const item of selected) {
      // Field order is part of gradia.evidence-render.v2.
      const header = '{"itemId":' + escaped(item.itemId) + ',"profile":' + escaped(item.profile) + ',"sourceHandle":' + escaped(item.sourceHandle) + ',"content":';
      const content = stringMeasure(item.content);
      utf8Bytes = add(utf8Bytes, add(stringMeasure(header).rawUtf8Bytes, add(content.utf8Bytes, 2)));
      utf16Bytes = add(utf16Bytes, add(header.length * 2, add(content.utf16Bytes, 4)));
      if (utf8Bytes > byteLimit) fail('RENDERED_BYTES');
    }
    if (utf8Bytes > byteLimit) fail('RENDERED_BYTES');
    return { selected, prefix, suffix, utf8Bytes, utf16Bytes };
  }
  function measure(input) { const p = prepare(input); return Object.freeze({ utf8Bytes: p.utf8Bytes, utf16Bytes: p.utf16Bytes, items: p.selected.length }); }
  function render(input) {
    const p = prepare(input), parts = [p.prefix];
    for (const item of p.selected) parts.push('{"itemId":' + escaped(item.itemId) + ',"profile":' + escaped(item.profile) + ',"sourceHandle":' + escaped(item.sourceHandle) + ',"content":' + escaped(item.content) + '}\n');
    parts.push(p.suffix);
    const text = parts.join('');
    if (text.length * 2 !== p.utf16Bytes || stringMeasure(text, 4194304).rawUtf8Bytes !== p.utf8Bytes) fail('MEASURE_MISMATCH');
    return Object.freeze({ text, utf8Bytes: p.utf8Bytes, utf16Bytes: p.utf16Bytes, items: p.selected.length });
  }
  function rank({ items, ranking, similarities, policy, countLimit }) {
    integer(countLimit); if (countLimit > 8192 || !Array.isArray(ranking) || ranking.length !== items.length) fail('RANKING');
    if (!policy || policy.schema !== 'libra.recall-mmr.v2' || ![40, 80, 160, 320].includes(policy.candidateLimit)
      || typeof policy.mmrEnabled !== 'boolean' || !Number.isFinite(policy.mmrLambda) || policy.mmrLambda < 0 || policy.mmrLambda > 1) fail('POLICY');
    const seen = new Set(), indices = new Map(items.map((item, i) => [id(item.itemId), i]));
    if (indices.size !== items.length || !Array.isArray(similarities) || similarities.length !== items.length) fail('SIMILARITIES');
    for (const row of similarities) if (!Array.isArray(row) || row.length !== items.length || row.some(n => !Number.isFinite(n) || n < 0 || n > 1)) fail('SIMILARITIES');
    for (const row of ranking) {
      if (!indices.has(row.itemId) || seen.has(row.itemId) || typeof row.forced !== 'boolean'
        || ['relevance', 'exactScore', 'sparseEvidence'].some(key => !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 1)) fail('RANKING');
      seen.add(row.itemId);
    }
    const pool = ranking.slice(0, policy.candidateLimit), selected = [], omissions = [];
    if (!policy.mmrEnabled) selected.push(...pool.splice(0, countLimit));
    else while (pool.length && selected.length < countLimit) {
      let bestIndex = 0, bestScore = -Infinity;
      for (let index = 0; index < pool.length; index++) {
        const candidate = pool[index]; let redundancy = 0;
        for (const previous of selected) redundancy = Math.max(redundancy, similarities[indices.get(candidate.itemId)][indices.get(previous.itemId)]);
        const penalty = redundancy >= .985 && !candidate.forced && candidate.exactScore < .30 && candidate.sparseEvidence < .30 ? .65 : 0;
        const score = policy.mmrLambda * candidate.relevance - (1 - policy.mmrLambda) * redundancy - penalty;
        if (score > bestScore) { bestScore = score; bestIndex = index; }
      }
      if (selected.length && bestScore < .02 && !pool[bestIndex].forced) break;
      selected.push(pool.splice(bestIndex, 1)[0]);
    }
    for (const row of pool) omissions.push(Object.freeze({ itemId: row.itemId, reason: selected.length >= countLimit ? 'selection_count_limit' : 'mmr_score_floor' }));
    for (const row of ranking.slice(policy.candidateLimit)) omissions.push(Object.freeze({ itemId: row.itemId, reason: 'mmr_candidate_limit' }));
    return Object.freeze({ selectedItemIds: Object.freeze(selected.map(row => row.itemId)), omissions: Object.freeze(omissions) });
  }
  return Object.freeze({ contract: 'gradia.evidence-render.v2', stringMeasure, validateItems, measure, render, rank });
}
