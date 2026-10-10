    // One volatile active-scope preimage. Tokens are private object identities,
    // never inferred from a global active transaction or serialized into lore.
    let reuseVerifiedBaselinePostRaw;
    const LatestTurnBaselineOwner = (() => {
        let slot = null;
        const snapshots = new WeakMap();
        let unavailableReason = 'no_current_runtime_baseline';
        const invalidate = reason => { slot = null; unavailableReason = String(reason || 'baseline_invalidated'); };
        const topology = (chat, sourceReceipt = null) => {
            const editableIds = new Set([...(sourceReceipt?.userIds || []),...(sourceReceipt?.assistantIds || [])]);
            const messages = getChatMessages(chat);
            if (!messages.length) return null;
            const rows = [];
            for (const message of messages) {
                const ids = normalizeCanonicalMessageIds([message?.id,message?.messageId,message?.m_id,message?.uuid,message?.key,message?.chatId,message?.generationInfo?.generationId]);
                if (!ids.length) return null;
                const editable = ids.some(id => editableIds.has(id));
                const bodies = ['data','content','text'].filter(key => typeof message?.[key] === 'string').map(key => message[key]);
                if (!editable && (!bodies.length || bodies.some(body => body !== bodies[0]))) return null;
                rows.push([String(message?.role || ''),ids.slice().sort(),!!message.disabled,!!message.isComment,!!message.isOOC,
                    editable ? null : bodies[0]]);
            }
            return JSON.stringify(rows);
        };
        const current = () => {
            if (slot && !RuntimeStateLease.isCurrent(slot.lease)) invalidate('runtime_lease_changed');
            return slot;
        };
        const begin = ({ proof, sourceReceipt, canonicalMemoryId, turn, chat, lease } = {}) => {
            if (runtimeDetached) return null;
            const hadUnfinished = current()?.state === 'capturing';
            invalidate('new_turn_not_eligible');
            if (hadUnfinished || MaintenanceLLMQueue.activeCount || MaintenanceLLMQueue.pendingCount
                || BackgroundMaintenanceQueue.activeCount || BackgroundMaintenanceQueue.pendingCount
                || [...MemoryState.turnMaintenanceSchedulesByChatId.values()].some(entry => entry?.running || entry?.queued || entry?.timer || (entry?.pendingRecords?.length || 0) > 0)
                || MemoryState.afterRequestForegroundTasksByScope.size) {
                unavailableReason = 'previous_analysis_not_quiescent'; return null;
            }
            if (!proof?.ok || !Object.prototype.hasOwnProperty.call(proof,'canonicalRaw')
                || (proof.canonicalRaw !== null && typeof proof.canonicalRaw !== 'string')
                || sourceReceipt?.state !== 'bound' || sourceReceipt.canonicalScope !== proof.scopeKey
                || sourceReceipt.resetGeneration !== proof.resetGeneration || !canonicalMemoryId
                || !RuntimeStateLease.isCurrent(lease)) { unavailableReason = 'prospective_owner_proof_unavailable'; return null; }
            const nativeTopology = topology(chat,sourceReceipt);
            if (!nativeTopology) { unavailableReason = 'native_topology_identity_unavailable'; return null; }
            const token = Object.freeze({});
            slot = { token, state:'capturing', beforeRaw:proof.canonicalRaw, postRaw:null,
                scopeKey:proof.scopeKey, resetGeneration:proof.resetGeneration, canonicalMemoryId,
                sourceReceipt:JSON.parse(JSON.stringify(sourceReceipt)), turn, lease,
                topology:nativeTopology, inFlight:new Set() };
            return token;
        };
        const beforeWrite = (scopeKey, token, priorRaw) => {
            const owner = current(); if (!owner) return null;
            if (owner.scopeKey !== scopeKey || !((token === owner.token && owner.state === 'capturing') || (token === owner.publicationTicket && owner.state === 'publishing'))) {
                invalidate('unowned_canonical_write'); return null;
            }
            if (priorRaw !== (owner.postRaw ?? owner.beforeRaw)) { invalidate('baseline_root_changed_before_owned_write'); return null; }
            const ticket = Object.freeze({}); owner.inFlight.add(ticket); return ticket;
        };
        const verifiedWrite = (scopeKey, ticket, raw) => {
            const owner = current();
            if (!owner || owner.scopeKey !== scopeKey || !owner.inFlight.has(ticket) || typeof raw !== 'string') return false;
            owner.inFlight.delete(ticket); owner.postRaw = raw; return true;
        };
        const complete = (token, turn) => {
            const owner = current(); if (!owner || owner.token !== token) return false;
            if (owner.turn !== turn || owner.inFlight.size || !owner.postRaw || MemoryEngine.getCurrentTurn() !== turn
                || MemoryState.pendingTurnCommits.size) { invalidate('owned_analysis_not_verified'); return false; }
            owner.state = 'ready'; return true;
        };
        const fail = (token, reason) => { if (current()?.token === token && token) invalidate(reason || 'owned_analysis_failed'); };
        const inspect = () => {
            const owner = current();
            return owner ? {state:owner.state,turn:owner.turn,canonicalMemoryId:owner.canonicalMemoryId,
                retainedCodeUnits:(owner.beforeRaw?.length || 0)+(owner.postRaw?.length || 0)+owner.topology.length}
                : {state:'unavailable',reason:unavailableReason,retainedCodeUnits:0};
        };
        const take = canonicalMemoryId => {
            const owner = current();
            if (!owner || owner.state !== 'ready' || owner.canonicalMemoryId !== canonicalMemoryId) throw new Error('latest_runtime_baseline_unavailable');
            const snapshot = Object.freeze({beforeRaw:owner.beforeRaw,postRaw:owner.postRaw,scopeKey:owner.scopeKey,
                resetGeneration:owner.resetGeneration,canonicalMemoryId:owner.canonicalMemoryId,turn:owner.turn,
                sourceReceipt:JSON.parse(JSON.stringify(owner.sourceReceipt)),topology:owner.topology,lease:owner.lease});
            snapshots.set(snapshot, owner.token); return snapshot;
        };
        const checkTopology = chat => {
            const owner = current(); if (!owner || !['ready','publishing'].includes(owner.state)) return false;
            if (topology(chat,owner.sourceReceipt) !== owner.topology) { invalidate('native_topology_changed'); return false; }
            return true;
        };
        const isCurrent = snapshot => { const owner=current(); return !!owner && ["ready","publishing"].includes(owner.state) && snapshots.get(snapshot) === owner.token; };
        const claimPublication = snapshot => {
            const owner = current();
            if (!owner || owner.state !== 'ready' || snapshots.get(snapshot) !== owner.token) throw new Error('reanalysis_owner_changed');
            owner.publicationTicket = Object.freeze({}); owner.state = 'publishing';
            return owner.publicationTicket;
        };
        // Share only identical primitive bytes after the caller's fresh proof.
        // This does not borrow owner authority or observe lease/currentness getters.
        reuseVerifiedBaselinePostRaw = (scopeKey, resetGeneration, raw) => {
            const owner = slot;
            const postRaw = owner?.postRaw;
            return owner && owner.scopeKey === scopeKey && owner.resetGeneration === resetGeneration
                && typeof postRaw === 'string' && postRaw === raw ? postRaw : raw;
        };
        return Object.freeze({claimPublication,isCurrent,begin,beforeWrite,verifiedWrite,complete,fail,inspect,take,checkTopology,invalidate});
    })();
