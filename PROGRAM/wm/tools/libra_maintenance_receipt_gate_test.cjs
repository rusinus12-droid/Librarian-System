'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const acorn = require('acorn');
const vm = require('node:vm');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');

// TEST-ONLY dependency boundary. The emitted maintenance worker stays intact.
// The ordinary persistence initializer is removed before evaluation: neither
// its canonical writer nor its host mirror can execute, including during boot.
const transformed = new Map();
const extracted = new Map();
function instrumentArtifact(code) {
    if (transformed.has(code)) return transformed.get(code);
    const inputCode = code;
    const edits = [];
    let waiterCode, consumerCode;
    const ast = acorn.parse(code, { ecmaVersion: 'latest' });
    const wanted = new Set(['persistLoreToActiveChat', 'ActivityDashboardCore', 'LibraToast']);
    const stack = [ast];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (node.type === 'VariableDeclarator' && node.id?.name === 'awaitCommittedTurnMaintenance') waiterCode = code.slice(node.init.start, node.init.end);
        // Terser inlines this single-use helper, retaining the emitted async closure.
        if (node.type === 'ArrowFunctionExpression' && node.async && node.params?.[0]?.left?.name === 'started'
            && code.slice(node.start, node.end).includes('normalizeAfterRequestForegroundTimeoutMs')) waiterCode = code.slice(node.start, node.end);
        if (node.type === 'BlockStatement') {
            const index = node.body.findIndex(statement => statement.type === 'VariableDeclaration' && statement.declarations.some(declaration => declaration.id?.name === 'maintenanceWait'));
            if (index >= 0) consumerCode = node.body.slice(index + 1).map(statement => code.slice(statement.start, statement.end)).join('\n');
        }
        if (node.type === 'VariableDeclarator' && wanted.has(node.id?.name)) {
            const name = node.id.name;
            const original = code.slice(node.init.start, node.init.end);
            const replacement = name === 'persistLoreToActiveChat'
                ? 'async (...args) => globalThis.__WM_RECEIPT_GATE__.persist(...args)'
                : `globalThis.__WM_RECEIPT_GATE__.observe(${JSON.stringify(name)},(${original}))`;
            edits.push({ start: node.init.start, end: node.init.end, replacement });
            wanted.delete(name);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) stack.push(...value);
            else if (value && typeof value === 'object') stack.push(value);
        }
    }
    assert.equal(wanted.size, 0, `missing emitted dependency seam: ${[...wanted]}`);
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
    }
    transformed.set(inputCode, code);
    assert(waiterCode && consumerCode, 'exact emitted completion consumers found');
    extracted.set(process.env.LIBRA_GUI_TEST_DIST, { waiterCode, consumerCode });
    return code;
}

// Reuse only the fixture export, never its ordinary-persistence test cases.
const helper = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
const fixtureModule = new Module(helper, module);
fixtureModule.filename = helper;
fixtureModule.paths = Module._nodeModulePaths(__dirname);
fixtureModule.instrumentArtifact = instrumentArtifact;
let helperSource = fs.readFileSync(helper, 'utf8');
helperSource = helperSource
    .replace('const end=code.lastIndexOf', 'code=module.instrumentArtifact(code);const end=code.lastIndexOf')
    .replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')")
    .replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,DebugExportManager,DurableTurnLedger,runTurnMaintenanceRecord,startCommittedTurnMaintenance};')
    .replace('w.risuai=R;w.Risuai=R;', 'w.__WM_RECEIPT_GATE__=options.receiptGate;w.risuai=R;w.Risuai=R;')
    .replace('async setChatToIndex(ci,ti,value){', "async setChatToIndex(ci,ti,value){throw new Error('TEST FORBIDS ordinary host mirror');")
    .replace('async setCharacter(value){', "async setCharacter(value){throw new Error('TEST FORBIDS ordinary character write');");
fixtureModule._compile(helperSource, helper);
const { loadGui } = fixtureModule.exports;
const clone = value => JSON.parse(JSON.stringify(value));

