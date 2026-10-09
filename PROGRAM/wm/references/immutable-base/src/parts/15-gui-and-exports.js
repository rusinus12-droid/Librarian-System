// ══════════════════════════════════════════════════════════════
// [GUI] LIBRA World Manager UI (V1.1 Rendering Method Applied)
// ══════════════════════════════════════════════════════════════
const ManagementReviewCore = (() => {
        const buildAcceptedPayload = (prepared = null, lore = []) => {
            const source = prepared?.payload && typeof prepared.payload === 'object' && !Array.isArray(prepared.payload) ? safeClone(prepared.payload) : {};
            const entityExtraction = source.entityExtraction && typeof source.entityExtraction === 'object' && !Array.isArray(source.entityExtraction)
                ? safeClone(source.entityExtraction)
                : {};
            let packetExtraction = null;
            if (source.canonicalPacket && typeof source.canonicalPacket === 'object' && !Array.isArray(source.canonicalPacket)) {
                try {
                    packetExtraction = EntityAwareProcessor?.extractStructuredEntitySignalsFromPackets?.(source.canonicalPacket, {
                        lorebook: lore,
                        conversationText: source.conversationText || '',
                        sourceMessageId: `gui_accept:${prepared?.entry?.id || ''}`,
                        turn: MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0
                    }) || null;
                } catch (error) {
                    recordSuppressedRuntimeError('gui.health.accept.packet_projection_failed', error, {
                        id: String(prepared?.entry?.id || '').trim()
                    });
                }
            }
            const packetEntities = Array.isArray(packetExtraction?.entities) ? packetExtraction.entities : [];
            const explicitEntities = Array.isArray(entityExtraction.entities) ? entityExtraction.entities : (Array.isArray(source.entities) ? source.entities : []);
            const entityByName = new Map();
            [...packetEntities, ...explicitEntities].forEach(entity => {
                const name = String(entity?.name || entity?.canonicalName || '').trim();
                if (!name) return;
                entityByName.set(name, { ...(entityByName.get(name) || {}), ...safeClone(entity), name });
            });
            const relations = [
                ...(Array.isArray(packetExtraction?.relations) ? packetExtraction.relations : []),
                ...(Array.isArray(entityExtraction.relations) ? entityExtraction.relations : []),
                ...(Array.isArray(source.relations) ? source.relations : [])
            ];
            const world = {
                ...((packetExtraction?.world && typeof packetExtraction.world === 'object' && !Array.isArray(packetExtraction.world)) ? packetExtraction.world : {}),
                ...((entityExtraction.world && typeof entityExtraction.world === 'object' && !Array.isArray(entityExtraction.world)) ? entityExtraction.world : {}),
                ...((source.world && typeof source.world === 'object' && !Array.isArray(source.world)) ? source.world : {})
            };
            const conflicts = [
                ...(Array.isArray(packetExtraction?.conflicts) ? packetExtraction.conflicts : []),
                ...(Array.isArray(entityExtraction.conflicts) ? entityExtraction.conflicts : []),
                ...(Array.isArray(source.conflicts) ? source.conflicts : [])
            ];
            const payload = {
                ...source,
                ...entityExtraction,
                success: source.success === false ? false : true,
                degraded: source.degraded === true,
                sourceMode: 'gui_manual_correction',
                source: 'gui_manual_correction',
                allowManualOverride: true,
                entities: Array.from(entityByName.values()).slice(0, 48),
                relations: relations.slice(0, 96),
                world,
                conflicts,
                conversationText: source.conversationText || ''
            };
            const hasWorld = !!(world && typeof world === 'object' && Object.keys(world).length > 0);
            const mergeable = payload.entities.length > 0 || payload.relations.length > 0 || hasWorld;
            return { payload, mergeable };
        };
    const prepare = (canonicalLore = [], options = {}) => {
        if (!Array.isArray(canonicalLore)) throw new Error('invalid_management_lore');
        const lore = safeClone(canonicalLore), context = options.context || {};
        if (!context.runtimeScopeKey || context.runtimeScopeKey !== getActiveManagedRuntimeScopeKey()
            || context.runtimeScopeKey !== getChatRuntimeScopeKey(context.chat, context.char)) throw new Error('management_scope_mismatch');
        const action = String(options.action || ''), id = String(options.id || '');
        const run = () => {
            QuarantineManager.list(lore, { strictRead: true });
            IntegrityScanner.listFindings(lore, { strictRead: true });
            let result;
            if (action === 'quarantine-accept') {
                const prepared = QuarantineManager.prepareAcceptedPayload(lore, id, { operation: 'gui.health.accept', allowFallbackReasonMerge: true, allowManualOverride: true });
                if (!prepared.ok) throw new Error(prepared.reason || 'accept_rejected');
                if (prepared.entry.status === 'accepted') return { changed: false, reason: 'already_accepted', lore };
                const extraction = buildAcceptedPayload(prepared, lore);
                if (!extraction.mergeable) throw new Error('no_changes_applied');
                TimeEngine.loadState(lore, { scopeKey: context.runtimeScopeKey, chatId: context.chat?.id });
                EntityManager.rebuildCache(lore);
                HierarchicalWorldManager.loadWorldGraph(lore, true);
                const applied = EntityAwareProcessor.applyExtractionsSync(extraction.payload, lore, MemoryEngine.CONFIG, `gui_accept:${id}`);
                if (applied?.blocked) throw new Error('guard_blocked');
                if (!Array.isArray(applied?.applied) || !applied.applied.length) throw new Error('no_changes_applied');
                EntityManager.saveToLorebookSync(context.char, context.chat, lore);
                HierarchicalWorldManager.saveWorldGraphUnsafe(lore);
                const marked = QuarantineManager.markStatus(lore, id, 'accepted', { reviewer: 'gui', note: `accepted via GUI · ${applied.applied.slice(0, 8).join('; ')}` });
                if (!marked.changed) throw new Error(marked.reason || 'not_found');
                result = { prepared, applied, marked };
            } else if (/^quarantine-(ignore|resolve)$/.test(action)) {
                result = QuarantineManager.markStatus(lore, id, action.endsWith('ignore') ? 'ignored' : 'resolved', { reviewer: 'gui', note: action });
                if (!result.changed) throw new Error(result.reason || 'not_found');
            } else if (/^integrity-(accept|ignore|resolve)$/.test(action)) {
                const status = action.endsWith('ignore') ? 'ignored' : (action.endsWith('accept') ? 'accepted' : 'resolved');
                result = IntegrityScanner.markFindingStatus(lore, id, status, { note: action });
                if (!result.changed) throw new Error(result.reason || 'not_found');
            } else if (action === 'scan') {
                for (let i = 0; i < 4; i += 1) {
                    result = IntegrityScanner.scanBatch(lore, { batchLimit: 80, maxMs: 32, scopeKey: context.runtimeScopeKey });
                    if (!result || result.done) break;
                }
            } else throw new Error('unknown_management_action');
            return { changed: true, completed: action === 'scan' ? result?.done === true : true, lore: options.readOnly === true ? lore : safeClone(lore), result: safeClone(result) };
        };
        const frames = [LibraLoreConsolidator.withRawManagementRead, EntityManager.withTemporaryState,
            HierarchicalWorldManager.withTemporaryState, TimeEngine.withTemporaryState, EntityCandidateCore.withTemporaryState,
            QuarantineManager.withTemporaryState, IntegrityScanner.withTemporaryState];
        const enter = index => index === frames.length ? run() : frames[index](() => enter(index + 1));
        return enter(0);
    };
    const fail = (reason, details = {}) => Object.assign(new Error(reason), { code: reason, ...details });
    const captureBinding = async context => {
        const char = context?.char, chat = context?.chat;
        const first = values => values.map(value => String(value ?? '').trim()).find(Boolean) || '';
        const characterId = first([char?.id, char?._id, char?.uid, char?.uuid, char?.key, char?.chaId]);
        const chatId = first([chat?.id, chat?._id, chat?.uid, chat?.uuid, chat?.key, chat?.chatId]);
        if (!characterId || !chatId) throw fail('management_identity_unresolved');
        const persona = await LibraDataStorage.resolvePersonaId(chat, char, { fresh: true, strict: true });
        const scopeKey = LibraDataStorage.scopeKeyFor(char, chat, persona || 'default');
        if (scopeKey !== LibraDataStorage.scopeKeyFor(char, chat)) throw fail('persona_binding_requires_migration');
        const resetGeneration = typeof PersonaScopeIdentity === 'undefined' ? 0 : (PersonaScopeIdentity.get(char, chat)?.resetGeneration ?? 0);
        return Object.freeze({ characterId, chatId, scopeKey, runtimeScopeKey: getChatRuntimeScopeKey(chat, char), resetGeneration });
    };
    const sameBinding = (left, right) => !!left && !!right && ['characterId', 'chatId', 'scopeKey', 'runtimeScopeKey', 'resetGeneration'].every(key => left[key] === right[key]);
    const assertOwner = (binding, options = {}) => {
        if (!binding) throw fail('management_binding_unavailable');
        if (options.isViewCurrent && options.isViewCurrent() !== true) throw fail('management_view_closed');
        if (options.token && !ScopedRuntimeTransaction.owns(options.token)) throw fail('stale_identity');
        if (options.worldlineRevision !== undefined && Number(LibraTurnWorldline.get(binding.scopeKey)?.revision || 0) !== options.worldlineRevision) throw fail('stale_worldline');
        if (getActiveManagedRuntimeScopeKey() !== binding.runtimeScopeKey) throw fail('stale_identity');
    };
    const currentContext = async (binding, options = {}) => {
        assertOwner(binding, options);
        const context = await resolveActiveChatContext();
        assertOwner(binding, options);
        if (!context?.chat && context?.personaAdmission?.reason) throw fail(context.personaAdmission.reason);
        const current = await captureBinding(context);
        assertOwner(binding, options);
        if (!sameBinding(binding, current)) throw fail('stale_identity');
        return { ...context, runtimeScopeKey: binding.runtimeScopeKey, scopeKey: binding.scopeKey };
    };
    const read = async (binding, options = {}) => {
        let context = await currentContext(binding, options);
        const worldlineRevision = options.worldlineRevision ?? Number(LibraTurnWorldline.get(binding.scopeKey)?.revision || 0);
        const readOptions = { ...options, worldlineRevision };
        const result = await LibraDataStorage.readVerified(binding.scopeKey);
        context = await currentContext(binding, readOptions);
        if (!result.ok) throw fail(result.reason);
        const provenance = LibraDataStorage.inspectHydrationEntries(result.entries, { ...context, ...binding, canonicalEnvelopeVerified: !result.missing });
        if (!provenance.ok) throw fail('canonical_provenance_unverified');
        result.entries = provenance.entries;
        if (result.missing && LibraDataStorage.getHydrationDiagnostics(binding.scopeKey).reasons.includes('branch_source_unverified')) throw fail('canonical_provenance_unverified');
        if (result.missing && (LibraLoreConsolidator.unpackRawFromLore(context.chat?.localLore || []).some(LibraDataStorage.isLibraEntry)
            || (LibraDataStorage.isHydrated(binding.scopeKey) && LibraDataStorage.getShadowEntries(binding.scopeKey).length))) throw fail('canonical_missing_unverified_data');
        return { ...result, lore: result.entries, context, worldlineRevision };
    };
    const publish = (lore, context) => LibraLoreConsolidator.withRawManagementRead(() => {
        MemoryEngine.rebuildIndex(lore);
        TimeEngine.loadState(lore, { scopeKey: context.runtimeScopeKey, chatId: context.chat.id });
        HierarchicalWorldManager.loadWorldGraph(lore, true);
        EntityManager.rebuildCache(lore);
        EntityCandidateCore.loadState(lore, { scopeKey: context.runtimeScopeKey, chatId: context.chat.id });
        QuarantineManager.list(lore, { strictRead: true });
        IntegrityScanner.listFindings(lore, { strictRead: true });
    });
    const commit = async (binding, options = {}) => {
        await loreLock.writeLock();
        let token = null, canonicalVerified = false;
        try {
            assertOwner(binding, options);
            token = ScopedRuntimeTransaction.begin(binding.runtimeScopeKey, 'gui.health.review');
            if (!token) throw fail('management_busy');
            const guardOptions = { ...options, token };
            const before = await read(binding, guardOptions);
            guardOptions.worldlineRevision = before.worldlineRevision;
            assertOwner(binding, guardOptions);
            const prepared = prepare(before.entries, { action: options.action, id: options.id, context: before.context });
            let verifiedRaw = before.raw;
            if (prepared.changed) {
                const saved = await LibraDataStorage.saveVerified(binding.scopeKey, prepared.lore, { expectedRaw: before.raw,
                    isCurrent: async () => { await currentContext(binding, guardOptions); return true; } });
                if (!saved.ok) throw fail(saved.reason, { uncertain: saved.uncertain });
                verifiedRaw = saved.raw;
            }
            canonicalVerified = true;
            let context = await currentContext(binding, guardOptions);
            // Management confirms canonical storage only. Legacy host lore may
            // contain newer or unrelated records; it must never be cleaned up here.
            const proof = await LibraDataStorage.readVerified(binding.scopeKey);
            context = await currentContext(binding, guardOptions);
            if (!proof.ok || proof.raw !== verifiedRaw) throw fail(proof.reason || 'canonical_changed');
            assertOwner(binding, guardOptions);
            publish(prepared.lore, context);
            return { ok: true, changed: prepared.changed, completed: prepared.completed, reason: prepared.reason || '', canonicalVerified: true,
                lore: safeClone(prepared.lore), context };
        } catch (error) {
            if (canonicalVerified) error.canonicalVerified = true;
            throw error;
        } finally {
            if (token) ScopedRuntimeTransaction.end(token);
            loreLock.writeUnlock();
        }
    };
    const reset = async (binding, options = {}) => {
        releaseHealth();
        await loreLock.writeLock();
        let token = null, canonicalVerified = false;
        try {
            assertOwner(binding, options);
            token = ScopedRuntimeTransaction.begin(binding.runtimeScopeKey, 'gui.memory.reset');
            if (!token) throw fail('management_busy');
            const guards = { ...options, token };
            const before = await read(binding, guards);
            guards.worldlineRevision = before.worldlineRevision;
            const nextBinding = { ...binding, resetGeneration: binding.resetGeneration + 1 };
            const saved = await LibraDataStorage.resetVerified(binding.scopeKey, {
                expectedGeneration: binding.resetGeneration,
                isCurrent: async phase => {
                    const expected = /after_write|after_readback/.test(phase) ? nextBinding : binding;
                    await currentContext(expected, guards);
                    return true;
                }
            });
            if (!saved.ok) throw fail(saved.reason, { uncertain: saved.uncertain });
            canonicalVerified = true;
            const context = await currentContext(nextBinding, guards);
            const proof = await LibraDataStorage.readVerified(binding.scopeKey);
            await currentContext(nextBinding, guards);
            if (!proof.ok || proof.raw !== saved.raw) throw fail(proof.reason || 'canonical_changed');
            assertOwner(binding, guards);
            const published = LibraDataStorage.publishVerifiedView(context.char, context.chat, binding.scopeKey, []);
            if (!published.ok) throw fail(published.reason);
            LibraLoreConsolidator.withRawManagementRead(() => {
                reloadChatScopedRuntime([], binding.chatId, { scopeKey: binding.runtimeScopeKey,
                    resetSessionCaches: true, resetScopedState: true, forceWorldReload: true,
                    restoreScopeSnapshot: false, transactionToken: token });
                MemoryState.sessionCache.delete(binding.runtimeScopeKey);
                MemoryState.cbsResolvedCharacterLoreByScope.delete(binding.runtimeScopeKey);
                EntityCandidateCore.resetState();
                QuarantineManager.resetState();
                IntegrityScanner.resetState();
            });
            MemoryState.currentSessionId = buildScopedSessionId(binding.runtimeScopeKey);
            MemoryState.isInitialized = true;
            return { ok: true, canonicalVerified: true, resetGeneration: saved.resetGeneration, clearedEntries: before.entries.length };
        } catch (error) {
            if (error.uncertain || canonicalVerified) PersonaRuntimeCoordinator.quarantineOwnedRuntime(token, binding.scopeKey);
            if (canonicalVerified) error.canonicalVerified = true;
            throw error;
        } finally {
            if (token) ScopedRuntimeTransaction.end(token);
            loreLock.writeUnlock();
        }
    };
    const recoveryPolicy = MemorySuiteHealthRecovery.create();
    let healthOwner = null, readOnlyScanPage = null, repairProof = null, repairTicket = null, healthSequence = 0;
    const releaseHealth = () => { healthOwner = readOnlyScanPage = repairProof = repairTicket = null; recoveryPolicy.clear(); };
    const ownerFor = (binding, snapshot) => {
        const signature = JSON.stringify([binding, snapshot.worldlineRevision, 'plugin_only']);
        if (!healthOwner || healthOwner.signature !== signature || healthOwner.raw !== snapshot.raw) {
            releaseHealth();
            healthOwner = { id: ++healthSequence, signature, raw: snapshot.raw };
        }
        return healthOwner;
    };
    const coverageFor = (binding, snapshot) => {
        const owner = ownerFor(binding, snapshot);
        const total = snapshot.entries.filter(entry => entry.comment !== 'lmai_integrity_scan').length;
        const page = readOnlyScanPage?.owner === owner ? readOnlyScanPage : null;
        return { state: page ? (page.completed ? 'complete' : 'incomplete') : total === 0 ? 'complete' : 'unscanned',
            completed: page ? page.completed : total === 0, scannedThrough: page?.scannedThrough || 0, total: page?.total ?? total };
    };
    const readHealthBound = async (binding, options = {}) => {
        const before = await read(binding, options), coverage = coverageFor(binding, before);
        const page = readOnlyScanPage;
        const view = page?.entry ? before.entries.filter(entry => entry.comment !== 'lmai_integrity_scan').concat(page.entry) : before.entries;
        return { ...before, lore: view, coverage, previewOnly: !!page };
    };
    const inspectBound = async (binding, options = {}) => {
        const before = await read(binding, options), owner = ownerFor(binding, before);
        const previous = readOnlyScanPage?.owner === owner && !readOnlyScanPage.completed ? readOnlyScanPage : null;
        // Retain just scan metadata and one immutable canonical proof. The
        // existing prepare function creates the one mutable working lore copy.
        const scanLore = before.entries.filter(entry => entry.comment !== 'lmai_integrity_scan');
        const storedEntry = previous?.entry || before.entries.find(entry => entry.comment === 'lmai_integrity_scan');
        if (storedEntry) {
            const state = JSON.parse(storedEntry.content);
            if (!previous) state.cursor = { ...state.cursor, index: 0 };
            scanLore.push({ ...storedEntry, content: JSON.stringify(state) });
        }
        const prepared = prepare(scanLore, { action: 'scan', readOnly: true, context: before.context });
        const proof = await read(binding, { ...options, worldlineRevision: before.worldlineRevision });
        if (proof.raw !== before.raw || healthOwner !== owner) { releaseHealth(); throw fail('canonical_changed'); }
        const scannedThrough = prepared.completed ? prepared.result?.total : prepared.result?.nextIndex;
        const entry = prepared.lore.find(row => row.comment === 'lmai_integrity_scan');
        readOnlyScanPage = { owner, entry: entry ? Object.freeze({ ...entry }) : null,
            completed: prepared.completed, scannedThrough, total: prepared.result?.total };
        const findings = (prepared.result?.findings || []).filter(row => !['ignored','resolved','accepted'].includes(row.status));
        return { ...before, lore: prepared.lore, changed: false, completed: prepared.completed, readOnly: true,
            scannedThrough, total: prepared.result?.total, coverage: coverageFor(binding, before), previewOnly: true,
            report: MemorySuiteHealthRecovery.report({ owner: 'WM', known: true, complete: prepared.completed,
                issues: findings.map(() => ({ code: 'INTEGRITY_REVIEW_REQUIRED', count: 1 })) }) };
    };
    const previewRepairBound = async (binding, options = {}) => {
        const before = await read(binding, options), owner = ownerFor(binding, before);
        repairTicket = recoveryPolicy.preview(String(owner.id), { id: 'refresh_derived_cache', safe: true, model: false, physical: false });
        repairProof = repairTicket.allowed ? { owner, binding, worldlineRevision: before.worldlineRevision } : null;
        return repairTicket;
    };
    const healthGuard = method => async (...args) => { try { return await method(...args); } catch (error) { releaseHealth(); throw error; } };
    const readHealth = healthGuard(readHealthBound), inspect = healthGuard(inspectBound), previewRepair = healthGuard(previewRepairBound);
    const healthRetention = () => ({ ownedCanonicalSnapshots: healthOwner ? 1 : 0,
        canonicalCodeUnits: typeof healthOwner?.raw === 'string' ? healthOwner.raw.length : 0,
        scanMetadataCodeUnits: readOnlyScanPage?.entry?.content?.length || 0,
        fullLoreSnapshotsRetained: 0, ticket: recoveryPolicy.retention() });
    const repairDerivedCache = async (ticket, options = {}) => {
        const preview = ticket === repairTicket ? repairProof : null;
        if (!preview) return { status: 'blocked', reason: 'stale_or_unknown_ticket' };
        await loreLock.writeLock();
        let token = null;
        try {
            const binding = preview.binding;
            assertOwner(binding, options);
            token = ScopedRuntimeTransaction.begin(binding.runtimeScopeKey, 'gui.health.derived_cache');
            if (!token) throw fail('management_busy');
            const guards = { ...options, token, worldlineRevision: preview.worldlineRevision };
            const before = await read(binding, guards);
            const projection = () => JSON.stringify({ entities:Array.from(EntityManager.getEntityCache().entries()), relations:Array.from(EntityManager.getRelationCache().entries()) });
            const expected = TimeEngine.withTemporaryState(() => EntityManager.withTemporaryState(() => { EntityManager.rebuildCache(before.entries); return projection(); }));
            const result = await recoveryPolicy.run(ticket, { binding: ownerFor(binding, before) === preview.owner ? String(preview.owner.id) : 'stale',
                preflight: async () => { await currentContext(binding, guards); return true; },
                execute: async () => { assertOwner(binding, guards); TimeEngine.withTemporaryState(() => EntityManager.rebuildCache(before.entries)); },
                verify: async () => { const after = await read(binding, guards); return after.raw === before.raw && projection() === expected; }
            });
            if (result.status === 'verified') {
                const after = await read(binding, guards);
                if (after.raw !== before.raw || projection() !== expected) {
                    releaseHealth();
                    return {status:'blocked',reason:'derived_cache_changed'};
                }
            }
            return result;
        } catch (error) { releaseHealth(); throw error; } finally { if (token) ScopedRuntimeTransaction.end(token); loreLock.writeUnlock(); }
    };
    return Object.freeze({ prepare, buildAcceptedPayload, captureBinding, read, commit, reset, inspect, readHealth, previewRepair, repairDerivedCache, releaseHealth, healthRetention });
})();

