/* LIBRARIAN HOST LINEAGE SDK v1.0.0
 * Read-only RisuAI 2026.8.250 native-branch evidence, not a memory store.
 * Authority remains with each owner's source digest, worldline and commit gate.
 */
function createMemorySuiteHostLineage() {
  'use strict';
  const schema = 'librarian.host_lineage.v1';
  const str = value => value == null ? '' : String(value);
  const object = value => value && typeof value === 'object' ? value : {};
  const unwrap = value => object(value?.msg || value);
  const messages = chat => Array.isArray(chat?.message) ? chat.message : Array.isArray(chat?.messages) ? chat.messages : [];
  const chatId = chat => str(chat?.id || chat?.chatId || '');
  const characterId = character => str(character?.chaId || character?.id || character?.characterId || '');
  const role = value => {
    const item = unwrap(value), r = str(item.role || item.type || '').toLowerCase();
    return ['user', 'human', 'player'].includes(r) ? 'user'
      : ['char', 'assistant', 'character', 'bot', 'ai', 'model'].includes(r) ? 'assistant' : r;
  };
  const body = value => {
    const item = unwrap(value), data = item.data ?? item.content ?? item.text ?? '';
    return typeof data === 'string' ? data : JSON.stringify(data);
  };
  // These are source facts, not UI position, a title heuristic, or a single ID.
  const descriptor = value => {
    const item = unwrap(value);
    return [role(item), str(item.chatId || item.id || ''), body(item), item.disabled === true,
      item.isComment === true, str(item.saying || '')];
  };
  const same = (a, b) => {
    const x = descriptor(a), y = descriptor(b);
    return x.every((v, i) => v === y[i]);
  };
  const countPairs = list => {
    let pending = false, complete = false, total = 0;
    for (const raw of list) {
      const item = unwrap(raw);
      if (item.disabled === true || item.isComment === true || !body(item).trim()) continue;
      const r = role(item);
      if (r === 'user') { if (complete) total += 1; pending = true; complete = false; }
      else if (r === 'assistant' && pending) complete = true;
    }
    return total + (complete ? 1 : 0);
  };
  const fingerprint = list => {
    // Diagnostic fingerprint only: eligibility is decided by exact comparisons.
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (const item of list) {
      const text = JSON.stringify(descriptor(item)) + '\u0000';
      for (let i = 0; i < text.length; i += 1) {
        a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
        b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b) >>> 0;
      }
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  };
  const prefixRevision = (chat, completedPairs) => {
    const rows = messages(chat), wanted = Math.max(0, Number(completedPairs) || 0);
    if (!wanted) return fingerprint([]);
    let pending = false, complete = false, count = 0, end = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const item = unwrap(rows[i]);
      if (item.disabled === true || item.isComment === true || !body(item).trim()) continue;
      const r = role(item);
      if (r === 'user') {
        if (complete) { count += 1; if (count >= wanted) break; }
        pending = true; complete = false;
      } else if (r === 'assistant' && pending) { complete = true; end = i + 1; }
    }
    return fingerprint(rows.slice(0, end));
  };
  const marker = chat => {
    const rows = messages(chat);
    let found = null;
    for (let i = 0; i < rows.length; i += 1) {
      const item = unwrap(rows[i]), text = body(item);
      // A quoted marker in ordinary RP dialogue must never establish lineage.
      if (item.isComment !== true || item.disabled !== true || role(item) !== 'assistant'
        || !text.startsWith('{{specialcomment::branchedfrom::')) continue;
      found = { present: true, valid: false, markerIndex: i, parentChatId: '', parentName: '', forkMessageId: '' };
      if (!text.endsWith('::}}')) continue;
      const fields = text.slice('{{specialcomment::branchedfrom::'.length, -'::}}'.length).split('::');
      if (fields.length < 3) continue;
      const parentChatId = fields.shift(), forkMessageId = fields.pop();
      // Names may themselves contain "::". The parent and final fork ID are fixed fields.
      const parentName = fields.join('::');
      found = { ...found, parentChatId, parentName, forkMessageId,
        valid: !!parentChatId && !!forkMessageId && !['undefined', 'null'].includes(forkMessageId) };
    }
    return found || { present: false, valid: false, markerIndex: -1, parentChatId: '', parentName: '', forkMessageId: '' };
  };
  const prefix = (parent, child, limit = messages(child).length) => {
    const left = messages(parent), right = messages(child);
    const end = Math.min(left.length, right.length, Math.max(0, limit));
    let common = 0;
    while (common < end && same(left[common], right[common])) common += 1;
    const rows = right.slice(0, common);
    return { commonPrefixMessages: common, commonPrefixPairs: countPairs(rows), prefixDigest: fingerprint(rows) };
  };
  const inspect = (characterValue, chatValue) => {
    const character = object(characterValue), chat = object(chatValue), id = chatId(chat), mark = marker(chat);
    const base = { schema, hostVersion: '2026.8.250', characterId: characterId(character), hostChatId: id,
      kind: mark.present ? 'native_branch' : 'independent_chat', status: 'independent', reason: 'no_native_branch_marker',
      parentChatId: mark.parentChatId, parentName: mark.parentName, forkMessageId: mark.forkMessageId,
      markerIndex: mark.markerIndex, forkMessageIndex: mark.markerIndex - 1, commonPrefixMessages: 0,
      commonPrefixPairs: 0, canonicalPrefixEnd: 0, partialCanonicalPairs: 0, prefixDigest: '',
      path: id ? [id] : [], pathVerified: !mark.present, inheritanceEligible: false };
    if (!id || !base.characterId) return { ...base, status: 'unverified', reason: 'host_identity_missing', pathVerified: false };
    if (!mark.present) return base;
    if (!mark.valid || mark.parentChatId === id) return { ...base, status: 'unverified', reason: 'invalid_branch_marker', pathVerified: false };
    const chats = Array.isArray(character.chats) ? character.chats : [];
    const parents = chats.filter(item => chatId(item) === mark.parentChatId);
    if (parents.length !== 1) return { ...base, status: 'unverified', reason: parents.length ? 'duplicate_parent_identity' : 'parent_unavailable', pathVerified: false };
    if (chats.filter(item => chatId(item) === id).length > 1) return { ...base, status: 'unverified', reason: 'duplicate_target_identity', pathVerified: false };
    const parent = parents[0], childRows = messages(chat), parentRows = messages(parent);
    const common = prefix(parent, chat, mark.markerIndex);
    const result = { ...base, ...common, canonicalPrefixEnd: Math.floor(common.commonPrefixPairs / 5) * 5,
      partialCanonicalPairs: common.commonPrefixPairs % 5, status: 'unverified', pathVerified: false, path: [mark.parentChatId, id] };
    const forkIndexes = parentRows.map((item, i) => str(unwrap(item).chatId) === mark.forkMessageId ? i : -1).filter(i => i >= 0);
    const childForkIndexes = childRows.slice(0, mark.markerIndex).map((item, i) => str(unwrap(item).chatId) === mark.forkMessageId ? i : -1).filter(i => i >= 0);
    if (forkIndexes.length !== 1 || childForkIndexes.length !== 1) return { ...result, reason: 'fork_identity_not_unique' };
    if (forkIndexes[0] !== mark.markerIndex - 1 || childForkIndexes[0] !== mark.markerIndex - 1) return { ...result, reason: 'fork_position_mismatch' };
    if (common.commonPrefixMessages !== mark.markerIndex) return { ...result, status: 'diverged', reason: 'branch_prefix_changed' };
    if (Number(parent.fmIndex ?? -1) !== Number(chat.fmIndex ?? -1)) return { ...result, status: 'diverged', reason: 'greeting_selection_changed' };
    const seen = new Set([id, mark.parentChatId]);
    let ancestor = parent, pathVerified = true, pathReason = '';
    for (let depth = 0; depth < 64; depth += 1) {
      const edge = marker(ancestor);
      if (!edge.present) break;
      if (!edge.valid) { pathVerified = false; pathReason = 'ancestor_marker_unverified'; break; }
      if (seen.has(edge.parentChatId)) return { ...result, reason: 'lineage_cycle', pathVerified: false };
      const matches = chats.filter(item => chatId(item) === edge.parentChatId);
      result.path.unshift(edge.parentChatId); seen.add(edge.parentChatId);
      if (matches.length !== 1) { pathVerified = false; pathReason = 'ancestor_unavailable'; break; }
      const grandparent = matches[0], evidence = prefix(grandparent, ancestor, edge.markerIndex);
      const parentForks = messages(grandparent).map((item, i) => str(unwrap(item).chatId) === edge.forkMessageId ? i : -1).filter(i => i >= 0);
      if (evidence.commonPrefixMessages !== edge.markerIndex || parentForks.length !== 1 || parentForks[0] !== edge.markerIndex - 1
        || str(unwrap(messages(ancestor)[edge.markerIndex - 1]).chatId) !== edge.forkMessageId) {
        pathVerified = false; pathReason = 'ancestor_prefix_unverified'; break;
      }
      ancestor = grandparent;
      if (depth === 63) { pathVerified = false; pathReason = 'lineage_depth_limit'; }
    }
    return { ...result, status: 'verified', reason: 'exact_host_branch_prefix', inheritanceEligible: true, pathVerified, pathReason };
  };
  const normalize = value => {
    const v = object(value);
    if (v.schema !== schema) return null;
    // Metadata from storage/server is descriptive, never accepted as fresh proof.
    const n = key => Math.max(0, Math.min(10000000, Number(v[key]) || 0));
    const s = key => str(v[key]).slice(0, 512);
    return { schema, hostVersion: s('hostVersion'), characterId: s('characterId'), hostChatId: s('hostChatId'),
      kind: v.kind === 'native_branch' ? 'native_branch' : 'independent_chat',
      status: ['verified','unverified','diverged','independent'].includes(v.status) ? v.status : 'unverified',
      reason: s('reason'), parentChatId: s('parentChatId'), parentName: s('parentName'), forkMessageId: s('forkMessageId'),
      markerIndex: Math.max(-1, Number(v.markerIndex) || 0), forkMessageIndex: Math.max(-1, Number(v.forkMessageIndex) || 0),
      commonPrefixMessages: n('commonPrefixMessages'), commonPrefixPairs: n('commonPrefixPairs'), canonicalPrefixEnd: n('canonicalPrefixEnd'),
      partialCanonicalPairs: n('partialCanonicalPairs'), prefixDigest: s('prefixDigest'),
      path: (Array.isArray(v.path) ? v.path : []).slice(0, 66).map(x => str(x).slice(0, 512)),
      pathVerified: v.pathVerified === true, pathReason: s('pathReason'), inheritanceEligible: v.inheritanceEligible === true };
  };
  const escape = value => str(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const render = (value, options = {}) => {
    const v = normalize(value), id = str(options.chatId || v?.hostChatId || '');
    if (!v || v.hostChatId !== id) return '<section class="ms-host-lineage"><h3>현재 세계선</h3><p>현재 채팅의 분기 근거를 확인하지 못했습니다.</p></section>';
    const status = { verified:'공통 원문 검증됨', unverified:'분기 근거 미검증', diverged:'부모와 원문 불일치', independent:'네이티브 분기 표식 없음' }[v.status];
    const short = text => text.length > 24 ? text.slice(0, 12) + '…' + text.slice(-8) : text;
    const path = v.path.map(short).join(' → ') || short(id);
    const extra = options.owner === 'libra' && v.kind === 'native_branch'
      ? `<div>정본 승계 상한: ${v.canonicalPrefixEnd}턴 · 경계 ${v.partialCanonicalPairs}턴은 완성된 5턴 정본이 아닙니다.</div>` : '';
    return `<section class="ms-host-lineage" x-ms-host-lineage="${escape(v.hostChatId)}" style="margin:12px 0;padding:14px 16px;border:1px solid var(--border,rgba(127,127,127,.28));border-radius:10px;overflow-wrap:anywhere"><h3 style="margin:0 0 8px;font-size:1em">현재 세계선 <small style="font-weight:normal">${escape(status)}</small></h3><div>현재 경로: ${escape(path)}</div>${v.parentChatId ? `<div>부모: ${escape(v.parentName || short(v.parentChatId))} · 분기 메시지: ${escape(short(v.forkMessageId))}</div><div>검증한 공통 원문: ${v.commonPrefixPairs} U+A턴 / ${v.commonPrefixMessages}개 메시지</div>` : ''}${extra}${v.kind === 'native_branch' && !v.pathVerified ? '<div>상위 분기 전체 경로는 미검증입니다.</div>' : ''}${options.inheritance ? `<div>${escape(options.inheritance)}</div>` : ''}<div style="opacity:.7;font-size:.85em">${escape(v.reason)}${options.worldlineId ? ' · ' + escape(options.worldlineId) : ''}</div></section>`;
  };
  return Object.freeze({ schema, marker, prefix, inspect, normalize, render, countPairs, fingerprint, prefixRevision, same });
}
/* END LIBRARIAN HOST LINEAGE SDK */
