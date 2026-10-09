'use strict';
// WM-owned capability boundary. This module does not install a provider, migrate
// data, or certify that a self-described provider actually enforces its promises.
// Native Risu and existing LIB CAS alone do not satisfy this contract.
const PROTOCOL = 'wm.snapshot-authority.v1';
const SCHEMA = 'wm.canonical-raw.v1';
const REQUIRED_CAPABILITIES = Object.freeze(['atomic_expected_head_publish', 'immutable_verified_generations',
    'durable_nonreusable_epochs', 'all_writer_ownership', 'healthy_head_certifies_generation',
    'atomic_acquire_and_pin', 'reader_retention', 'commit_status_reconciliation']);
const WRITER_OPERATIONS = Object.freeze(['normal', 'verified', 'reset', 'remove', 'import', 'restore', 'branch', 'migration', 'sync', 'recovery']);
const EPOCH_OPERATIONS = new Set(['reset', 'remove', 'restore', 'migration', 'recovery']);
const HEAD_KEYS = Object.freeze(['protocol', 'authorityId', 'storeId', 'scope', 'epoch', 'revision', 'schema', 'generationId', 'sha256', 'utf8Bytes', 'tombstone']);
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // Prototype budget, not a new user data limit.
const MAX_HEAD_BYTES = 2048;
const wellFormed = value => {
    for (let i=0;i<value.length;i++) {
        const code=value.charCodeAt(i);
        if (code>=0xd800 && code<=0xdbff) {
            const next=value.charCodeAt(++i);
            if (!(next>=0xdc00 && next<=0xdfff)) return false;
        } else if (code>=0xdc00 && code<=0xdfff) return false;
    }
    return true;
};
const encode = value => new TextEncoder().encode(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const equal = (a, b) => !!a && !!b && HEAD_KEYS.every(key => a[key] === b[key]);
const fail = (reason, extra = {}) => ({ok:false, reason, ...extra});

function createSnapshotAuthority(provider, options = {}) {
    const names = ['describe', 'acquire', 'readGeneration', 'head', 'release', 'prepare', 'publish', 'status'];
    let contract, io;
    try {
        if (!provider || names.some(name => typeof provider[name] !== 'function')) return fail('unsupported_provider');
        contract = provider.describe();
        if (contract?.protocol !== PROTOCOL || !token(contract.authorityId)
            || REQUIRED_CAPABILITIES.some(name => !Array.isArray(contract.capabilities) || !contract.capabilities.includes(name))
            || WRITER_OPERATIONS.some(name => !Array.isArray(contract.writers) || !contract.writers.includes(name))) return fail('unsupported_provider');
        io = Object.freeze(Object.fromEntries(names.map(name => [name, provider[name].bind(provider)])));
        contract = Object.freeze({protocol:PROTOCOL, authorityId:contract.authorityId});
    } catch (_) { return fail('unsupported_provider'); }
    const maxPayloadBytes = options.maxPayloadBytes === undefined ? DEFAULT_MAX_BYTES : options.maxPayloadBytes;
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) return fail('invalid_budget');
    const hash = async bytes => {
        if (!globalThis.crypto?.subtle) throw new Error('sha256_unavailable');
        const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const validScope = scope => typeof scope === 'string' && scope.length > 0 && wellFormed(scope) && encode(scope).length <= 1024;
    const headCopy = (value, scope) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_head');
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.keys(descriptors).length !== HEAD_KEYS.length || HEAD_KEYS.some(key => !descriptors[key] || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')))
            throw new Error('invalid_head');
        const head = Object.fromEntries(HEAD_KEYS.map(key => [key, descriptors[key].value]));
        if (head.protocol !== PROTOCOL || head.authorityId !== contract.authorityId || head.schema !== SCHEMA || head.scope !== scope
            || !['authorityId','storeId','epoch','revision','generationId'].every(key => token(head[key]))
            || typeof head.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(head.sha256)
            || typeof head.tombstone !== 'boolean' || !Number.isSafeInteger(head.utf8Bytes) || head.utf8Bytes < 0
            || head.utf8Bytes > maxPayloadBytes || (head.tombstone && head.utf8Bytes !== 0)
            || encode(JSON.stringify(head)).length > MAX_HEAD_BYTES) throw new Error('invalid_head');
        return Object.freeze(head);
    };
    const states = new WeakMap(), closedLeases = new WeakMap(), active = new Set(), releasePending = new Set(), releasing = new Map();
    let disposed = false;
    const release = lease => {
        if (lease == null) return Promise.resolve(true);
        if (releasing.has(lease)) return releasing.get(lease);
        releasePending.add(lease);
        const work = (async () => {
            try { await io.release(lease); releasePending.delete(lease); return true; }
            catch (_) { return false; }
        })();
        releasing.set(lease,work);
        return work.finally(() => { if (releasing.get(lease) === work) releasing.delete(lease); });
    };
    const releaseForHandle = async (handle, lease) => {
        if (lease == null) return true;
        closedLeases.set(handle,lease);
        const released = await release(lease);
        if (released && closedLeases.get(handle) === lease) closedLeases.delete(handle);
        return released;
    };
    const close = async handle => {
        const state = states.get(handle);
        let lease = closedLeases.get(handle);
        if (state) {
            states.delete(handle); active.delete(state); state.closed = true;
            lease = state.lease;
            state.lease = null; state.raw = undefined; state.head = null; state.bytes = 0;
        }
        return await releaseForHandle(handle,lease) ? {ok:true} : fail('lease_release_failed');
    };
    const live = state => !disposed && !state.closed && states.get(state.handle) === state;
    const terminal = async (state, reason) => { await close(state.handle); return fail(reason); };
    const open = scope => {
        if (disposed || !validScope(scope)) return null;
        const handle = Object.freeze({});
        const state = {handle, scope, lease:null, raw:undefined, head:null, bytes:0, closed:false, pending:null};
        states.set(handle,state);active.add(state);return handle;
    };
    const check = async state => {
        try {
            const response = await io.head(state.scope, state.lease);
            if (!live(state)) return fail('closed');
            if (response?.leaseValid !== true) return terminal(state,'lease_invalid');
            const current = headCopy(response.head, state.scope);
            if (!equal(current,state.head)) return terminal(state,'snapshot_changed');
            return {ok:true,head:current};
        } catch (_) { return terminal(state,'authority_unavailable'); }
    };
    const acquire = async state => {
        let acquired;
        try {
            acquired = await io.acquire(state.scope);
            if (!live(state)) { await releaseForHandle(state.handle,acquired?.lease); return fail('closed'); }
            if (acquired?.lease == null) return terminal(state,'lease_invalid');
            state.lease = acquired.lease;
            const initial = headCopy(acquired.head,state.scope);
            const raw = await io.readGeneration(state.lease);
            if (!live(state)) return fail('closed');
            if (initial.tombstone ? raw !== null : typeof raw !== 'string' || !wellFormed(raw)) return terminal(state,'generation_invalid');
            const bytes = encode(raw === null ? '' : raw);
            if (bytes.length !== initial.utf8Bytes || bytes.length > maxPayloadBytes || await hash(bytes) !== initial.sha256)
                return terminal(state,'generation_invalid');
            if (!live(state)) return fail('closed');
            // Publish owned bytes only after a fresh healthy HEAD observation.
            state.head = initial;
            const verified = await check(state);
            if (!verified.ok || !live(state)) return verified.ok ? fail('closed') : verified;
            state.raw = raw; state.bytes = bytes.length;
            return {ok:true,raw,head:initial,missing:initial.tombstone};
        } catch (_) {
            if (acquired?.lease != null && state.lease == null && !state.closed) await release(acquired.lease);
            return terminal(state,'authority_unavailable');
        }
    };
    const read = handle => {
        const state = states.get(handle);
        if (!state || !live(state)) return Promise.resolve(fail('closed'));
        if (state.pending) return state.pending;
        const work = async () => {
            if (!state.head) return acquire(state);
            const result = await check(state);
            return result.ok && live(state) ? {ok:true,raw:state.raw,head:state.head,missing:state.head.tombstone} : result;
        };
        const pending = work().finally(() => { if (state.pending === pending) state.pending = null; });
        state.pending = pending; return pending;
    };
    const current = async handle => {
        const state = states.get(handle);
        if (!state || !live(state)) return fail('closed');
        if (state.pending) { const pending = await state.pending; if (!pending.ok) return pending; }
        if (!state.head) return fail('unacquired');
        return check(state);
    };
    const commit = async input => {
        if (disposed) return fail('closed');
        if (!input || !WRITER_OPERATIONS.includes(input.operation)) return fail('writer_not_owned');
        const {scope, raw, operation, operationId} = input;
        if (!validScope(scope) || !token(operationId) || (operation === 'remove' ? raw !== null : typeof raw !== 'string')) return fail('invalid_write');
        if (raw !== null && !wellFormed(raw)) return fail('invalid_utf16');
        const bytes = encode(raw === null ? '' : raw);
        if (bytes.length > maxPayloadBytes) return fail('payload_limit');
        let expectedHead, rawSha256, prepared;
        try { expectedHead = headCopy(input.expectedHead,scope); rawSha256 = await hash(bytes); }
        catch (_) { return fail('invalid_write'); }
        if (disposed) return fail('closed');
        const matchesReceipt = receipt => {
            try {
                if(prepared.requestFingerprint)return receipt?.status==='committed' && receipt.operationId===operationId && receipt.requestFingerprint===prepared.requestFingerprint && equal(headCopy(receipt.receipt?.head||receipt.head,scope),prepared.head);
                return receipt?.status === 'committed' && receipt.operationId === operationId && receipt.operation === operation
                    && receipt.scope === scope && receipt.rawSha256 === rawSha256 && equal(headCopy(receipt.expectedHead,scope),expectedHead)
                    && equal(headCopy(receipt.head,scope),prepared.head);
            } catch (_) { return false; }
        };
        try {
            prepared = await io.prepare({scope,expectedHead,raw,operation,operationId,rawSha256});
            if (disposed) return fail('closed');
            const head = headCopy(prepared?.head,scope);
            if (!token(prepared.preparedId) || prepared.operationId !== operationId || prepared.operation !== operation || prepared.scope !== scope || prepared.rawSha256 !== rawSha256
                || !equal(headCopy(prepared.expectedHead,scope),expectedHead) || head.storeId !== expectedHead.storeId
                || head.sha256 !== rawSha256 || head.utf8Bytes !== bytes.length || head.tombstone !== (raw === null)
                || head.revision === expectedHead.revision || head.generationId === expectedHead.generationId
                || (EPOCH_OPERATIONS.has(operation) && head.epoch === expectedHead.epoch)) return fail('prepared_invalid');
            prepared = Object.freeze({preparedId:prepared.preparedId,operationId,scope,operation,expectedHead,rawSha256,head,...prepared.requestFingerprint?{requestFingerprint:prepared.requestFingerprint}:{}});
        } catch (error) { return fail(error?.uncertain?'commit_uncertain':error?.code === 'conflict' ? 'conflict' : 'prepare_failed',error?.uncertain?{uncertain:true,operationId,requestFingerprint:error.requestFingerprint}:{}); }
        let published;
        try {
            published = await io.publish(prepared);
            if (published?.status === 'conflict') return fail('conflict');
            if (matchesReceipt(published)) return {ok:true,head:prepared.head,operationId,reconciled:false};
        } catch (_) { /* Only the durable operation receipt can settle an unknown outcome. */ }
        try {
            const receipt = await io.status(operationId,prepared.requestFingerprint);
            if (matchesReceipt(receipt)) return {ok:true,head:prepared.head,operationId,reconciled:true};
        } catch (_) {}
        return fail('commit_uncertain',{uncertain:true,operationId,...prepared.requestFingerprint?{requestFingerprint:prepared.requestFingerprint}:{}});
    };
    const dispose = async () => {
        disposed = true;
        await Promise.all([...active].map(state => close(state.handle)));
        await Promise.all([...releasePending].map(release));
        return releasePending.size ? fail('lease_release_failed') : {ok:true};
    };
    const observe = async handles => {
        const owned=handles.map(handle=>states.get(handle));
        if(owned.some(s=>!s||!live(s)||!s.head||!s.lease)||typeof provider.observeHeads!=='function')return fail('lease_invalid');
        try{const heads=await provider.observeHeads(owned.map(s=>s.scope),{leases:owned.map(s=>s.lease)});return Array.isArray(heads)&&heads.length===owned.length&&new Set(heads.map(h=>h.scope)).size===owned.length&&owned.every(s=>heads.some(h=>equal(headCopy(h,s.scope),s.head)))?{ok:true}:fail('snapshot_changed');}catch{return fail('authority_unavailable');}
    };
    const diagnostics = () => Object.freeze({openHandles:active.size,retainedBytes:[...active].reduce((n,s)=>n+s.bytes,0),
        leases:[...active].filter(s=>s.lease!=null).length, pendingReleases:releasePending.size, disposed});
    return Object.freeze({ok:true,open,read,current,close,dispose,commit,observe,diagnostics});
}
module.exports = Object.freeze({createSnapshotAuthority,PROTOCOL,SCHEMA,REQUIRED_CAPABILITIES,WRITER_OPERATIONS});