const LMAI_GUI = (() => {
    const GUI_CSS = `/* ============================================================
   LIBRA World Manager — redesign mockup
   구조/기능 유지 계약:
   - 모든 id 속성은 실제 플러그인 JS(overlay.querySelector)가
     그대로 바인딩할 수 있도록 원본과 100% 동일하게 유지했습니다.
   - 기능에 쓰이는 class(panel, tb, on, act-*, rC-val,
     is-ok/is-failed/is-running/is-disabled)와
     data-vertex-json-* 속성도 원본 그대로 유지했습니다.
   - 순수 스타일용 class/마크업 구조는 자유롭게 재구성했습니다.
   ============================================================ */
*{box-sizing:border-box;margin:0;padding:0}
:root{
  /* Risu 테마 변수를 우선 따르되, 폴백값을 "카드 카탈로그 / 필드 기록부" 톤으로 재설계 */
  --bg:        var(--risu-theme-bgcolor, #0c1013);
  --bg2:       var(--risu-theme-darkbg, #12171b);
  --bg3:       var(--risu-theme-selected, #1a2227);
  --bg4:       #212b31;
  --accent:    var(--risu-theme-primary-600, var(--risu-theme-borderc, #c9a15a));
  --accent2:   var(--risu-theme-secondary-500, var(--risu-theme-borderc, #e0bd7c));
  --accent-ink:#3a2f16;
  --text:      var(--risu-theme-textcolor, #ece6d6);
  --text2:     var(--risu-theme-textcolor2, #98a3a6);
  --text3:     #667075;
  --border:    var(--risu-theme-borderc, #283136);
  --line:      var(--border);
  --success:   var(--risu-theme-success-500, #5c9d6e);
  --danger:    var(--risu-theme-danger-500, #b5584c);
  --teal:      #4f8f95;
  --violet:    #8079ab;
  --radius:    7px;
  --radius-lg: 12px;
  --fs-body:   13px;
  --fs-label:  12px;
  --fs-small:  10.5px;
  --fs-title:  14px;
  --lh-ui:     1.5;
  --serif:     Georgia, 'Noto Serif KR', 'Nanum Myeongjo', serif;
  --mono:      ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans:      var(--risu-font-family, -apple-system, 'Malgun Gothic', 'Apple SD Gothic Neo', 'Segoe UI', sans-serif);
}
.demo-frame{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px}

/* ---------- overlay shell ---------- */
.lmai-overlay{position:fixed;inset:0;padding:18px;background:color-mix(in srgb,var(--risu-theme-darkbg,#05070a) 72%, transparent);z-index:9999;display:flex;align-items:center;justify-content:center;font-family:var(--sans);font-size:var(--fs-body);line-height:var(--lh-ui);color:var(--text);overflow:auto}
.lmai-overlay [data-libra-gui-backdrop="true"]{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.gui-wrap{position:relative;width:100%;max-width:1160px;height:min(92dvh,900px);max-height:calc(100dvh - 32px);background:var(--bg);border:1px solid color-mix(in srgb,var(--border) 70%, transparent);border-radius:var(--radius-lg);box-shadow:0 20px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.02) inset;color:var(--text);font-size:var(--fs-body);line-height:var(--lh-ui);overflow:hidden;display:grid;grid-template-columns:76px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}

/* ---------- top strip (title + close) ---------- */
.hdr{grid-column:1/3;grid-row:1;display:flex;align-items:center;justify-content:space-between;
  padding:12px 16px;border-bottom:1px solid var(--border);background:linear-gradient(180deg, var(--bg2), var(--bg));}
.hdr .brand{display:flex;align-items:baseline;gap:9px}
.hdr .brand 
.hdr h1{font-family:var(--serif);font-size:17px;font-weight:600;letter-spacing:.2px}
.hdr .ver{font-family:var(--mono);font-size:10px;color:var(--text3);margin-left:6px}
.hdr .sub{font-size:var(--fs-small);color:var(--text3);margin-top:1px}
.xbtn{background:transparent;border:1px solid var(--border);color:var(--text2);cursor:pointer;
  font-size:14px;line-height:1;width:30px;height:30px;border-radius:8px;transition:all .15s;display:flex;align-items:center;justify-content:center}
.xbtn:hover{background:var(--danger);border-color:var(--danger);color:#fff}

/* ---------- left rail (index-tab style nav) ---------- */
.tabs{grid-column:1;grid-row:2;display:flex;flex-direction:column;align-items:stretch;
  border-right:1px solid var(--border);background:var(--bg2);padding:10px 0;gap:2px;overflow-y:auto}
.tb{appearance:none;background:transparent;border:none;color:var(--text3);cursor:pointer;
  display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px 11px;
  font-size:10.5px;font-family:var(--sans);line-height:1.25;position:relative;transition:color .15s,background .15s}
.tb .ic{font-size:17px;line-height:1}
.tb:hover{color:var(--text)}
.tb.on{color:var(--text);background:color-mix(in srgb, var(--accent) 12%, transparent)}
.tb.on::before{content:'';position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}

/* ---------- content ---------- */
.content{grid-column:2;grid-row:2;overflow:hidden;min-height:0;position:relative}
.panel{display:none;height:100%;overflow-y:auto;padding:18px 20px 90px;min-height:0}
.panel.on{display:block}
.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
.panel-heading h2{font-family:var(--serif);font-size:20px;font-weight:600;line-height:1.25}
.panel-heading p{color:var(--text3);font-size:var(--fs-label);margin-top:4px}
.view-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:-2px 0 16px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.view-tab{appearance:none;background:var(--bg2);border:1px solid var(--border);color:var(--text2);border-radius:var(--radius);padding:7px 11px;cursor:pointer;font-size:var(--fs-label);font-family:var(--sans)}
.view-tab:hover{border-color:var(--accent);color:var(--text)}
.view-tab.on{background:color-mix(in srgb,var(--accent) 15%,var(--bg2));border-color:var(--accent);color:var(--accent2)}
.home-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px;border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border));border-radius:var(--radius-lg);background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 8%,var(--bg2)),var(--bg2));margin-bottom:14px}
.home-hero h2{font-family:var(--serif);font-size:21px;font-weight:600}
.home-hero p{color:var(--text2);font-size:var(--fs-label);margin-top:5px;max-width:680px}
.home-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.home-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:16px}
.home-card{border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg2);padding:13px;min-height:112px}
.home-card-head{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--text2);font-size:var(--fs-label)}
.home-card-value{font-family:var(--serif);font-size:18px;color:var(--text);margin-top:10px}
.home-card-note{font-size:var(--fs-small);color:var(--text3);margin-top:5px;line-height:1.45}
.status-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:999px;padding:2px 7px;font-family:var(--mono);font-size:9.5px;color:var(--text2);white-space:nowrap}
.status-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--text3)}
.status-pill.ok::before{background:var(--success);box-shadow:0 0 7px color-mix(in srgb,var(--success) 70%,transparent)}
.status-pill.warn::before{background:var(--accent2)}
.home-sync{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg2);padding:13px;margin-bottom:16px}
.home-sync strong{display:block;font-size:var(--fs-body)}
.home-sync span{display:block;color:var(--text3);font-size:var(--fs-small);margin-top:3px}
.settings-overview{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg2);padding:12px 13px;margin-bottom:14px}
.settings-overview-copy strong{display:block}.settings-overview-copy span{display:block;color:var(--text3);font-size:var(--fs-small);margin-top:3px}

.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
input,select,textarea{background:var(--bg2);border:1px solid var(--border);color:var(--text);
  padding:7px 10px;border-radius:var(--radius);font-size:var(--fs-body);line-height:var(--lh-ui);
  outline:none;transition:border-color .15s,box-shadow .15s;font-family:var(--sans)}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)}
.si{flex:1;min-width:180px}
.stat{font-size:var(--fs-label);color:var(--text2);white-space:nowrap;font-family:var(--mono)}
.stat strong{color:var(--accent2);font-weight:600}

.btn{padding:7px 12px;border:none;border-radius:var(--radius);font-size:var(--fs-label);
  cursor:pointer;transition:all .15s;min-height:32px;font-family:var(--sans);font-weight:500;letter-spacing:.1px}
.bp{background:var(--accent);color:#1b1607}.bp:hover{filter:brightness(1.1)}
.bs{background:var(--bg4);color:var(--text);border:1px solid var(--border)}.bs:hover{border-color:var(--accent)}
.bd{background:transparent;border:1px solid var(--danger);color:var(--danger)}.bd:hover{background:var(--danger);color:#fff}

/* section eyebrow / divider */
.sec{font-family:var(--mono);font-size:10px;font-weight:600;color:var(--accent);
  text-transform:uppercase;letter-spacing:.16em;margin:20px 0 9px;padding-bottom:6px;
  border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
.sec:first-child{margin-top:0}
.sec::before{content:'';width:5px;height:5px;border-radius:1px;background:var(--accent);display:inline-block;transform:rotate(45deg)}

/* ---------- index-card list (memory/entity/relation/narrative) ---------- */
.list{display:flex;flex-direction:column;gap:8px}
.wa-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0 12px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.wa-tab{display:flex;align-items:center;gap:7px;background:var(--bg2);border:1px solid var(--border);color:var(--text2);border-radius:var(--radius);padding:8px 11px;cursor:pointer;font-family:var(--sans);font-size:var(--fs-label);transition:all .15s}
.wa-tab:hover{border-color:var(--accent);color:var(--text)}
.wa-tab.on{background:color-mix(in srgb,var(--accent) 15%,var(--bg2));border-color:var(--accent);color:var(--accent2)}
.wa-tab-count{font-family:var(--mono);font-size:10px;min-width:19px;padding:1px 5px;border-radius:999px;background:var(--bg4);text-align:center;color:var(--text2)}
.wa-tab.on .wa-tab-count{background:color-mix(in srgb,var(--accent) 28%,var(--bg4));color:var(--accent2)}
.wa-pane{display:none}
.wa-pane.on{display:block}
.wa-pane-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin:4px 0 12px}
.wa-pane-title{font-family:var(--serif);font-size:15px;color:var(--text);font-weight:600}
.wa-pane-note{font-size:var(--fs-small);color:var(--text3);margin-top:3px;line-height:1.45}
.wa-group{margin-top:16px}
.wa-group:first-child{margin-top:0}
.wa-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase}
.udlc-editor{border:1px solid color-mix(in srgb,var(--accent) 38%,var(--border));background:color-mix(in srgb,var(--accent) 5%,var(--bg2));border-radius:var(--radius-lg);padding:14px;margin-bottom:14px}
.udlc-grid{display:grid;grid-template-columns:minmax(0,.55fr) minmax(0,1.45fr);gap:10px}
.udlc-grid .wide{grid-column:1/3}
.udlc-target-columns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
.udlc-target-box{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);min-height:120px;max-height:240px;overflow:auto;padding:8px}
.udlc-target-title{position:sticky;top:-8px;background:var(--bg);z-index:1;font-family:var(--mono);font-size:10px;color:var(--accent2);padding:3px 2px 7px}
.udlc-target-item{display:flex;align-items:flex-start;gap:7px;padding:6px;border-radius:5px;color:var(--text2);font-size:var(--fs-label);cursor:pointer;line-height:1.4}
.udlc-target-item:hover{background:var(--bg3);color:var(--text)}
.udlc-target-item input{margin-top:2px;flex:0 0 auto}
.udlc-kv{display:grid;grid-template-columns:minmax(110px,.3fr) minmax(0,1fr);gap:6px 10px;margin-top:9px;font-size:var(--fs-label)}
.udlc-kv b{color:var(--accent2);font-family:var(--mono);font-size:10px}.udlc-kv span{color:var(--text2);white-space:pre-wrap;word-break:break-word}
.udlc-quick-actions{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0 12px}.udlc-quick{border:1px solid var(--border);background:var(--bg);color:var(--text2);border-radius:999px;padding:6px 10px;font-size:var(--fs-label);cursor:pointer}.udlc-quick:hover{border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 9%,var(--bg))}
.udlc-simple-label{font-size:var(--fs-body);font-weight:700;color:var(--text);margin-bottom:7px}.udlc-simple-help{color:var(--text3);font-size:var(--fs-label);line-height:1.55;margin-bottom:9px}
@media(max-width:760px){.udlc-grid,.udlc-target-columns{grid-template-columns:1fr}.udlc-grid .wide{grid-column:1}}
.card{background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--stub, var(--accent));
  border-radius:var(--radius);padding:12px 13px;transition:border-color .15s,transform .1s}
.card:hover{border-color:color-mix(in srgb,var(--accent) 55%, var(--border))}
.card.mem{--stub:var(--accent)}
.card.ent{--stub:var(--teal)}
.card.rel{--stub:var(--violet)}
.card.nar{--stub:var(--violet)}
.card-hdr{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;gap:8px}
.card-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:5px}
.card-title{font-weight:600;font-size:var(--fs-body)}
.card-hint{margin-top:7px;font-size:var(--fs-label);color:var(--text3)}
.memory-readable{border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border));background:color-mix(in srgb,var(--accent) 7%,var(--bg2));border-radius:var(--radius);padding:10px 11px;margin-bottom:9px}
.memory-readable-title{font-family:var(--mono);font-size:10px;color:var(--accent2);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
.memory-readable-text{white-space:pre-wrap;word-break:keep-all;line-height:1.65;color:var(--text);font-size:13px}
.memory-readable-sub{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.memory-readable-sub .bdg{max-width:100%;overflow:hidden;text-overflow:ellipsis}
/* RP 장기 연속성 — 정본 기억과 다른 역할이라 접어서 함께 둔다.
   본문에 섞지 않는 이유: 같은 문장이 반복되고 어느 쪽이 최신인지 읽을 수 없다. */
.memory-rp-box{margin-top:8px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--border));border-radius:var(--radius);background:color-mix(in srgb,var(--accent) 4%,var(--bg))}
.memory-rp-box summary{cursor:pointer;user-select:none;color:var(--text2);font-size:var(--fs-label);padding:7px 9px;display:flex;align-items:center;gap:6px;list-style:none}
.memory-rp-box summary::-webkit-details-marker{display:none}
.memory-rp-box summary::before{content:'▸';font-size:10px;color:var(--text3);transition:transform .16s}
.memory-rp-box[open] summary::before{transform:rotate(90deg)}
.memory-rp-help{padding:0 9px 8px;color:var(--text3);font-size:var(--fs-small);line-height:1.6;border-bottom:1px solid color-mix(in srgb,var(--border) 60%,transparent)}
.memory-rp-group{padding:7px 9px;border-top:1px solid color-mix(in srgb,var(--border) 45%,transparent)}
.memory-rp-label{font-family:var(--mono);font-size:10px;color:var(--accent2);letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
.memory-rp-list{margin:0;padding-left:16px;color:var(--text2);font-size:var(--fs-small);line-height:1.6}
.memory-rp-list li{word-break:keep-all}
.memory-raw-box{margin-top:8px;border:1px dashed color-mix(in srgb,var(--border) 80%,transparent);border-radius:var(--radius);background:color-mix(in srgb,var(--bg) 65%,transparent)}
.memory-raw-box summary{cursor:pointer;user-select:none;color:var(--text2);font-size:var(--fs-label);padding:7px 9px;display:flex;align-items:center;gap:6px}
.memory-raw-box summary::before{content:'▶';font-size:9px;color:var(--text3);transition:transform .16s}
.memory-raw-box[open] summary::before{transform:rotate(90deg);color:var(--accent)}
.memory-raw-help{font-size:var(--fs-small);color:var(--text3);padding:0 9px 7px;line-height:1.45}
.memory-raw-box textarea{border-radius:0 0 var(--radius) var(--radius);border-left:0;border-right:0;border-bottom:0;margin-top:0;font-family:var(--mono);font-size:11px;line-height:1.55}
.empty{padding:26px 10px;text-align:center;color:var(--text3);font-size:var(--fs-label);border:1px dashed var(--border);border-radius:var(--radius)}

.bdg{font-family:var(--mono);font-size:9.5px;padding:2px 6px;border-radius:4px;font-weight:600;white-space:nowrap;letter-spacing:.03em}
.bh{background:color-mix(in srgb, var(--success) 22%, transparent);color:#8fd39f}
.bm{background:color-mix(in srgb, var(--accent) 22%, transparent);color:var(--accent2)}
.bl{background:var(--bg4);color:var(--text3)}
.bt{background:var(--bg4);color:var(--text2);border:1px solid var(--border)}
.acts{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap}
.acts .btn{padding:5px 9px;min-height:26px;font-size:10.5px}
.wa-inject-toggle{position:relative;background:var(--bg);border:1px solid var(--border);color:var(--text3);padding-left:20px!important}
.wa-inject-toggle::before{content:'';position:absolute;left:8px;top:50%;width:7px;height:7px;border-radius:50%;transform:translateY(-50%);background:#3a4247;box-shadow:0 0 0 1px rgba(255,255,255,.05)}
.wa-inject-toggle.is-on{color:#baf8d7;border-color:#42d79a;background:color-mix(in srgb,#27c987 17%,var(--bg2));box-shadow:0 0 12px color-mix(in srgb,#38e4a4 34%,transparent),inset 0 0 8px color-mix(in srgb,#38e4a4 10%,transparent)}
.wa-inject-toggle.is-on::before{background:#51f0af;box-shadow:0 0 5px #51f0af,0 0 12px #2bd993}

/* add-form drawer */
.add-form{display:none;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:14px;margin-bottom:14px}
.add-form.on{display:block;animation:drop .15s ease}
@keyframes drop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.fld{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.fld label{font-size:var(--fs-label);color:var(--text2)}
.fld input,.fld select,.fld textarea{width:100%}
.ef{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ec{resize:vertical}

.entity-band{border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg2)}
.entity-band-title{font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;
  letter-spacing:.12em;margin-bottom:9px}
.entity-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.entity-wide{grid-column:1/3}
.entity-state-log{grid-column:1/3;border:1px solid color-mix(in srgb,var(--border) 70%, transparent);
  border-radius:var(--radius);background:var(--bg);overflow:hidden}
.entity-state-log summary{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;
  list-style:none;padding:8px 10px;font-family:var(--mono);font-size:10px;color:var(--text2);user-select:none}
.entity-state-log summary::-webkit-details-marker{display:none}
.entity-state-log summary::before{content:'▶';font-size:9px;color:var(--text3);transition:transform .16s}
.entity-state-log[open] summary::before{transform:rotate(90deg);color:var(--accent)}
.entity-state-log-title{display:flex;align-items:center;gap:7px;min-width:0}
.entity-state-log-body{border-top:1px solid var(--border);max-height:184px;overflow-y:auto;padding:8px 10px;
  display:flex;flex-direction:column;gap:6px}
.entity-state-row{border:1px solid color-mix(in srgb,var(--border) 60%, transparent);border-radius:var(--radius);
  padding:7px 8px;background:var(--bg2)}
.entity-state-row-head{display:flex;align-items:center;gap:7px;margin-bottom:4px;flex-wrap:wrap}
.entity-state-turn{font-family:var(--mono);font-size:10px;color:var(--accent2)}
.entity-state-source{font-family:var(--mono);font-size:9px;color:var(--text3)}
.entity-state-summary{font-size:var(--fs-label);line-height:1.55;color:var(--text);word-break:break-word}
.entity-state-meta{margin-top:4px;font-size:var(--fs-small);line-height:1.45;color:var(--text2);word-break:break-word}
.entity-state-empty{font-size:var(--fs-label);color:var(--text3);padding:10px;text-align:center}

.rw{display:flex;align-items:center;gap:9px}
.rw input[type=range]{flex:1;accent-color:var(--accent)}
.rv{font-family:var(--mono);font-size:var(--fs-label);color:var(--text2);min-width:34px;text-align:right}

.tr{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)}
.tr:last-child{border-bottom:none}
.tr label{font-size:var(--fs-body)}
.tog{position:relative;display:inline-flex;width:36px;height:20px;flex:0 0 36px}
.tog input{position:absolute;inset:0;margin:0;opacity:0;cursor:pointer;z-index:2}
.tsl{position:absolute;inset:0;background:var(--bg4);border:1px solid var(--border);border-radius:999px;transition:background .15s}
.tsl::before{content:'';position:absolute;width:14px;height:14px;left:2px;top:2px;background:var(--text2);
  border-radius:50%;transition:transform .15s}
.tog input:checked+.tsl{background:color-mix(in srgb, var(--accent) 55%, var(--bg4));border-color:var(--accent)}
.tog input:checked+.tsl::before{transform:translateX(16px);background:#1b1607}

/* ---------- world tree text block ---------- */
.wt{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);
  padding:12px;color:var(--text2);font-size:var(--fs-label);min-height:38px;white-space:pre-wrap;line-height:1.6}
.sbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.inline-actions{margin-bottom:4px}

/* ---------- accordion (world sub-structure + settings) ---------- */
.acc{border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:10px;background:var(--bg2)}
.acc-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;cursor:pointer;
  user-select:none;transition:background .15s}
.acc-h:hover{background:var(--bg3)}
.acc-h .ttl{display:flex;align-items:center;gap:9px;font-family:var(--serif);font-size:14px;font-weight:600}
.acc-h .idx{font-family:var(--mono);font-size:10px;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%, transparent);
  border-radius:4px;padding:1px 6px}
.acc-h .chev{color:var(--text3);transition:transform .18s;font-size:11px}
.acc.open .acc-h .chev{transform:rotate(90deg);color:var(--accent)}
.acc-b{display:none;padding:4px 14px 16px;border-top:1px solid var(--border)}
.acc.open .acc-b{display:block}
.acc-hint{font-size:var(--fs-small);color:var(--text3);padding:0 14px 12px;margin-top:-4px}

.settings-subblock{border:1px solid color-mix(in srgb,var(--border) 75%, transparent);border-radius:var(--radius);
  padding:11px;background:var(--bg);margin-top:12px}
.settings-subblock:first-of-type{margin-top:4px}
.settings-subtitle{font-family:var(--mono);font-size:10px;font-weight:600;color:var(--text3);
  text-transform:uppercase;letter-spacing:.12em;margin-bottom:9px}
.setting-note{font-size:var(--fs-small);color:var(--text3);margin-top:5px;line-height:1.5}
.settings-note-line{font-size:var(--fs-small);color:var(--text3);margin-top:6px;font-family:var(--mono)}
.settings-2col{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.field-wide{grid-column:1/3}

.vertex-json-tools{border:1px dashed var(--border);border-radius:var(--radius);padding:10px;margin:8px 0 10px;background:var(--bg)}
.vertex-json-tools[hidden]{display:none}
.vertex-json-actions{margin:6px 0 4px}
.vertex-preview-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}

.llm-test-toolbar{margin-top:6px}
.llm-test-status.is-ok{color:#8fd39f}
.llm-test-status.is-failed{color:var(--danger)}
.llm-test-status.is-running{color:var(--accent2)}
.llm-test-status.is-disabled{color:var(--text3)}

.cs{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:8px}
.ci{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:9px 10px;
  font-family:var(--mono);font-size:11px;color:var(--text2)}
.health-toolbar{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}
.health-panel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:8px}
.health-panel{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);overflow:hidden;min-height:86px}
.health-panel h4{margin:0;padding:8px 10px;border-bottom:1px solid var(--border);font-size:11px;color:var(--text2);font-family:var(--mono);font-weight:700}
.health-list{display:flex;flex-direction:column;gap:6px;padding:8px;max-height:230px;overflow-y:auto}
.health-item{border:1px solid color-mix(in srgb,var(--border) 72%, transparent);border-radius:var(--radius);background:var(--bg);padding:8px;display:grid;gap:6px}
.health-item-head{display:flex;justify-content:space-between;align-items:center;gap:7px;font-family:var(--mono);font-size:10px;color:var(--text2)}
.health-item-title{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.health-item-body{font-size:11px;color:var(--text2);line-height:1.45;overflow-wrap:anywhere}
.health-actions{display:flex;gap:5px;flex-wrap:wrap}
.health-actions .btn{padding:4px 7px;min-height:24px;font-size:10px}
.health-sev-error,.health-sev-critical{border-color:color-mix(in srgb,var(--danger) 45%, var(--border))}
.health-sev-warn{border-color:color-mix(in srgb,var(--accent2) 45%, var(--border))}
@media(max-width:900px){.health-panel-grid{grid-template-columns:1fr}}

.settings-actions{padding-top:14px;border-top:1px solid var(--border);margin-top:6px}

.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(8px);
  background:var(--bg4);border:1px solid var(--accent);color:var(--text);padding:9px 16px;
  border-radius:8px;font-size:var(--fs-label);opacity:0;pointer-events:none;transition:all .2s;z-index:50}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:5px;border:2px solid var(--bg)}
::-webkit-scrollbar-thumb:hover{background:var(--text3)}

.note-banner{grid-column:1/3;background:var(--accent-ink);color:var(--accent2);font-family:var(--mono);
  font-size:10.5px;padding:6px 16px;border-bottom:1px solid var(--border);display:none}

/* Plugin-host compatibility and dynamic row states. */
.card.mem{--stub:var(--accent)}
.card.ent{--stub:var(--teal)}
.card.rel,.card.nar{--stub:var(--violet)}
.card{border-left:3px solid var(--stub,var(--accent))}
.card.mem .mt-val{display:block;width:100%;min-height:118px;margin-top:8px;font-family:var(--mono);font-size:12px;line-height:1.55;resize:vertical}
.card.mem .mi-val{width:70px}
.memory-importance-row{display:flex;gap:8px;align-items:center;margin-top:8px}
.rel-score-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.rel-score-head label{margin:0}
.rel-score-tools{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.rel-define{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0 8px;padding:6px 8px;border:1px solid color-mix(in srgb,var(--border) 65%, transparent);border-radius:var(--radius);background:color-mix(in srgb,var(--bg) 60%, transparent)}
.rel-define-main{font-size:var(--fs-label);font-weight:700;color:var(--text)}
.rel-define-note{font-size:var(--fs-small);color:var(--text2);line-height:var(--lh-ui)}
.rw input[type=range][data-unset="1"]{opacity:.45;accent-color:var(--border)}
.ec{resize:vertical}
.hdr .sub{font-size:var(--fs-small);color:var(--text3);margin-top:1px}
@media(max-width:780px){
  .lmai-overlay{padding:0;align-items:stretch;justify-content:stretch}
  .lmai-overlay [data-libra-gui-backdrop="true"]{align-items:stretch;justify-content:stretch}
  .gui-wrap{width:100%;max-width:100%;height:100dvh;max-height:100dvh;border-radius:0;grid-template-columns:1fr;grid-template-rows:auto auto minmax(0,1fr)}
  .hdr{grid-column:1;grid-row:1;padding:10px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px}
  .hdr h1{font-size:15px}
  .hdr .sub{grid-column:1}
  .xbtn{grid-column:2;grid-row:1 / 3}
  .tabs{grid-column:1;grid-row:2;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-right:0;border-bottom:1px solid var(--border);padding:6px;background:var(--bg2);overflow-x:auto}
  .tb{padding:7px 3px;font-size:10px;border-radius:var(--radius);min-width:48px}
  .tb.on::before{left:8px;right:8px;top:auto;bottom:0;width:auto;height:2px;border-radius:2px}
  .content{grid-column:1;grid-row:3}
  .panel{padding:12px 10px 84px}
  .ef,.entity-grid,.settings-2col,.vertex-preview-grid{grid-template-columns:1fr}
  .entity-wide,.field-wide{grid-column:1}
  .toolbar{display:grid;grid-template-columns:1fr 1fr;align-items:stretch}
  .toolbar .si,.toolbar .stat{grid-column:1 / -1}
  .toolbar .btn,.toolbar select,.toolbar input{width:100%}
  .card-hdr{flex-direction:column;align-items:stretch}
  .acts{width:100%;justify-content:flex-end}
  .home-grid{grid-template-columns:1fr}
  .home-hero,.home-sync,.settings-overview{flex-direction:column;align-items:stretch}
  .home-actions{justify-content:stretch}.home-actions .btn{flex:1}
}
@media(max-width:480px){
  .tabs{grid-template-columns:repeat(4,minmax(48px,1fr))}
  .toolbar{grid-template-columns:1fr}
  .toolbar .si,.toolbar .stat{grid-column:auto}
  .acts{justify-content:stretch}
  .acts .btn{flex:1 1 100%}
}

/* ============================================================

/* ============================================================
   Production port of ux-prototype/libra-gui-ux-prototype.html
   셸은 원본 레이어(A)의 것을 그대로 쓴다 — 좌측 아이콘 레일 + 하단 3px 액센트.
   종전에는 라이트/블루 레이어가 이 셸을 상단 탭으로 덮고 있었고,
   그 레이어를 걷어내면서 A 가 갖고 있던 원래 셸이 되살아났다.
   ============================================================ */

/* ============================================================
   원본 레이어(A) 위에 얹는 기능 스타일.
   종전에는 라이트/블루 레이어(B)가 A 를 116개 선택자에서 덮고 있었고,
   그 결과 A 가 갖고 있던 원래 셸(76px 아이콘 레일 사이드바)이 죽어 있었다.
   B 는 A 가 전혀 스타일하지 않는 기능 128개만 A 의 토큰 언어로 옮겨 살리고,
   중복 116개는 버린다 — 그래야 셸이 하나가 된다.
   ============================================================ */

/* --- 셸 부속 (A 의 .hdr/.tabs/.tb/.content 를 그대로 살리고 빈 곳만 채운다) --- */
.ent-name-link{appearance:none;background:none;border:0;padding:0;cursor:pointer;
  font-family:var(--serif);font-size:var(--fs-title);font-weight:600;color:var(--text);
  border-bottom:1px dotted transparent}
.ent-name-link:hover{color:var(--accent2);border-bottom-color:color-mix(in srgb,var(--accent) 45%,transparent)}
/* 엔티티 차단 리스트 — 자주 쓰지 않으므로 기본 접힘. */
.entity-block-panel{margin-top:16px;border-top:1px solid var(--border);padding-top:10px}
.entity-block-panel>summary{cursor:pointer;color:var(--text3);font-size:var(--fs-label);
  list-style:none;padding:6px 2px;display:flex;align-items:center;gap:8px;font-family:var(--sans)}
.entity-block-panel>summary::-webkit-details-marker{display:none}
.entity-block-panel>summary::before{content:'▸';color:var(--accent)}
.entity-block-panel[open]>summary::before{content:'▾'}
.entity-block-panel>summary:hover{color:var(--text2)}
/* details 가 닫혀 있으면 본문은 렌더되지 않아야 한다 (display:flex 가 이를 덮으면 안 된다). */
.entity-block-body{display:flex;flex-direction:column;gap:8px;padding:6px 0 4px}
.entity-block-panel:not([open])>.entity-block-body{display:none}
.world-legacy:not([open])>*:not(summary){display:none}
/* 세계관 — 목업은 노드 목록을 앞세우고 원본 편집 필드는 접어 둔다. */
.world-legacy{margin-top:18px;border-top:1px solid var(--border);padding-top:12px}
.world-legacy>summary{cursor:pointer;color:var(--text3);font-size:var(--fs-label);
  list-style:none;padding:6px 2px;font-family:var(--sans)}
.world-legacy>summary::-webkit-details-marker{display:none}
.world-legacy>summary::before{content:'▸ ';color:var(--accent)}
.world-legacy[open]>summary::before{content:'▾ '}
.world-legacy>summary:hover{color:var(--text2)}
.wld-node-card .card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
/* ═══ 상세 페이지 히어로 — 목업의 프로필/상세 머리 영역 ═══ */
.crumbs-link{color:var(--text2);text-decoration:none;border-bottom:1px dotted var(--text3);cursor:pointer}
.crumbs-link:hover{color:var(--accent2);border-bottom-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.hero{display:flex;gap:18px;align-items:center;padding:20px 22px;border:1px solid var(--border);
  border-radius:var(--radius-lg);margin-bottom:16px;
  background:radial-gradient(420px 180px at 0% 0%,color-mix(in srgb,var(--accent) 11%,transparent),transparent 70%),
    linear-gradient(180deg,color-mix(in srgb,var(--bg2) 96%,var(--accent)),var(--bg2))}
.hero-av{width:52px;height:52px;flex:none;border-radius:14px;display:grid;place-items:center;
  font-family:var(--serif);font-size:24px;font-weight:600;color:#231a08;
  background:linear-gradient(180deg,var(--accent2),var(--accent))}
.hero-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.hero-name{font-family:var(--serif);font-size:22px;font-weight:600;color:var(--text);line-height:1.2}
.hero-role{font-size:var(--fs-label);color:var(--text2);line-height:1.5}
.hero-tags{display:flex;gap:5px;flex-wrap:wrap}
.hero-side{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}
.hero-stat{display:flex;align-items:baseline;gap:6px;font-size:var(--fs-small);color:var(--text3)}
.hero-stat b{font-family:var(--mono);font-size:var(--fs-label);color:var(--text);font-weight:600}
.kv-grid{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px 14px;
  font-size:var(--fs-label);line-height:1.6;margin-top:10px}
.kv-grid .kv-k{color:var(--text3)}
.kv-grid .kv-v{color:var(--text);font-weight:500;white-space:pre-wrap;word-break:break-word}
/* ═══ KPI 계기판 · 인덱스 탐색기 — 목업의 인물/관계 머리 영역 ═══ */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:16px}
.card.kpi{padding:14px 15px;display:flex;flex-direction:column;gap:5px}
.card.kpi.hl{border-color:color-mix(in srgb,var(--accent) 42%,transparent);
  background:radial-gradient(320px 140px at 0% 0%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 70%),var(--bg2)}
.kpi-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.kpi-name{font-family:var(--sans);font-size:var(--fs-label);color:var(--text2);font-weight:500}
.kpi-num{font-family:var(--serif);font-size:26px;font-weight:600;color:var(--text);line-height:1.1}
.kpi-num small{font-family:var(--sans);font-size:var(--fs-label);font-weight:400;color:var(--text3);margin-left:3px}
.kpi-note{font-size:var(--fs-small);color:var(--text3);line-height:1.5}
.badge{display:inline-flex;align-items:center;font-family:var(--mono);font-size:var(--fs-small);font-weight:600;
  padding:2px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text2);background:var(--bg3)}
.badge.b-gold{color:var(--accent2);border-color:color-mix(in srgb,var(--accent) 40%,transparent);
  background:color-mix(in srgb,var(--accent) 14%,transparent)}
.badge.b-info{color:#7fb0d8;border-color:color-mix(in srgb,#7fb0d8 38%,transparent);background:color-mix(in srgb,#7fb0d8 12%,transparent)}
.badge.b-warn{color:#d99a4e;border-color:color-mix(in srgb,#d99a4e 38%,transparent);background:color-mix(in srgb,#d99a4e 12%,transparent)}
.explorer{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);
  margin-bottom:14px;overflow:hidden}
.ex-top{display:flex;align-items:center;gap:10px;padding:10px 12px;flex-wrap:wrap;
  border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg3) 45%,transparent)}
.ex-search{flex:1;min-width:170px;display:flex;align-items:center;gap:8px;padding:6px 10px;
  background:var(--bg);border:1px solid var(--border);border-radius:var(--radius)}
.ex-search input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--text);
  font-family:var(--sans);font-size:var(--fs-label)}
.ex-count{font-family:var(--mono);font-size:var(--fs-small);color:var(--text3);white-space:nowrap}
.dens{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}
.dens button{appearance:none;border:0;background:transparent;color:var(--text2);cursor:pointer;
  font-family:var(--sans);font-size:var(--fs-small);font-weight:600;padding:5px 10px;border-radius:5px}
.dens button.on{background:var(--bg4);color:var(--accent2)}
.ex-idx{display:flex;flex-wrap:wrap;gap:3px;padding:8px 12px;border-bottom:1px solid var(--border)}
.ex-idx button{appearance:none;border:1px solid transparent;background:transparent;color:var(--text2);
  cursor:pointer;font-family:var(--sans);font-size:var(--fs-small);font-weight:600;
  min-width:24px;padding:3px 6px;border-radius:5px}
.ex-idx button:hover{background:var(--bg3);color:var(--text)}
.ex-idx button.on{background:color-mix(in srgb,var(--accent) 16%,transparent);border-color:color-mix(in srgb,var(--accent) 40%,transparent);color:var(--accent2)}
.ex-idx button:disabled{opacity:.32;cursor:default}
.ex-idx .n{font-family:var(--mono);font-size:9.5px;opacity:.7;margin-left:2px}
.ex-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:9px 12px;
  background:color-mix(in srgb,var(--bg3) 26%,transparent)}
.ex-chips button{border:1px solid var(--border);background:var(--bg);color:var(--text2);border-radius:999px;
  padding:4px 10px;font-family:var(--sans);font-size:var(--fs-small);cursor:pointer;display:inline-flex;gap:5px;align-items:center}
.ex-chips button:hover{border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent2)}
.ex-chips button.on{background:color-mix(in srgb,var(--accent) 16%,transparent);
  border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent2);font-weight:600}
.ent-pane{margin-top:4px}
.rel-head{margin-top:18px}
.inp-inline{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:5px;
  padding:5px 8px;color:var(--text);font-family:var(--sans);font-size:var(--fs-label)}
.rel-score-cell{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.rel-score-cell .fl{font-family:var(--mono);font-size:9.5px;color:var(--text3);width:24px;flex:none}
.tbl .rel-row td{vertical-align:top}
.tbl .rel-detail-row td{padding:0 14px 8px;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent)}
.tbl .rel-detail-row textarea{width:100%;margin-top:5px;font-family:var(--sans);font-size:var(--fs-label)}
.list.density-list .card{border:0;border-bottom:1px solid var(--border);border-radius:0;background:transparent;padding:9px 2px}
.list.density-cards .card{border:1px solid var(--border)}
/* ═══ 내러티브 · 세계관 · 세계선 — 인물 카드와 같은 언어로 통일 ═══ */
/* 카드 안 편집 필드는 접어 둔다 — 읽기 요약이 먼저 보이고 편집은 필요할 때. */
.card-detail{margin-top:4px;border-top:1px solid color-mix(in srgb, var(--border) 55%, transparent);padding-top:8px}
.card-detail>summary{cursor:pointer;color:var(--text3);font-family:var(--sans);font-size:var(--fs-small);
  list-style:none;padding:4px 0;display:flex;align-items:center;gap:6px}
.card-detail>summary::-webkit-details-marker{display:none}
.card-detail>summary::before{content:'▸';color:var(--accent)}
.card-detail[open]>summary::before{content:'▾'}
.card-detail>summary:hover{color:var(--text2)}
.card-detail:not([open])>*:not(summary){display:none}
.card-detail>.fld:first-of-type{margin-top:8px}

/* 세계관 노드 카드 — 인물 카드와 같은 골격 */
.wld-node-card .card-meta{gap:6px}
.wld-node-card .chip{font-size:10.5px;padding:2px 9px}

/* 인물 카드 편집 밴드 — 기본 닫힘. details 의 내용을 확실히 감춘다.
   (.entity-band{display:flex} 가 UA [hidden] 을 덮는 함정이 있었다.) */
details.entity-edit>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px}
details.entity-edit>summary::-webkit-details-marker{display:none}
details.entity-edit>summary .entity-band-title{margin:0}
details.entity-edit:not([open])>.entity-grid{display:none}
details.entity-edit>summary::before{content:'▸';color:var(--text3);font-size:11px;transition:transform .15s}
details.entity-edit[open]>summary::before{content:'▾'}
/* 세계선 노드 상세 — 턴/상태 위에 시각·시도 정보를 한 줄로. */
.wl-node-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wl-node-meta{margin-top:5px;font-family:var(--mono);font-size:var(--fs-small);color:var(--text3);letter-spacing:.02em}
.wl-node.on .wl-node-meta{color:var(--text2)}
/* 세계선 — 노드를 목업 타임라인처럼 정돈한다(로직은 계약 파일 그대로, 표현만). */
.wl-view{gap:12px}
.wl-head{align-items:center;padding-bottom:2px}
.wl-stat{font-family:var(--sans);font-size:var(--fs-label);font-weight:600;color:var(--text)}
.wl-rev{font-family:var(--mono);font-size:var(--fs-small);color:var(--text3);opacity:1}
.wl-section{font-family:var(--mono);font-size:var(--fs-small);font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;color:var(--text3);margin:14px 0 8px}
.wl-chain,.wl-history{gap:7px}
.wl-node{background:linear-gradient(180deg, color-mix(in srgb, var(--bg2) 94%, var(--accent)), var(--bg2));
  border:0;border-radius:var(--radius-lg);padding:11px 14px;
  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 4%,transparent), 0 1px 2px rgba(0,0,0,.2);
  transition:transform .12s, box-shadow .16s}
.wl-node:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 6%,transparent), 0 5px 16px rgba(0,0,0,.32)}
.wl-node.on{border:0;box-shadow:inset 3px 0 0 var(--accent), inset 0 1px 0 color-mix(in srgb,#fff 4%,transparent), 0 1px 2px rgba(0,0,0,.2)}
.wl-node.off{opacity:.72;border:0;background:var(--bg2);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--border) 80%, transparent)}
.wl-turn{font-family:var(--sans);font-size:var(--fs-title);font-weight:600;color:var(--text);letter-spacing:.1px}
.wl-node.off .wl-turn{color:var(--text2)}
.wl-status{font-family:var(--sans);font-size:var(--fs-small);color:var(--text3)}
/* ═══ 목업의 표·빵부스러기·게이지·칩 언어를 원본 토큰으로 이식 ═══
   제품은 카드 목록이었고 목업은 표였다. 목업이 훑어보기(밀도·비교)에 유리하다. */
.crumb{font-family:var(--mono);font-size:var(--fs-small);color:var(--text3);letter-spacing:.08em;
  text-transform:uppercase;margin-bottom:8px}
.crumb b{color:var(--accent)}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:16px}
.page-head h2{font-family:var(--serif);font-size:22px;font-weight:600;letter-spacing:.2px;line-height:1.15}
.page-head .desc{color:var(--text2);font-size:var(--fs-label);margin-top:5px}
.tbl-wrap{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--bg2)}
.tbl-head{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);
  background:color-mix(in srgb,var(--bg3) 55%,transparent);flex-wrap:wrap}
.tbl{width:100%;border-collapse:collapse;font-size:var(--fs-label)}
.tbl th{text-align:left;font-family:var(--mono);font-size:var(--fs-small);font-weight:600;letter-spacing:.09em;
  text-transform:uppercase;color:var(--text3);padding:10px 14px;border-bottom:1px solid var(--border);
  background:color-mix(in srgb,var(--bg3) 30%,transparent)}
.tbl td{padding:12px 14px;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);vertical-align:top}
.tbl tr:last-child td{border-bottom:0}
.tbl tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
.tbl .strong{color:var(--text);font-weight:500}
.tbl .dim{color:var(--text3);font-size:var(--fs-small);margin-top:3px}
.gauge{display:flex;align-items:center;gap:7px}
.gauge .bars{display:flex;gap:2px}
.gauge .bars i{width:4px;height:14px;border-radius:1px;background:var(--bg4)}
.gauge .bars i.f1{background:color-mix(in srgb,var(--text3) 55%,transparent)}
.gauge .bars i.f2{background:color-mix(in srgb,var(--accent) 55%,transparent)}
.gauge .bars i.f3{background:linear-gradient(180deg,var(--accent2),var(--accent))}
.gauge span{font-family:var(--mono);font-size:var(--fs-small);font-weight:600;color:var(--text2)}
.chip{display:inline-flex;align-items:center;gap:4px;font-family:var(--sans);font-size:var(--fs-small);font-weight:500;
  padding:4px 9px;border-radius:999px;background:var(--bg4);color:var(--text2);border:1px solid var(--border)}
.mem-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:10px 14px;
  border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg3) 26%,transparent)}
.mem-filters .fl{font-family:var(--mono);font-size:var(--fs-small);font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;color:var(--text3);margin-right:2px}
.mem-filters button{border:1px solid var(--border);background:var(--bg);color:var(--text2);border-radius:999px;
  padding:5px 10px;font-family:var(--sans);font-size:var(--fs-label);cursor:pointer;
  display:inline-flex;gap:5px;align-items:center;transition:.13s}
.mem-filters button:hover{border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent2)}
.mem-filters button.on{background:color-mix(in srgb,var(--accent) 16%,transparent);
  border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent2);font-weight:600}
.grp-h{display:flex;align-items:center;gap:10px;padding:11px 14px;
  background:color-mix(in srgb,var(--bg3) 52%,transparent);
  border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.grp-h:first-child{border-top:0}
.grp-h .gt{font-family:var(--sans);font-size:var(--fs-title);font-weight:600;color:var(--text)}
.grp-h .gc{font-family:var(--mono);font-size:var(--fs-small);font-weight:600;color:var(--text3)}
.hide{display:none!important}
/* ══════════════════════════════════════════════════════════════
   카드 재설계 — 종전 카드는 좌측 3px 색 띠 + 회색 배지 박스 +
   헤더 가운데에 떠 있는 상태 배지라 투박했다. 띠를 없애고
   이름을 세리프로 키우고 배지를 이름 옆에 붙이고 알약 버튼으로 정리한다.
   ══════════════════════════════════════════════════════════════ */
.card{
  border:0;
  border-left:0;
  border-radius:var(--radius-lg);
  background:linear-gradient(180deg, color-mix(in srgb, var(--bg2) 94%, var(--accent)), var(--bg2));
  box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 4%, transparent), 0 1px 2px rgba(0,0,0,.22);
  padding:14px 16px;
  transition:box-shadow .16s, transform .12s, background .16s;
}
.card:hover{
  box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent), 0 6px 18px rgba(0,0,0,.34);
  transform:translateY(-1px);
}
.card-hdr{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;
  justify-content:flex-start}
.card-hdr>strong{display:flex;align-items:center;gap:8px;min-width:0;
  font-family:var(--serif);font-size:15.5px;font-weight:600;color:var(--text);letter-spacing:.15px}
.card-hdr>.card-meta{margin:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.card-hdr>.acts{margin-left:auto}

/* 배지 — 채운 회색 박스 대신 얇은 알약. 이름 옆에 조용히 붙는다. */
.bdg{border:1px solid color-mix(in srgb, var(--border) 90%, transparent);background:transparent;
  color:var(--text3);border-radius:999px;padding:2px 9px;font-family:var(--sans);
  font-size:10.5px;font-weight:600;letter-spacing:0;line-height:1.5}
.bdg.bt{color:var(--text2)}
.bdg.bh{color:#d99a4e;border-color:color-mix(in srgb,#d99a4e 32%,transparent)}
.bdg.bm{color:#7fb0d8;border-color:color-mix(in srgb,#7fb0d8 32%,transparent)}

/* 카드 액션 — 알약 버튼. 카드 안에서 무게를 줄인다. */
.card .acts .btn{min-height:28px;padding:4px 13px;border-radius:999px;
  font-family:var(--sans);font-size:var(--fs-small);font-weight:650;line-height:1.35}
.card .card-hdr .acts{gap:5px}

/* 읽기 요약 — 테두리 박스를 걷어내고 조용한 한 줄로. */
.entity-summary{display:flex;align-items:center;gap:0;flex-wrap:wrap;
  margin:0 0 10px;padding:0;border:0;background:none}
.entity-summary-bit{font-size:var(--fs-label);color:var(--text2);font-family:var(--sans)}
.entity-summary-bit+.entity-summary-bit{margin-left:9px;padding-left:9px;
  border-left:1px solid color-mix(in srgb, var(--border) 80%, transparent)}
.entity-summary .bdg{margin-left:7px}

/* 목록 간격 — 카드 사이 숨 쉴 공간. */
.list{gap:10px}
.card.rel{background:linear-gradient(180deg, color-mix(in srgb, var(--bg2) 96%, var(--accent2)), var(--bg2))}
/* 프로필 상세 — 관계 행과 읽기 기록을 조용하게. */
#prof-relations .card.rel{padding:12px 14px}
#prof-relations .card-hdr{margin-bottom:6px}
#prof-relations .rel-dir{font-family:var(--sans);font-size:14px;font-weight:600;color:var(--text)}
#prof-relations .rel-dir-arrow{color:var(--accent);margin:0 7px;font-weight:400}
.kv-grid{grid-template-columns:96px minmax(0,1fr);gap:9px 16px;margin-top:12px}
.kv-grid .kv-k{font-family:var(--sans);font-size:var(--fs-label);color:var(--text3);letter-spacing:.02em}
.kv-grid .kv-v{color:var(--text);font-weight:450;font-size:var(--fs-label)}
.kv-grid .kv-k:not(:first-child),.kv-grid .kv-v:not(:nth-child(2)){
  border-top:1px solid color-mix(in srgb, var(--border) 45%, transparent);padding-top:9px}
#prof-read .kv-k:first-child,#prof-read .kv-v:nth-child(2){border-top:0;padding-top:0}
/* 헤더 실시간 대시보드 — 목업의 .global-status (상태 점이 상태별로 색·맥동을 바꾼다).
   상태 값은 ActivityDashboardCore 가 data-libra-activity-state 로 싣는다. */
.global-status.gs-pill, .hdr-actions>.global-status{gap:11px;padding:6px 13px 6px 10px;border-radius:999px;
  background:var(--bg3);border:1px solid var(--border);font-size:var(--fs-label)}
.global-status-dot.busy{background:#5b8fc9}
.global-status-dot{position:relative}
.global-status[data-libra-activity-state="running"] .global-status-dot{background:#5b8fc9;animation:libra-ring 2s ease-out infinite}
.global-status[data-libra-activity-state="running"] .global-status-dot::after{
  content:'';position:absolute;inset:-3px;border-radius:50%;
  border:1px solid #5b8fc9;animation:libra-ring-halo 2s ease-out infinite}
@keyframes libra-ring{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes libra-ring-halo{0%{transform:scale(.7);opacity:.9}100%{transform:scale(1.9);opacity:0}}
@media(prefers-reduced-motion:reduce){
  .global-status[data-libra-activity-state="running"] .global-status-dot,
  .global-status[data-libra-activity-state="running"] .global-status-dot::after{animation:none}
}
.hdr-spacer{flex:1}
/* 헤더 카운터 — 기억/인물 수와 현재 모델을 상태 표시 옆에 붙인다. */
.global-status .sep{width:1px;height:12px;background:var(--border);flex:none}
.global-status .k{color:var(--text3);font-size:var(--fs-small)}
.global-status b{font-family:var(--mono);font-size:var(--fs-small);color:var(--text);font-weight:600}
.global-status .badge{font-family:var(--mono);font-size:var(--fs-small);font-weight:600;
  color:var(--accent2);background:color-mix(in srgb,var(--accent) 16%,transparent);
  border:1px solid color-mix(in srgb,var(--accent) 38%,transparent);
  border-radius:999px;padding:2px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 사이드바 하단 데이터 카드 — 목업의 .side-card */
.side-card{margin-top:auto;padding:11px;border:1px solid var(--border);border-radius:var(--radius);
  background:var(--bg2);display:flex;flex-direction:column;gap:7px}
.side-card .row{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:var(--fs-small);color:var(--text3)}
.side-card .row b{font-family:var(--mono);font-size:var(--fs-small);color:var(--text);font-weight:600}
.side-card .bar{height:3px;border-radius:999px;background:var(--bg4);overflow:hidden}
.side-card .bar i{display:block;height:100%;background:var(--accent);border-radius:999px;transition:width .3s}
/* 사이드바 — 목업의 .side/.nav/.cnt 를 원본 토큰으로 쓴다.
   그룹 라벨 + 항목(아이콘 · 라벨 · 카운트) + 좌측 골드 액센트. */
.gui-wrap{grid-template-columns:208px minmax(0,1fr)}
.tabs{padding:14px 11px;gap:1px}
.side-sec{margin-bottom:15px}
.side-sec:last-of-type{margin-bottom:6px}
.side-label{font-family:var(--mono);font-size:var(--fs-small);font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--text3);padding:0 11px 8px}
.side-link{appearance:none;background:transparent;border:0;border-left:2px solid transparent;cursor:pointer;
  display:flex;align-items:center;gap:10px;padding:8px 11px;border-radius:var(--radius);
  color:var(--text2);font-family:var(--sans);font-size:var(--fs-label);line-height:1.3;
  text-align:left;width:100%;transition:background .13s,color .13s}
.side-link .ic{width:17px;flex:none;font-size:14px;opacity:.85;text-align:center}
.side-link:hover{background:var(--bg3);color:var(--text)}
.side-link.on{background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 18%,transparent),transparent 94%);
  border-left-color:var(--accent);color:var(--accent2);font-weight:600}
.side-link.in-root:not(.on){color:var(--text)}
.side-link .cnt{margin-left:auto;font-family:var(--mono);font-size:var(--fs-small);font-weight:600;
  color:var(--text3);background:var(--bg4);padding:3px 7px;border-radius:999px;min-width:21px;text-align:center}
.side-link.on .cnt{background:color-mix(in srgb,var(--accent) 26%,var(--bg4));color:var(--accent2)}
@media(max-width:780px){
  .gui-wrap{grid-template-columns:1fr}
  /* ★ flex-direction / flex-wrap 을 여기서 선언하지 않는다 — 780px 에서 이기는 display 는
     345블록의 grid(도구 실측: inertFlexDeclarations)라 flex 속성이 **무력**하고,
     읽는 사람에게 "여기는 flex row" 라는 거짓 인상만 준다. 남는 선언은 grid 에서도 유효하다
     (align-items / gap 은 Box Alignment 라 grid 에서 그대로 쓰인다).
     ※ 480px 의 .tabs 도 grid 기준이다 (grid-template-columns 만 좁힌다).
     ※ 주의: 주석 안에 CSS 중괄호를 쓰지 않는다 — 이 파일의 CSS 파서는 주석을 걷어내지 않고
        중괄호 균형으로 블록을 찾으므로, 주석의 닫는 중괄호 하나가 이후 규칙을 통째로 삼킨다. */
  .tabs{align-items:center;gap:6px;border-right:0;
    border-bottom:1px solid var(--border);padding:8px 10px}
  /* ★ flex-wrap 이 없으면 그룹 항목이 한 줄에 갇힌다 — 도구 실측(inertFlex).
     780px 에서 그룹이 4개 세로로 쌓이므로, 각 그룹 안 항목은 감겨야 한다. */
  .side-sec{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .side-label{display:none}
  .side-link{width:auto}
  .side-card{display:none}
}
}
.hdr-brand{display:flex;align-items:center;gap:10px;min-width:0}
.hdr-actions{display:flex;align-items:center;gap:12px}
.lmai-overlay [hidden]{display:none!important}
.global-status{display:flex;align-items:center;gap:7px;color:var(--text);font-size:var(--fs-label);white-space:nowrap}
.global-status-dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
#libra-global-status{min-width:0;overflow:hidden;text-overflow:ellipsis}

/* --- 홈: 최근 변화 --- */
.home-sync .home-actions{align-items:center}
.home-recent{margin-top:4px}
.home-recent-head{display:grid;gap:4px;margin-bottom:4px}
.home-recent-head h3{font-family:var(--serif);font-size:17px;font-weight:600}
.home-recent-list{display:grid;gap:0}
.home-recent-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--border)}
.home-recent-row:last-child{border-bottom:0}
.home-recent-copy{display:grid;gap:4px;min-width:0}
.home-recent-copy strong{font-weight:500}

/* --- 추가 요소: 패널 전환 --- */
.additional-primary-pane{display:none}
.additional-primary-pane.on{display:block}
.additional-composer{display:grid;gap:4px;padding:16px;margin-bottom:16px}
.additional-composer .udlc-quick-actions{margin:2px 0 4px}

/* --- 세계선 뷰: 턴 노드 체인과 이력 --- */
.wl-view{display:grid;gap:8px;font-size:var(--fs-body)}
.wl-head{display:flex;gap:12px;align-items:baseline;color:var(--text2);font-size:var(--fs-label)}
.wl-stat{font-weight:600;color:var(--text)}
.wl-rev{opacity:.75}
.wl-lineage{border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;display:grid;gap:3px;background:var(--bg2)}
.wl-lineage-title{font-weight:600;font-size:var(--fs-label)}
.wl-lineage-body{font-size:var(--fs-label);color:var(--text)}
.wl-lineage-note{font-size:var(--fs-small);color:var(--text3)}
.wl-section{margin-top:4px;font-weight:600;font-size:var(--fs-label);color:var(--text2)}
.wl-chain,.wl-history{display:grid;gap:5px}
.wl-node{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--border);border-radius:var(--radius);padding:6px 10px;background:var(--bg2)}
.wl-node.on{border-color:color-mix(in srgb,var(--accent) 55%,transparent)}
.wl-node.off{opacity:.6;border-style:dashed}
.wl-turn{font-family:var(--mono);font-size:var(--fs-label);font-weight:600}
.wl-status{font-size:var(--fs-small);color:var(--text3)}
.wl-empty{padding:14px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--text3);font-size:var(--fs-label);text-align:center}

/* --- 설정: 아코디언과 컴포저 산출물 --- */
.sec{font-family:var(--sans);font-size:16px;font-weight:500;color:var(--text);text-transform:none;letter-spacing:0;margin:20px 0 8px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.list{gap:8px}
.acc{margin:0;border:0;border-top:1px solid var(--border);border-radius:0;background:var(--bg);overflow:visible}
.acc:last-of-type{border-bottom:1px solid var(--border)}
#tab-settings .acc-b{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}
#tab-settings .acc.open .acc-b{display:grid}
#tab-settings .acc-b>.tr,#tab-settings .acc-b>.settings-subblock,#tab-settings .acc-b>.toolbar,#tab-settings .acc-b>.settings-note-line,#tab-settings .acc-b>.field-wide,#tab-settings .acc-b>.sbar,#tab-settings .acc-b>.sec,#tab-settings .acc-b>.cs,#tab-settings .acc-b>.health-panel-grid,#tab-settings .acc-b>.settings-overview{grid-column:1/-1}
.prototype-settings-heading{display:grid;gap:4px;margin-bottom:16px}
.prototype-settings-heading h2{font-size:18px;font-weight:500}
.prototype-settings-heading h3{font-family:var(--serif);font-size:17px;font-weight:600}
.prototype-settings-heading p{font-size:var(--fs-label);color:var(--text3)}
.prototype-settings-summary{display:grid;align-items:stretch;gap:0;padding:14px;margin-bottom:20px}
.prototype-settings-summary>.home-actions{justify-content:flex-start}
.prototype-profile-summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin:12px 0 6px}
.prototype-work-mode{margin-top:20px}
/* ★ display 는 아래쪽 .prototype-work-mode-head 규칙이 정한다 —
   여기서 다시 선언하면 죽은 코드가 되고 읽는 사람을 오도한다(도구 실측: layout mode conflict). */
.prototype-work-mode-head h3{font-family:var(--serif);font-size:17px;font-weight:600}
.prototype-work-mode-head span{font-size:var(--fs-label);color:var(--text3)}
.prototype-work-mode>.settings-subblock{padding:0;border:0;border-radius:0;background:var(--bg);margin:4px 0 14px}
.prototype-work-mode>.settings-subblock>.settings-subtitle{display:none}
.prototype-work-mode>.settings-subblock>.fld,.prototype-work-mode>.settings-subblock>.tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,360px);align-items:center;gap:16px;margin:0;padding:12px 0;border-bottom:1px solid var(--border)}
.prototype-work-mode>.settings-subblock>.fld>label{margin:0}
.prototype-work-mode>.settings-subblock>.fld>select,.prototype-work-mode>.settings-subblock>.fld>input{width:100%}
.prototype-work-mode>.settings-subblock>.tr>.tog{justify-self:end}

/* --- 한국어 가독성: 운영 라벨을 좁은 mono 처리에서 빼낸다 --- */
.lmai-overlay{font-family:var(--sans);font-weight:400;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.card .card-meta .bdg{font-family:var(--sans);font-size:var(--fs-label);font-weight:650;line-height:1.4}
.card .acts .btn{min-height:32px;padding:5px 11px;font-family:var(--sans);font-size:var(--fs-label);font-weight:650;line-height:1.35}
.card .acts .wa-inject-toggle{min-width:58px;padding-left:24px!important;font-size:var(--fs-label)!important;font-weight:750;color:var(--text2)}
.card .acts .wa-inject-toggle::before{left:10px;width:8px;height:8px}
.card .acts .wa-inject-toggle.is-on{color:var(--success);border-color:color-mix(in srgb,var(--success) 65%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--success) 12%,transparent)}
.udlc-target-item small,.udlc-target-item .hint{font-family:var(--sans);font-size:12.5px;color:var(--text2)}
.udlc-target-title{font-family:var(--sans);font-size:var(--fs-label);font-weight:750;line-height:1.45;color:var(--accent2);letter-spacing:0}
.udlc-kv b{font-family:var(--sans);font-size:var(--fs-label);font-weight:750;line-height:1.6;color:var(--accent2);letter-spacing:0}
.entity-band .fld label,.card.rel .fld label,.rel-score-head label{font-family:var(--sans);font-size:var(--fs-title);font-weight:650;line-height:1.45;color:var(--text)}
.entity-band input,.entity-band textarea,.card.rel input,.card.rel textarea{font-family:var(--sans);font-size:13.5px;font-weight:450;line-height:1.55;color:var(--text)}

/* --- 인물 패널 서브탭 — view-tab 을 그대로 쓰되 한 단계 낮은 위계로 보인다 --- */
.entity-subtabs{margin:-6px 0 12px;padding-bottom:0;border-bottom:0;gap:6px}
.entity-subtabs .view-tab{background:transparent;border-color:transparent;color:var(--text3);font-size:var(--fs-small);min-height:26px;padding:2px 8px}
.entity-subtabs .view-tab:hover{background:var(--bg3);border-color:var(--border);color:var(--text)}
.entity-subtabs .view-tab.on{background:color-mix(in srgb,var(--accent) 12%,transparent);border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent2);font-weight:500}
.entity-pane-note{margin-bottom:10px}
.entity-pane-tail{margin-top:10px}

/* --- 인물 읽기 요약 — 12개 편집 필드를 훑지 않고 한눈에 (편집 필드는 그대로 아래에 유지) --- */
.entity-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 12px;padding:8px 10px;
  border:1px solid var(--border);border-radius:var(--radius);background:color-mix(in srgb,var(--accent) 5%,var(--bg2))}
.entity-summary-bit{font-size:var(--fs-small);color:var(--text2);font-family:var(--sans)}
.entity-summary-bit+.entity-summary-bit{padding-left:8px;border-left:1px solid var(--border)}

/* --- 관계 방향 — 수치는 A→B 값이므로 헤더에 방향을 명시한다 --- */
.rel-dir{display:inline-flex;align-items:center;gap:5px;font-family:var(--sans)}
.rel-dir-arrow{color:var(--accent);font-weight:600}

/* --- 연상 그래프 보기 — 캔버스 + 우측 요약 --- */
.mem-graph{display:grid;grid-template-columns:minmax(0,1fr) 248px;gap:12px;min-height:420px;
  border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);padding:10px}
.mem-graph.hide{display:none}
.mem-graph canvas{display:block;width:100%;height:100%;min-height:400px;border-radius:var(--radius);
  background:radial-gradient(circle at 30% 20%,color-mix(in srgb,var(--accent) 5%,transparent),transparent 55%)}
.mem-graph-side{display:flex;flex-direction:column;gap:9px;min-width:0;overflow:auto}
.mg-kpi{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.mg-kpi div{padding:7px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}
.mg-kpi .v{font-family:var(--mono);font-size:14px;color:var(--accent2)}
.mg-kpi .k{font-size:var(--fs-small);color:var(--text3);margin-top:2px}
.mg-paths{display:flex;flex-direction:column;gap:6px}
.mg-path{padding:7px 9px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}
.mg-path .who{font-size:var(--fs-small);color:var(--text);margin-bottom:3px}
.mg-path .who b{color:var(--accent2)}
.mg-path .hop{font-family:var(--mono);font-size:var(--fs-small);color:var(--text3);line-height:1.6}
.mg-empty{padding:12px;color:var(--text3);font-size:var(--fs-small);line-height:1.7}

/* --- 메모리 구분 — 보기 전환 · 그룹 헤더 · 서사근거 토글 --- */
.mem-views{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2)}
.mem-views button{appearance:none;border:0;background:transparent;color:var(--text2);
  font-family:var(--sans);font-size:var(--fs-small);font-weight:600;padding:7px 11px;border-radius:5px;
  cursor:pointer;transition:.13s;white-space:nowrap}
.mem-views button:hover{color:var(--text)}
.mem-views button.on{background:var(--bg4);color:var(--accent2)}
.mem-group{margin-bottom:14px}
.mem-group-h{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:8px;
  border:1px solid var(--border);border-radius:var(--radius);background:var(--bg3)}
.mem-group-t{font-size:var(--fs-label);font-weight:600;color:var(--text);font-family:var(--sans)}
.mem-group-m{margin-left:auto;font-size:var(--fs-small);color:var(--text3);font-family:var(--mono)}
#mem-shown-note{color:var(--text3);font-weight:400}
/* 한 켠에 조용히 — 기본은 없는 것처럼 취급되므로 존재를 알리지 않는다 */
.mem-footnote{display:flex;justify-content:flex-end;padding:6px 2px 0}
.mem-footnote button{background:none;border:0;color:var(--text3);font-size:var(--fs-small);
  font-family:var(--sans);cursor:pointer;padding:4px 2px;text-decoration:none}
.mem-footnote button:hover{color:var(--text2)}
.mem-footnote button.is-on{color:var(--text2)}

/* --- 설정 셸 — 좌측 구역 내비 + 검색 + 본문. 접이식 그룹만으로는 찾기 어려웠던 문제를 푼다. --- */
.settings-shell{display:grid;grid-template-columns:212px minmax(0,1fr);gap:18px;align-items:start}
.settings-nav{position:sticky;top:0;display:flex;flex-direction:column;gap:3px;max-height:calc(100dvh - 150px);overflow:auto}
.settings-nav-search{width:100%;min-height:30px;padding:0 9px;margin-bottom:6px;border:1px solid var(--border);
  border-radius:var(--radius);background:var(--bg2);color:var(--text);font-family:var(--sans);font-size:var(--fs-label)}
.settings-nav-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.settings-nav-count{font-size:var(--fs-small);color:var(--text3);padding:0 4px 4px;font-family:var(--sans)}
.settings-nav-item{display:flex;align-items:flex-start;gap:7px;width:100%;padding:7px 9px;text-align:left;
  border:1px solid transparent;border-radius:var(--radius);background:transparent;color:var(--text2);
  font-family:var(--sans);font-size:var(--fs-label);line-height:1.35;cursor:pointer}
.settings-nav-item:hover{background:var(--bg3);color:var(--text)}
.settings-nav-item.on{background:color-mix(in srgb,var(--accent) 12%,var(--bg2));border-color:color-mix(in srgb,var(--accent) 40%,transparent);color:var(--accent2);font-weight:500}
.settings-nav-item.is-muted,.acc.is-muted{opacity:.35}
.settings-nav-idx{font-family:var(--mono);font-size:var(--fs-small);color:var(--text3);flex:none}
.settings-nav-item.on .settings-nav-idx{color:var(--accent)}
.settings-nav-ttl{flex:1;min-width:0}
.settings-content{display:flex;flex-direction:column;gap:10px;min-width:0}
/* 저장바를 화면 하단에 고정 — 종전에는 top 1937 으로 화면 밖이었다 */
.sbar.settings-actions{position:sticky;bottom:0;z-index:3;margin-top:14px;padding:11px 12px;
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);
  border-top:1px solid var(--border);border-radius:0 0 var(--radius) var(--radius)}
/* 설정 저장바 — 실측으로 원인을 확정한 뒤 배치했다.
   스크롤 주체는 #tab-settings(overflow-y:auto)이고, .settings-content/.settings-shell
   은 흐름대로 늘어나는 static 컨테이너다(scrollHeight == clientHeight).
   그래서 position:static 으로 두면 저장바가 문서 맨 아래(top 2668)로 밀려나
   화면 밖이 되고, position:sticky;bottom:0 을 그대로 두면 자리를 지키지 못해
   바로 위 폼 필드(Model 입력창)와 겹친다 — 두 증상을 모두 실측했다.
   해법: 흐름에서 저장바 **높이만큼의 여백을 확보**해 겹치지 않게 하고,
   스크롤 컨테이너 안에서 bottom:0 으로 화면 아래에 머물게 한다. */
#tab-settings{padding-bottom:0}
#tab-settings .settings-content{padding-bottom:74px}
#tab-settings .settings-content>.sbar.settings-actions{position:sticky;bottom:0;margin-top:14px}
/* 작동 방식 — 기본 접힘. 펼치면 2000px 를 차지해 세부 설정을 화면 밖으로 밀어냈다. */
.prototype-work-mode-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.prototype-work-mode-toggle{margin-left:auto;flex:none;padding:4px 10px;min-height:26px;cursor:pointer;
  border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);color:var(--text2);
  font-family:var(--sans);font-size:var(--fs-small)}
.prototype-work-mode-toggle:hover{border-color:var(--accent);color:var(--accent2)}
.prototype-work-mode-body{display:none}
.prototype-work-mode.open .prototype-work-mode-body{display:block}

@media(max-width:880px){
  .settings-shell{grid-template-columns:1fr}
  .settings-nav{position:static;max-height:none;flex-direction:row;flex-wrap:wrap;align-items:center}
  .settings-nav-item{width:auto}
}
@media(max-width:760px){
  .prototype-work-mode>.settings-subblock>.fld,.prototype-work-mode>.settings-subblock>.tr{grid-template-columns:1fr;gap:8px}
  .prototype-work-mode>.settings-subblock>.tr>.tog{justify-self:start}
}
@media(max-width:520px){
  .hdr-actions .global-status{display:none}
  .home-recent-row{grid-template-columns:1fr}
  .home-recent-row .btn{justify-self:start}
}
`;

    const GUI_BODY = `
<div class="gui-wrap">
<div class="hdr">
  <div class="hdr-brand">
    <div class="brand"><h1>LIBRA World Manager <span class="ver">v6.0.0</span></h1><div class="sub">장기 기억 · 세계관 · 서사를 자동으로 관리합니다</div></div>
  </div>
  <div class="hdr-spacer" aria-hidden="true"></div>
  <div class="hdr-actions"><div class="global-status" id="libra-global-status-wrap" aria-live="polite" data-libra-activity-state=""><span class="global-status-dot" aria-hidden="true"></span><span id="libra-global-status">상태 확인 중</span><span class="sep" aria-hidden="true"></span><span class="k">기억</span><b id="hdr-mem">0</b><span class="sep" aria-hidden="true"></span><span class="k">인물</span><b id="hdr-ent">0</b><span class="badge b-gold" id="hdr-model">—</span></div><button class="xbtn" id="xbtn" title="닫기">✕</button></div>
  </div>
  <div class="tabs" role="tablist" aria-label="LIBRA GUI tabs">
    <div class="side-sec">
      <div class="side-label">개요</div>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="home" data-view-tab="home"><span class="ic">⌂</span><span>홈</span></button>
    </div>
    <div class="side-sec">
      <div class="side-label">데이터</div>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="memory" data-view-tab="memory"><span class="ic">▤</span><span>메모리</span><span class="cnt" id="nav-mc">0</span></button>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="entity" data-view-tab="entity"><span class="ic">◍</span><span>인물</span><span class="cnt" id="nav-ec">0</span></button>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="relations" data-view-tab="relations"><span class="ic">⇄</span><span>관계</span><span class="cnt" id="nav-rc">0</span></button>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="narrative" data-view-tab="narrative"><span class="ic">◈</span><span>내러티브</span><span class="cnt" id="nav-nc">0</span></button>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="world" data-view-tab="world"><span class="ic">⬡</span><span>세계관</span><span class="cnt" id="nav-wc">0</span></button>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="worldline" data-view-tab="worldline"><span class="ic">⁂</span><span>세계선</span><span class="cnt" id="nav-wlc">0</span></button>
    </div>
    <div class="side-sec">
      <div class="side-label">추가 요소</div>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="world-additional" data-view-tab="world-additional"><span class="ic">✚</span><span>새 요소 만들기</span></button>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="wa-auto" data-view-tab="wa-auto"><span class="ic">✦</span><span>월드 에디셔널</span><span class="cnt" id="nav-wac">0</span></button>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="udlc" data-view-tab="udlc"><span class="ic">✍</span><span>유저 DLC</span><span class="cnt" id="nav-udc">0</span></button>
    </div>
    <div class="side-sec">
      <div class="side-label">시스템</div>
      <button class="side-link" type="button" role="tab" aria-selected="false" data-tab="settings" data-view-tab="settings"><span class="ic">⚙</span><span>설정</span></button>
    </div>
    <div class="side-card">
      <div class="row"><span>대화 데이터</span><b id="side-card-turns">—</b></div>
      <div class="bar"><i id="side-card-bar" style="width:0%"></i></div>
      <div class="row"><span>저장소</span><b id="side-card-storage">—</b></div>
      <div class="row"><span>무결성</span><b id="side-card-integrity">—</b></div>
    </div>
  </div>
<div class="content">
  <div id="tab-home" class="panel on">
    <div class="crumb">개요 / <b>현재 상태</b></div>
    <div class="page-head">
      <div><h2>현재 상태</h2><div class="desc">필요한 작업과 활성 기능만 한눈에 확인합니다.</div></div>
      <div class="toolbar"><button class="btn bs" id="btn-home-settings" type="button">연결 설정</button></div>
    </div>
    <div class="home-grid">
      <div class="home-card"><div class="home-card-head"><span>LLM 연결</span><span class="status-pill" id="home-llm-pill">확인 중</span></div><div class="home-card-value" id="home-llm-value">—</div><div class="home-card-note" id="home-llm-note">기본 프로필을 확인하고 있습니다.</div></div>
      <div class="home-card"><div class="home-card-head"><span>대화 데이터</span><span class="status-pill" id="home-data-pill">확인 중</span></div><div class="home-card-value" id="home-data-value">—</div><div class="home-card-note" id="home-data-note">전체 DB 상태를 집계하고 있습니다.</div></div>
      <div class="home-card"><div class="home-card-head"><span>현재 사용 중</span><span class="status-pill" id="home-additional-pill">확인 중</span></div><div class="home-card-value" id="home-additional-value">—</div><div class="home-card-note" id="home-additional-note">현재 투입·추적 상태를 확인하고 있습니다.</div></div>
    </div>
    <div class="home-sync"><div><strong id="home-sync-title">대화 구조를 확인하고 있습니다</strong><span id="home-sync-note">초기 분석·증분 분석·재분석을 LIBRA가 자동으로 판단합니다.</span></div><div class="home-actions"><button class="btn bp" id="btn-home-sync" type="button">대화 데이터 동기화</button></div></div>
    <section class="home-recent"><div class="home-recent-head"><h3>최근 변화</h3><span class="home-card-note">세부 DB를 열지 않아도 중요한 변경만 확인할 수 있습니다.</span></div><div class="home-recent-list" id="home-recent-list"></div></section>
  </div>
  <div id="tab-memory" class="panel">
    <div class="crumb">데이터 / <b>메모리</b></div>
    <div class="page-head"><div><h2>메모리</h2><div class="desc">현재 채팅에 저장된 전체 기억입니다. 검색·추가·삭제가 바로 반영됩니다.</div></div></div>
    <div class="tbl-wrap">
      <div class="tbl-head">
        <div class="si"><span>🔍</span><input type="text" id="ms" placeholder="메모리 검색..."></div>
        <select id="mf">
          <option value="all">전체 중요도</option>
          <option value="h">높음 (7+)</option>
          <option value="m">중간 (4-6)</option>
          <option value="l">낮음 (1-3)</option>
        </select>
        <span class="stat">총 <strong id="mc">0</strong>개 <span id="mem-shown-note"></span></span>
        <div class="mem-views" role="group" aria-label="메모리 보기">
          <button type="button" class="on" data-mem-view="list">리스트</button>
          <button type="button" data-mem-view="turn">턴별</button>
          <button type="button" data-mem-view="kind">종류별</button>
          <button type="button" data-mem-view="graph">그래프</button>
        </div>
        <button class="btn bs" id="btn-toggle-add-mem" type="button">➕ 추가</button>
        <button class="btn bp" id="btn-save-all-mem" type="button">💾 저장</button>
      </div>
      <div class="mem-filters">
        <span class="fl">분류</span>
        <span id="mem-kind-filters">
          <button type="button" class="on" data-mem-kind="all">전체</button>
          <button type="button" data-mem-kind="사건">사건</button>
          <button type="button" data-mem-kind="관계">관계</button>
          <button type="button" data-mem-kind="서사">서사</button>
          <button type="button" data-mem-kind="상태">상태</button>
          <button type="button" data-mem-kind="세계관">세계관</button>
        </span>
        <span class="fl" style="margin-left:10px">수명</span>
        <span id="mem-ttl-filters">
          <button type="button" class="on" data-mem-ttl="all">전체</button>
          <button type="button" data-mem-ttl="perm">영구</button>
          <button type="button" data-mem-ttl="temp">일시</button>
        </span>
        <span class="fl" style="margin-left:10px">턴 범위</span>
        <span id="mem-turn-filters">
          <button type="button" class="on" data-mem-turn="all">전체</button>
          <button type="button" data-mem-turn="recent">최근(T90+)</button>
          <button type="button" data-mem-turn="mid">중간(T60-89)</button>
          <button type="button" data-mem-turn="old">과거(T~59)</button>
        </span>
      </div>
      <div id="amf" class="add-form">
        <div class="fld field-wide"><label>내용</label><textarea id="am-c" class="ec" rows="3" placeholder="새 메모리 내용을 입력하세요"></textarea></div>
        <div class="ef">
          <div class="fld"><label>중요도 (1-10)</label><input type="number" id="am-i" min="1" max="10" value="5"></div>
          <div class="fld"><label>카테고리</label><input type="text" id="am-cat" placeholder="일반"></div>
        </div>
        <div class="toolbar"><button class="btn bs" id="btn-add-mem" type="button">추가</button><button class="btn bd" id="btn-cancel-mem" type="button">취소</button></div>
      </div>
      <div id="ml-graph" class="mem-graph hide">
        <canvas id="ml-graph-cv"></canvas>
        <div class="mem-graph-side">
          <div class="mg-kpi" id="ml-graph-kpi"></div>
          <div class="mg-paths" id="ml-graph-paths"></div>
        </div>
      </div>
      <div id="ml" class="list"></div>
      <table class="tbl hide"><tbody id="ml-table"></tbody></table>
      <div class="mem-footnote"><button type="button" id="mem-nsrc-toggle">서사 근거 표시</button></div>
    </div>
  </div>
  <div id="tab-entity" class="panel">
    <div class="crumb">데이터 / <b>인물</b></div>
    <div class="page-head">
      <div><h2>인물</h2><div class="desc">현재 채팅에 기록된 전체 인물입니다. 이름을 누르면 개별 프로필이 열립니다.</div></div>
      <div class="toolbar">
        <button class="btn bs" id="btn-toggle-add-ent">➕ 인물 추가</button>
        <button class="btn bp" id="btn-save-ents">💾 인물 저장</button>
      </div>
    </div>

    <!-- 맨 상단: 인물·관계 대표 정보 (요약 계기판) -->
    <div class="kpi-grid">
      <div class="card kpi hl">
        <div class="kpi-top"><span class="kpi-name">◍ 등록 인물</span><span class="badge b-gold" id="sum-ent-badge">보호 0</span></div>
        <div class="kpi-num" id="sum-ent-count">0<small>명</small></div>
        <div class="kpi-note" id="sum-ent-note">최근 등장 인물을 집계하고 있습니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">⇄ 관계</span><span class="badge b-info" id="sum-rel-badge">방향 포함</span></div>
        <div class="kpi-num" id="sum-rel-count">0<small>건</small></div>
        <div class="kpi-note" id="sum-rel-note">가장 강한 관계를 계산하고 있습니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">⚠ 주의 필요</span><span class="badge b-warn">확인 권장</span></div>
        <div class="kpi-num" id="sum-need-count">0<small>명</small></div>
        <div class="kpi-note">오래 미등장이거나 떡밥이 열린 인물입니다.</div>
      </div>
    </div>

    <!-- 인덱스형 탐색기 -->
    <div class="explorer">
      <div class="ex-top">
        <div class="ex-search"><span>🔍</span><input type="text" id="ent-search" placeholder="이름 · 역할 · 소속 · 별칭으로 검색"></div>
        <div class="ex-count" id="ent-count">인물 0명</div>
        <div class="dens" role="group" aria-label="밀도">
          <button type="button" class="on" data-density="cards">카드</button>
          <button type="button" data-density="list">목록</button>
        </div>
      </div>
      <div class="ex-idx" id="ent-index" role="tablist" aria-label="이름 인덱스"></div>
      <div class="ex-chips" id="ent-filter">
        <button type="button" class="on" data-filter="all">전체</button>
        <button type="button" data-filter="locked">보호됨</button>
        <button type="button" data-filter="threads">떡밥 열림</button>
        <button type="button" data-filter="recent">최근 등장</button>
      </div>
      <div class="mem-views" role="group" aria-label="인물 보기" style="margin-left:auto">
        <button type="button" class="on" data-ent-view="list">목록</button>
        <button type="button" data-ent-view="graph">그래프</button>
      </div>
    </div>

    <div id="el-graph" class="mem-graph hide">
      <canvas id="el-graph-cv"></canvas>
      <div class="mem-graph-side">
        <div class="mg-kpi" id="el-graph-kpi"></div>
        <div class="mg-paths" id="el-graph-paths"></div>
      </div>
    </div>

    <div id="aef" class="add-form">
      <div class="entity-band" style="margin-top:0">
        <div class="entity-band-title">기본 정본 카드</div>
        <div class="fld"><label>이름</label><input type="text" id="ae-name" placeholder="캐릭터 이름"></div>
        <div class="entity-grid">
          <div class="fld entity-wide"><label>역할</label><input type="text" id="ae-role" placeholder="서사 역할"></div>
          <div class="fld entity-wide"><label>외모 특징 (쉼표 구분)</label><input type="text" id="ae-feat" placeholder="검은 머리, 키 큰"></div>
          <div class="fld entity-wide"><label>성격 특성 (쉼표 구분)</label><input type="text" id="ae-trait" placeholder="친절한, 용감한"></div>
          <div class="fld entity-wide"><label>배경</label><textarea id="ae-bg" rows="3" class="ec" placeholder="근거 있는 배경만 입력"></textarea></div>
          <div class="fld entity-wide"><label>현재 상태</label><textarea id="ae-current-state" rows="3" class="ec" placeholder="현재 장면에서의 상태"></textarea></div>
          <div class="fld entity-wide"><label>말투 단서 (쉼표 구분)</label><input type="text" id="ae-speech-notes" placeholder="짧게 말함, 존칭 사용"></div>
          <div class="fld entity-wide"><label>심리</label><input type="text" id="ae-psychology" placeholder="심리 기준선 또는 현재 갈등"></div>
          <div class="fld entity-wide"><label>열린 떡밥 (줄바꿈 구분)</label><textarea id="ae-open-threads" rows="3" class="ec" placeholder="아직 해결되지 않은 인물 관련 흐름"></textarea></div>
        </div>
      </div>
      <div style="display:flex;gap:5px;margin-top:5px">
        <button class="btn bs" id="btn-add-ent">추가</button>
        <button class="btn bd" id="btn-cancel-ent">취소</button>
      </div>
    </div>
    <div id="arf" class="add-form">
      <div class="ef">
        <div class="fld"><label>인물 A</label><input type="text" id="ar-a" placeholder="인물 A"></div>
        <div class="fld"><label>인물 B</label><input type="text" id="ar-b" placeholder="인물 B"></div>
      </div>
      <div class="ef">
        <div class="fld"><label>관계 유형</label><input type="text" id="ar-type" placeholder="친구, 연인 등"></div>
        <div class="fld"><label>관계 수치</label><div class="tr"><label>직접 지정</label><label class="tog"><input type="checkbox" id="ar-score-enabled"><span class="tsl"></span></label></div><div class="hint">끄면 첫 대면 · 정의 보류로 저장됩니다.</div></div>
      </div>
      <div class="ef" id="ar-score-wrap">
        <div class="fld"><label>친밀도</label><div class="rw"><input type="range" id="ar-cls" min="0" max="100" value="10" disabled><span id="ar-clsv" class="rv">미정</span></div></div>
        <div class="fld"><label>신뢰도</label><div class="rw"><input type="range" id="ar-trs" min="0" max="100" value="10" disabled><span id="ar-trsv" class="rv">미정</span></div></div>
      </div>
      <div class="ef">
        <div class="fld"><label>감정 (A→B)</label><input type="text" id="ar-sent" placeholder="호감, 경계 등"></div>
      </div>
      <div style="display:flex;gap:5px;margin-top:5px">
        <button class="btn bs" id="btn-add-rel">추가</button>
        <button class="btn bd" id="btn-cancel-rel">취소</button>
      </div>
    </div>
        <div id="el" class="list"></div>
    <details class="entity-block-panel">
      <summary>⛔ 엔티티 차단 리스트 <span class="badge b-plain" id="entity-block-count">0</span></summary>
      <div class="entity-block-body">
        <div class="setting-note">차단한 이름과 별칭은 기존 인물·관계 데이터에서 제외되며, 이후 엔티티 분석·관계 생성·유저 DLC 대상 및 프롬프트에도 다시 투입되지 않습니다.</div>
        <div class="toolbar">
          <input type="text" id="entity-block-input" class="si" placeholder="차단할 엔티티 이름">
          <button class="btn bs" id="btn-add-entity-block">⛔ 차단 추가</button>
        </div>
        <div id="entity-block-list" class="list">
  </div>
      </div>
    </details>
  </div>
  
    <div id="tab-entity-profile" class="panel">
    <div class="crumb"><a href="#" class="crumbs-link" data-back="entity">인물</a> / <b id="prof-crumb">—</b></div>
    <div class="hero">
      <div class="hero-av" id="prof-avatar">·</div>
      <div class="hero-main">
        <div class="hero-name" id="prof-name">—</div>
        <div class="hero-role" id="prof-role">—</div>
        <div class="hero-tags" id="prof-tags"></div>
      </div>
      <div class="hero-side">
        <span class="badge b-gold" id="prof-canon">—</span>
        <div class="hero-stat"><span>상태 로그</span><b id="prof-last">—</b></div>
        <div class="hero-stat"><span>관계</span><b id="prof-relcount">0건</b></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="st">이 인물의 관계</div>
      <div class="dim" id="prof-relnote">수치는 두 인물 사이의 값이며 화살표는 감정의 방향입니다.</div>
      <div id="prof-relations" class="list"></div>
    </div>
    <div class="card">
      <div class="st">읽기용 기록</div>
      <div class="kv-grid" id="prof-read"></div>
    </div>
  </div>
  <div id="tab-narrative-detail" class="panel">
    <div class="crumb"><a href="#" class="crumbs-link" data-back="narrative">내러티브</a> / <b id="nar-detail-crumb">—</b></div>
    <div class="hero">
      <div class="hero-av">◈</div>
      <div class="hero-main">
        <div class="hero-name" id="nar-detail-title">—</div>
        <div class="hero-role" id="nar-detail-context">—</div>
        <div class="hero-tags" id="nar-detail-tags"></div>
      </div>
      <div class="hero-side">
        <span class="badge b-warn" id="nar-detail-lock">—</span>
        <div class="hero-stat"><span>최근 갱신</span><b id="nar-detail-turn">—</b></div>
        <div class="hero-stat"><span>요약 이력</span><b id="nar-detail-hist">—</b></div>
      </div>
    </div>
    <div class="card">
      <div class="st">서사 흐름</div>
      <div class="kv-grid" id="nar-detail-read"></div>
    </div>
  </div>
  <div id="tab-world-detail" class="panel">
    <div class="crumb"><a href="#" class="crumbs-link" data-back="world">세계관</a> / <b id="wld-detail-crumb">—</b></div>
    <div class="hero">
      <div class="hero-av">⬡</div>
      <div class="hero-main">
        <div class="hero-name" id="wld-detail-name">—</div>
        <div class="hero-role" id="wld-detail-summary">—</div>
        <div class="hero-tags" id="wld-detail-tags"></div>
      </div>
      <div class="hero-side">
        <span class="badge b-gold" id="wld-detail-badge">—</span>
        <div class="hero-stat"><span>분류</span><b id="wld-detail-class">—</b></div>
        <div class="hero-stat"><span>규칙</span><b id="wld-detail-rules">—</b></div>
      </div>
    </div>
    <div class="card">
      <div class="st">읽기용 기록</div>
      <div class="kv-grid" id="wld-detail-read"></div>
    </div>
  </div>
  
  
  <div id="tab-relations" class="panel">
    <div class="crumb">데이터 / <b>관계</b></div>
<div class="page-head rel-head">
        <div><h2>관계</h2><div class="desc">관계 수치는 <strong>인물 속성이 아니라 두 인물 사이의 값</strong>입니다. 화살표는 감정의 방향입니다.</div></div>
        <div class="toolbar">
          <button class="btn bs" id="btn-toggle-add-rel">➕ 관계 추가</button>
          <button class="btn bp" id="btn-save-rels">💾 관계 저장</button>
        </div>
      </div>
      <div class="explorer">
        <div class="ex-top">
          <div class="ex-search"><span>🔍</span><input type="text" id="rel-search" placeholder="인물 이름 · 관계 유형으로 검색"></div>
          <div class="ex-count" id="rel-count">관계 0건</div>
        </div>
        <div class="ex-chips" id="rel-filter">
          <!-- 칩은 제품 데이터에 실재하는 축만 쓴다: details.closeness / details.trust /
               meta.manualLocked / 감정 누락. '긴장'은 제품에 없는 내가 만든 축이어서 제거했다. -->
          <button type="button" class="on" data-rel-filter="all">전체</button>
          <button type="button" data-rel-filter="strong">친밀 70+</button>
          <button type="button" data-rel-filter="weak">친밀 40 미만</button>
          <button type="button" data-rel-filter="onenone">한쪽만 기록</button>
          <button type="button" data-rel-filter="locked">수동 보호</button>
        </div>
        <div class="mem-views" role="group" aria-label="관계 보기" style="margin-left:auto">
          <button type="button" class="on" data-rel-view="list">목록</button>
          <button type="button" data-rel-view="graph">그래프</button>
        </div>
      </div>
      <div id="rl-graph" class="mem-graph hide">
        <canvas id="rl-graph-cv"></canvas>
        <div class="mem-graph-side">
          <div class="mg-kpi" id="rl-graph-kpi"></div>
          <div class="mg-paths" id="rl-graph-paths"></div>
        </div>
      </div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th style="width:190px">방향</th><th style="width:110px">관계 유형</th><th style="width:200px">친밀도 · 신뢰도</th><th>감정 · 최근 변화</th><th style="width:90px"></th></tr></thead>
        <tbody id="rl"></tbody>
      </table></div>
    </div>

  <div id="tab-narrative" class="panel">
    <div class="crumb">데이터 / <b>내러티브</b></div>
    <div class="page-head">
      <div><h2>내러티브</h2><div class="desc">서사 흐름을 직접 고칩니다. 항목을 누르면 편집 영역이 열립니다.</div></div>
      <div class="toolbar">
        <button class="btn bs" id="btn-add-narrative">➕ 내러티브 추가</button>
        <button class="btn bp" id="btn-save-narrative">💾 내러티브 저장</button>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="card kpi hl">
        <div class="kpi-top"><span class="kpi-name">◈ 서사 항목</span><span class="badge b-gold" id="sum-nar-badge">활성 0 · 보호 0</span></div>
        <div class="kpi-num" id="sum-nar-count">0<small>개</small></div>
        <div class="kpi-note">가장 오래된 항목부터 자동 요약됩니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">◆ 현재 아크</span><span class="badge b-info">진행 중</span></div>
        <div class="kpi-num" id="sum-nar-arc" style="font-size:var(--fs-title)">—</div>
        <div class="kpi-note" id="sum-nar-arc-note">아직 기록된 아크가 없습니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">⚠ 미해결</span><span class="badge b-warn">추적 중</span></div>
        <div class="kpi-num" id="sum-nar-open">0<small>건</small></div>
        <div class="kpi-note" id="sum-nar-open-note">미해결 흐름을 집계하고 있습니다.</div>
      </div>
    </div>
        <div class="wa-tabs" role="tablist" aria-label="내러티브 오케스트레이션 DB 보기">
      <button class="wa-tab on" type="button" role="tab" aria-selected="true" data-narrative-tab="storylines">내러티브 DB</button>
      <button class="wa-tab" type="button" role="tab" aria-selected="false" data-narrative-tab="author">스토리 작가</button>
      <button class="wa-tab" type="button" role="tab" aria-selected="false" data-narrative-tab="director">감독</button>
    </div>
    <div class="wa-pane on" role="tabpanel" data-narrative-pane="storylines">
      <div class="wa-pane-head"><div><div class="wa-pane-title">내러티브 DB</div><div class="wa-pane-note">스토리라인, 요약 이력과 턴별 서사 흐름입니다. 총 <strong id="nc">0</strong>개 스토리라인.</div></div></div>
      <div id="narrative-list" class="list"></div>
    </div>
    <div class="wa-pane" role="tabpanel" data-narrative-pane="author">
      <div class="wa-pane-head"><div><div class="wa-pane-title">스토리 작가 플랜</div><div class="wa-pane-note">장기 서사 목표와 다음 비트를 만드는 독립 DB입니다. 연속성 확인을 위해 읽기 전용으로 표시합니다.</div></div></div>
      <div id="story-author-view" class="list"></div>
    </div>
    <div class="wa-pane" role="tabpanel" data-narrative-pane="director">
      <div class="wa-pane-head"><div><div class="wa-pane-title">감독 지시</div><div class="wa-pane-note">작가 플랜을 장면의 연출·대사·속도 지시로 변환한 독립 DB입니다. 읽기 전용입니다.</div></div></div>
      <div id="director-view" class="list"></div>
    </div>
  </div>
  <div id="tab-world" class="panel">
    <div class="crumb">데이터 / <b>세계관</b></div>
    <div class="page-head">
      <div><h2>세계관</h2><div class="desc">세계 규칙은 <strong>노드 계층</strong>으로 쌓입니다. 활성 경로에 따라 장면용 세계관이 구성됩니다.</div></div>
      <div class="toolbar">
        <button class="btn bs" id="btn-save-world-fields">💾 세계관 저장</button>
        <button class="btn bp" id="btn-save-world-correction">사용자 교정 저장</button>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="card kpi hl">
        <div class="kpi-top"><span class="kpi-name">⬡ 세계 노드</span><span class="badge b-gold" id="sum-wld-badge">활성 0 · 이력 0</span></div>
        <div class="kpi-num" id="sum-wld-nodes">0<small>개</small></div>
        <div class="kpi-note">현재 활성 경로에 따라 장면용 세계관이 구성됩니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">◈ 확립된 규칙</span><span class="badge b-info" id="sum-wld-rules-badge">분류 집계</span></div>
        <div class="kpi-num" id="sum-wld-rules">0<small>건</small></div>
        <div class="kpi-note" id="sum-wld-rules-note">현재 노드의 규칙을 집계하고 있습니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">⚠ 사용자 교정</span><span class="badge b-warn">미반영</span></div>
        <div class="kpi-num" id="sum-wld-corr">0<small>건</small></div>
        <div class="kpi-note">잘못 기록된 세계관을 직접 고친 항목입니다.</div>
      </div>
    </div>
    <div class="explorer">
      <div class="ex-top">
        <div class="ex-search"><span>🔍</span><input type="text" id="wld-search" placeholder="노드 이름 · 분류 · 규칙 내용으로 검색"></div>
        <div class="ex-count" id="wld-count">노드 0개</div>
      </div>
      <div class="ex-chips" id="wld-filter">
        <button type="button" class="on" data-wld-filter="all">전체</button>
        <button type="button" data-wld-filter="active">활성 경로</button>
        <button type="button" data-wld-filter="history">이력</button>
      </div>
    </div>
    <div id="wld-list" class="ent-list"></div>
    <div id="wld-empty" class="empty hide" hidden><div class="big">◌</div><p>조건에 맞는 세계 노드가 없습니다.</p></div>

    <details class="world-legacy">
      <summary>세계관 원본 편집 (정본 필드 · 규칙 · 로그)</summary>
        <div class="sec">🗺 세계관 트리</div>
    <div id="wt" class="wt"></div>
    <div class="sec">🌐 전역 세계 특성</div>
    <div id="world-global-features" class="wt" style="font-size:var(--fs-body)"></div>
    <div class="sec">📋 현재 세계 규칙</div>
    <div id="wr" class="wt" style="font-size:var(--fs-body)"></div>
    <div class="sec">🧱 세계관 정본 필드</div>
    <div class="entity-band" style="margin-top:0">
      <div class="entity-band-title">영구 세계 구조</div>
      <div class="entity-grid">
        <div class="fld"><label>세계 이름</label><input type="text" id="world-node-name" placeholder="주요 세계"></div>
        <div class="fld"><label>세계 분류</label><input type="text" id="world-classification" placeholder="현대 현실, 현대 판타지, 아카데미 등"></div>
        <div class="fld entity-wide"><label>세계 요약</label><textarea id="world-summary" class="ec" rows="3" placeholder="이 세계의 안정적인 배경 요약"></textarea></div>
        <div class="fld"><label>시대·기술 수준</label><input type="text" id="world-tech" placeholder="modern, medieval, futuristic, unknown"></div>
        <div class="fld"><label>마법</label><select id="world-magic"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>기/무공</label><select id="world-ki"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>초자연</label><select id="world-supernatural"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>레벨</label><select id="world-system-leveling"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>스킬</label><select id="world-system-skills"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>스탯</label><select id="world-system-stats"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>직업/클래스</label><select id="world-system-classes"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>길드</label><select id="world-system-guilds"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>세력</label><select id="world-system-factions"><option value="">불명</option><option value="true">있음</option><option value="false">없음</option></select></div>
        <div class="fld"><label>중력</label><input type="text" id="world-gravity" placeholder="normal"></div>
        <div class="fld"><label>시간 흐름</label><input type="text" id="world-time-flow" placeholder="linear"></div>
        <div class="fld"><label>공간</label><input type="text" id="world-space" placeholder="three_dimensional"></div>
        <div class="fld entity-wide"><label>주요 장소·시설 (줄바꿈 구분)</label><textarea id="world-places" class="ec" rows="3"></textarea></div>
        <div class="fld entity-wide"><label>조직·권력 구조 (줄바꿈 구분)</label><textarea id="world-organizations" class="ec" rows="3"></textarea></div>
        <div class="fld entity-wide"><label>사회·문화 규칙 (줄바꿈 구분)</label><textarea id="world-social-rules" class="ec" rows="4"></textarea></div>
        <div class="fld entity-wide"><label>신화적 존재 (줄바꿈 구분)</label><textarea id="world-mythical" class="ec" rows="2"></textarea></div>
        <div class="fld entity-wide"><label>비인간 종족 (줄바꿈 구분)</label><textarea id="world-races" class="ec" rows="2"></textarea></div>
        <div class="fld entity-wide"><label>특수 현상 (줄바꿈 구분)</label><textarea id="world-phenomena" class="ec" rows="3"></textarea></div>
        <div class="fld entity-wide"><label>추가 규칙 (줄바꿈 구분)</label><textarea id="world-custom-rules" class="ec" rows="4"></textarea></div>
      </div>
    </div>
    <div class="sbar inline-actions"><button class="btn bs" id="btn-save-world-fields">💾 세계관 필드 저장</button></div>
    <div class="sec">🧭 현재 세계 상태 로그</div>
    <div id="world-state-log" class="wt" style="font-size:var(--fs-body)"></div>
    <div class="sec">🌐 세계관 코덱스 상태</div>
    <div id="world-codex-status" class="wt" style="font-size:var(--fs-body)"></div>
    <div class="sec">✍ 수동 세계관 보정</div>
    <div class="fld">
      <label>잘못 기록된 세계관을 직접 고치기</label>
      <textarea id="world-user-correction" class="ec" rows="5" placeholder="예: 이 세계는 현대물이 아니라 현대 판타지다. 마법은 공개되지 않았고, 시스템창은 실제가 아니라 연출이다."></textarea>
    </div>
    <div class="sbar inline-actions"><button class="btn bs" id="btn-save-world-correction">💾 세계관 보정 저장</button></div>
    <div class="sec">🧭 현재 장면용 세계관 보정</div>
    <div id="world-lens-meta" class="wt" style="font-size:var(--fs-body)"></div>
    <div class="fld">
      <label>현재 구조에서 선택·압축한 장면용 세계관 보정 프롬프트</label>
      <textarea id="world-lens-prompt" class="ec" rows="10" readonly placeholder="아직 생성된 장면용 세계관 보정이 없습니다."></textarea>
    </div>
      </details>
  </div>
  <div id="tab-worldline" class="panel">
    <div class="crumb">데이터 / <b>세계선</b></div>
    <div class="page-head">
      <div><h2>세계선</h2><div class="desc">턴이 진행되면 <strong>자동으로 쌓이는 기록</strong>입니다. 리롤·삭제로 물러난 턴도 지우지 않고 <strong>이력으로 보존</strong>합니다.</div></div>
      <div class="toolbar"><button class="btn bs" id="wl-refresh" type="button">↻ 새로고침</button></div>
    </div>
    <div class="kpi-grid">
      <div class="card kpi hl">
        <div class="kpi-top"><span class="kpi-name">⁂ 현재 경로</span><span class="badge b-gold">활성</span></div>
        <div class="kpi-num" id="sum-wl-active">0<small>턴</small></div>
        <div class="kpi-note">현재 대화에서 살아 있는 턴 노드입니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">◌ 이력</span><span class="badge b-warn">리롤·삭제</span></div>
        <div class="kpi-num" id="sum-wl-history">0<small>개</small></div>
        <div class="kpi-note">리롤로 대체되거나 삭제로 물러난 턴입니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">◆ 기록 회차</span><span class="badge b-info">revision</span></div>
        <div class="kpi-num" id="sum-wl-rev">0<small>회차</small></div>
        <div class="kpi-note">이 대화 범위의 세계선이 갱신된 횟수입니다.</div>
      </div>
    </div>
    <div class="sec">🌿 분기 계보</div>
    <div id="wl-lineage" class="wt" style="font-size:var(--fs-body)"></div>
    <div class="sec">🧭 세계선 타임라인</div>
    <div id="wl-view" class="wl-view"></div>
  </div>
  <div id="tab-world-additional" class="panel">
    <div class="view-tabs additional-primary-tabs" role="tablist" aria-label="추가 요소 기능" hidden>
      <button class="view-tab on" type="button" role="tab" aria-selected="true" data-additional-tab="create">새 요소 만들기</button>
      <button class="view-tab" type="button" role="tab" aria-selected="false" data-additional-tab="world-additional">월드 에디셔널</button>
    </div>
    <div class="additional-primary-pane on" data-additional-pane="create">
      <div class="crumb">추가 요소 / <b>새 요소 만들기</b></div>
      <div class="page-head">
        <div><h2>새 요소 만들기</h2><div class="desc">무엇을 추가할지 적으면 LIBRA가 종류와 저장 위치를 스스로 판단해 구성합니다.</div></div>
      </div>
      <div class="card additional-composer">
        <div class="fld"><label>무엇을 추가하거나 알아보고 싶나요? <span class="setting-note">자동 분류</span></label><textarea id="udlc-unified-request" rows="5" placeholder="예: 현재 관계에서 아리엘이 고백을 받았을 때의 반응과 말투에 맞는 대사 예시를 알려줘."></textarea></div>
        <div class="fld"><label>빠른 예시</label><div class="udlc-quick-actions"><button class="udlc-quick" type="button" data-udlc-unified-example="공정하게 피할 단서가 있는 함정을 현재 세계관에 맞춰 추가해 줘." data-udlc-unified-kind="world">함정</button><button class="udlc-quick" type="button" data-udlc-unified-example="이 세계의 기술·마법·연금술과 의료 체계에 맞는 서로 다른 피임 도구를 최소 3개 추가해 줘. 각 도구의 사용법, 유효 기간, 실패 조건, 부작용, 입수 경로와 보호 범위를 구분해 줘." data-udlc-unified-kind="world">피임 도구</button><button class="udlc-quick" type="button" data-udlc-unified-example="현재 세계관에 맞는 던전, 몬스터, 드랍 아이템, 경험치 체계와 몬스터 게이트를 서로 연결된 별도 요소로 추가해 줘." data-udlc-unified-kind="world">던전 패키지</button><button class="udlc-quick" type="button" data-udlc-unified-example="현재 세계관에 맞는 마법, 요술, 마법진, 마법 지팡이와 마법 서클을 서로 구분되는 별도 요소로 추가해 줘." data-udlc-unified-kind="world">마법 체계</button><button class="udlc-quick" type="button" data-udlc-unified-example="현재 세계관의 성장·전투 규칙에 맞는 스킬과 초능력을 각각 별도 요소로 추가해 줘. 획득 조건, 비용, 제약과 대응법을 포함해 줘." data-udlc-unified-kind="world">스킬·초능력</button><button class="udlc-quick" type="button" data-udlc-unified-example="현재 관계에서 고백이나 데이트 제안을 받았을 때의 예상 반응과 대사 예시를 만들어 줘." data-udlc-unified-kind="entity">상황 반응</button><button class="udlc-quick" type="button" data-udlc-unified-example="극중 날짜에 따라 생식 건강과 월경 주기를 계속 추적해 줘." data-udlc-unified-kind="entity">상태 추적</button><button class="udlc-quick" type="button" data-udlc-unified-example="성인 인물의 섹스·자위·임신·출산·경험 인수·질내사정·펠라치오·애널 섹스 횟수와 첫 섹스 상대를 계속 추적해 줘." data-udlc-unified-kind="entity">성경험 이력</button><button class="udlc-quick" type="button" data-udlc-unified-example="현재 세계관과 연결되는 새로운 장소를 추가해 줘." data-udlc-unified-kind="world">장소</button></div></div>
        <div class="fld"><label>적용 대상 <span class="setting-note">선택하지 않으면 세계 전체에 적용합니다</span></label><select id="udlc-unified-target"><option value="world">세계 전체</option></select></div>
        <div class="home-actions" style="justify-content:flex-start"><button class="btn bp" id="btn-analyze-user-dlc-unified" type="button">✨ 분석해서 추가</button><span class="setting-note" id="user-dlc-unified-status" aria-live="polite">세계관 적응, 저장 위치와 갱신 방식을 자동으로 결정합니다.</span></div>
      </div>
    </div>
    
  </div>
  <div id="tab-wa-auto" class="panel">
    <div class="crumb">추가 요소 / <b>월드 에디셔널</b> <span class="badge b-gold" style="margin-left:6px">자동</span></div>
    <div class="page-head">
      <div><h2>월드 에디셔널</h2>
        <div class="desc">LIBRA가 응답을 분석해 <strong>자동으로 만든</strong> 요소입니다. 만들 내용을 쓰는 화면이 아니라, <strong>무엇이 들어갔고 무엇이 빠졌는지 보고 정본으로 확정하는</strong> 화면입니다.</div></div>
      <div class="toolbar">
        <button class="btn bs" id="btn-refresh-world-additional" type="button">↻ 새로고침</button>
        <button class="btn bp" id="btn-merge-world-additional" type="button">정본으로 확정</button>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="card kpi hl">
        <div class="kpi-top"><span class="kpi-name">✦ 생성된 요소</span><span class="badge b-gold" id="wa-kpi-mix">엔티티 0 · 월드 0</span></div>
        <div class="kpi-num" id="wa-kpi-total">0<small>건</small></div>
        <div class="kpi-note">최근 분석에서 생성된 후보입니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">◐ 지금 투입 중</span><span class="badge b-info">이번 턴</span></div>
        <div class="kpi-num" id="wa-kpi-active">0<small>건</small></div>
        <div class="kpi-note">프롬프트에 실제로 들어간 요소입니다.</div>
      </div>
      <div class="card kpi">
        <div class="kpi-top"><span class="kpi-name">◈ 발현 · 통합</span><span class="badge b-ok">누적</span></div>
        <div class="kpi-num" id="wa-kpi-log">0<small>건</small></div>
        <div class="kpi-note">작품에 등장했거나 정본에 통합된 기록입니다.</div>
      </div>
    </div>
    <div class="toolbar">
      <span class="stat">Directive DB <strong id="wa-db-count">0</strong>개</span>
      <button class="btn bp" id="btn-analyze-world-additional" type="button">✨ 전용 수동 분석</button>
    </div>
    <div class="hint" id="world-additional-analysis-status" style="margin:8px 0 12px">현재 채팅을 기준으로 콜드스타트·과거대화 재분석과 독립적으로 분석합니다.</div>
    <div class="settings-subblock" aria-label="월드 에디셔널 적용 설정" data-global-settings>
      <div class="settings-subtitle">월드 에디셔널 투입 설정</div>
      <div class="fld"><label id="swamax-label">한 응답의 최대 자동 투입 수 <span id="swamax-current-candidates">(현재 후보 수 : 0)</span></label><input type="number" id="swamax" min="1" max="6" placeholder="3"><div class="setting-note">카드에서 ‘투입 ON’으로 지정한 요소는 이 수를 넘어도 반드시 프롬프트에 포함됩니다. 장면에서의 표현 강도와 인물 영향은 응답 모델이 현재 정본·관계·상황에 맞춰 결정합니다.</div></div>
    </div>
    <div class="sec">운영 요약</div>
    <div id="world-additional-summary" class="cs"></div>
    <div class="wa-tabs" role="tablist" aria-label="월드 에디셔널 DB 보기">
      <button class="wa-tab on" type="button" role="tab" aria-selected="true" data-wa-tab="entities">엔티티 DB <span class="wa-tab-count" id="wa-entity-count">0</span></button>
      <button class="wa-tab" type="button" role="tab" aria-selected="false" data-wa-tab="world">월드 DB <span class="wa-tab-count" id="wa-world-count">0</span></button>
      <button class="wa-tab" type="button" role="tab" aria-selected="false" data-wa-tab="active">현재 주입/활성 <span class="wa-tab-count" id="wa-active-count">0</span></button>
      <button class="wa-tab" type="button" role="tab" aria-selected="false" data-wa-tab="log">발현/통합 로그 <span class="wa-tab-count" id="wa-log-count">0</span></button>
      <button class="wa-tab" type="button" role="tab" aria-selected="false" data-wa-tab="user-dlc">유저 DLC <span class="wa-tab-count" id="wa-user-dlc-count">0</span></button>
    </div>
    <div class="wa-pane on" role="tabpanel" data-wa-pane="entities">
      <div class="wa-pane-head"><div><div class="wa-pane-title">엔티티 분석 결과</div><div class="wa-pane-note">월드 에디셔널이 별도 생성한 인물과 역할, 등장 조건 및 근거입니다.</div></div></div>
      <div id="world-additional-entities" class="list"></div>
    </div>
    <div class="wa-pane" role="tabpanel" data-wa-pane="world">
      <div class="wa-pane-head"><div><div class="wa-pane-title">월드 분석 결과</div><div class="wa-pane-note">세계 추가 요소와 장면 개입 지시를 구분해 표시합니다.</div></div></div>
      <div id="world-additional-world"></div>
    </div>
    <div class="wa-pane" role="tabpanel" data-wa-pane="active">
      <div class="wa-pane-head"><div><div class="wa-pane-title">현재 주입 및 활성 지시</div><div class="wa-pane-note">준비·대기·주입 상태인 지시만 표시합니다.</div></div></div>
      <div id="world-additional-active" class="list"></div>
      <div class="wa-pane-head" style="margin-top:14px"><div><div class="wa-pane-title">투입 판정</div><div class="wa-pane-note">이번 턴에 어떤 요소가 왜 들어갔고 왜 빠졌는지 보여줍니다. "주입됨·미활용"은 프롬프트에는 들어갔지만 아직 작품에 등장하지 않은 요소입니다.</div></div></div>
      <div id="world-additional-diagnostics"></div>
    </div>
    <div class="wa-pane" role="tabpanel" data-wa-pane="log">
      <div class="wa-pane-head"><div><div class="wa-pane-title">발현 및 통합 이력</div><div class="wa-pane-note">실제 응답에서 발현되거나 정본 흐름에 통합된 기록입니다.</div></div></div>
      <div id="world-additional-log" class="list"></div>
    </div>
    
    </div>
  <div id="tab-udlc" class="panel">
      <div class="crumb">추가 요소 / <b>유저 DLC</b> <span class="badge b-gold" style="margin-left:6px">창안</span></div>
      <div class="page-head">
        <div><h2>유저 DLC</h2>
          <div class="desc"><strong>내가 원하는 요소를 직접 창안</strong>하는 곳입니다. LIBRA가 캐릭터 로어북과 세계/엔티티 DB를 근거로 세계관에 맞게 구성해 줍니다. 일반 자동 분석과 분리되어 보관됩니다.</div></div>
      </div>
      <div class="kpi-grid">
        <div class="card kpi hl">
          <div class="kpi-top"><span class="kpi-name">✍ 창안 요소</span><span class="badge b-gold" id="udlc-kpi-mix">세계 0 · 인물 0</span></div>
          <div class="kpi-num" id="udlc-kpi-total">0<small>건</small></div>
          <div class="kpi-note">내가 요청해 만든 요소입니다.</div>
        </div>
        <div class="card kpi">
          <div class="kpi-top"><span class="kpi-name">◐ 추적 중</span><span class="badge b-info">인물 상태</span></div>
          <div class="kpi-num" id="udlc-kpi-track">0<small>건</small></div>
          <div class="kpi-note">응답 후 커스텀 상태를 추적하는 항목입니다.</div>
        </div>
        <div class="card kpi">
          <div class="kpi-top"><span class="kpi-name">◆ 대상 인물</span><span class="badge b-ok">분석 완료</span></div>
          <div class="kpi-num" id="udlc-kpi-targets">0<small>명</small></div>
          <div class="kpi-note">유저 DLC 분석 대상으로 지정된 인물입니다.</div>
        </div>
      </div>
      <div class="wa-tabs" role="tablist" aria-label="유저 DLC 분기">
        <button class="wa-tab on" type="button" role="tab" aria-selected="true" data-udlc-tab="world">세계 요소 <span class="wa-tab-count" id="udlc-world-count">0</span></button>
        <button class="wa-tab" type="button" role="tab" aria-selected="false" data-udlc-tab="entity">인물 <span class="wa-tab-count" id="udlc-entity-count">0</span></button>
      </div>
      <div class="wa-pane on" role="tabpanel" data-udlc-pane="world">
        <div class="udlc-editor">
          <div class="udlc-simple-label">세계에 무엇을 추가할까요?</div>
          <div class="udlc-simple-help">원하는 요소와 꼭 지켜야 할 조건을 평소 말하듯 적어 주세요. 종류·이름·작동 방식과 세계관 적응은 LIBRA가 자동으로 구성합니다. 피임 도구, 던전 패키지, 마법 체계처럼 서로 연결된 여러 요소도 한 번에 요청할 수 있습니다.</div>
          <textarea id="udlc-world-request" class="ec" rows="6" placeholder="예: 주인공이 보물 상자를 열면 최근 기억을 잃지만, 주변 문양을 조사하면 미리 피할 수 있는 함정을 추가해 줘."></textarea>
          <div class="udlc-quick-actions"><button class="udlc-quick" type="button" data-udlc-world-example="공정하게 피할 단서가 있는 함정을 추가해 줘.">함정</button><button class="udlc-quick" type="button" data-udlc-world-example="이 세계의 기술이나 마법 체계에 맞는 특별한 도구를 추가해 줘.">도구</button><button class="udlc-quick" type="button" data-udlc-world-example="이 세계의 기술·마법·연금술과 의료 체계에 맞는 서로 다른 피임 도구를 최소 3개 추가해 줘. 각 도구의 사용법, 효과 시작, 유효 기간, 실패 조건, 부작용, 입수 경로, 가역성과 감염 예방 범위를 구분해 줘.">피임 도구</button><button class="udlc-quick" type="button" data-udlc-world-example="현재 세계관에 맞는 던전, 몬스터, 드랍 아이템, 경험치 체계와 몬스터 게이트를 서로 연결된 별도 요소로 추가해 줘. 진입·출현·종료 조건, 약점, 드랍, 보상과 중복 보상 방지 규칙을 포함해 줘.">던전 패키지</button><button class="udlc-quick" type="button" data-udlc-world-example="현재 세계관에 맞는 마법, 요술, 마법진, 마법 지팡이와 마법 서클을 서로 구분되는 별도 요소로 추가해 줘. 획득·발동 조건, 비용, 제약과 실패 결과를 포함해 줘.">마법 체계</button><button class="udlc-quick" type="button" data-udlc-world-example="현재 세계관의 성장·전투 규칙에 맞는 스킬과 초능력을 각각 별도 요소로 추가해 줘. 획득 조건, 발동법, 비용, 성장 규칙, 제약과 대응법을 포함해 줘.">스킬·초능력</button><button class="udlc-quick" type="button" data-udlc-world-example="인물들이 개입하고 해결할 수 있는 단계적인 위기를 추가해 줘.">위기</button><button class="udlc-quick" type="button" data-udlc-world-example="현재 세계관과 연결되는 새로운 장소를 추가해 줘.">장소</button><button class="udlc-quick" type="button" data-udlc-world-example="기존 세력과 관계를 맺는 새로운 조직을 추가해 줘.">조직</button><button class="udlc-quick" type="button" data-udlc-world-example="기존 설정과 모순되지 않는 세계 법칙을 추가해 줘.">세계 법칙</button></div>
          <div class="toolbar"><button class="btn bp" id="btn-analyze-user-dlc-world" type="button">✨ 세계관에 맞춰 추가</button><span class="hint" id="user-dlc-world-status">원하는 내용을 입력해 주세요.</span></div>
        </div>
        <div id="user-dlc-world-preview"></div>
        <div id="user-dlc-world-results" class="list"></div>
      </div>
      <div class="wa-pane" role="tabpanel" data-udlc-pane="entity">
        <div class="udlc-editor">
          <div class="toolbar"><button class="btn bs" id="btn-refresh-user-dlc-targets" type="button">↻ 인물 목록 새로고침</button><span class="hint" id="user-dlc-target-count">인물 목록을 불러오는 중…</span></div>
          <div class="udlc-target-columns">
            <div class="udlc-target-box"><div class="udlc-target-title">반응을 분석할 LIBRA 인물</div><div id="user-dlc-entity-target-list"></div></div>
          </div>
          <div class="udlc-simple-label">선택한 인물에게 무엇을 추가할까요?</div>
          <div class="udlc-simple-help">상황별 반응, 관계에 따른 태도, 방어 능력, 생식 건강이나 질병 위험 등을 자연어로 적어 주세요. 선택 인물과 연결된 LIBRA 관계도는 자동으로 근거에 포함됩니다.</div>
          <div class="setting-note" id="user-dlc-retarget-banner" style="display:none"><span id="user-dlc-retarget-banner-text"></span> <button class="btn bs" id="btn-cancel-user-dlc-retarget" type="button">대상 편집 취소</button></div>
          <textarea id="udlc-entity-request" class="ec" rows="6" placeholder="예: 두 인물의 현재 관계에 따라 데이트나 친밀한 제안을 받았을 때의 예상 반응과 말투 기반 대사 예시를 추가해 줘."></textarea>
          <div class="udlc-quick-actions"><button class="udlc-quick" type="button" data-udlc-entity-example="현재 관계 단계에 따라 고백이나 데이트 제안을 받았을 때의 반응과 대사 예시를 추가해 줘.">고백·데이트</button><button class="udlc-quick" type="button" data-udlc-entity-example="친밀한 제안을 받았을 때 현재 호감·신뢰·경계에 따른 수락 가능성과 예상 반응을 추가해 줘.">친밀한 제안</button><button class="udlc-quick" type="button" data-udlc-entity-example="강압적인 행동을 당했을 때 거절·저항·방어·탈출 능력과 예상 반응을 추가해 줘.">거절·방어</button><button class="udlc-quick" type="button" data-udlc-entity-example="극중 날짜를 기준으로 월경 주기, 가임 가능성, 피임과 임신 가능성을 계속 추적해 줘.">생식 건강</button><button class="udlc-quick" type="button" data-udlc-entity-example="성인 인물의 섹스 횟수, 처녀 여부, 자위 횟수, 임신 횟수, 출산 횟수, 경험 인수, 질내사정 횟수, 펠라치오 횟수, 애널 섹스 횟수와 첫 섹스 상대를 계속 추적해 줘.">성경험 이력</button><button class="udlc-quick" type="button" data-udlc-entity-example="관련 노출과 극중 시간에 따라 질병·부상·회복 가능성을 계속 추적해 줘.">건강 상태</button></div>
          <div class="toolbar"><button class="btn bp" id="btn-analyze-user-dlc-entity" type="button">✨ 추가하고 사용</button><span class="hint" id="user-dlc-entity-status">반응을 분석할 인물을 한 명 이상 선택해 주세요.</span></div>
        </div>
        <div class="wa-pane-head"><div><div class="wa-pane-title">추가 요소 <span class="wa-tab-count" id="udlc-tracker-count">0</span></div><div class="wa-pane-note">사용은 응답 반영, 추적은 매 턴 자동 갱신을 뜻합니다. 전체 시나리오는 DB에 보관하고 현재 예상 결과만 응답에 전달합니다.</div></div></div>
        <div id="user-dlc-tracker-results" class="list"></div>
        <div class="wa-pane-head"><div><div class="wa-pane-title">이전 방식의 누적 분석</div><div class="wa-pane-note">기존 버전에서 저장한 데이터입니다.</div></div></div>
        <div id="user-dlc-entity-results" class="list"></div>
      </div>
    </div>
  <div id="tab-settings" class="panel">
    <div class="crumb">시스템 / <b>설정</b></div>
    <div class="page-head">
      <div><h2>설정</h2><div class="desc">일반 사용에 필요한 항목을 먼저 보여주고 전문 설정은 구역별로 분리합니다.</div></div>
    </div>
    <div class="sgrid">
      <div class="ss" data-settings-section="llm-profiles">
        <h3>🔌 프로바이더</h3>
        <div class="fld"><label>기본값</label><select id="sllmdefault"></select></div>
        <div class="fld"><label>프리셋</label><select id="sllmpresetselect"></select></div>
        <div class="toolbar llm-test-toolbar"><button class="btn bs" id="btn-llmp-new" type="button">새 프리셋</button><button class="btn bs" id="btn-llmp-clone" type="button">복제</button><button class="btn bs" id="btn-llmp-save" type="button">적용</button><button class="btn bs" id="btn-llmp-delete" type="button">삭제</button><button class="btn bs" id="btn-test-llmp" type="button">현재 프리셋 테스트</button></div>
        <div class="settings-note-line llm-test-status" id="llmp-test-status">프리셋 테스트 대기 중</div>
        <input type="hidden" id="sllmpinherit" value="primary">
        <input type="checkbox" id="sllmpenabled" checked hidden>
        <div class="fld"><label>프리셋 이름</label><input type="text" id="sllmpname" placeholder="예: fast, deep, image_aux"></div>
        <div class="fld"><label>프로필 제공자 <span class="setting-note">39개 직접 지원</span></label><select id="sllmpp"><option value="openai">openai</option><option value="claude">claude</option><option value="gemini">gemini</option><option value="openrouter">openrouter</option><option value="lmstudio">lmstudio</option><option value="ollama">ollama</option><option value="ollama_cloud">ollama_cloud</option><option value="nanogpt">nanogpt</option><option value="vertex">vertex</option><option value="vertex-openai">vertex-openai</option><option value="copilot">copilot</option><option value="custom">custom</option></select></div>
        <div class="fld"><label>API URL</label><input type="text" id="sllmpu" placeholder="provider 기본값을 사용하려면 비워둘 수 있습니다"></div>
        <div class="fld"><label>API Key / Token</label><input type="password" id="sllmpk" placeholder="비워두면 기존 값 유지"></div>
        <div class="vertex-json-tools" data-vertex-json-slot="preset" hidden>
          <label class="fld"><span>Vertex 서비스 계정 JSON 파일</span><input type="file" accept=".json,application/json" data-vertex-json-file="preset"><small>파일을 선택하면 이 LLM 프로필의 URL과 인증 JSON을 자동으로 채웁니다.</small></label>
          <label class="fld"><span>Vertex 서비스 계정 JSON 붙여넣기</span><textarea data-vertex-json-paste="preset" spellcheck="false" placeholder="{&quot;type&quot;:&quot;service_account&quot;,&quot;project_id&quot;:&quot;my-project&quot;}"></textarea></label>
          <div class="vertex-json-actions"><button class="btn bs" type="button" data-vertex-json-apply="preset">JSON 적용</button></div>
          <div class="vertex-preview-grid"><label class="fld"><span>Project ID</span><input type="text" readonly data-vertex-json-preview="preset:project_id"></label><label class="fld"><span>Client Email</span><input type="text" readonly data-vertex-json-preview="preset:client_email"></label><label class="fld field-wide"><span>Private Key Preview</span><textarea readonly rows="2" data-vertex-json-preview="preset:private_key" spellcheck="false"></textarea></label></div>
          <div class="settings-note-line" data-vertex-json-status="preset">Vertex 제공자를 선택하면 JSON 도구가 활성화됩니다.</div>
        </div>
        <div class="fld"><label>Model</label><input type="text" id="sllmpm" list="sllmp-provider-models" placeholder="예: glm-5.2:cloud"><datalist id="sllmp-provider-models"></datalist></div>
        <div class="toolbar llm-test-toolbar"><button class="btn bs" id="btn-llmp-refresh-models" type="button">모델 목록 불러오기</button><span class="settings-note-line" id="sllmp-model-status">제공자가 지원하면 API에서 최신 목록을 불러옵니다.</span></div>
        <div class="fld"><label>요청 형식</label><select id="sllmpfmt"><option value="chat_completions">Chat Completions (범용)</option><option value="responses">Responses</option></select><div class="setting-note" id="sllmpfmt-hint">대부분의 제공자는 Chat Completions를 사용합니다.</div></div>
        <div class="fld"><label>Temperature <span id="sllmptv">0.30</span></label><input type="range" id="sllmpt" min="0" max="2" step="0.05" value="0.30"></div>
        <div class="fld"><label>Timeout (ms)</label><input type="number" id="sllmpto" min="5000" max="600000" placeholder="120000"></div>
        <div class="fld"><label>Max Completion Tokens</label><input type="number" id="sllmpmc" min="64" placeholder="12000"></div>
        <div class="fld"><label>Reasoning Preset</label><select id="sllmprp"><option value="auto">Auto</option><option value="gpt">GPT</option><option value="gemini">Gemini</option><option value="claude">Claude</option><option value="deepseek">DeepSeek</option><option value="kimi">Kimi</option><option value="glm">GLM</option><option value="custom">Custom</option></select></div>
        <div class="fld"><label>Reasoning Effort</label><select id="sllmpre"><option value="none">사용 안 함</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
        <div class="fld"><label>Reasoning Budget Tokens</label><input type="number" id="sllmprb" placeholder="0"></div>
        <div class="fld"><label>GLM Thinking</label><select id="sllmpgt"><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></div>
        <div class="fld"><label>Service Tier <span class="setting-note">이 프로필에만 적용</span></label><select id="sllmpst"><option value="off">Off / Standard</option><option value="auto">auto</option><option value="default">default</option><option value="flex">flex</option><option value="priority">priority</option><option value="scale">scale</option></select><div class="setting-note">이 요청에 붙는 tier 값입니다. 어떤 호출을 Flex 로 보낼지는 <strong>설정 &gt; 모델 세부 설정과 Flex Service Tier</strong> 의 Flex Routing 이 전역으로 정합니다.</div></div>
        <div class="tr"><label>스트리밍 응답 집계</label><label class="tog"><input type="checkbox" id="sllmpstream"><span class="tsl"></span></label></div>
        <div class="fld field-wide"><label>작업별 사용 프리셋</label>
          <div class="setting-note">호출 수는 기능 ON/OFF와 캐시 상태에 따라 달라집니다. 실제 호출 수는 실시간 대시보드의 LLM 카운터에 표시됩니다.</div>
          <div class="fld"><label>상태 변동 관리자</label><select data-llm-routes="turnCanonicalPacket,mergeVerification"></select><div class="setting-note">예상 호출: 보통 응답 후 1회. 검증/보강이 필요한 경우 추가 호출이 붙을 수 있습니다.</div></div>
          <div class="fld"><label>기억/세계관 관리자</label><select data-llm-routes="turnMaintenanceBundle,worldAdditionalTurnAnalysis,characterStateConsolidation,worldStateConsolidation"></select><div class="setting-note">예상 호출: 보통 응답 후 백그라운드 0~1회. 월드 에디셔널과 상태 압축은 필요할 때 전용 경량 호출로 실행됩니다.</div></div>
          <div class="fld"><label>유저 DLC 전용</label><select id="sllm-user-dlc-profile" data-llm-routes="userDlcWorldAnalysis,userDlcEntityAnalysis,userDlcTrackerAnalysis"></select><div class="setting-note">World 적응 분석, Entity 누적 분석, 응답 후 커스텀 상태 추적에만 사용됩니다. 비워 두면 기본 프리셋을 상속합니다.</div></div>
          <div class="fld"><label>초기 상태/재분석 관리자</label><select data-llm-routes="coldStartChunkSummary,coldStartFinalSynthesis,guiWorldReanalysis,guiEntityReanalysis,guiNarrativeReanalysis"></select><div class="setting-note">예상 호출: 상시 호출 없음. 초기 로드나 GUI 재분석을 실행할 때 대화 분량에 따라 여러 번 호출됩니다.</div></div>
        </div>
        <textarea id="sllmpresets" style="display:none" spellcheck="false"></textarea>
        <textarea id="sllmrouting" style="display:none" spellcheck="false"></textarea>
      </div>
      <div class="ss">
        <h3>💸 Flex / Service Tier</h3>
        <div class="setting-note">Flex는 지연을 감수하는 저비용 tier입니다. 기본값은 꺼짐이며, 콜드 스타트·재분석·소스 반영 같은 백그라운드 작업에만 쓰는 것을 권장합니다.</div>
         <div class="setting-note setting-note-strong"><strong>Flex Routing 은 전역</strong>으로 어떤 호출을 Flex 로 보낼지 정합니다. 반면 LLM 프로필의 <strong>Service Tier</strong> 는 그 프로필이 보내는 요청 자체에 붙는 tier 값입니다 — 둘은 다른 계층이며, Routing 이 Off 면 개별 프로필의 tier 설정과 무관하게 Flex 로 가지 않습니다.</div>
        <div class="fld"><label>Flex Routing</label><select id="sfrm"><option value="off">Off</option><option value="background">Background only</option><option value="all">All supported LLM calls</option></select></div>
        <div class="fld"><label>Flex Timeout (ms)</label><input type="number" id="sfto" min="60000" max="1800000" placeholder="600000"></div>
        <div class="tr"><label>429/503/timeout 시 Standard 1회 fallback</label><label class="tog"><input type="checkbox" id="sffb"><span class="tsl"></span></label></div>
        <div class="fld"><label>Vertex Flex Mode</label><select id="svfm"><option value="provisioned_then_flex">Provisioned 우선, Flex fallback</option><option value="flex_only">Flex only</option></select></div>
        <div class="tr"><label>Custom provider에 service_tier 전달</label><label class="tog"><input type="checkbox" id="scstp"><span class="tsl"></span></label></div>
      </div>
      <div class="ss">
        <h3>🧠 Embedding 설정</h3>
        <div class="fld"><label>Provider</label><select id="sep"><option value="voyageai">VoyageAI · LIBRA 권장</option><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="gemini-embedding">Gemini Embedding</option><option value="lmstudio">LM Studio</option><option value="ollama">Ollama(local)</option><option value="vertex">Vertex</option><option value="vertex-embedding">Vertex Embedding</option><option value="custom">Custom</option></select></div>
        <div class="fld"><label>URL</label><input type="text" id="seu" placeholder="https://api.openai.com/v1/embeddings"></div>
        <div class="fld"><label>API Key / Vertex JSON</label><input type="password" id="sek" placeholder="sk-... 또는 Vertex service account JSON"></div>
        <div class="vertex-json-tools" data-vertex-json-slot="embedding" hidden>
          <label class="fld"><span>Embedding Vertex 서비스 계정 JSON 파일</span><input type="file" accept=".json,application/json" data-vertex-json-file="embedding"><small>JSON 파일을 선택하면 Embedding URL과 인증 JSON을 자동으로 채웁니다.</small></label>
          <label class="fld"><span>Embedding Vertex 서비스 계정 JSON 붙여넣기</span><textarea data-vertex-json-paste="embedding" spellcheck="false" placeholder='{&quot;type&quot;:&quot;service_account&quot;,&quot;project_id&quot;:&quot;my-project&quot;}'></textarea></label>
          <div class="vertex-json-actions"><button class="btn bs" type="button" data-vertex-json-apply="embedding">JSON 적용</button></div>
          <div class="vertex-preview-grid">
            <label class="fld"><span>Project ID</span><input type="text" readonly data-vertex-json-preview="embedding:project_id" placeholder="my-gcp-project"></label>
            <label class="fld"><span>Client Email</span><input type="text" readonly data-vertex-json-preview="embedding:client_email" placeholder="service-account@project.iam.gserviceaccount.com"></label>
            <label class="fld field-wide"><span>Private Key Preview</span><textarea readonly rows="2" data-vertex-json-preview="embedding:private_key" spellcheck="false"></textarea></label>
          </div>
          <div class="settings-note-line" data-vertex-json-status="embedding">Vertex embedding provider를 선택하면 JSON 도구가 활성화됩니다.</div>
        </div>
        <div class="fld"><label>Model</label><input type="text" id="sem" list="sem-provider-models" placeholder="voyage-4-large"><datalist id="sem-provider-models"></datalist><div class="setting-note">LIBRA 권장 모델은 voyage-4-large입니다. 모델은 자동 변경하지 않습니다.</div></div>
        <div class="fld"><label>Timeout (ms)</label><input type="number" id="seto" placeholder="120000"></div>
        <div class="tr"><label>Semantic embedding enabled</label><input type="checkbox" id="seenabled"></div>
        <div class="fld"><label>Expected dimension (unknown if blank)</label><input type="number" id="sedimension" min="1" max="8192" step="1"></div>
        <div class="fld"><label>Model revision (unknown if blank)</label><input type="text" id="serevision"></div>
        <div class="fld"><label>Recall mode</label><select id="sdual-mode"><option value="dual">Dual</option><option value="shadow">Shadow</option><option value="legacy">Legacy</option></select></div>
        <div class="fld"><label>Heuristic candidate depth</label><input type="number" id="sdual-hdepth" min="1" max="32" step="1"></div>
        <div class="fld"><label>Semantic candidate depth</label><input type="number" id="sdual-sdepth" min="1" max="32" step="1"></div>
        <div class="fld"><label>RRF rank constant</label><input type="number" id="sdual-rrf" min="1" max="1000" step="1"></div>
        <div class="fld"><label>Query budget (ms)</label><input type="number" id="sdual-budget" min="1" max="1500" step="1"></div>
        <div class="setting-note">uncalibrated operational default. Heuristic recall remains available while semantic configuration or current index coverage is unavailable.</div>
        ${['memory','entity','world','narrative'].map(f => `<div class="settings-subblock"><div class="settings-subtitle">${f} admission</div><div class="fld"><label>Heuristic minimum</label><input type="number" id="sdual-${f}-heuristic" min="0" step="any"></div><div class="fld"><label>Semantic cosine minimum</label><input type="number" id="sdual-${f}-semantic" min="-1" max="1" step="any"></div><div class="fld"><label>Semantic margin minimum</label><input type="number" id="sdual-${f}-margin" min="0" max="2" step="any"></div></div>`).join('')}
        <div class="settings-note-line" id="sdual-readiness" aria-live="polite"></div>
         <div class="toolbar llm-test-toolbar"><button class="btn bs" id="btn-test-embed" type="button">임베딩 연결 테스트</button><span class="settings-note-line llm-test-status" id="embed-test-status">임베딩 테스트 대기 중</span></div>
      </div>
      <div class="ss">
        <h3>⚖ 데이터 작성 & 가중치</h3>
        <div class="settings-subblock">
          <div class="settings-subtitle">회상 가중치</div>
          <div class="fld"><label>가중치 모드 <span class="setting-note">자동은 유사도·중요도·최신성을 LIBRA가 판단합니다. 직접 지정을 고르면 아래 세 값을 씁니다.</span></label><select id="swmode"><option value="auto">자동</option><option value="custom">직접 지정</option></select></div>
          <div class="fld"><label>유사도 가중치</label><input type="number" id="swsim" min="0" max="1" step="0.05" placeholder="예: 0.5"></div>
          <div class="fld"><label>중요도 가중치 (w_imp)</label><input type="number" id="swimp" min="0" max="1" step="0.05" placeholder="예: 0.3"></div>
          <div class="fld"><label>최신성 가중치 (w_rec)</label><input type="number" id="swrec" min="0" max="1" step="0.05" placeholder="예: 0.2"></div>
          <div class="setting-note">세 값은 합이 1에 가깝게 두는 것이 자연스럽습니다. 직접 지정일 때 회상 점수에 반영됩니다.</div>
        </div>
        <div class="settings-subblock">
          <div class="settings-subtitle">회상 선별</div>
          <div class="fld"><label>근거 게이트 <span class="setting-note">회상 결과에서 근거가 약한 항목을 걸러내는 강도입니다.</span></label><select id="sreg"><option value="off">Off</option><option value="soft">Soft (권장)</option><option value="strict">Strict</option></select></div>
          <div class="fld"><label>유사도 프로파일</label><select id="sscprof"><option value="balanced">balanced</option><option value="lexical">lexical</option><option value="strict">strict</option><option value="semantic">semantic</option><option value="salience">salience</option><option value="recency">recency</option><option value="entity_focus">entity_focus</option><option value="custom">custom</option></select></div>
          <div class="fld"><label>단어 가중치</label><input type="number" id="sscword" min="0" max="1" step="0.05" placeholder="예: 0.4"></div>
          <div class="fld"><label>문자 n-gram 가중치</label><input type="number" id="sscchar" min="0" max="1" step="0.05" placeholder="예: 0.25"></div>
          <div class="fld"><label>개념 가중치</label><input type="number" id="sscconcept" min="0" max="1" step="0.05" placeholder="예: 0.2"></div>
          <div class="fld"><label>어휘 포괄 가중치</label><input type="number" id="ssclex" min="0" max="1" step="0.05" placeholder="예: 0.1"></div>
          <div class="fld"><label>초점 인물 가중치</label><input type="number" id="sscfocus" min="0" max="1" step="0.05" placeholder="예: 0.05"></div>
          <div class="fld"><label>기억 항목 상한 <span class="setting-note">20~5000 사이입니다.</span></label><input type="number" id="smaxlimit" min="20" max="5000" step="10" placeholder="예: 360"></div>
          <div class="fld"><label>중요도 임계값 <span class="setting-note">중요도 등급 기준입니다. 이 값 미만인 기억은 회상에서 제외됩니다.</span></label><input type="number" id="sthr" min="1" max="10" step="1" placeholder="예: 4"></div>
          <div class="fld"><label>유사도 임계값 <span class="setting-note">0.01~1 사이 소수입니다. 낮출수록 더 많은 기억이 회상됩니다.</span></label><input type="number" id="ssimthr" min="0.01" max="1" step="0.01" placeholder="예: 0.2"></div>
          <div class="fld"><label>기억 프리셋</label><select id="smempreset"><option value="">(기본)</option><option value="sim_small">sim_small</option><option value="sim_large">sim_large</option><option value="balanced">balanced</option></select></div>
        </div>
        <div class="settings-subblock">
          <div class="settings-subtitle">프롬프트 주입</div>
          <div class="fld"><label>주입 예산 프리셋</label><select id="sinjbp"><option value="">(기본)</option><option value="compact">compact</option><option value="balanced">balanced</option><option value="large">large</option><option value="max">max</option><option value="custom">custom</option></select></div>
          <div class="fld"><label>주입 예산 토큰</label><input type="number" id="sinjbtok" min="0" placeholder="예: 4000"><div class="setting-note">custom 프리셋일 때 적용됩니다.</div></div>
        </div>
        <div class="settings-subblock">
          <div class="settings-subtitle">초기 구조 분석</div>
          <div class="fld"><label>분석 범위</label><select id="scsp"><option value="all">전체 대화</option><option value="recent100">최근 100개 메시지</option><option value="recent200">최근 200개 메시지</option><option value="recent500">최근 500개 메시지</option><option value="custom">사용자 지정</option></select></div>
          <div class="fld" id="schl-wrap"><label>사용자 지정 메시지 수</label><input type="number" id="schl" min="1" placeholder="예: 300"><div class="setting-note">전체 대화가 너무 길면 최근 N개만 구조 분석합니다.</div></div>
          <div class="fld"><label>현재 턴 분석 근거</label><select id="saem"><option value="assistant_only">AI 응답만 분석</option><option value="user_and_assistant">유저 입력 + AI 응답 분석</option></select><div class="setting-note">기본값은 현행 유지입니다. 유저 입력까지 켜면 사용자가 직접 쓴 행동/대사도 엔티티·세계관 분석 근거가 됩니다.</div></div>
          <div style="display:flex;gap:7px;flex-wrap:wrap">
            <button class="btn bp" id="btn-cold-start">🔄 초기 구조 분석</button>
            <button class="btn bp" id="btn-cold-reanalyze" data-reanalysis-mode="whole_conversation_merge">♻️ 전체 대화 재분석·보강 병합</button>
            <button class="btn bs" id="btn-add-user-lorebook">✍️ 수동 로어북 추가</button>
          </div>
          <div class="hint" id="historical-reanalysis-status" data-mode="whole_conversation_merge" role="status">전체 대화에서 검증된 보강분을 기존 정본에 병합합니다. 특정 턴의 교체·복원과는 다른 작업입니다.</div>
        </div>
      </div>
      <div class="ss">
        <h3>🔧 응답 개선</h3>
        <div class="settings-subblock">
          <div class="settings-subtitle">응답 / 진행 보조</div>
          <div class="fld"><label>실시간 작업 표시 <span class="setting-note">작업이 진행되는 동안 화면 상단 헤더에 현재 LIBRA 작업과 진행률을 표시합니다. 작업이 끝나면 자동으로 사라집니다.</span></label><select id="sactdash"><option value="compact">간단히 표시</option><option value="full">자세히 표시</option><option value="off">표시 안 함</option></select></div>
          <div class="tr"><label>디버그 기록 <span class="setting-note">켜면 최근 2턴의 요청 흐름, LLM 호출, 오류, 대시보드 상태를 디버그 내보내기에 남깁니다.</span><span class="settings-note-line" id="sdebug-status" aria-live="polite">꺼짐 · 상세 실행 기록을 저장하지 않습니다.</span></label><label class="tog"><input type="checkbox" id="sdebug" aria-label="디버그 기록"><span class="tsl"></span></label></div>
          <div class="fld"><label>NSFW 지침 모드 <span class="setting-note">OFF/SOFT/DIRECT/EXPLICIT 순으로 장면 지침 강도가 증가합니다.</span></label><select id="snsfwm"><option value="off">Off</option><option value="soft">Soft</option><option value="direct">Direct</option><option value="explicit">Explicit</option></select></div>
          <div class="tr setting-subordinate" id="sngp-row"><label>NSFW 지침 주입 <span class="setting-note">NSFW 모드가 OFF가 아닐 때 V4.2식 전용 지침을 프롬프트에 포함합니다.</span></label><label class="tog"><input type="checkbox" id="sngp"><span class="tsl"></span></label></div>
          <div class="tr"><label>Assistant prefill 사용 <span class="setting-note">NSFW/자동 계속쓰기용 assistant prefill 블록을 provider-safe 컨텍스트로 주입합니다.</span></label><label class="tog"><input type="checkbox" id="sapf"><span class="tsl"></span></label></div>
          <div class="fld"><label>스토리 작가 모드</label><select id="ssam"><option value="disabled">비활성</option><option value="supportive">서포트형</option><option value="proactive">주도형</option><option value="aggressive">강공형</option></select></div>
          <div class="fld"><label>감독 모드</label><select id="sdm"><option value="disabled">비활성</option><option value="light">라이트</option><option value="standard">표준</option><option value="strong">강함</option><option value="absolute">절대감독</option></select></div>
        <div class="settings-subblock">
          <div class="settings-subtitle">기억 엔진 / 기능 토글</div>
          <div class="tr"><label>감정 추적 <span class="setting-note">감정 강도가 높은 기억의 중요도를 올립니다.</span></label><input type="checkbox" id="semotion"></div>
          <div class="tr"><label>비밀 지식 가드 <span class="setting-note">인물별로 아는 것/모르는 것을 구분해 메타 누출을 막습니다.</span></label><input type="checkbox" id="ssecret"></div>
          <div class="tr"><label>인물 지식 금고</label><input type="checkbox" id="svault"></div>
          <div class="tr"><label>CBS 호환 <span class="setting-note">RisuAI CBS 문법을 해석합니다.</span></label><input type="checkbox" id="scbs"></div>
          <div class="tr"><label>캐릭터 설명·로어북 반영 <span class="setting-note">캐릭터 카드의 설명과 로어북을 LIBRA 데이터 근거로 씁니다.</span></label><input type="checkbox" id="screfl"></div>
          <div class="tr"><label>페르소나 연결 동기화</label><input type="checkbox" id="spsync"></div>
          <div class="tr"><label>섹션 세계 추론</label><input type="checkbox" id="sswi"></div>
          <div class="tr"><label>응답 스트리밍 호환 <span class="setting-note">스트리밍 응답이 끝난 뒤 LIBRA 데이터를 커밋합니다.</span></label><input type="checkbox" id="sstream"></div>
          <div class="tr"><label>보조 요청 건너뛰기 <span class="setting-note">기억/감정/번역 같은 보조 요청에는 LIBRA를 건너뜁니다.</span></label><input type="checkbox" id="sbypass"></div>
          <div class="tr"><label>로어북 RAG</label><input type="checkbox" id="srag"></div>
        </div>
        <div class="settings-subblock">
          <div class="settings-subtitle">하이브리드 메모리 엔진 (HME)</div>
          <div class="tr"><label>HME 사용 <span class="setting-note">기억을 유형별 행으로 관리해 회상 정확도를 높입니다.</span></label><input type="checkbox" id="shme"></div>
          <div class="fld"><label>연상 그래프 회상 <span class="setting-note">관련 기억을 그래프로 확장해 함께 회상합니다.</span></label><select id="shmegraph"><option value="off">Off</option><option value="light">light</option><option value="balanced">balanced</option><option value="deep">deep</option></select></div>
          <div class="fld"><label>그래프 디버그</label><select id="shmedbg"><option value="off">Off</option><option value="compact">compact</option><option value="full">full</option></select></div>
        </div>
        <div class="settings-subblock">
          <div class="settings-subtitle">RP 장기 기억</div>
          <div class="tr"><label>RP 장기 연속성 원장 <span class="setting-note">역할극의 장기 흐름을 별도 원장으로 유지합니다.</span></label><input type="checkbox" id="srplt"></div>
          <div class="fld"><label>장기 기억 TTL (턴)</label><input type="number" id="srplttl" min="120" placeholder="예: 400"></div>
          <div class="fld"><label>주입 최대 글자 수</label><input type="number" id="srplchars" min="400" placeholder="예: 1200"></div>
        </div>
        <div class="settings-subblock">
          <div class="settings-subtitle">유지보수 / 응답 처리</div>
          <div class="tr"><label>afterRequest 병렬 분석 <span class="setting-note">패킷 분석과 유지보수를 병렬로 돌려 대기 시간을 줄입니다.</span></label><input type="checkbox" id="sapara"></div>
        </div>
        </div>
      </div>
      </div>
    <div class="sec">🩺 데이터 헬스 리뷰</div>
    <div id="health-summary" class="cs"></div>
    <div class="health-toolbar">
      <button class="btn bs" id="btn-health-scan" type="button">무결성 스캔</button>
      <button class="btn" id="btn-health-refresh" type="button">새로고침</button>
      <button class="btn" id="btn-health-repair-preview" type="button">안전 복구 미리보기</button>
      <button class="btn" id="btn-health-repair-apply" type="button" disabled>캐시 복구 실행</button>
    </div>
    <div id="health-recovery-status" class="cs" role="status">읽기 전용 검사 · 자동 모델 재분석 없음</div>
    <div class="health-panel-grid">
      <div class="health-panel"><h4>검역 대기</h4><div id="health-quarantine-list" class="health-list"><div class="empty">검역 항목 없음</div></div></div>
      <div class="health-panel"><h4>충돌/모순</h4><div id="health-conflict-list" class="health-list"><div class="empty">충돌 항목 없음</div></div></div>
      <div class="health-panel"><h4>무결성 경고</h4><div id="health-integrity-list" class="health-list"><div class="empty">무결성 경고 없음</div></div></div>
    </div>
    <div class="sec">📊 캐시 통계</div>
    <div id="cst" class="cs"></div>
    <div class="settings-overview"><div class="settings-overview-copy"><strong>검색 캐시</strong><span id="cache-reset-status">파생 검색 자료만 초기화하며 원본 LIBRA 데이터는 보존합니다.</span></div><button class="btn bs" id="lmai-cache-reset" type="button">검색 캐시 초기화</button></div>
    <input type="file" id="settings-file-input" accept=".json,application/json" style="display:none">
    <div class="sbar settings-actions">
      <span class="settings-note-line" id="settings-auto-save-status" aria-live="polite">전역 설정 자동 저장 켜짐</span>
      <button class="btn bp" id="btn-transition">🚀 다음 세션으로 대화 이어가기</button>
      <button class="btn" id="btn-export-settings-file">📤 설정 내보내기</button>
      <button class="btn" id="btn-import-settings-file">📥 설정 가져오기</button>
      <button class="btn" id="btn-export-debug-file">🧪 디버그 내보내기</button>
      <button class="btn bp" id="btn-save-settings">💾 설정 저장</button>
      <button class="btn bd" id="btn-reset-settings">🔄 설정 초기화</button>
      <button class="btn bd" id="lmai-data-reset">🗑 현재 페르소나의 LIBRA 기억 초기화</button>
      <span id="data-reset-status" aria-live="polite"></span>
    </div>
  </div>
</div>
</div>
<div id="toast" class="toast"></div>
    `;

    // Pure, DOM-independent snapshot/renderer helpers.  The simulator uses these
    // same functions as the GUI so a green test means the stored planner data is
    // actually convertible into the user-visible view, not merely present in lore.
    const cloneNarrativeInspectorValue = (value, fallback = {}) => {
        try { return JSON.parse(JSON.stringify(value ?? fallback)); }
        catch (_) { return JSON.parse(JSON.stringify(fallback)); }
    };
    const escapeNarrativeInspectorHtml = (value = '') => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const parseNarrativeInspectorEntry = (entry, fallback = {}) => {
        if (!entry) return { state: cloneNarrativeInspectorValue(fallback), parseError: false };
        try {
            const parsed = JSON.parse(String(entry.content || '{}'));
            return {
                state: cloneNarrativeInspectorValue(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback),
                parseError: false
            };
        } catch (_) {
            return { state: cloneNarrativeInspectorValue(fallback), parseError: true };
        }
    };
    const hasNarrativeInspectorState = (kind, state = {}) => {
        if (!state || typeof state !== 'object') return false;
        if (kind === 'author') {
            return Number(state.lastPlanTurn || 0) > 0 || Boolean(state.currentArc || state.narrativeGoal)
                || (Array.isArray(state.nextBeats) && state.nextBeats.length > 0);
        }
        if (kind === 'director') {
            return Number(state.lastTurn || 0) > 0 || Boolean(state.sceneMandate)
                || (Array.isArray(state.requiredOutcomes) && state.requiredOutcomes.length > 0);
        }
        return (Array.isArray(state.storylines) && state.storylines.length > 0)
            || (Array.isArray(state.turnLog) && state.turnLog.length > 0);
    };
    const buildNarrativeInspectorSnapshot = (lorebook = [], fallbacks = {}) => {
        let managed = Array.isArray(lorebook) ? lorebook : [];
        try {
            if (typeof LibraLoreConsolidator !== 'undefined' && typeof LibraLoreConsolidator.unpack === 'function') {
                managed = LibraLoreConsolidator.unpack(managed);
            }
        } catch (_) { /* plain lore remains usable */ }
        const findEntry = comment => managed.find(item => item?.comment === comment) || null;
        const narrativeEntry = findEntry('lmai_narrative');
        const authorEntry = findEntry('lmai_story_author');
        const directorEntry = findEntry('lmai_director');
        const narrativeParsed = parseNarrativeInspectorEntry(narrativeEntry, fallbacks.narrativeState || { storylines: [], turnLog: [], lastSummaryTurn: 0 });
        const authorParsed = parseNarrativeInspectorEntry(authorEntry, fallbacks.storyAuthorState || {});
        const directorParsed = parseNarrativeInspectorEntry(directorEntry, fallbacks.directorState || {});
        const config = fallbacks.config && typeof fallbacks.config === 'object' ? fallbacks.config : {};
        const authorMode = String(config.storyAuthorMode || 'disabled').toLowerCase();
        const directorMode = String(config.directorMode || 'disabled').toLowerCase();
        const narrativeState = narrativeParsed.state || {};
        const authorState = authorParsed.state || {};
        const directorState = directorParsed.state || {};
        return {
            narrative: {
                stored: Boolean(narrativeEntry),
                available: Boolean(narrativeEntry) || hasNarrativeInspectorState('narrative', narrativeState),
                parseError: narrativeParsed.parseError,
                storylineCount: Array.isArray(narrativeState.storylines) ? narrativeState.storylines.length : 0,
                turnLogCount: Array.isArray(narrativeState.turnLog) ? narrativeState.turnLog.length : 0,
                state: narrativeState
            },
            storyAuthor: {
                stored: Boolean(authorEntry),
                available: Boolean(authorEntry) || hasNarrativeInspectorState('author', authorState),
                parseError: authorParsed.parseError,
                configuredEnabled: config.storyAuthorEnabled === true && authorMode !== 'disabled',
                configuredMode: authorMode,
                state: authorState
            },
            director: {
                stored: Boolean(directorEntry),
                available: Boolean(directorEntry) || hasNarrativeInspectorState('director', directorState),
                parseError: directorParsed.parseError,
                configuredEnabled: config.directorEnabled === true && directorMode !== 'disabled',
                configuredMode: directorMode,
                state: directorState
            }
        };
    };
    const NARRATIVE_INSPECTOR_LABELS = Object.freeze({
        disabled: '비활성', supportive: '서포트형', proactive: '주도형', aggressive: '강공형',
        light: '가볍게', standard: '표준', strong: '강하게', absolute: '절대 지휘',
        active: '사용 중', dirty: '갱신 필요', stale: '유효 기간 만료', retracted: '철회됨',
        full: '전체 갱신', reuse: '기존 계획 재사용', unknown: '확인 중',
        setup: '도입', development: '전개', escalation: '긴장 고조', turning_point: '전환점',
        aftermath: '여파', transition: '장면 전환',
        dialogue: '대화', decision: '선택', reveal: '정보 공개', confrontation: '대립',
        intimacy: '친밀감', interruption: '돌발 상황', consequence: '결과 반영',
        subtle: '은은한 연출', balanced: '균형 잡힌 연출', forceful: '분명한 연출',
        steady: '안정적인 속도', measured: '여유 있는 속도', brisk: '빠른 속도', relentless: '멈추지 않는 속도',
        'follow-current-user-rhythm': '현재 사용자의 흐름을 따름',
        'vary-beat-and-state': '전개 방식과 장면 상태에 변화를 줌',
        'introduce-grounded-change': '현재 상황에 근거한 변화를 추가함',
        empty_continue: '현재 장면 계속', ooc_correction: '설정·메타 정정', ic_dialogue: '극중 대화',
        request_or_choice: '요청 또는 선택', ic_action: '극중 행동',
        soft_continuation_only: '현재 장면 안에서 자연스럽게 이어가기',
        no_major_jump_without_user_signal: '사용자 신호 없이 큰 장면 전환 금지',
        open: '진행 중', resolved: '해결됨', resolved_light: '가볍게 해소됨',
        possible: '가능성 있음', confirmed: '확정됨', unknown_status: '판단 보류'
    });
    const NARRATIVE_INSPECTOR_KEY_LABELS = Object.freeze({
        turn: '기준 턴', currentUserIntent: '현재 사용자 의도', userIntentType: '의도 유형',
        povEntity: '시점 인물', activeParticipants: '현재 등장인물', location: '현재 장소', sceneTime: '극중 시간',
        hardContinuityLocks: '반드시 유지할 연속성', userAgencyLocks: '사용자 선택권 보호', protectedSecrets: '아직 공개하지 않을 비밀',
        activeWorldRules: '현재 적용되는 세계 규칙', currentRelationshipStates: '현재 관계 상태', unresolvedThreads: '남아 있는 이야기',
        forbiddenJumps: '피해야 할 급전개', allowedTransitionLevel: '허용되는 장면 전환', confidence: '판단 신뢰도', status: '현재 상태',
        scenePhase: '장면 단계', momentumScore: '이야기 추진력', stallRisk: '정체 위험', repetitionRisk: '반복 위험',
        dialogueLoopRisk: '대화 반복 위험', openTensions: '해결되지 않은 긴장', payoffCandidates: '회수 가능한 요소',
        recommendedBeatType: '추천 전개', recommendedPacing: '추천 진행 속도', userIntentAlignment: '사용자 의도 반영 원칙',
        doNotResolveYet: '아직 해결하지 않을 요소', sceneExitReadiness: '장면 전환 준비도',
        refreshMode: '갱신 방식', generatedAtTurn: '계획 생성 턴', validUntilTurn: '계획 유효 턴', lastObservedTurn: '최근 확인 턴',
        reuseCount: '재사용 횟수', dirtyReasons: '갱신이 필요한 이유', contextChanged: '상황 변화 여부'
    });
    const NARRATIVE_INSPECTOR_HIDDEN_KEYS = new Set([
        'schema', 'schemaVersion', 'sceneId', 'signature', 'sourceMessageIds', 'lastObservedSourceMessageIds',
        'inputSignature', 'lastObservedInputSignature', 'messageId', 'm_id', 'spanHash', 'evidenceRefs',
        'generatedAt', 'updatedAt', 'lastUpdated', 'id', 'key'
    ]);
    const NARRATIVE_INSPECTOR_FIXED_TEXT = new Map([
        ['Ongoing Story', '진행 중인 이야기'],
        ['Align the next story beat with the latest user input and confirmed continuity.', '다음 전개는 최신 사용자 입력을 우선 반영하면서 확정된 연속성을 유지합니다.'],
        ['Continue the active scene from its current state without inventing a new premise.', '새로운 전제를 만들지 않고 현재 장면을 그대로 이어갑니다.'],
        ['Continue the active scene without restarting or inventing a new premise.', '장면을 다시 시작하거나 새로운 전제를 만들지 않고 현재 흐름을 이어갑니다.'],
        ['Continue from the immediately active scene without restarting it and advance one grounded beat.', '현재 장면을 다시 시작하지 않고, 상황에 근거한 전개를 한 단계 진행합니다.'],
        ['Continue from the immediately active scene without restarting or recapping it.', '현재 장면을 다시 시작하거나 요약하지 않고 바로 이어갑니다.'],
        ['Continue the immediately active scene from its current state.', '현재 진행 중인 장면을 그 상태에서 이어갑니다.'],
        ['The next response should answer the current user intent while preserving continuity.', '다음 응답은 연속성을 지키면서 현재 사용자의 의도에 직접 답해야 합니다.'],
        ['The latest user input is the primary response axis; planner guidance may only support it.', '최신 사용자 입력을 최우선으로 따르며, 작가와 감독의 지시는 이를 보조하는 범위에서만 사용합니다.'],
        ['Preserve the most relevant unresolved tension without forcing a premature payoff.', '가장 중요한 미해결 긴장을 유지하되 너무 이르게 결론내지 않습니다.'],
        ['A different beat is needed to avoid narrative repetition.', '같은 전개가 반복되지 않도록 다른 방식의 장면 변화가 필요합니다.'],
        ['Use current world and relationship pressure as constraints or possibilities, not guaranteed outcomes.', '현재 세계와 관계의 압력은 가능성과 제약으로 활용하되 확정된 결과처럼 강요하지 않습니다.'],
        ['Change the beat type or produce a concrete state change instead of repeating the previous emotional confirmation.', '이전의 감정 확인을 반복하지 말고 전개 방식을 바꾸거나 구체적인 상태 변화를 만듭니다.'],
        ['Before the response ends, create a meaningful consequence, decision, reveal, interruption, or relationship shift.', '응답이 끝나기 전에 의미 있는 결과·선택·정보 공개·돌발 상황·관계 변화를 하나 만듭니다.'],
        ['Do not skip or replace the current user turn.', '현재 사용자 턴을 건너뛰거나 다른 내용으로 대체하지 않습니다.'],
        ['Do not change location, time, participants, relationship state, or established knowledge without current-turn cause.', '현재 턴에 근거가 없다면 장소·시간·등장인물·관계·확정된 정보를 바꾸지 않습니다.'],
        ['Do not turn predicted pressure into an already completed canon event.', '예상되는 압력을 이미 일어난 확정 사건처럼 취급하지 않습니다.'],
        ['Do not decide the user persona’s actions, consent, private feelings, desire, bodily reaction, or final choice.', '사용자 캐릭터의 행동·동의·내면·욕구·신체 반응·최종 선택을 대신 결정하지 않습니다.'],
        ['Respond to the latest user turn before following lower-priority planner guidance.', '낮은 우선순위의 작가·감독 지시보다 최신 사용자 턴에 먼저 응답합니다.'],
        ['Create one visible, continuity-grounded change before the response ends.', '응답이 끝나기 전에 연속성에 근거한 눈에 보이는 변화를 하나 만듭니다.'],
        ['Do not create a new story goal independent of the Story Author plan.', '스토리 작가의 계획과 무관한 새 서사 목표를 만들지 않습니다.'],
        ['Do not contradict established world rules, relationship states, known facts, or the latest user input.', '확정된 세계 규칙·관계 상태·사실·최신 사용자 입력과 충돌하지 않습니다.'],
        ['Render direction through visible action, dialogue, pacing, or consequence rather than backstage explanation.', '설정 설명 대신 실제 행동·대사·속도·결과로 연출 의도를 보여줍니다.'],
        ['Use remembered dialogue as voice and continuity evidence, not as lines to copy verbatim.', '기억된 대사는 말투와 연속성의 근거로만 사용하고 그대로 복사하지 않습니다.'],
        ['Follow the current user-led rhythm.', '현재 사용자가 이끄는 장면의 리듬을 따릅니다.'],
        ['End after a concrete state change or consequential turn, not before it.', '구체적인 상태 변화나 의미 있는 전개가 발생한 뒤에 장면을 마칩니다.']
    ]);
    const narrativeInspectorLabel = (value, fallback = '') => {
        const key = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        return NARRATIVE_INSPECTOR_LABELS[key] || fallback || String(value ?? '').trim();
    };
    const narrativeInspectorTryJson = (value = '') => {
        const text = String(value || '').trim().replace(/^•\s*/, '');
        if (!((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) return null;
        try { return JSON.parse(text); } catch (_) { return null; }
    };
    const naturalizeNarrativeInspectorString = (value = '') => {
        const text = String(value ?? '').trim().replace(/^•\s*/, '');
        if (!text) return '';
        const parsed = narrativeInspectorTryJson(text);
        if (parsed !== null) return narrativeInspectorText(parsed);
        if (NARRATIVE_INSPECTOR_FIXED_TEXT.has(text)) return NARRATIVE_INSPECTOR_FIXED_TEXT.get(text);
        if (/^Potential payoff:\s*/i.test(text)) return `회수 가능성: ${naturalizeNarrativeInspectorString(text.replace(/^Potential payoff:\s*/i, ''))}`;
        if (/^Where natural, realize this author beat:\s*/i.test(text)) return `장면 흐름에 어울릴 경우 반영: ${naturalizeNarrativeInspectorString(text.replace(/^Where natural, realize this author beat:\s*/i, ''))}`;
        if (/^Keep staging centered on\s+/i.test(text)) {
            const names = text.replace(/^Keep staging centered on\s+/i, '').replace(/\s+unless the user introduces another active participant\.?$/i, '');
            return `${names}을(를) 중심으로 연출하되, 사용자가 새 등장인물을 참여시키면 그 변화를 반영합니다.`;
        }
        if (/^Turn\s+(\d+)\s*:/i.test(text)) return text.replace(/^Turn\s+(\d+)\s*:/i, '$1턴:');
        const prefixed = text.match(/^(beat|preserve|world|thread|focus|pacing|pressure|ending)\s*:\s*(.+)$/i);
        if (prefixed) {
            const prefixLabels = { beat: '추천 전개', preserve: '유지할 요소', world: '세계관 조건', thread: '이어갈 이야기', focus: '중심 인물', pacing: '진행 속도', pressure: '장면 압력', ending: '마무리 조건' };
            return `${prefixLabels[prefixed[1].toLowerCase()] || prefixed[1]}: ${naturalizeNarrativeInspectorString(prefixed[2])}`;
        }
        const enumLabel = narrativeInspectorLabel(text);
        return enumLabel !== text ? enumLabel : text;
    };
    const narrativeInspectorObjectLines = (value = {}) => {
        const main = value.description ?? value.summary ?? value.text ?? value.label ?? value.name ?? value.title ?? value.content;
        const lines = [];
        if (main != null) {
            const mainText = naturalizeNarrativeInspectorString(main);
            if (mainText) lines.push(mainText);
        }
        const statusValue = value.status ?? value.state;
        if (statusValue != null && String(statusValue).trim()) {
            const statusText = narrativeInspectorLabel(statusValue);
            if (statusText && !lines.some(line => line.includes(statusText))) lines.push(`현재 상태: ${statusText}`);
        }
        if (lines.length) return lines;
        return Object.entries(value)
            .filter(([key, item]) => !NARRATIVE_INSPECTOR_HIDDEN_KEYS.has(key) && item != null && item !== '' && !(Array.isArray(item) && item.length === 0))
            .flatMap(([key, item]) => {
                const label = NARRATIVE_INSPECTOR_KEY_LABELS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2');
                const text = narrativeInspectorText(item);
                return text ? [`${label}: ${text.replace(/\n•\s*/g, ' / ')}`] : [];
            });
    };
    function narrativeInspectorLines(value) {
        if (value == null || value === '') return [];
        if (Array.isArray(value)) return value.flatMap(item => narrativeInspectorLines(item)).filter(Boolean);
        if (value && typeof value === 'object') return narrativeInspectorObjectLines(value).filter(Boolean);
        const text = naturalizeNarrativeInspectorString(value);
        return text ? String(text).split(/\n+/).map(item => item.replace(/^•\s*/, '').trim()).filter(Boolean) : [];
    }
    function narrativeInspectorText(value) {
        return narrativeInspectorLines(value).join('\n• ');
    }
    const renderNarrativeInspectorField = (label, value) => {
        const lines = narrativeInspectorLines(value);
        if (!lines.length) return '';
        const display = lines.length > 1 || Array.isArray(value) || (value && typeof value === 'object')
            ? lines.map(line => `• ${line}`).join('\n')
            : lines[0];
        return `<div class="memory-readable"><div class="memory-readable-title">${escapeNarrativeInspectorHtml(label)}</div><div style="white-space:pre-wrap;word-break:break-word;line-height:1.55">${escapeNarrativeInspectorHtml(display)}</div></div>`;
    };
    const renderNarrativeInspectorDetails = (label, value) => {
        if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return '';
        const readableFields = Object.entries(value)
            .filter(([key, item]) => !NARRATIVE_INSPECTOR_HIDDEN_KEYS.has(key) && item != null && item !== '' && !(Array.isArray(item) && item.length === 0))
            .map(([key, item]) => renderNarrativeInspectorField(NARRATIVE_INSPECTOR_KEY_LABELS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2'), item))
            .filter(Boolean)
            .join('');
        if (!readableFields) return '';
        return `<details class="card mem"><summary>${escapeNarrativeInspectorHtml(label)}</summary><div style="display:grid;gap:8px;margin-top:10px">${readableFields}</div></details>`;
    };
    const renderNarrativeInspectorHtml = (snapshot = {}, kind = 'author') => {
        const isDirector = kind === 'director';
        const branch = isDirector ? snapshot?.director : snapshot?.storyAuthor;
        const label = isDirector ? '감독' : '스토리 작가';
        if (!branch?.available) return `<div class="empty">저장된 ${label} 데이터가 없습니다</div>`;
        const state = branch.state && typeof branch.state === 'object' ? branch.state : {};
        const meta = state.plannerMeta && typeof state.plannerMeta === 'object' ? state.plannerMeta : {};
        const lastTurn = Number(isDirector ? state.lastTurn : state.lastPlanTurn) || 0;
        const title = naturalizeNarrativeInspectorString(isDirector ? (state.sceneMandate || '감독 장면 지시') : (state.currentArc || '스토리 작가 플랜'));
        const status = String(meta.status || (lastTurn ? 'active' : 'stale'));
        const refreshMode = String(meta.refreshMode || 'unknown');
        const configModeLabel = narrativeInspectorLabel(branch.configuredMode, branch.configuredMode);
        const configLabel = branch.configuredEnabled ? `${configModeLabel}으로 사용 중` : '현재 설정에서 사용하지 않음';
        const badges = [
            `<span class="bdg ${branch.configuredEnabled ? 'bm' : 'bl'}">${escapeNarrativeInspectorHtml(configLabel)}</span>`,
            `<span class="bdg bt">${branch.stored ? 'DB에 저장됨' : '현재 실행에서만 사용 중'}</span>`,
            `<span class="bdg ${status === 'active' ? 'bm' : 'bt'}">${escapeNarrativeInspectorHtml(narrativeInspectorLabel(status, status))}</span>`,
            `<span class="bdg bt">${escapeNarrativeInspectorHtml(narrativeInspectorLabel(refreshMode, refreshMode))}</span>`,
            `<span class="bdg bl">T${lastTurn}</span>`,
            branch.parseError ? '<span class="bdg bh">저장 데이터 해석 필요</span>' : ''
        ].filter(Boolean).join('');
        const generated = Number(meta.generatedAtTurn || 0) || 0;
        const validUntil = Number(meta.validUntilTurn || 0) || 0;
        const escalationDelta = Number(state.escalationDelta || 0) || 0;
        const summary = [
            ['최근 반영', lastTurn ? `T${lastTurn}` : '아직 없음'],
            ['계획 생성', generated ? `T${generated}` : '아직 없음'],
            ['적용 범위', validUntil ? `T${validUntil}까지` : '현재 장면'],
            ['재사용', `${Number(meta.reuseCount || 0) || 0}회`],
            [isDirector ? '연출 방식' : '장면 단계', narrativeInspectorLabel(isDirector ? state.executionMode : state.scenePhase, '미정')],
            [isDirector ? '실행할 전개' : '추천 전개', narrativeInspectorLabel(isDirector ? state.beatTypeToExecute : state.recommendedBeatType, '미정')],
            [isDirector ? '장면 강도' : '긴장 변화', isDirector
                ? `${narrativeInspectorLabel(state.pressureLevel, state.pressureLevel || '미정')} · ${narrativeInspectorLabel(state.targetPacing, state.targetPacing || '미정')}`
                : (escalationDelta > 0 ? `${escalationDelta}단계 높임` : escalationDelta < 0 ? `${Math.abs(escalationDelta)}단계 낮춤` : '현재 수준 유지')]
        ].map(([key, value]) => `<div class="ci"><b>${escapeNarrativeInspectorHtml(key)}</b><br>${escapeNarrativeInspectorHtml(value)}</div>`).join('');
        const fields = isDirector ? [
            ['장면 명령', state.sceneMandate],
            ['필수 결과', state.requiredOutcomes],
            ['금지 동작', state.forbiddenMoves],
            ['강조점', state.emphasis],
            ['스테이징 지시', state.stagingInstructions],
            ['대사 지시', state.dialogueInstructions],
            ['페이싱 지시', state.pacingInstructions],
            ['연속성 잠금', state.continuityLocks],
            ['작가 플랜 입력', state.authorPlanInputs],
            ['월드 매니저 입력', state.worldManagerInputs],
            ['중심 인물', state.focusCharacters],
            ['종료 요구', state.endingRequirement]
        ] : [
            ['서사 목표', state.narrativeGoal],
            ['주요 긴장', state.primaryTension],
            ['활성 긴장', state.activeTensions],
            ['열린 질문', state.openQuestions],
            ['회수 후보', state.payoffCandidates],
            ['다음 비트', state.nextBeats],
            ['비트 이유', state.beatReason],
            ['가드레일', state.guardrails],
            ['아직 해결 금지', state.doNotResolveYet],
            ['중심 인물', state.focusCharacters],
            ['관계 상태 신호', state.relationStateSignals],
            ['월드 매니저 힌트', state.worldManagerHints],
            ['환경 압력', state.environmentPressures],
            ['스토리라인 이어짐', state.storylineCarryoverSignals],
            ['사용자 의도 정렬', state.userIntentAlignment]
        ];
        return `<div class="card nar" data-narrative-inspector="${isDirector ? 'director' : 'author'}">
            <div class="card-hdr"><div><div class="card-meta">${badges}</div><div class="card-title">${escapeNarrativeInspectorHtml(title)}</div></div></div>
            <div class="cs">${summary}</div>
          </div>
          ${fields.map(([fieldLabel, value]) => renderNarrativeInspectorField(fieldLabel, value)).filter(Boolean).join('')}
          ${renderNarrativeInspectorDetails('현재 장면의 기준', state.sceneContract)}
          ${renderNarrativeInspectorDetails('서사 흐름 점검', state.narrativeDiagnostics)}
          ${renderNarrativeInspectorDetails('계획 갱신 정보', meta)}`;
    };