async function runScenario(file, receipt, deferred = false, options = {}) {
    process.env.LIBRA_GUI_TEST_DIST = path.join(__dirname, '../dist', file);
    const calls = { persist: [], activity: [], finish: [], toasts: [], retryTimers: [], providers: 0 };
    const gate = {
        async persist(chat, lore, options) {
            calls.persist.push({ chatId: chat?.id, options: clone(options || {}) });
            if (receipt instanceof Error) throw receipt;
            return { ...receipt };
        },
        observe(name, target) {
            return Object.fromEntries(Object.entries(target).map(([key, value]) => [key,
                typeof value !== 'function' ? value : function (...args) {
                    if (name === 'ActivityDashboardCore' && key === 'update') calls.activity.push(clone(args[1] || {}));
                    if (name === 'ActivityDashboardCore' && key === 'finish') calls.finish.push({ status: args[1], message: args[2] });
                    if (name === 'LibraToast' && ['sequence', 'notify'].includes(key)) calls.toasts.push({ method: key, messages: clone(args[0]) });
                    return value.apply(target, args);
                }
            ]));
        }
    };
    const f = await loadGui({ nativeInitialization: true, store: new Map(), receiptGate: gate,
        nativeFetch: async () => { calls.providers++; throw new Error('TEST FORBIDS model/provider transport'); }
    });
    try {
        const scope = f.api.MemoryState._activeScopeKey;
        const ledger = f.api.DurableTurnLedger;
        const rawAssistant = 'Synthetic response.\n  Raw spacing stays intact.\n';
        const rawUser = 'Synthetic request.\n  Original spacing.\n';
        const handle = await ledger.appendObserved({
            scopeKey: scope, runtimeScopeKey: scope, recordId: 'receipt-gate-capture',
            chatId: f.control.chat.id, characterId: f.control.char.id, characterIndex: 0, chatIndex: 0,
            userText: rawUser, assistantText: rawAssistant, resetGeneration: 0
        });
        assert.equal(handle.ok, true, 'real raw ledger capture succeeds');
        assert.equal(handle.verified, true, 'real raw ledger capture has verified readback');
        const rawBefore = f.store.get(handle.recordKey);
        if (options.failTerminalAck) {
            const originalWrite = f.w.risuai.pluginStorage.setItem;
            f.w.risuai.pluginStorage.setItem = async (key, value) => {
                if (key === handle.recordKey + '::status' && JSON.parse(value).patch?.analysisStatus !== 'running') return false;
                return originalWrite(key, value);
            };
        }
        const runtimeSetTimeout = f.w.setTimeout.bind(f.w);
        f.w.setTimeout = (callback, delay, ...args) => {
            if ([1379, 2758].includes(Number(delay)) || /scheduleTurnMaintenanceRecord|analysis-recovery-/.test(String(callback))) {
                calls.retryTimers.push({ delay, callback: String(callback) });
                return 987654321; // never execute an unauthorized retry/model path
            }
            return runtimeSetTimeout(callback, delay, ...args);
        };
        for (const key of ['persist', 'activity', 'finish', 'toasts']) calls[key].length = 0;
        f.calls.writes.length = 0;
        const record = {
            char: f.control.char, chat: f.control.chat, chatId: f.control.chat.id, scopeKey: scope, turnForMaintenance: 1,
            aiResponse: rawAssistant, activityContext: { scopeKey: scope },
            targetContext: { durableLedgerRecordKey: handle.recordKey, durableLedgerRecordId: handle.recordId, scopeKey: scope, resetGeneration: 0 },
            turnState: { analysisPending: false, analysisDeferred: deferred, precomputedMaintenance: {} },
            maintenanceConfig: { ...f.api.MemoryEngine.CONFIG, debug: false, analysisRecoveryDeferredAttempts: 2,
                analysisRecoveryDeferredDelayMs: 1379, rpLongTermMemoryEnabled: false, afterRequestMaintenanceMode: 'foreground' }
        };
        const result = options.foreground
            ? await f.api.startCommittedTurnMaintenance(record, { activityContext: record.activityContext }).task
            : await f.api.runTurnMaintenanceRecord(record);
        const persisted = readLedgerReceipts(f.store).find(row => row.recordId === handle.recordId);
        const rows = clone(f.api.DebugExportManager.getOperationalRecords(scope));
        const observed = { result: clone(result), persisted: clone(persisted), calls: clone(calls), rows,
            rawUnchanged: f.store.get(handle.recordKey) === rawBefore,
            rawAssistant, rawUser,
            pending: clone(await ledger.listPending(scope)),
            pendingPage: clone(await ledger.listPendingPage(scope)),
            canonicalWrites: f.calls.writes.filter(row => row.key.startsWith('LIBRA_DATA::')).length,
            hostWrites: f.calls.hostWrites.length };
        const counts = { persist: calls.persist.length, providers: calls.providers };
        observed.reentry = clone(await f.api.runTurnMaintenanceRecord({ ...record, analysisRecoveryAttempt: 1 }));
        observed.reentryPersistCalls = calls.persist.length - counts.persist;
        observed.reentryProviderCalls = calls.providers - counts.providers;
        return observed;
    } finally { f.close(); }
}

