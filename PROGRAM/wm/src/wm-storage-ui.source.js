/* Metadata-only WM storage UI. Selection/connection never writes the route or uploads memory. */
const WmStorageUI = (() => {
    'use strict';
    const C = typeof WmStorageContracts !== 'undefined' ? WmStorageContracts : require('./wm-storage-contracts.source.js');
    const R = typeof WmStorageRouter !== 'undefined' ? WmStorageRouter : require('./wm-storage-router.source.js');
    const G = typeof WmNativeHostGate !== 'undefined' ? WmNativeHostGate : require('./wm-native-host-gate.source.js');
    const clone = value => JSON.parse(JSON.stringify(value));
    const token = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const reason = (value, fallback) => typeof value === 'string' && /^[a-z0-9_]{1,100}$/.test(value) ? value : fallback;
    const mode = value => value === 'plugin_only' || value === 'server_only';
    const zero = () => Object.fromEntries(C.DOMAINS.map(domain => [domain, 0]));
    const sum = totals => C.DOMAINS.reduce((total, domain) => {
        const value = totals[domain];
        if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) throw Error('storage_total_invalid');
        return total + value;
    }, 0);
    const activeStates = ['preparing', 'inventory_frozen', 'copying', 'verifying', 'cutover_prepared', 'cutover_committed'];
    const states = [...activeStates, 'complete', 'interrupted', 'conflict', 'uncertain', 'recovery_required'];
    const labels = {
        preparing: '준비 중', inventory_frozen: '목록 고정 완료', copying: '복사 중', verifying: '전체 검증 중',
        cutover_prepared: '정본 전환 준비 완료', cutover_committed: '새 정본 확인 중', complete: '전체 이관 검증 완료',
        interrupted: '중단됨', conflict: '충돌 · 원본 확인 필요', uncertain: '결과 확인 필요', recovery_required: '복구 확인 필요'
    };
    const explanations = {
        manual_work_paused:'이관 또는 재로드 확인까지 WM 기억 작업이 멈춰 있습니다.',
        manual_source_changed:'원본에 변경이 확인되어 전환을 막았습니다. 원본은 보존합니다.',
        manual_destination_changed:'대상에 다른 변경이 확인되어 덮어쓰기를 막았습니다.',
        manual_route_changed:'저장 경로가 다른 작업에서 바뀌었습니다. 다시 불러와 확인해 주세요.',
        manual_cancelled_reload_required:'이관을 중단하고 원본 경로를 보존했습니다. WM을 다시 불러오면 원래 경로로 재개합니다.',
        connection_route_in_use:'서버 경로나 진행 중 이관이 사용 중입니다. 같은 서버 재연결만 허용됩니다.',
        manual_switch_confirmation_required:'검증 결과와 새 저장 위치를 확인한 뒤 전환해 주세요.',

        native_host_provider_missing: '이 호스트의 안전한 저장 제공자가 없습니다.',
        native_host_unqualified: '모든 WM 쓰기 경로의 잠금과 내구성 검증이 필요합니다.',
        native_host_profile_unqualified: '이 호스트 버전의 저장 전환 지원을 검증하지 않았습니다.',
        native_host_guarantees_unqualified: '전체 쓰기 잠금·내구성·재시작 보장을 검증하지 않았습니다.',
        native_host_methods_missing: '호스트 저장 기능이 부족합니다.', native_host_catalog_missing: '전체 WM 목록을 안전하게 읽을 수 없습니다.',
        migration_provider_missing: '전체 이관 제공자가 연결되지 않았습니다.', server_connection_unavailable: '서버 연결을 확인할 수 없습니다. 주소·네트워크·호스트의 접속 허용 상태를 확인해 주세요.',
        connection_url_invalid: 'HTTPS 서버 주소 또는 HTTP loopback 주소만 입력해 주세요. 경로·쿼리·인증정보를 URL에 넣을 수 없습니다.',
        connection_credential_invalid: '기존 WM 전용 접속 자격만 입력해 주세요. 관리자·다른 플러그인 자격은 사용할 수 없습니다.',
        connection_configuration_required: '서버 주소와 기존 WM 전용 접속 자격을 먼저 저장해 주세요.',
        connection_settings_unverified: '연결 설정 저장 결과를 확인하지 못했습니다. 다시 열어 확인해 주세요.',
        connection_settings_invalid: '저장된 연결 설정을 읽을 수 없습니다. 연결 설정 지우기 후 다시 입력해 주세요.',
        connection_settings_unavailable: '호스트의 연결 설정 저장소를 읽을 수 없습니다.',
        connection_authentication_failed: '서버가 WM 전용 접속 자격을 확인하지 못했습니다.',
        connection_transport_unavailable: '이 호스트의 안전한 직접 HTTP 연결 경로를 사용할 수 없습니다.',
        connection_response_invalid: 'WM 서버의 응답 형식이나 저장 상태를 확인하지 못했습니다.',
        connection_timeout: '서버 연결 확인 시간이 초과되었습니다.',
        connection_configuration_changed: '연결 설정이 바뀌었습니다. 다시 확인해 주세요.',
        migration_activation_disabled: '이 빌드의 실제 저장 전환은 닫혀 있습니다.', inventory_incomplete: '전체 WM 목록을 확인하지 못했습니다.',
        inventory_unavailable: 'WM 목록을 읽을 수 없습니다.', destination_unavailable: '대상 저장소를 확인할 수 없습니다.',
        destination_existing_data: '대상에 WM 데이터가 있어 자동 덮어쓰기를 막았습니다.', destination_capacity: '대상 공간이 부족합니다.',
        already_target_mode: '현재 정본과 같은 저장 방식입니다.', migration_pending: '진행 중이거나 확인이 필요한 작업을 먼저 확인해 주세요.',
        preview_changed: '목록이나 대상 상태가 바뀌었습니다. 미리보기를 다시 확인해 주세요.',
        cancelled_source_fence_retained: '원본과 복사본을 보존했습니다. 원본 쓰기 잠금은 재개·상태 확인까지 유지됩니다.',
        cutover_status_required: '정본 전환 결과를 확인하기 전 새 작업을 시작하지 않습니다.'
    };
    const explain = value => explanations[value] || '지원 상태 또는 작업 결과를 확인해야 합니다.';
    function publicState(value) {
        if (value === null || value === undefined) return null;
        if (!R.plainData(value) || !token(value.operationId) || !digest(value.requestFingerprint) || !states.includes(value.state)
            || !C.validateRoute(value.sourceRoute).ok || !C.validateRoute(value.targetRoute).ok || !digest(value.inventoryDigest)
            || !C.validateDomainTotals(value.domainCounts).ok || !C.validateDomainTotals(value.domainBytes).ok
            || !Number.isSafeInteger(value.copiedBytes) || value.copiedBytes < 0) throw Error('migration_state_invalid');
        const fields = ['operationId', 'requestFingerprint', 'state', 'sourceRoute', 'targetRoute', 'inventoryDigest', 'domainCounts', 'domainBytes', 'copiedBytes'];
        const out = Object.fromEntries(fields.map(key => [key, clone(value[key])]));
        if (value.reason) out.reason = reason(value.reason, 'migration_status_required');
        const receipt = value.receipt;
        if (R.exactData(receipt, C.DTO_KEYS.MigrationReceipt) && receipt.schema === 'wm.migration-receipt.v1'
            && receipt.operationId === out.operationId && receipt.requestFingerprint === out.requestFingerprint
            && receipt.inventoryDigest === out.inventoryDigest && R.routeEqual(receipt.sourceRoute, out.sourceRoute)
            && R.routeEqual(receipt.targetRoute, out.targetRoute) && receipt.sourcePreserved === true
            && receipt.verified === true && C.validateDomainTotals(receipt.domainCounts).ok && C.validateDomainTotals(receipt.domainBytes).ok) out.receipt = clone(receipt);
        return out;
    }
    function backupView(value) {
        if (!R.plainData(value) || !['none', 'absent', 'verified', 'failed', 'unknown'].includes(value.state)) return {state: 'unknown'};
        const out = {state: value.state};
        if (token(value.id)) out.id = value.id;
        if (typeof value.verifiedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.verifiedAt)) out.verifiedAt = value.verifiedAt;
        if (value.coverage && R.plainData(value.coverage)) {
            const coverage = {};
            if (typeof value.coverage.wm === 'boolean') coverage.wm = value.coverage.wm;
            for (const domain of C.DOMAINS) if (typeof value.coverage[domain] === 'boolean') coverage[domain] = value.coverage[domain];
            out.coverage = coverage;
        }
        if (out.state === 'verified' && (!out.id || !out.verifiedAt || out.coverage?.wm !== true)) out.state = 'unknown';
        return out;
    }
    function createWmStorageViewModel({router = null, migration = null, hostGate = null, backupStatus = null, connection: connectionController = null, manual = null} = {}) {
        if (router && typeof router.readMigrationRoute !== 'function') throw Error('storage_router_invalid');
        if (hostGate && !G.isGate(hostGate)) throw Error('storage_host_gate_invalid');
        let configuration = null, connectionRevision = 0;
        let connection = 'unknown', connectionResult = null, connectionFlight = null, currentState = null, preview = null, lastRoute = null;
        const flights = new Map(), confirmedPreviews = new Map();
        const single = (key, fn) => {
            if (flights.has(key)) return flights.get(key);
            const p = Promise.resolve().then(fn); flights.set(key, p);
            p.finally(() => { if (flights.get(key) === p) flights.delete(key); }).catch(() => {});
            return p;
        };
        const supported = () => !!manual || qualification().supported;
        const qualification = () => hostGate ? clone(hostGate.inspect()) : {
            supported: false, profileId: null, qualifiedBuildHash: null, inventoryComplete: false,
            allWritersFenced: false, durableRouteCAS: false, restartSafe: false, reason: 'native_host_provider_missing'
        };
        async function readState(id) {
            if (typeof migration?.readState === 'function') currentState = publicState(await migration.readState(id));
            return clone(currentState);
        }
        async function inspect() {
            let modeConfirmed = !router, routeReason = null;
            if (router) {
                try { const route = await router.readMigrationRoute(); if (!C.validateRoute(route).ok) throw Error('route_invalid'); lastRoute = clone(route); modeConfirmed = true; }
                catch { routeReason = 'route_unavailable'; }
            }
            let stateReadFailed = false;
            try { await readState(); } catch { stateReadFailed = true; }
            let backups;
            try { backups = typeof backupStatus === 'function' ? await backupStatus() : typeof backupStatus?.inspect === 'function' ? await backupStatus.inspect() : null; } catch { backups = null; }
            let configurationReason = null;
            if (connectionController) {
                try {
                    const nextConfiguration = await connectionController.inspectConfiguration();
                    if (configuration && configuration.revision !== nextConfiguration.revision) { connection = 'unknown'; connectionResult = null; }
                    configuration = nextConfiguration;
                }
                catch (error) { configuration = null; connection = 'unknown'; connectionResult = null; configurationReason = reason(error?.message, 'connection_settings_unavailable'); }
            }
            const authoritativeMode = lastRoute?.mode || 'plugin_only';
            const savedSuccessVisible = !stateReadFailed && modeConfirmed && currentState?.state === 'complete'
                && currentState.receipt?.verified === true && currentState.receipt.cutoverStatus === 'committed'
                && !!lastRoute && R.routeEqual(lastRoute, currentState.targetRoute);
            return {
                manualProfile:manual?clone(manual.qualification()):null,reloadRequired:manual?.needsReload()===true,
                mode: authoritativeMode, routeGeneration: lastRoute?.routeGeneration || null, connection, qualification: qualification(),
                migration: clone(currentState), lastBackup: backupView(backups?.lastBackup), lastRestore: backupView(backups?.lastRestore),
                modeConfirmed, routeReason, stateReadFailed, savedSuccessVisible, connectionResult: clone(connectionResult),
                updatesPaused: manual?.isPaused()===true || (lastRoute && lastRoute.state !== 'active') || (authoritativeMode === 'server_only' && connection === 'disconnected')
                    || !!currentState && !['complete', 'conflict'].includes(currentState.state),
                migrationAvailable: !!router && !!migration && supported(),
                connectionConfigurationSupported: !!connectionController, connectionConfiguration: clone(configuration), configurationReason
            };
        }
        async function checkConnection() {
            if (connectionFlight) return connectionFlight;
            const requestedRevision = connectionRevision;
            connectionFlight = (async () => {
                try {
                    const backend = connectionController || router?.migrationBackend?.('server_only');
                    if (typeof backend?.checkConnection !== 'function') throw Error('server_connection_unavailable');
                    const checkedConfiguration = connectionController ? await connectionController.inspectConfiguration() : null;
                    const result = await backend.checkConnection();
                    if (requestedRevision !== connectionRevision) return {ok:false,reason:'connection_configuration_changed'};
                    if (connectionController) {
                        const currentConfiguration = await connectionController.inspectConfiguration();
                        if (currentConfiguration.revision !== checkedConfiguration.revision) throw Error('connection_configuration_changed');
                        configuration = currentConfiguration;
                    }
                    if (requestedRevision !== connectionRevision) return {ok:false,reason:'connection_configuration_changed'};
                    if (!R.exactData(result, ['ok', 'backendId', 'protocol', 'limits'], ['reason']) || result.ok !== true
                        || !token(result.backendId) || result.protocol !== C.PROTOCOL || !R.plainData(result.limits)
                        || Object.values(result.limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw Error('connection_result_invalid');
                    connectionResult = {ok: true, backendId: result.backendId, protocol: result.protocol, limits: clone(result.limits)};
                    connection = 'connected';
                } catch (error) {
                    if (requestedRevision !== connectionRevision) return {ok:false,reason:'connection_configuration_changed'};
                    connection = 'disconnected'; connectionResult = {ok: false, backendId: 'unavailable', protocol: C.PROTOCOL, limits: {}, reason: reason(error?.message, 'server_connection_unavailable')};
                }
                return clone(connectionResult);
            })();
            try { return await connectionFlight; } finally { connectionFlight = null; }
        }
        async function saveConnectionConfiguration(input) {
            if (!connectionController) throw Error('connection_transport_unavailable');
            connectionRevision++; connection = 'unknown'; connectionResult = null;
            configuration = await connectionController.saveConfiguration(input); return clone(configuration);
        }
        async function clearConnectionConfiguration() {
            if (!connectionController) throw Error('connection_transport_unavailable');
            connectionRevision++; connection = 'unknown'; connectionResult = null;
            configuration = await connectionController.clearConfiguration(); return clone(configuration);
        }
        async function previewMigration(targetMode) {
            if (!mode(targetMode)) throw Error('target_mode_invalid');
            const view = await inspect(), blockers = [];
            if (!supported()) blockers.push(view.qualification.reason);
            if (!router || !migration) blockers.push('migration_provider_missing');
            if (!view.modeConfirmed) blockers.push('route_unavailable');
            if (view.stateReadFailed || currentState && !['complete', 'conflict'].includes(currentState.state)) blockers.push('migration_pending');
            if (blockers.length) {
                preview = {previewFingerprint: null, sourceRoute: clone(lastRoute), targetMode, targetBackendId: 'unavailable',
                    domainCounts: zero(), domainBytes: zero(), requiredStagingBytes: 0, sourcePreserved: true,
                    targetHasExistingData: false, complete: false, canStart: false, blockers};
                return clone(preview);
            }
            const value = await migration.inspect({targetMode});
            if (!R.exactData(value, C.DTO_KEYS.MigrationPreview) || !digest(value.previewFingerprint)
                || !C.validateRoute(value.sourceRoute).ok || !R.routeEqual(value.sourceRoute, lastRoute)
                || value.targetMode !== targetMode || !token(value.targetBackendId)
                || !C.validateDomainTotals(value.domainCounts).ok || !C.validateDomainTotals(value.domainBytes).ok
                || value.requiredStagingBytes !== sum(value.domainBytes) || value.sourcePreserved !== true
                || !Array.isArray(value.blockers) || value.blockers.some(v => typeof v !== 'string' || !/^[a-z0-9_]+$/.test(v))
                || typeof value.canStart !== 'boolean' || typeof value.complete !== 'boolean' || typeof value.targetHasExistingData !== 'boolean') throw Error('migration_preview_invalid');
            preview = clone(value);
            if (!preview.complete || preview.targetHasExistingData || preview.blockers.length) preview.canStart = false;
            return clone(preview);
        }
        function confirmMigration({previewFingerprint, operationId} = {}) {
            if (!token(operationId) || operationId.length > 64 || !digest(previewFingerprint)) return Promise.reject(Error('migration_input_invalid'));
            const previous = confirmedPreviews.get(operationId);
            if (previous && previous !== previewFingerprint) return Promise.reject(Error('operation_identity_conflict'));
            confirmedPreviews.set(operationId, previewFingerprint);
            return single('confirm:' + operationId, async () => {
                const old = await readState(operationId);
                if (old) {
                    if (old.operationId !== operationId) throw Error('operation_identity_conflict');
                    // Persisted operations are resumed through their own state; a new confirmation cannot reuse their ID.
                    if (!previous && !flights.has('advance:' + operationId)) throw Error('migration_status_required');
                    return old;
                }
                if (!preview || preview.previewFingerprint !== previewFingerprint || !preview.canStart) throw Error('migration_preview_blocked');
                const fresh = await previewMigration(preview.targetMode);
                if (!fresh.canStart || fresh.previewFingerprint !== previewFingerprint) throw Error('preview_changed');
                currentState = publicState(await migration.prepare({previewFingerprint, operationId}));
                return clone(currentState);
            });
        }
        function resumeMigration(operationId) {
            return single('resume:' + operationId, async () => {
                if (!token(operationId) || !supported() || !migration) throw Error('native_host_unqualified');
                const old = await readState(operationId);
                if (!old || old.operationId !== operationId) throw Error('migration_status_required');
                if (old.state === 'complete' || old.state === 'conflict') return old;
                currentState = publicState(await migration.resume(operationId)); return clone(currentState);
            });
        }
        function advanceMigration(operationId) {
            return single('advance:' + operationId, async () => {
                if (!supported()) throw Error('native_host_unqualified');
                const state = await readState(operationId);
                if (!state || state.operationId !== operationId) throw Error('migration_status_required');
                let next;
                if (['inventory_frozen', 'copying'].includes(state.state)) next = await migration.copyNext({operationId, maxBytes: 256 * 1024});
                else if (state.state === 'verifying') next = await migration.verify(operationId);
                else if (state.state === 'cutover_prepared') { if(manual)return state;await migration.cutover(operationId); return readState(operationId); }
                else return state;
                currentState = publicState(next); return clone(currentState);
            });
        }
        async function cancelMigration(operationId) {
            if (!token(operationId) || !migration) throw Error('migration_status_required');
            await flights.get('advance:' + operationId)?.catch(() => {});
            currentState = publicState(await migration.cancel(operationId)); return clone(currentState);
        }
        async function connectUsingBootstrap(input){if(!connectionController)throw Error('connection_transport_unavailable');connectionRevision++;connection='unknown';connectionResult=null;configuration=await connectionController.connectUsingBootstrap(input);return clone(configuration);}
        async function confirmSwitch(operationId,confirmed){if(!manual||confirmed!==true)throw Error('manual_switch_confirmation_required');await migration.cutover(operationId,{confirmed:true});return readState(operationId);}
        return Object.freeze({inspect, checkConnection, connectUsingBootstrap, confirmSwitch, saveConnectionConfiguration, clearConnectionConfiguration, previewMigration, confirmMigration, resumeMigration, advanceMigration, cancelMigration});
    }
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
    const modeLabel = value => value === 'server_only' ? '서버에만 저장' : '플러그인에만 저장';
    const bytesLabel = value => `${Number(value).toLocaleString()} bytes`;
    function renderWmStoragePanel(view, {preview = null, targetMode = 'server_only', busy = false, running = false, message = ''} = {}) {
        const state = view.migration, support = view.manualProfile?.supported || view.qualification.supported, paused = view.updatesPaused;
        const backupLabel = value => ({none: '기록 없음', absent: 'WM 자료 미포함', verified: 'WM 검증 완료', failed: '검증 실패', unknown: '미확인'}[value.state] || '미확인')
            + (value.state === 'verified' ? ` · ${value.id} · ${value.verifiedAt}` : '');
        const domains = {canonical: '정본 기억', cold: '보관 원문', raw: '원문 영수증', raw_history: '원문 처리 이력', lineage: '세계선 계보', orphan: '미연결 기록'};
        const pending = !!state && !['complete', 'conflict'].includes(state.state);
        const migrationText = view.stateReadFailed ? '작업 상태 확인 필요' : state ? labels[state.state] : '진행 중인 이관 없음';
        const noRun = busy || !support || !view.migrationAvailable;
        return `<div class="wm-storage-summary" role="status" aria-live="polite">
            <strong data-wm-storage-mode>${escape(view.modeConfirmed ? modeLabel(view.mode) : '정본 위치 확인 필요')}</strong>
            <p>WM 전체 채팅의 기억에 적용됩니다. RisuAI 원래 채팅·페르소나·이미지는 기존 호스트에 남습니다.</p>
            <p data-wm-storage-connection>서버 연결: ${escape({unknown: '미확인', connected: '연결 확인됨', disconnected: '연결 안 됨'}[view.connection])}${view.connectionResult?.ok ? ' · ' + escape(view.connectionResult.backendId) + ' · ' + escape(view.connectionResult.protocol) : ''}</p>
            <p data-wm-storage-qualification>저장 전환 지원: ${view.manualProfile ? '수동 복사·검증·전환 v1' : support ? '제공자 지원 확인됨' : '사용 불가 · ' + escape(explain(view.qualification.reason))}</p>
            <p data-wm-storage-outage ${paused ? '' : 'hidden'}>WM 기억 갱신이 멈춰 있습니다. 일반 채팅 원본은 유지하며 로컬 자동 대체 저장을 하지 않습니다.</p>
            <p>연결 확인과 방식 선택만으로 기억을 업로드하거나 정본 위치를 바꾸지 않습니다. 서버 연결 해제도 로컬 복귀가 아닙니다.</p>
            <p ${view.migrationAvailable ? 'hidden' : ''}>전체 이관 사용 불가 · ${escape(explain('migration_provider_missing'))}</p>
            <p class="setting-note">연결 확인은 서버 저장 모드 활성화를 뜻하지 않습니다. ${view.manualProfile ? '이 수동 방식은 이 WM의 작업만 멈춥니다. 다른 창·구버전·외부 writer는 통제하지 못하며, 호스트 원자적 전환이나 정확히 한 번 실행을 보장하지 않습니다. 다른 창의 WM 작업을 멈춘 뒤 진행하세요.' : '안전한 호스트 제공자와 저장 전환 검증이 필요합니다.'}</p>
            <p data-wm-storage-reload ${view.reloadRequired?'':'hidden'}>저장 경로를 기록했습니다. WM을 다시 불러오거나 RisuAI를 새로고침해야 기억 작업이 재개됩니다. 원본은 보존되어 있습니다.</p>
            ${view.connectionResult?.reason ? `<p>${escape(explain(view.connectionResult.reason))}</p>` : ''}
            ${view.configurationReason ? `<p>${escape(explain(view.configurationReason))}</p>` : ''}
        </div>
        ${view.connectionConfigurationSupported ? `<section data-wm-connection-settings>
            <div class="fld"><label>WM 서버 주소<input type="url" data-wm-connection-url value="${escape(view.connectionConfiguration?.baseUrl || '')}" autocomplete="off" placeholder="https://server.example 또는 http://127.0.0.1:포트" ${busy ? 'disabled' : ''}></label></div>
            <div class="fld"><label>기존 WM 전용 접속 자격<input type="password" data-wm-connection-credential value="" autocomplete="new-password" spellcheck="false" placeholder="${view.connectionConfiguration?.credentialSaved ? '저장됨 · 같은 주소에서 비워 두면 유지' : '기존 WM 전용 자격 입력'}" ${busy ? 'disabled' : ''}></label></div>
            <p class="setting-note">주소와 입력한 접속 자격을 이 호스트의 플러그인 저장소에 보관합니다. 암호화된 금고는 아닙니다. 기억·설정 내보내기·진단 로그에는 포함하지 않습니다. 연결·접속 허용 버튼은 기존 LIB 서버의 WM 전용 접속 자격을 발급받아 이 호스트에 보관합니다. 시작 시 자동 발급하지 않으며 서버 실행은 별도입니다. 주소를 바꾸면 기존 자격은 재사용하지 않습니다.</p>
            <div class="toolbar"><button type="button" class="btn bs" data-wm-storage-action="connect-bootstrap" ${busy ? 'disabled' : ''}>LIB 서버에 WM 연결·접속 허용</button><button type="button" class="btn bs" data-wm-storage-action="save-connection" ${busy ? 'disabled' : ''}>주소·접속 자격 저장</button><button type="button" class="btn bs" data-wm-storage-action="clear-connection" ${busy ? 'disabled' : ''}>연결 설정 지우기</button></div>
        </section>` : ''}
        <div class="toolbar"><button type="button" class="btn bs" data-wm-storage-action="connection" ${busy ? 'disabled' : ''}>서버 연결 확인</button><button type="button" class="btn bs" data-wm-storage-action="refresh" ${busy ? 'disabled' : ''}>상태 새로고침</button></div>
        <div class="fld"><label>전체 기억을 옮길 저장 방식</label><select data-wm-storage-target ${busy || pending ? 'disabled' : ''}><option value="plugin_only" ${targetMode === 'plugin_only' ? 'selected' : ''}>플러그인에만 저장</option><option value="server_only" ${targetMode === 'server_only' ? 'selected' : ''}>서버에만 저장</option></select></div>
        <button type="button" class="btn bs" data-wm-storage-action="preview" ${noRun || pending ? 'disabled' : ''}>전체 이관 미리보기</button>
        <section data-wm-storage-preview ${preview ? '' : 'hidden'}>
            ${preview ? `<p>대상: ${escape(modeLabel(preview.targetMode))} · ${escape(preview.targetBackendId)}</p><p>전체 항목 ${sum(preview.domainCounts).toLocaleString()}개 · 필요한 추가 공간 ${bytesLabel(preview.requiredStagingBytes)}</p>
            <ul>${C.DOMAINS.map(domain => `<li>${domains[domain]}: ${preview.domainCounts[domain]}개 · ${bytesLabel(preview.domainBytes[domain])}</li>`).join('')}</ul>
            <p>원본과 이전 generation은 보존합니다. 이관 중 추가 공간이 필요하며 자동 삭제·병합·덮어쓰기는 하지 않습니다.</p>
            <p>${preview.complete ? '전체 목록 확인됨' : '전체 목록 미확인'}${preview.targetHasExistingData ? ' · 대상 기존 자료 있음' : ''}</p>
            ${preview.blockers.map(value => `<p>${escape(explain(value))}</p>`).join('')}` : ''}
            <button type="button" class="btn bp" data-wm-storage-action="confirm" ${noRun || !preview?.canStart || pending ? 'disabled' : ''}>전체 이관 확인 후 실행</button>
        </section>
        <section data-wm-storage-progress role="status" aria-live="polite" data-state="${escape(view.stateReadFailed ? 'uncertain' : state?.state || 'none')}">
            <strong>${escape(migrationText)}</strong>${state ? `<p>작업 ID: ${escape(state.operationId)}</p><p>복사한 용량: ${bytesLabel(state.copiedBytes)} / ${bytesLabel(sum(state.domainBytes))}</p>
            <progress max="${Math.max(1, sum(state.domainBytes))}" value="${Math.min(state.copiedBytes, sum(state.domainBytes))}" aria-label="WM 이관 복사 진행"></progress>
            ${state.reason ? `<p>${escape(explain(state.reason))}</p>` : ''}` : ''}
            <p data-wm-storage-success ${view.savedSuccessVisible ? '' : 'hidden'}>전체 기억 검증과 정본 전환이 확인되었습니다. 원본은 비활성 복구용 복사본으로 남습니다.</p>
            <button type="button" class="btn bp" data-wm-storage-action="switch" ${!view.manualProfile||state?.state!=='cutover_prepared'||busy||running?'disabled':''}>검증 결과 확인 후 정본 전환</button>
            <div class="toolbar"><button type="button" class="btn bs" data-wm-storage-action="resume" ${noRun || !pending || running ? 'disabled' : ''}>같은 작업 재개·결과 확인</button><button type="button" class="btn bs" data-wm-storage-action="cancel" ${!pending || busy && !running ? 'disabled' : ''}>이관 중단</button></div>
            <p class="setting-note">화면을 닫으면 다음 복사 단계가 멈춥니다. 보존된 작업 ID로 재개하며 새 이관을 만들지 않습니다.</p>
        </section>
        <section data-wm-storage-backups><p>마지막 백업: ${escape(backupLabel(view.lastBackup))}</p><p>마지막 복원: ${escape(backupLabel(view.lastRestore))}</p><p>다른 owner의 백업 완료는 WM 백업 검증을 뜻하지 않습니다.</p></section>
        <p data-wm-storage-message role="status">${escape(message)}</p>`;
    }
    function mountWmStoragePanel({root, viewModel, confirm = async () => false, newOperationId = () => 'wm-ui-' + globalThis.crypto.randomUUID()} = {}) {
        if (!root || !viewModel) throw Error('storage_panel_options_invalid');
        let disposed = false, busy = false, running = false, stopRequested = false, preview = null, operationId = null, targetMode = 'server_only', message = '', view = null;
        let refreshRevision = 0;
        const render = () => { if (!disposed && view) root.innerHTML = renderWmStoragePanel(view, {preview, targetMode, busy, running, message}); };
        async function refresh() {
            const revision = ++refreshRevision, next = await viewModel.inspect();
            if (disposed || revision !== refreshRevision) return;
            view = next;
            if (next.migration && (!preview?.canStart || !['complete', 'conflict'].includes(next.migration.state))) operationId = next.migration.operationId;
            render();
        }
        async function drive() {
            running = true; stopRequested = false; render();
            try {
                while (!disposed && !stopRequested) {
                    const next = await viewModel.advanceMigration(operationId); await refresh();
                    if (!next || !['inventory_frozen', 'copying', 'verifying', 'cutover_prepared'].includes(next.state) || next.state==='cutover_prepared'&&view?.manualProfile) break;
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            } finally { running = false; render(); }
        }
        const onChange = event => {
            if (!event.target.matches('[data-wm-storage-target]') || busy || running) return;
            targetMode = event.target.value; preview = null; operationId = null; message = '저장 방식 선택은 미리보기 대상만 바꿉니다.'; render();
        };
        const onClick = async event => {
            const button = event.target.closest('[data-wm-storage-action]');
            if (!button || !root.contains(button) || button.disabled || disposed) return;
            const action = button.dataset.wmStorageAction;
            if (action === 'cancel') {
                stopRequested = true;
                try { await viewModel.cancelMigration(operationId); message = '원본과 보존된 작업 상태를 확인해 주세요.'; await refresh(); } catch { message = '중단 결과 확인이 필요합니다.'; render(); }
                return;
            }
            if (busy || running) return;
            const connectionInput = ['save-connection','connect-bootstrap'].includes(action) ? {baseUrl:root.querySelector('[data-wm-connection-url]')?.value || '', credential:root.querySelector('[data-wm-connection-credential]')?.value || ''} : null;
            busy = true; message = ''; render();
            try {
                if(action==='connect-bootstrap'){const approved=await confirm('기존 LIB 서버에서 WM 전용 지속 접속 자격을 발급받고 이 호스트에 저장합니다. WM 데이터만 접근하며, 자격은 암호화된 금고에 저장되는 것이 아닙니다. 이 서버에 WM 접속을 허용할까요?');if(approved&&!disposed){await viewModel.connectUsingBootstrap({baseUrl:connectionInput.baseUrl,confirmed:true});message='WM 접속 자격을 저장했습니다. 전체 이관은 별도로 확인해 주세요.';}}
                else if(action==='switch'){const approved=await confirm('전체 복사본의 검증이 끝났습니다. 이 작업의 새 저장소로 WM 정본 경로를 전환할까요? 원본은 보존합니다. 전환 후 WM 재로드 또는 RisuAI 새로고침이 필요합니다.');if(approved&&!disposed)await viewModel.confirmSwitch(operationId,true);}
                else if (action === 'save-connection') { await viewModel.saveConnectionConfiguration(connectionInput); message = '연결 설정을 저장했습니다. 서버 연결 확인은 별도로 실행해 주세요.'; }
                else if (action === 'clear-connection') { await viewModel.clearConnectionConfiguration(); message = '연결 설정을 지웠습니다. 정본 저장 방식은 바뀌지 않았습니다.'; }
                else if (action === 'connection') await viewModel.checkConnection();
                else if (action === 'preview') { preview = await viewModel.previewMigration(targetMode); operationId = preview.canStart ? newOperationId() : null; }
                else if (action === 'confirm') {
                    if (!preview?.canStart || !operationId) return;
                    const approved = await confirm(`WM 전체 채팅의 기억 ${sum(preview.domainCounts)}개를 ${modeLabel(preview.targetMode)} 방식으로 옮깁니다.\n추가 공간 ${bytesLabel(preview.requiredStagingBytes)}이 필요합니다. 원본은 보존하며 전체 검증 후 정본 전환을 별도로 확인합니다. 이 WM 작업만 정지하며 다른 창·외부 writer는 통제하지 못합니다.\n전체 이관을 실행할까요?`);
                    if (!approved || disposed) return;
                    await viewModel.confirmMigration({previewFingerprint: preview.previewFingerprint, operationId});
                    busy = false; await refresh(); await drive();
                } else if (action === 'resume') { await viewModel.resumeMigration(operationId); busy = false; await refresh(); await drive(); }
                await refresh();
            } catch (error) {
                message = explain(reason(error?.message, 'migration_status_required'));
                if (error?.message === 'preview_changed') { preview = null; operationId = null; }
                await refresh().catch(() => {});
            } finally { busy = false; render(); }
        };
        root.addEventListener('click', onClick); root.addEventListener('change', onChange);
        const ready = refresh().catch(() => { message = '저장 상태를 확인할 수 없습니다.'; if (!disposed) root.textContent = message; });
        return Object.freeze({ready, refresh, dispose() { disposed = true; stopRequested = true; refreshRevision++; root.removeEventListener('click', onClick); root.removeEventListener('change', onChange); }});
    }
    return Object.freeze({createWmStorageViewModel, renderWmStoragePanel, mountWmStoragePanel});
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WmStorageUI;