for (const file of ['LIBRA World Manager Full.js', 'LIBRA World Manager.js']) {
    for (const [name, receipt, deferred] of [
        ['canonicalVerified false', { ok: true, canonicalVerified: false }, false],
        ['canonicalVerified missing', { ok: true }, false],
        ['live forged candidate-only receipt', { ok: true, candidateOnly: true, verified: true }, false],
        ['canonical write succeeded but receipt unverified', { ok: false, canonicalWritten: true }, false],
        ['failed receipt with unknown write outcome', { ok: false }, false],
        ['persistence throws with unknown write outcome', new Error('synthetic interrupted receipt'), false],
        ['deferred analysis with unverified save', { ok: true, canonicalVerified: false }, true]
    ]) {
        test(`${file}: ${name}`, async t => {
            const o = await runScenario(file, receipt, deferred);
            await t.test('fake receipt boundary only; raw capture unchanged', () => {
                assert.equal(o.calls.persist.length, 1, 'worker consumed exactly one injected receipt');
                assert.equal(o.canonicalWrites, 0, 'no ordinary canonical persistence was executed');
                assert.equal(o.hostWrites, 0, 'no ordinary mirror was executed');
                assert.equal(o.rawUnchanged, true, 'immutable raw receipt bytes unchanged');
                assert.equal(o.persisted.assistantText, o.rawAssistant);
                assert.equal(o.persisted.userText, o.rawUser);
                assert.equal(o.calls.providers, 0);
            });
            await t.test('observable uncertain result rather than success or analysis failure', () => {
                assert.equal(o.result.status, 'uncertain');
                assert.equal(o.result.uncertain, true, 'uncertainty is machine-readable');
                if (receipt instanceof Error) assert.equal(o.result.error, receipt.message, 'preserve original exception detail');
                else assert.match(String(o.result.reason || o.result.error || ''), /uncertain|unverified/);
                assert.notEqual(o.rows.at(-1)?.status, 'done');
            });
            await t.test('durable terminal uncertainty cannot claim analysis done', () => {
                assert.equal(o.persisted.analysisStatus, 'terminal');
                assert.equal(o.persisted.analysisError, 'canonical_save_unverified');
                assert.equal(o.result.durableReplaySuppressed, true, 'verified terminal receipt suppresses automatic replay');
                assert.equal(o.pending.length, 0, 'excluded from automatic legacy backfill');
                assert.equal(o.pendingPage.records.length, 0, 'excluded from automatic paged backfill');
            });
            await t.test('no successful activity finish, final-save completion or toast', () => {
                assert.equal(o.calls.activity.some(row => row.status === 'done' || row.stepStatus === 'done' || /최종 저장 완료|저장을 완료/.test(`${row.activeTask || ''} ${row.message || ''}`)), false);
                assert.equal(o.calls.finish.some(row => /^(done|ok|complete|completed)$/.test(String(row.status))), false);
                assert.equal(o.calls.toasts.length, 0, 'uncertain storage must not trigger completion toasts');
            });
            await t.test('uncertain storage never schedules analysis retry or reanalyzes old receipt', () => {
                assert.equal(o.calls.retryTimers.length, 0, 'no false deferred-analysis retry after uncertain save');
                assert.equal(o.rows.some(row => row.stage === 'retry'), false);
                assert.equal(o.reentry.skipped, true);
                assert.equal(o.reentryPersistCalls, 0);
                assert.equal(o.reentryProviderCalls, 0);
            });
            console.log(JSON.stringify({ artifact: file, scenario: name, status: o.result.status,
                ledgerStatus: o.persisted.analysisStatus, persistCalls: o.calls.persist.length,
                retryTimers: o.calls.retryTimers.length, successFinishes: o.calls.finish.filter(row => row.status === 'done').length,
                completionToasts: o.calls.toasts.length, canonicalWrites: o.canonicalWrites, hostWrites: o.hostWrites }));
        });
    }
    test(`${file}: failed terminal ACK honestly remains unsuppressed uncertainty`, async () => {
        const o = await runScenario(file, { ok: true, canonicalVerified: false }, false, { failTerminalAck: true });
        assert.equal(o.result.status, 'uncertain');
        assert.equal(o.result.durableReplaySuppressed, false);
        assert.equal(o.persisted.analysisStatus, 'running');
        assert.equal(o.rawUnchanged, true);
        assert.equal(o.calls.toasts.length, 0);
        assert.equal(o.canonicalWrites, 0);
        assert.equal(o.hostWrites, 0);
    });
    test(`${file}: foreground maintenance does not overwrite uncertain activity`, async () => {
        const o = await runScenario(file, { ok: true, canonicalVerified: false }, false, { foreground: true });
        assert.equal(o.result.status, 'uncertain');
        assert.equal(o.calls.activity.at(-1).status, 'uncertain');
        assert.notEqual(o.calls.activity.at(-1).stepStatus, 'done');
        assert.equal(o.calls.toasts.length, 0);
    });
    test(`${file}: emitted wait helper preserves uncertainty`, async () => {
        const { waiterCode } = extracted.get(path.join(__dirname, '../dist', file));
        const wait = vm.runInNewContext('(' + waiterCode + ')', {
            normalizeAfterRequestForegroundTimeoutMs: value => value,
            MemoryEngine: { CONFIG: {} }, MemoryState: {}, setTimeout, clearTimeout
        });
        const result = await wait({ task: Promise.resolve({ status: 'uncertain', reason: 'maintenance_persist_unverified' }) }, { timeoutMs: 1000 });
        assert.equal(result.status, 'uncertain');
        assert.equal(result.result.status, 'uncertain');
    });
    test(`${file}: emitted afterRequest consumer keeps raw commit but never overwrites uncertain activity`, async () => {
        const { consumerCode } = extracted.get(path.join(__dirname, '../dist', file));
        const activity = [], logs = [];
        await vm.runInNewContext('(async () => {' + consumerCode + '})()', {
            maintenanceWait: { status: 'uncertain', result: { status: 'uncertain' } },
            immediateCommit: { turn: 1, turnKey: 'raw-capture-key', memoryCreated: true }, predictedTurn: 1, activityContext: {}, afterDebugKey: 'after-request-test',
            ActivityDashboardCore: { update: (_, patch) => activity.push(patch), finish: (_, status, message) => activity.push({ status, message }) },
            DebugExportManager: { finishRequest: (_, status, details) => logs.push({ status, details }) },
            MemoryState: {}, MemoryEngine: { CONFIG: {} }
        });
        assert(activity.some(row => row.status === 'uncertain'));
        assert(!activity.some(row => ['committed', 'done'].includes(row.status)));
        assert.equal(logs.at(-1).details.maintenanceStatus, 'uncertain');
        assert.equal(logs.at(-1).details.turnKey, 'raw-capture-key');
        assert.equal(logs.at(-1).details.memoryCreated, true);
    });
    test(`${file}: explicit no-write rejection remains failed`, async () => {
        const o = await runScenario(file, { ok: false, writeIssued: false, canonicalVerified: false, reason: 'write_not_issued' });
        assert.equal(o.result.status, 'failed');
        assert.equal(o.calls.toasts.length, 0);
        assert.equal(o.rawUnchanged, true);
        assert.equal(o.canonicalWrites, 0);
        assert.equal(o.hostWrites, 0);
    });
    test(`${file}: canonicalVerified true retains success`, async () => {
        const o = await runScenario(file, { ok: true, canonicalVerified: true });
        assert.equal(o.result.status, 'done');
        assert.equal(o.persisted.analysisStatus, 'done');
        assert(o.calls.activity.some(row => row.status === 'done' && row.step === '최종 저장'));
        assert(o.calls.finish.some(row => row.status === 'done'));
        assert(o.calls.toasts.some(row => row.method === 'sequence'));
        assert.equal(o.calls.persist.length, 1);
        assert.equal(o.calls.providers, 0);
        assert.equal(o.canonicalWrites, 0);
        assert.equal(o.hostWrites, 0);
        assert.equal(o.rawUnchanged, true);
        assert.equal(o.pending.length, 0);
        assert.equal(o.pendingPage.records.length, 0);
    });
}
