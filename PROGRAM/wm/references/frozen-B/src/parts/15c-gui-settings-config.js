        const buildNarrativeLoreEntry = () => ({
            key: LibraLoreKeys.narrative(),
            comment: 'lmai_narrative',
            content: JSON.stringify(_NAR),
            mode: 'normal',
            insertorder: 70,
            alwaysActive: false
        });

        const applyColdStartScopePresetToUI = (preset = 'all', limit = null) => {
            const select = overlay.querySelector('#scsp');
            const limitInput = overlay.querySelector('#schl');
            const limitWrap = overlay.querySelector('#schl-wrap');
            const normalizedPreset = String(preset || 'all').trim() || 'all';
            if (select) select.value = ['all', 'recent100', 'recent200', 'recent500', 'custom'].includes(normalizedPreset) ? normalizedPreset : 'custom';
            const resolvedLimit = Number(limit ?? _CFG?.coldStartHistoryLimit ?? MemoryEngine.CONFIG?.coldStartHistoryLimit ?? 0);
            if (limitInput) limitInput.value = Number.isFinite(resolvedLimit) && resolvedLimit > 0 ? Math.floor(resolvedLimit) : '';
            if (limitWrap) limitWrap.style.display = (select?.value === 'custom') ? 'block' : 'none';
        };

        const normalizeSettingsObjectValue = (value, fallback = {}) => {
            if (value && typeof value === 'object' && !Array.isArray(value)) return value;
            if (typeof value === 'string') {
                const raw = value.trim();
                if (!raw) return {};
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                } catch (_) {}
            }
            return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
        };
        const readSettingsJsonObject = (selector, fallback = {}, label = 'JSON') => {
            const node = overlay.querySelector(selector);
            const raw = String(node?.value || '').trim();
            if (!raw) return {};
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected');
                return parsed;
            } catch (_) {
                toast(`⚠ ${label} 형식 오류: 기존 설정을 유지합니다`);
                return normalizeSettingsObjectValue(fallback, {});
            }
        };
        const stringifySettingsJsonObject = (value = {}) => {
            try {
                return JSON.stringify(normalizeSettingsObjectValue(value, {}), null, 2);
            } catch (_) {
                return '{}';
            }
        };
        const redactSecretFieldsForDebug = (value, depth = 0) => {
            if (value === null || value === undefined || depth > 6) return value;
            if (Array.isArray(value)) return value.map(item => redactSecretFieldsForDebug(item, depth + 1));
            if (typeof value !== 'object') return value;
            const out = {};
            for (const [key, item] of Object.entries(value)) {
                out[key] = /(?:key|token|secret|password|credential|private_key)/i.test(key)
                    ? (item ? '[REDACTED]' : item)
                    : redactSecretFieldsForDebug(item, depth + 1);
            }
            return out;
        };
        const LLM_GUI_ROUTE_TASKS = Object.freeze([
            ['turnCanonicalPacket', '통합 패킷 추출'],
            ['turnMaintenanceBundle', '턴 유지보수'],
            ['worldAdditionalTurnAnalysis', '월드 에디셔널 턴 분석'],
            ['coldStartChunkSummary', '콜드스타트 청크'],
            ['coldStartFinalSynthesis', '콜드스타트 최종'],
            ['characterStateConsolidation', '캐릭터 상태'],
            ['worldStateConsolidation', '세계 상태'],
            ['guiWorldReanalysis', 'GUI 월드 재분석'],
            ['guiEntityReanalysis', 'GUI 엔티티 재분석'],
            ['guiNarrativeReanalysis', 'GUI 내러티브 재분석'],
            ['userDlcWorldAnalysis', '유저 DLC World 분석'],
            ['userDlcEntityAnalysis', '유저 DLC Entity 분석'],
            ['userDlcTrackerAnalysis', '유저 DLC 상태 추적'],
            ['mergeVerification', '병합 검증']
        ]);
        const LLM_GUI_ROUTE_KEYS = new Set(LLM_GUI_ROUTE_TASKS.map(([key]) => key));
        const normalizeCustomLLMPresetName = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            const normalized = normalizeLLMPresetName(raw);
            return normalized || '';
        };
        const normalizeVisibleLLMProfileValue = (value = '') => {
            const raw = String(value || '').trim();
            return raw ? normalizeLLMPresetName(raw) : '';
        };
        const getLLMPresetBacking = () => normalizeSettingsObjectValue(overlay.querySelector('#sllmpresets')?.value || {}, {});
        const setLLMPresetBacking = (presets = {}) => {
            const node = overlay.querySelector('#sllmpresets');
            if (node) node.value = stringifySettingsJsonObject(presets);
        };
        const getLLMRoutingBacking = () => normalizeSettingsObjectValue(overlay.querySelector('#sllmrouting')?.value || {}, {});
        const setLLMRoutingBacking = (routes = {}) => {
            const node = overlay.querySelector('#sllmrouting');
            if (node) node.value = stringifySettingsJsonObject(routes);
        };
        const getLLMRouteKeysForSelect = (select) => {
            if (!select) return [];
            const rawGroup = String(select.dataset?.llmRoutes || '').trim();
            if (rawGroup) {
                return rawGroup
                    .split(',')
                    .map(key => String(key || '').trim())
                    .filter(key => LLM_GUI_ROUTE_KEYS.has(key));
            }
            const single = String(select.dataset?.llmRoute || '').trim();
            return single && LLM_GUI_ROUTE_KEYS.has(single) ? [single] : [];
        };
        const getCustomLLMPresetNames = () => {
            const names = Object.keys(getLLMPresetBacking())
                .map(normalizeCustomLLMPresetName)
                .filter(Boolean)
                .filter((name, index, list) => list.indexOf(name) === index);
            const pinned = ['primary', 'aux'].filter(name => names.includes(name));
            const rest = names.filter(name => !pinned.includes(name)).sort((a, b) => a.localeCompare(b));
            return [...pinned, ...rest];
        };
        const uniqueCustomLLMPresetName = (base = 'preset') => {
            const names = new Set(getCustomLLMPresetNames());
            const cleanBase = normalizeCustomLLMPresetName(base) || 'preset';
            if (!names.has(cleanBase)) return cleanBase;
            let index = 2;
            while (names.has(`${cleanBase}_${index}`)) index += 1;
            return `${cleanBase}_${index}`;
        };
        const setSelectOptions = (select, options = [], selected = '') => {
            if (!select) return;
            const normalizedOptions = options.map(([value, label]) => [String(value || ''), String(label || value || '')]);
            select.innerHTML = normalizedOptions
                .map(([value, label]) => `<option value="${escAttr(value)}">${esc(label)}</option>`)
                .join('');
            const wanted = String(selected || '');
            const hasWanted = normalizedOptions.some(([value]) => value === wanted);
            select.value = hasWanted ? wanted : (normalizedOptions[0]?.[0] || '');
        };
        const buildLLMRouteProfileOptions = (includeGlobalDefault = true) => {
            const names = getCustomLLMPresetNames();
            const labelFor = (name = '') => {
                if (name === 'primary') return '기본 프리셋';
                if (name === 'aux') return '보조 프리셋';
                return name;
            };
            return [
                ...(includeGlobalDefault ? [['', '(전역/내장 기본)']] : []),
                ...names.map(name => [name, labelFor(name)])
            ];
        };
        const fetchedProviderModels = new Map();
        const providerModelCacheKey = (provider = '', url = '') => `${normalizePresetProviderKey(provider)}|${normalizePresetCompare(url)}`;
        const setLLMPresetModelStatus = (message = '', state = 'idle') => {
            const status = overlay.querySelector('#sllmp-model-status');
            if (!status) return;
            status.textContent = message || '제공자가 지원하면 API에서 최신 목록을 불러옵니다.';
            status.classList.remove('is-running', 'is-ok', 'is-failed');
            if (state === 'running') status.classList.add('is-running');
            else if (state === 'ok') status.classList.add('is-ok');
            else if (state === 'failed') status.classList.add('is-failed');
        };
        const syncLLMPresetRequestFormatSupport = (options = {}) => {
            const provider = overlay.querySelector('#sllmpp')?.value || 'openai';
            const meta = directProviderCatalog()?.get?.(provider, { url: overlay.querySelector('#sllmpu')?.value || '' }) || null;
            const select = overlay.querySelector('#sllmpfmt');
            const hint = overlay.querySelector('#sllmpfmt-hint');
            const responseOption = select?.querySelector('option[value="responses"]');
            const supportsResponses = meta?.supportsResponses === true;
            if (responseOption) responseOption.disabled = !supportsResponses;
            if (select && select.value === 'responses' && !supportsResponses && options.keepInvalid !== true) select.value = 'chat_completions';
            if (hint) {
                hint.textContent = supportsResponses
                    ? `${meta?.label || provider}는 Chat Completions와 Responses를 모두 지원합니다.`
                    : '이 제공자는 Chat Completions 형식을 사용합니다.';
            }
        };
        const syncLLMPresetModelDatalist = () => {
            const provider = overlay.querySelector('#sllmpp')?.value || 'openai';
            const url = overlay.querySelector('#sllmpu')?.value || '';
            const list = overlay.querySelector('#sllmp-provider-models');
            if (!list) return;
            const presetModels = providerPresetFor('llm', provider).models || [];
            const fetched = fetchedProviderModels.get(providerModelCacheKey(provider, url)) || [];
            const models = Array.from(new Set([...presetModels, ...fetched].map(item => String(item || '').trim()).filter(Boolean)));
            list.innerHTML = models.map(model => `<option value="${escAttr(model)}"></option>`).join('');
        };
        const refreshLLMPresetModels = async () => {
            const provider = overlay.querySelector('#sllmpp')?.value || 'openai';
            const url = overlay.querySelector('#sllmpu')?.value || '';
            const key = overlay.querySelector('#sllmpk')?.value || '';
            const catalog = directProviderCatalog();
            if (!catalog?.listModels) {
                setLLMPresetModelStatus('현재 환경에서는 모델 목록 조회를 사용할 수 없습니다.', 'failed');
                return;
            }
            const button = overlay.querySelector('#btn-llmp-refresh-models');
            if (button) button.disabled = true;
            setLLMPresetModelStatus('모델 목록을 불러오는 중…', 'running');
            try {
                const records = await catalog.listModels(provider, { url, key, force: true, timeout: 20000 });
                const models = (Array.isArray(records) ? records : []).map(item => typeof item === 'string' ? item : item?.id).filter(Boolean);
                fetchedProviderModels.set(providerModelCacheKey(provider, url), models);
                syncLLMPresetModelDatalist();
                setLLMPresetModelStatus(`${models.length}개 모델을 불러왔습니다.`, 'ok');
            } catch (error) {
                setLLMPresetModelStatus(error?.message || '모델 목록을 불러오지 못했습니다.', 'failed');
            } finally {
                if (button) button.disabled = false;
            }
        };
        const applyProviderPresetToLLMPresetEditor = (options = {}) => {
            const providerEl = overlay.querySelector('#sllmpp');
            const urlEl = overlay.querySelector('#sllmpu');
            const modelEl = overlay.querySelector('#sllmpm');
            const provider = providerEl?.value || 'openai';
            const preset = providerPresetFor('llm', provider);
            const force = options.force === true;
            syncLLMPresetModelDatalist();
            if (urlEl && preset.url && (force || isKnownProviderPresetUrl(urlEl.value, 'llm'))) urlEl.value = preset.url;
            const primaryModel = Array.isArray(preset.models) ? preset.models[0] : '';
            if (modelEl && primaryModel && (force || isKnownProviderPresetModel(modelEl.value, 'llm'))) modelEl.value = primaryModel;
            syncLLMPresetRequestFormatSupport();
        };
        const readStoredLLMProfileSeed = (slot = 'primary') => {
            const aux = String(slot || '').toLowerCase() === 'aux';
            const primarySource = _CFG.llm || MemoryEngine.CONFIG.llm || {};
            const configuredAux = _CFG.auxLlm || MemoryEngine.CONFIG.auxLlm || null;
            const source = aux ? (configuredAux || primarySource) : primarySource;
            return normalizeLLMRuntimeProviderFromUI({
                ...source,
                enabled: aux ? configuredAux?.enabled === true : true
            });
        };
        const writeLLMPresetEditorForm = (name = '', preset = {}) => {
            const source = preset && typeof preset === 'object' && !Array.isArray(preset) ? preset : {};
            const setValue = (selector, value = '') => {
                const node = overlay.querySelector(selector);
                if (node) node.value = value;
            };
            const setChecked = (selector, checked = false) => {
                const node = overlay.querySelector(selector);
                if (node) node.checked = !!checked;
            };
            setValue('#sllmpname', name || '');
            setChecked('#sllmpenabled', source.enabled !== false);
            setValue('#sllmpinherit', normalizeLLMPresetName(source.inherit || source.extends || source.base || '') === 'aux' ? 'aux' : 'primary');
            const providerSelect = overlay.querySelector('#sllmpp');
            if (providerSelect) {
                const provider = providerValueForSettingsUI(source, providerSelect.value || 'openai');
                providerSelect.value = Array.from(providerSelect.options || []).some(option => option.value === provider) ? provider : 'custom';
            }
            setValue('#sllmpu', source.url || '');
            setValue('#sllmpk', source.key || '');
            setValue('#sllmpm', source.model || '');
            setValue('#sllmpfmt', String(source.requestFormat || source.request_format || 'chat_completions').toLowerCase() === 'responses' ? 'responses' : 'chat_completions');
            const temp = Number.isFinite(Number(source.temp ?? source.temperature)) ? Number(source.temp ?? source.temperature) : 0.3;
            setValue('#sllmpt', String(Math.max(0, Math.min(2, temp))));
            const tempLabel = overlay.querySelector('#sllmptv');
            if (tempLabel) tempLabel.textContent = Number(overlay.querySelector('#sllmpt')?.value || temp).toFixed(2);
            setValue('#sllmpto', source.timeout || source.timeoutMs || source.timeout_ms || 120000);
            setValue('#sllmpmc', source.maxCompletionTokens || source.max_completion_tokens || source.max_tokens || DEFAULT_MAX_COMPLETION_TOKENS);
            setValue('#sllmprp', source.reasoningPreset || source.reasoning_preset || 'auto');
            setValue('#sllmpre', source.reasoningEffort || source.reasoning_effort || 'none');
            setValue('#sllmprb', source.reasoningBudgetTokens || source.reasoning_budget_tokens || 0);
            setValue('#sllmpgt', source.glmThinkingType || source.glm_thinking_type || source.glmThinking || 'enabled');
            setValue('#sllmpst', FlexTierPolicy.normalizeServiceTier(source.serviceTier || source.service_tier || 'off'));
            setChecked('#sllmpstream', source.stream === true || String(source.stream || '').toLowerCase() === 'true');
            syncLLMPresetModelDatalist();
            syncLLMPresetRequestFormatSupport({ keepInvalid: true });
        };
        const readLLMPresetEditorForm = () => {
            const provider = overlay.querySelector('#sllmpp')?.value || 'openai';
            const inherit = normalizeLLMPresetName(overlay.querySelector('#sllmpinherit')?.value || 'primary') === 'aux' ? 'aux' : 'primary';
            const payload = normalizeLLMRuntimeProviderFromUI({
                enabled: overlay.querySelector('#sllmpenabled')?.checked !== false,
                inherit,
                provider,
                url: overlay.querySelector('#sllmpu')?.value || '',
                key: overlay.querySelector('#sllmpk')?.value || '',
                model: overlay.querySelector('#sllmpm')?.value || '',
                requestFormat: overlay.querySelector('#sllmpfmt')?.value || 'chat_completions',
                temp: Number.isFinite(parseFloat(overlay.querySelector('#sllmpt')?.value)) ? parseFloat(overlay.querySelector('#sllmpt').value) : 0.3,
                timeout: parseInt(overlay.querySelector('#sllmpto')?.value || 120000, 10) || 120000,
                serviceTier: FlexTierPolicy.normalizeServiceTier(overlay.querySelector('#sllmpst')?.value || 'off'),
                stream: overlay.querySelector('#sllmpstream')?.checked === true,
                reasoningPreset: overlay.querySelector('#sllmprp')?.value || 'auto',
                reasoningEffort: overlay.querySelector('#sllmpre')?.value || 'none',
                reasoningBudgetTokens: parseInt(overlay.querySelector('#sllmprb')?.value || 0, 10) || 0,
                maxCompletionTokens: parseInt(overlay.querySelector('#sllmpmc')?.value || DEFAULT_MAX_COMPLETION_TOKENS, 10) || DEFAULT_MAX_COMPLETION_TOKENS,
                glmThinkingType: overlay.querySelector('#sllmpgt')?.value || 'enabled'
            });
            payload.inherit = inherit;
            return {
                name: normalizeCustomLLMPresetName(overlay.querySelector('#sllmpname')?.value || ''),
                preset: payload
            };
        };
        const replaceLLMProfileReferences = (fromName = '', toName = '') => {
            const from = normalizeCustomLLMPresetName(fromName);
            const to = normalizeVisibleLLMProfileValue(toName);
            if (!from) return;
            const defaultSelect = overlay.querySelector('#sllmdefault');
            if (defaultSelect && normalizeVisibleLLMProfileValue(defaultSelect.value) === from) defaultSelect.value = to || '';
            const routes = getLLMRoutingBacking();
            for (const [key, value] of Object.entries(routes)) {
                if (normalizeVisibleLLMProfileValue(value) === from) routes[key] = to || '';
            }
            setLLMRoutingBacking(routes);
            overlay.querySelectorAll('[data-llm-route],[data-llm-routes]').forEach(select => {
                if (normalizeVisibleLLMProfileValue(select.value) === from) select.value = to || '';
            });
        };
        const refreshLLMProfileSelects = () => {
            const names = getCustomLLMPresetNames();
            const presetSelect = overlay.querySelector('#sllmpresetselect');
            const selectedPreset = normalizeCustomLLMPresetName(presetSelect?.value || '') || names[0] || '';
            setSelectOptions(presetSelect, names.length ? names.map(name => [name, name]) : [['', '(프리셋 없음)']], names.includes(selectedPreset) ? selectedPreset : (names[0] || ''));
            const defaultSelect = overlay.querySelector('#sllmdefault');
            const currentDefault = normalizeVisibleLLMProfileValue(defaultSelect?.value || '');
            setSelectOptions(defaultSelect, buildLLMRouteProfileOptions(false), currentDefault || 'primary');
            const routeOptions = buildLLMRouteProfileOptions(true);
            overlay.querySelectorAll('[data-llm-route],[data-llm-routes]').forEach(select => {
                const current = normalizeVisibleLLMProfileValue(select.value || '');
                setSelectOptions(select, routeOptions, current);
            });
        };
        const syncLLMRoutingControlsToBacking = () => {
            const routes = {};
            overlay.querySelectorAll('[data-llm-route],[data-llm-routes]').forEach(select => {
                const profile = normalizeVisibleLLMProfileValue(select.value || '');
                for (const key of getLLMRouteKeysForSelect(select)) {
                    if (profile) routes[key] = profile;
                }
            });
            setLLMRoutingBacking(routes);
            return routes;
        };
        const syncLLMRoutingControlsFromBacking = () => {
            const routes = normalizeLLMRouteMap(getLLMRoutingBacking());
            refreshLLMProfileSelects();
            overlay.querySelectorAll('[data-llm-route],[data-llm-routes]').forEach(select => {
                const keys = getLLMRouteKeysForSelect(select);
                const values = keys.map(key => normalizeVisibleLLMProfileValue(routes[key] || '')).filter(Boolean);
                const first = values[0] || '';
                const value = values.length && values.every(item => item === first) ? first : '';
                const hasValue = Array.from(select.options || []).some(option => option.value === value);
                select.value = hasValue ? value : '';
            });
        };
        const syncCurrentLLMPresetEditorToBacking = (options = {}) => {
            const allowRename = options.allowRename === true;
            const silent = options.silent !== false;
            const presetSelect = overlay.querySelector('#sllmpresetselect');
            const selected = normalizeCustomLLMPresetName(presetSelect?.value || '');
            const form = readLLMPresetEditorForm();
            const targetName = allowRename ? form.name : selected;
            if (!targetName) {
                if (!silent) toast('⚠ 프리셋 이름을 입력하세요');
                return false;
            }
            const presets = getLLMPresetBacking();
            if (allowRename && selected && selected !== targetName) {
                delete presets[selected];
                replaceLLMProfileReferences(selected, targetName);
            }
            presets[targetName] = form.preset;
            setLLMPresetBacking(presets);
            refreshLLMProfileSelects();
            if (presetSelect) presetSelect.value = targetName;
            if (allowRename) writeLLMPresetEditorForm(targetName, presets[targetName]);
            return true;
        };
        const setLLMPresetTestStatus = (message = '', state = 'idle') => {
            const status = overlay.querySelector('#llmp-test-status');
            if (!status) return;
            status.textContent = message || '프리셋 테스트 대기 중';
            status.classList.remove('is-running', 'is-ok', 'is-failed');
            if (state === 'running') status.classList.add('is-running');
            else if (state === 'ok') status.classList.add('is-ok');
            else if (state === 'failed') status.classList.add('is-failed');
        };
        const initializeLLMPresetEditor = () => {
            const presetSelect = overlay.querySelector('#sllmpresetselect');
            if (!presetSelect) return;
            if (overlay.dataset.llmPresetEditorBound !== '1') {
                overlay.dataset.llmPresetEditorBound = '1';
                presetSelect.addEventListener('change', () => {
                    const name = normalizeCustomLLMPresetName(presetSelect.value || '');
                    const presets = getLLMPresetBacking();
                    writeLLMPresetEditorForm(name, presets[name] || {});
                });
                overlay.querySelector('#sllmpp')?.addEventListener('change', () => {
                    applyProviderPresetToLLMPresetEditor({ force: true });
                    syncVertexCredentialPanels();
                    syncCurrentLLMPresetEditorToBacking({ silent: true });
                });
                overlay.querySelector('#btn-llmp-refresh-models')?.addEventListener('click', refreshLLMPresetModels);
                ['#sllmpenabled', '#sllmpinherit', '#sllmpu', '#sllmpk', '#sllmpm', '#sllmpfmt', '#sllmpt', '#sllmpto', '#sllmpmc', '#sllmprp', '#sllmpre', '#sllmprb', '#sllmpgt', '#sllmpst', '#sllmpstream'].forEach(selector => {
                    const node = overlay.querySelector(selector);
                    if (!node) return;
                    const handler = () => {
                        const tempLabel = overlay.querySelector('#sllmptv');
                        if (selector === '#sllmpt' && tempLabel) tempLabel.textContent = Number(node.value || 0).toFixed(2);
                        if (selector === '#sllmpu') {
                            syncLLMPresetModelDatalist();
                            syncLLMPresetRequestFormatSupport({ keepInvalid: true });
                        }
                        if (selector === '#sllmpk') syncVertexCredentialPanels();
                        syncCurrentLLMPresetEditorToBacking({ silent: true });
                    };
                    node.addEventListener('input', handler);
                    node.addEventListener('change', handler);
                });
                overlay.querySelector('#btn-llmp-new')?.addEventListener('click', () => {
                    const baseSlot = 'primary';
                    const name = uniqueCustomLLMPresetName('profile');
                    const presets = getLLMPresetBacking();
                    presets[name] = { ...readStoredLLMProfileSeed(baseSlot), inherit: baseSlot };
                    setLLMPresetBacking(presets);
                    refreshLLMProfileSelects();
                    presetSelect.value = name;
                    writeLLMPresetEditorForm(name, presets[name]);
                    toast(`➕ LLM 프리셋 생성: ${name}`);
                });
                overlay.querySelector('#btn-llmp-clone')?.addEventListener('click', () => {
                    const selected = normalizeCustomLLMPresetName(presetSelect.value || '');
                    const presets = getLLMPresetBacking();
                    const source = presets[selected] || readStoredLLMProfileSeed('primary');
                    const name = uniqueCustomLLMPresetName(selected ? `${selected}_copy` : 'profile_copy');
                    presets[name] = safeClone(source);
                    setLLMPresetBacking(presets);
                    refreshLLMProfileSelects();
                    presetSelect.value = name;
                    writeLLMPresetEditorForm(name, presets[name]);
                    toast(`⧉ LLM 프리셋 복제: ${name}`);
                });
                overlay.querySelector('#btn-llmp-save')?.addEventListener('click', () => {
                    if (syncCurrentLLMPresetEditorToBacking({ allowRename: true, silent: false })) {
                        toast('✅ LLM 프리셋 적용됨');
                    }
                });
                overlay.querySelector('#btn-llmp-delete')?.addEventListener('click', () => {
                    const selected = normalizeCustomLLMPresetName(presetSelect.value || '');
                    if (!selected) {
                        toast('⚠ 삭제할 프리셋이 없습니다');
                        return;
                    }
                    const presets = getLLMPresetBacking();
                    delete presets[selected];
                    setLLMPresetBacking(presets);
                    replaceLLMProfileReferences(selected, '');
                    syncLLMRoutingControlsFromBacking();
                    const next = getCustomLLMPresetNames()[0] || '';
                    if (presetSelect) presetSelect.value = next;
                    writeLLMPresetEditorForm(next, presets[next] || {});
                    toast(`🗑 LLM 프리셋 삭제: ${selected}`);
                });
                overlay.querySelector('#btn-test-llmp')?.addEventListener('click', async () => {
                    if (!syncCurrentLLMPresetEditorToBacking({ allowRename: true, silent: false })) return;
                    const selected = normalizeCustomLLMPresetName(presetSelect.value || '');
                    const button = overlay.querySelector('#btn-test-llmp');
                    try {
                        if (button) button.disabled = true;
                        setLLMPresetTestStatus(`${selected} 호출 테스트 중...`, 'running');
                        const cfg = buildSettingsConfigFromUI();
                        const result = await LLMProviderCallTest.run(cfg, selected);
                        setLLMPresetTestStatus(formatProviderTestResult(result), result.ok ? 'ok' : 'failed');
                        toast(result.ok ? `${selected} 호출 테스트 성공` : `${selected} 호출 테스트 실패`, 2600);
                    } catch (error) {
                        const message = error?.message || String(error || 'unknown error');
                        setLLMPresetTestStatus(`${selected} 호출 테스트 실패 · ${message}`, 'failed');
                        toast(`❌ ${selected} 호출 테스트 실패: ${message}`, 3000);
                    } finally {
                        if (button) button.disabled = false;
                    }
                });
                overlay.querySelectorAll('[data-llm-route]').forEach(select => {
                    select.addEventListener('change', () => {
                        syncLLMRoutingControlsToBacking();
                    });
                });
            }
            refreshLLMProfileSelects();
            const names = getCustomLLMPresetNames();
            const selected = normalizeCustomLLMPresetName(presetSelect.value || '') || names[0] || '';
            if (presetSelect) presetSelect.value = selected;
            const presets = getLLMPresetBacking();
            writeLLMPresetEditorForm(selected, presets[selected] || {});
            syncLLMRoutingControlsFromBacking();
        };
        // 선택적 숫자 입력 헬퍼 — 빈 칸이면 기존/기본값을 유지한다 (undefined 로 덮지 않는다).
        const readOptionalNumber = (selector, fallback) => {
            const raw = overlay.querySelector(selector)?.value;
            if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
            const n = Number(raw);
            return Number.isFinite(n) ? n : fallback;
        };
        const readOptionalInt = (selector, fallback) => {
            const v = readOptionalNumber(selector, fallback);
            return Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback;
        };
        // scoring_* 세부 가중치는 하나라도 입력되면 객체로 모아 반환한다.
        const buildScoringWeightsFromUi = () => {
            const map = {
                word: readOptionalNumber('#sscword', undefined),
                char: readOptionalNumber('#sscchar', undefined),
                concept: readOptionalNumber('#sscconcept', undefined),
                lexicalCoverage: readOptionalNumber('#ssclex', undefined),
                focus: readOptionalNumber('#sscfocus', undefined)
            };
            const out = {};
            for (const [k, v] of Object.entries(map)) if (v !== undefined) out[k] = v;
            return Object.keys(out).length ? out : (_CFG.scoringWeights || MemoryEngine.CONFIG.scoringWeights || null);
        };
        const syncDualRecallReadiness = () => {
            const node=overlay.querySelector('#sdual-readiness');if(!node)return;
            const state=TypedRecallRollout.inspect(),r=state.readiness;
            node.textContent=`Mode ${state.mode}; semantic configured ${r.semanticConfigured===true}; semantic ready ${r.semanticReady===true}; ${r.reason||r.status}; uncalibrated operational default`;
        };
        const buildDualRecallSettingsFromUI = () => {
            const number=id=>{const value=overlay.querySelector('#'+id)?.value;return value===undefined||String(value).trim()===''?NaN:Number(value);};
            const dimension=overlay.querySelector('#sedimension')?.value;
            const result={dualRecallMode:overlay.querySelector('#sdual-mode')?.value||_CFG.dualRecallMode||'dual',
                dualRecallHeuristicDepth:number('sdual-hdepth'),dualRecallSemanticDepth:number('sdual-sdepth'),dualRecallRrfK:number('sdual-rrf'),dualRecallQueryBudgetMs:number('sdual-budget'),
                dualRecallAdmission:Object.fromEntries(['memory','entity','world','narrative'].map(f=>[f,{heuristicMinScore:number('sdual-'+f+'-heuristic'),semanticMinScore:number('sdual-'+f+'-semantic'),semanticMinMargin:number('sdual-'+f+'-margin'),semanticMinLexicalOverlap:0}])),
                embed:{dimension:dimension===undefined||dimension.trim()===''?null:Number(dimension),modelRevision:overlay.querySelector('#serevision')?.value||''}};
            const errors=TypedRecallRollout.validateProductionRecallSettings(result);if(errors.length)throw new Error('Invalid recall field: '+errors.join(', '));
            return result;
        };
        const buildSettingsConfigFromUI = () => {
            const dualSettings=buildDualRecallSettingsFromUI();
            const coldStartScopePreset = String(overlay.querySelector('#scsp')?.value || _CFG.coldStartScopePreset || MemoryEngine.CONFIG.coldStartScopePreset || 'all');
            const coldStartCustomLimit = Number(overlay.querySelector('#schl')?.value || _CFG.coldStartHistoryLimit || MemoryEngine.CONFIG.coldStartHistoryLimit || 0);
            const analysisEvidenceMode = normalizeAnalysisEvidenceMode(overlay.querySelector('#saem')?.value || _CFG.analysisEvidenceMode || MemoryEngine.CONFIG.analysisEvidenceMode);
            const storyAuthorMode = String(overlay.querySelector("#ssam")?.value || _CFG.storyAuthorMode || MemoryEngine.CONFIG.storyAuthorMode || 'disabled').toLowerCase();
            const directorMode = String(overlay.querySelector("#sdm")?.value || _CFG.directorMode || MemoryEngine.CONFIG.directorMode || 'disabled').toLowerCase();
            const nsfwMode = normalizeNsfwMode(overlay.querySelector("#snsfwm")?.value || _CFG.nsfwMode || MemoryEngine.CONFIG.nsfwMode || (_CFG.nsfwEnabled || MemoryEngine.CONFIG.nsfwEnabled ? 'direct' : 'off'));
            const worldAdditionalMax = Math.max(1, Math.min(6, parseInt(overlay.querySelector("#swamax")?.value || _CFG.worldAdditionalMaxPerRequest || MemoryEngine.CONFIG.worldAdditionalMaxPerRequest || 3, 10) || 3));
            const storedMainLlm = readStoredLLMProfileSeed('primary');
            const storedAuxLlm = readStoredLLMProfileSeed('aux');
            syncCurrentLLMPresetEditorToBacking({ silent: true });
            syncLLMRoutingControlsToBacking();
            const llmPresetSource = readSettingsJsonObject('#sllmpresets', _CFG.llmPresets || MemoryEngine.CONFIG.llmPresets || {}, 'LLM 프로필 JSON');
            const llmRoutingSource = readSettingsJsonObject('#sllmrouting', _CFG.llmRouting || MemoryEngine.CONFIG.llmRouting || {}, '작업별 라우팅 JSON');
            const llmDefaultField = overlay.querySelector("#sllmdefault");
            const llmDefaultPreset = normalizeLLMPresetName(llmDefaultField ? llmDefaultField.value : (_CFG.llmDefaultPreset || MemoryEngine.CONFIG.llmDefaultPreset || ''));
            const normalizedLlmPresets = normalizeLLMPresetMap(llmPresetSource, storedMainLlm, storedAuxLlm);
            const mainLlmFromUi = normalizeLLMRuntimeProviderFromUI({
                ...storedMainLlm,
                ...(normalizedLlmPresets.primary || {})
            });
            const auxLlmFromUi = normalizeLLMRuntimeProviderFromUI({
                ...storedMainLlm,
                ...storedAuxLlm,
                ...(normalizedLlmPresets.aux || {}),
                enabled: normalizedLlmPresets.aux ? normalizedLlmPresets.aux.enabled !== false : storedAuxLlm.enabled === true
            });
            return normalizeMemoryRetentionSettings({
                ...buildOptimizedHiddenSettingsDefaults({ coldStartScopePreset, coldStartHistoryLimit: coldStartCustomLimit, analysisEvidenceMode }),
                ...dualSettings,
                activityDashboard: normalizeActivityDashboard(overlay.querySelector("#sactdash")?.value || _CFG.activityDashboard || MemoryEngine.CONFIG.activityDashboard || 'compact', 'compact'),
                debug: overlay.querySelector("#sdebug")?.checked === true,
                entityBlocklist: normalizeEntityBlocklistCollection(_CFG.entityBlocklist || MemoryEngine.CONFIG.entityBlocklist || []),
                nsfwGuidancePromptEnabled: overlay.querySelector("#sngp")?.checked !== false,
                assistantPrefillEnabled: overlay.querySelector("#sapf")?.checked !== false,
                nsfwMode,
                nsfwEnabled: nsfwMode !== 'off',
                // 기능 토글 / HME / RP (2026-09 신규 노출)
                emotionEnabled: overlay.querySelector('#semotion')?.checked === true,
                secretKnowledgeEnabled: overlay.querySelector('#ssecret')?.checked === true,
                entityKnowledgeVaultEnabled: overlay.querySelector('#svault')?.checked === true,
                cbsEnabled: overlay.querySelector('#scbs')?.checked === true,
                characterSourceReflectionEnabled: overlay.querySelector('#screfl')?.checked === true,
                personaBindingSyncEnabled: overlay.querySelector('#spsync')?.checked === true,
                sectionWorldInferenceEnabled: overlay.querySelector('#sswi')?.checked === true,
                responseStreamingCompatEnabled: overlay.querySelector('#sstream')?.checked === true,
                bypassAuxRequests: overlay.querySelector('#sbypass')?.checked === true,
                useLorebookRAG: overlay.querySelector('#srag')?.checked === true,
                hybridMemoryEngineEnabled: overlay.querySelector('#shme')?.checked === true,
                hmeAssociativeGraphMode: String(overlay.querySelector('#shmegraph')?.value || _CFG.hmeAssociativeGraphMode || MemoryEngine.CONFIG.hmeAssociativeGraphMode || 'off'),
                hmeGraphDebug: String(overlay.querySelector('#shmedbg')?.value || _CFG.hmeGraphDebug || MemoryEngine.CONFIG.hmeGraphDebug || 'off'),
                rpLongTermMemoryEnabled: overlay.querySelector('#srplt')?.checked === true,
                rpLongTermLongTtl: readOptionalInt('#srplttl', _CFG.rpLongTermLongTtl ?? MemoryEngine.CONFIG.rpLongTermLongTtl),
                rpLongTermInjectionMaxChars: readOptionalInt('#srplchars', _CFG.rpLongTermInjectionMaxChars ?? MemoryEngine.CONFIG.rpLongTermInjectionMaxChars),
                afterRequestParallelAnalysis: overlay.querySelector('#sapara')?.checked === true,
                // 회상 가중치 / 선별 / 주입 예산 (2026-09 신규 노출)
                weightMode: String(overlay.querySelector('#swmode')?.value || _CFG.weightMode || MemoryEngine.CONFIG.weightMode || 'auto'),
                weights: {
                    similarity: readOptionalNumber('#swsim', _CFG.weights?.similarity ?? MemoryEngine.CONFIG.weights?.similarity),
                    importance: readOptionalNumber('#swimp', _CFG.weights?.importance ?? MemoryEngine.CONFIG.weights?.importance),
                    recency: readOptionalNumber('#swrec', _CFG.weights?.recency ?? MemoryEngine.CONFIG.weights?.recency)
                },
                recallEvidenceGate: String(overlay.querySelector('#sreg')?.value || _CFG.recallEvidenceGate || MemoryEngine.CONFIG.recallEvidenceGate || 'soft'),
                scoringProfile: String(overlay.querySelector('#sscprof')?.value || _CFG.scoringProfile || MemoryEngine.CONFIG.scoringProfile || 'balanced'),
                scoringWeights: buildScoringWeightsFromUi(),
                maxLimit: readOptionalInt('#smaxlimit', _CFG.maxLimit ?? MemoryEngine.CONFIG.maxLimit),
                threshold: readOptionalNumber('#sthr', _CFG.threshold ?? MemoryEngine.CONFIG.threshold),
                simThreshold: readOptionalNumber('#ssimthr', _CFG.simThreshold ?? MemoryEngine.CONFIG.simThreshold),
                memoryPreset: String(overlay.querySelector('#smempreset')?.value || 'custom'),
                gcBatchSize: _CFG.gcBatchSize ?? MemoryEngine.CONFIG.gcBatchSize,
                injectionBudgetPreset: String(overlay.querySelector('#sinjbp')?.value || _CFG.injectionBudgetPreset || MemoryEngine.CONFIG.injectionBudgetPreset || ''),
                injectionBudgetMaxTokens: readOptionalInt('#sinjbtok', _CFG.injectionBudgetMaxTokens ?? MemoryEngine.CONFIG.injectionBudgetMaxTokens),
                storyAuthorEnabled: storyAuthorMode !== 'disabled',
                storyAuthorMode: storyAuthorMode === 'disabled' ? 'disabled' : storyAuthorMode,
                directorEnabled: directorMode !== 'disabled',
                directorMode: directorMode === 'disabled' ? 'disabled' : directorMode,
                worldAdditionalEnabled: true,
                worldAdditionalMode: 'firm',
                worldAdditionalMaxPerRequest: worldAdditionalMax,
                worldAdditionalAutoIntegrate: true,
                worldCanonCustomText: '',
                worldCanonCustomForce: false,
                worldAdditionalCustomText: '',
                worldAdditionalCustomForce: false,
                flexRoutingMode: FlexTierPolicy.normalizeRoutingMode(overlay.querySelector("#sfrm")?.value || 'off'),
                flexTimeoutMs: FlexTierPolicy.normalizeTimeout(parseInt(overlay.querySelector("#sfto")?.value || 600000, 10) || 600000),
                flexFallbackToStandard: overlay.querySelector("#sffb")?.checked === true,
                vertexFlexMode: FlexTierPolicy.normalizeVertexFlexMode(overlay.querySelector("#svfm")?.value || 'provisioned_then_flex'),
                customServiceTierPassthrough: overlay.querySelector("#scstp")?.checked === true,
                llm: mainLlmFromUi,
                auxLlm: auxLlmFromUi,
                llmPresets: normalizedLlmPresets,
                llmRouting: normalizeLLMRouteMap(llmRoutingSource),
                llmDefaultPreset: llmDefaultPreset || 'primary',
                embed: {
                    ...(_CFG.embed || {}),
                    ...dualSettings.embed,
                    enabled: overlay.querySelector('#seenabled')?.checked === true,
                    provider: overlay.querySelector("#sep").value,
                    url: overlay.querySelector("#seu").value,
                    key: overlay.querySelector("#sek").value,
                    model: overlay.querySelector("#sem").value,
                    timeout: parseInt(overlay.querySelector("#seto").value) || 120000
                }
            });
        };
        const formatProviderTestUsage = (usage = {}) => {
            const input = Number(usage.prompt_tokens ?? usage.promptTokenCount ?? usage.input_tokens ?? 0) || 0;
            const output = Number(usage.completion_tokens ?? usage.candidatesTokenCount ?? usage.output_tokens ?? 0) || 0;
            const total = Number(usage.total_tokens ?? usage.totalTokenCount ?? usage.total_tokens ?? 0) || (input + output);
            if (!input && !output && !total) return '';
            return `tokens ${total || '?'}${input || output ? ` (in ${input || '?'}, out ${output || '?'})` : ''}`;
        };
        const formatProviderTestStream = (stream = {}) => {
            const requested = stream.requested === true ? 'stream 요청' : 'non-stream';
            const used = stream.used === true ? 'stream 사용' : '일반 응답';
            const fallback = stream.meta?.fallbackNonStream ? 'reader 폴백' : '';
            return [requested, used, fallback].filter(Boolean).join(' / ');
        };
        const formatProviderTestResult = (result = {}) => {
            const provider = [result.provider || 'provider', result.model || 'model'].filter(Boolean).join('/');
            const duration = Number.isFinite(Number(result.durationMs)) ? `${Math.max(0, Math.round(Number(result.durationMs)))}ms` : '';
            const stream = formatProviderTestStream(result.stream || {});
            const usage = formatProviderTestUsage(result.usage || {});
            const flex = result.flex?.serviceTier || result.serviceTier ? `tier ${result.flex?.serviceTier || result.serviceTier}` : '';
            const endpoint = result.fallbackEndpoint ? `fallback /api/${result.fallbackEndpoint}` : '';
            const diagnostic = result.diagnostic ? `진단 ${result.diagnostic}` : '';
            const prefix = result.ok ? '성공' : (result.skipped ? '건너뜀' : '실패');
            const detail = result.ok
                ? (result.preview ? `응답 "${result.preview}"` : '테스트 토큰 확인')
                : `오류 ${result.error || 'unknown'}`;
            return [prefix, provider, duration, stream, usage, flex, endpoint, detail, diagnostic].filter(Boolean).join(' · ');
        };
        const normalizeImportedSettingsConfig = (importedConfig) => {
            const incoming = normalizeMemoryRetentionSettings(normalizeSettingsAliases(importedConfig));
            const merged = {
                ..._CFG,
                ...incoming,
                llm: {
                    ...(_CFG.llm || {}),
                    ...(incoming.llm && typeof incoming.llm === 'object' && !Array.isArray(incoming.llm) ? incoming.llm : {})
                },
                auxLlm: {
                    ...(_CFG.auxLlm || {}),
                    ...(incoming.auxLlm && typeof incoming.auxLlm === 'object' && !Array.isArray(incoming.auxLlm) ? incoming.auxLlm : {})
                },
                embed: {
                    ...(_CFG.embed || {}),
                    ...(incoming.embed && typeof incoming.embed === 'object' && !Array.isArray(incoming.embed) ? incoming.embed : {})
                }
            };
            const importedNsfwMode = Object.prototype.hasOwnProperty.call(incoming, 'nsfwMode')
                ? incoming.nsfwMode
                : Object.prototype.hasOwnProperty.call(incoming, 'nsfwEnabled')
                    ? (incoming.nsfwEnabled ? 'direct' : 'off')
                    : (_CFG.nsfwMode ?? MemoryEngine.CONFIG.nsfwMode ?? (_CFG.nsfwEnabled || MemoryEngine.CONFIG.nsfwEnabled ? 'direct' : 'off'));
            const importedNsfwEnabled = incoming.nsfwEnabled ?? _CFG.nsfwEnabled ?? MemoryEngine.CONFIG.nsfwEnabled;
            const importedNsfwGuidancePromptEnabled = incoming.nsfwGuidancePromptEnabled ?? _CFG.nsfwGuidancePromptEnabled ?? MemoryEngine.CONFIG.nsfwGuidancePromptEnabled;
            const importedAssistantPrefillEnabled = incoming.assistantPrefillEnabled ?? _CFG.assistantPrefillEnabled ?? MemoryEngine.CONFIG.assistantPrefillEnabled;
            if (merged.storyAuthorMode === undefined) merged.storyAuthorMode = merged.storyAuthorEnabled === true ? 'proactive' : 'disabled';
            merged.storyAuthorMode = ['disabled', 'supportive', 'proactive', 'aggressive'].includes(String(merged.storyAuthorMode || '').toLowerCase())
                ? String(merged.storyAuthorMode).toLowerCase()
                : 'disabled';
            merged.storyAuthorEnabled = merged.storyAuthorEnabled !== false && merged.storyAuthorMode !== 'disabled';
            if (!merged.storyAuthorEnabled) merged.storyAuthorMode = 'disabled';
            if (merged.directorMode === undefined) merged.directorMode = merged.directorEnabled === true ? 'strong' : 'disabled';
            merged.directorMode = ['disabled', 'light', 'standard', 'strong', 'absolute'].includes(String(merged.directorMode || '').toLowerCase())
                ? String(merged.directorMode).toLowerCase()
                : 'disabled';
            merged.directorEnabled = merged.directorEnabled !== false && merged.directorMode !== 'disabled';
            if (!merged.directorEnabled) merged.directorMode = 'disabled';
            merged.worldAdditionalEnabled = true;
            merged.worldAdditionalMode = 'firm';
            merged.worldAdditionalMaxPerRequest = Math.max(1, Math.min(6, parseInt(merged.worldAdditionalMaxPerRequest || 3, 10) || 3));
            merged.worldAdditionalAutoIntegrate = true;
            merged.worldCanonCustomText = '';
            merged.worldCanonCustomForce = false;
            merged.worldAdditionalCustomText = '';
            merged.worldAdditionalCustomForce = false;
            const importedActivityDashboard = normalizeActivityDashboard(merged.activityDashboard || 'compact', 'compact');
            const importedDebug = merged.debug === true || /^(1|true|yes|on|enabled)$/i.test(String(merged.debug || '').trim());
            merged.entityBlocklist = normalizeEntityBlocklistCollection(merged.entityBlocklist || []);
            const coldStartScopePreset = ['all', 'recent100', 'recent200', 'recent500', 'custom'].includes(String(merged.coldStartScopePreset || '').trim())
                ? String(merged.coldStartScopePreset).trim()
                : inferColdStartScopePreset(merged.coldStartHistoryLimit);
            // ★ 감사 P1 — 종전엔 여기서 `Object.assign(merged, 기본값)` 을 해 **가져온 설정을 덮었다**
            //   (사용자 GUI 키 31종: useLorebookRAG·sectionWorld·rpLongTerm·memoryPreset·threshold …).
            //   내보내기/가져오기는 "이 파일이 내 설정의 복사본"이라는 신뢰 기능이므로
            //   **가져온 값이 이기고**, 없는 키만 기본값으로 채운다.
            const importedDefaults = buildOptimizedHiddenSettingsDefaults({
                coldStartScopePreset,
                coldStartHistoryLimit: merged.coldStartHistoryLimit,
                analysisEvidenceMode: merged.analysisEvidenceMode
            });
            for (const [key, value] of Object.entries(importedDefaults)) {
                if (Object.prototype.hasOwnProperty.call(incoming, key)) continue;   // 가져온 값 우선
                merged[key] = value;
            }
            merged.activityDashboard = importedActivityDashboard;
            merged.debug = importedDebug;
            merged.nsfwGuidancePromptEnabled = importedNsfwGuidancePromptEnabled !== false;
            merged.assistantPrefillEnabled = importedAssistantPrefillEnabled !== false;
            merged.nsfwMode = normalizeNsfwMode(importedNsfwMode !== undefined ? importedNsfwMode : (importedNsfwEnabled ? 'direct' : 'off'));
            merged.nsfwEnabled = merged.nsfwMode !== 'off';
            merged.flexRoutingMode = FlexTierPolicy.normalizeRoutingMode(merged.flexRoutingMode || 'off');
            merged.flexTimeoutMs = FlexTierPolicy.normalizeTimeout(merged.flexTimeoutMs || 600000);
            merged.flexFallbackToStandard = merged.flexFallbackToStandard === true;
            merged.vertexFlexMode = FlexTierPolicy.normalizeVertexFlexMode(merged.vertexFlexMode || 'provisioned_then_flex');
            merged.customServiceTierPassthrough = merged.customServiceTierPassthrough === true;
            if (merged.llm) {
                merged.llm = normalizeLLMRuntimeProviderFromUI(merged.llm);
                merged.llm.serviceTier = FlexTierPolicy.normalizeServiceTier(merged.llm.serviceTier || 'off');
                merged.llm.stream = merged.llm.stream === true || /^(1|true|yes|on|enabled)$/i.test(String(merged.llm.stream || '').trim());
            }
            if (merged.auxLlm) {
                merged.auxLlm = normalizeLLMRuntimeProviderFromUI(merged.auxLlm);
                merged.auxLlm.serviceTier = FlexTierPolicy.normalizeServiceTier(merged.auxLlm.serviceTier || 'off');
                merged.auxLlm.stream = merged.auxLlm.stream === true || /^(1|true|yes|on|enabled)$/i.test(String(merged.auxLlm.stream || '').trim());
            }
            const importedPresetSource = incoming.llmPresetsJson !== undefined
                ? incoming.llmPresetsJson
                : (incoming.modelPresetsJson !== undefined
                    ? incoming.modelPresetsJson
                    : (incoming.providerPresetsJson !== undefined
                        ? incoming.providerPresetsJson
                        : (incoming.llmPresets !== undefined ? incoming.llmPresets : merged.llmPresets)));
            const importedRoutingSource = incoming.llmRoutingJson !== undefined
                ? incoming.llmRoutingJson
                : (incoming.llmRouting !== undefined ? incoming.llmRouting : merged.llmRouting);
            merged.llmPresets = normalizeLLMPresetMap(
                normalizeSettingsObjectValue(importedPresetSource, {}),
                merged.llm || {},
                merged.auxLlm || {}
            );
            merged.llmRouting = normalizeLLMRouteMap(normalizeSettingsObjectValue(importedRoutingSource, {}));
            const importedDefaultPreset = normalizeLLMPresetName(
                incoming.llmDefaultPreset ?? incoming.defaultPreset ?? incoming.defaultPresetName ?? merged.llmDefaultPreset ?? ''
            );
            merged.llmDefaultPreset = importedDefaultPreset || 'primary';
            return normalizeMemoryRetentionSettings(normalizeSettingsAliases(merged));
        };
        const applyImportedSettingsToUI = (importedConfig) => {
            _CFG = normalizeImportedSettingsConfig(importedConfig);
            loadSettings();
            return _CFG;
        };

        const renderCacheStats = () => {
            const container = overlay.querySelector('#cst');
            if (!container) return;
            const cacheStats = MemoryEngine.getCacheStats();
            container.innerHTML = `
                <div class="ci">메모리: ${_MEM.length}</div>
                <div class="ci">인물: ${_ENT.length}</div>
                <div class="ci">관계: ${_REL.length}</div>
                <div class="ci">메타 캐시: ${cacheStats?.meta?.size ?? 0}</div>
                <div class="ci">유사도 캐시: ${cacheStats?.sim?.size ?? 0}</div>
                <div class="ci">임베딩 캐시: ${cacheStats?.embedding?.size ?? 0}</div>
            `;
        };

        const loadSettings = () => {
            const c = normalizeMemoryRetentionSettings(_CFG);
            const loadedPresetMap = normalizeLLMPresetMap(c.llmPresets || {}, c.llm || {}, c.auxLlm || {});
            const loadedDefaultPreset = normalizeLLMPresetName(c.llmDefaultPreset || c.defaultPreset || c.defaultPresetName || 'primary');
            if (overlay.querySelector("#sllmpresets")) {
                overlay.querySelector("#sllmpresets").value = stringifySettingsJsonObject(loadedPresetMap);
            }
            if (overlay.querySelector("#sllmrouting")) {
                overlay.querySelector("#sllmrouting").value = stringifySettingsJsonObject(c.llmRouting || {});
            }
            initializeLLMPresetEditor();
            if (overlay.querySelector("#sllmdefault")) {
                overlay.querySelector("#sllmdefault").value = loadedDefaultPreset || 'primary';
            }
            syncLLMRoutingControlsFromBacking();
            if (overlay.querySelector("#sfrm")) overlay.querySelector("#sfrm").value = FlexTierPolicy.normalizeRoutingMode(c.flexRoutingMode || 'off');
            if (overlay.querySelector("#sfto")) overlay.querySelector("#sfto").value = FlexTierPolicy.normalizeTimeout(c.flexTimeoutMs || 600000);
            if (overlay.querySelector("#sffb")) overlay.querySelector("#sffb").checked = c.flexFallbackToStandard === true;
            if (overlay.querySelector("#svfm")) overlay.querySelector("#svfm").value = FlexTierPolicy.normalizeVertexFlexMode(c.vertexFlexMode || 'provisioned_then_flex');
            if (overlay.querySelector("#scstp")) overlay.querySelector("#scstp").checked = c.customServiceTierPassthrough === true;
            if (overlay.querySelector("#sactdash")) overlay.querySelector("#sactdash").value = normalizeActivityDashboard(c.activityDashboard || 'compact', 'compact');
            if (overlay.querySelector("#sdebug")) overlay.querySelector("#sdebug").checked = c.debug === true;
            syncDebugRecordStatus();
            if (overlay.querySelector("#snsfwm")) overlay.querySelector("#snsfwm").value = normalizeNsfwMode(c.nsfwMode || (c.nsfwEnabled ? 'direct' : 'off'));
            if (overlay.querySelector("#sngp")) overlay.querySelector("#sngp").checked = c.nsfwGuidancePromptEnabled !== false;
            if (overlay.querySelector("#sapf")) overlay.querySelector("#sapf").checked = c.assistantPrefillEnabled !== false;
            const loadedStoryAuthorMode = ['disabled', 'supportive', 'proactive', 'aggressive'].includes(String(c.storyAuthorMode || '').toLowerCase())
                ? String(c.storyAuthorMode).toLowerCase()
                : 'disabled';
            const loadedDirectorMode = ['disabled', 'light', 'standard', 'strong', 'absolute'].includes(String(c.directorMode || '').toLowerCase())
                ? String(c.directorMode).toLowerCase()
                : 'disabled';
            if (overlay.querySelector("#ssam")) overlay.querySelector("#ssam").value = c.storyAuthorEnabled === false ? 'disabled' : loadedStoryAuthorMode;
            if (overlay.querySelector("#sdm")) overlay.querySelector("#sdm").value = c.directorEnabled === false ? 'disabled' : loadedDirectorMode;
            if (overlay.querySelector("#swamax")) overlay.querySelector("#swamax").value = Math.max(1, Math.min(6, Number(c.worldAdditionalMaxPerRequest || 3) || 3));
            overlay.querySelector("#sep").value = (c.embed && c.embed.provider) || "voyageai";
            overlay.querySelector("#seu").value = (c.embed && c.embed.url) || "https://api.voyageai.com/v1/embeddings";
            overlay.querySelector("#sek").value = (c.embed && c.embed.key) || "";
            overlay.querySelector("#sem").value = (c.embed && c.embed.model) || "voyage-4-large";
            overlay.querySelector("#seto").value = (c.embed && c.embed.timeout) || 120000;
            overlay.querySelector('#seenabled').checked=c.embed?.enabled===true;
            overlay.querySelector('#sedimension').value=c.embed?.dimension??'';
            overlay.querySelector('#serevision').value=c.embed?.modelRevision||'';
            const dualConfig=TypedRecallRollout.buildProductionRecallConfiguration(c);
            for(const [id,value]of [['sdual-mode',dualConfig.mode],['sdual-hdepth',c.dualRecallHeuristicDepth??32],['sdual-sdepth',c.dualRecallSemanticDepth??32],['sdual-rrf',c.dualRecallRrfK??60],['sdual-budget',c.dualRecallQueryBudgetMs??1500]])overlay.querySelector('#'+id).value=value;
            for(const f of ['memory','entity','world','narrative'])for(const [key,suffix]of [['heuristicMinScore','heuristic'],['semanticMinScore','semantic'],['semanticMinMargin','margin']])overlay.querySelector('#sdual-'+f+'-'+suffix).value=dualConfig.policy.admission[f][key];
            syncDualRecallReadiness();
            syncProviderModelDatalist('embedding');
            syncVertexCredentialPanels();
            applyColdStartScopePresetToUI(c.coldStartScopePreset || inferColdStartScopePreset(c.coldStartHistoryLimit), c.coldStartHistoryLimit);
            if (overlay.querySelector("#saem")) overlay.querySelector("#saem").value = normalizeAnalysisEvidenceMode(c.analysisEvidenceMode || 'assistant_only');
            // 기능 토글 / HME / RP — 저장된 값으로 채운다.
            const setChk = (id, v) => { const n = overlay.querySelector('#' + id); if (n) n.checked = v === true; };
            setChk('semotion', c.emotionEnabled); setChk('ssecret', c.secretKnowledgeEnabled);
            setChk('svault', c.entityKnowledgeVaultEnabled); setChk('scbs', c.cbsEnabled);
            setChk('screfl', c.characterSourceReflectionEnabled); setChk('spsync', c.personaBindingSyncEnabled);
            setChk('sswi', c.sectionWorldInferenceEnabled); setChk('sstream', c.responseStreamingCompatEnabled);
            setChk('sbypass', c.bypassAuxRequests); setChk('srag', c.useLorebookRAG);
            setChk('shme', c.hybridMemoryEngineEnabled); setChk('srplt', c.rpLongTermMemoryEnabled);
            setChk('sapara', c.afterRequestParallelAnalysis);
            if (overlay.querySelector('#shmegraph')) overlay.querySelector('#shmegraph').value = String(c.hmeAssociativeGraphMode || 'off');
            if (overlay.querySelector('#shmedbg')) overlay.querySelector('#shmedbg').value = String(c.hmeGraphDebug || 'off');
            if (overlay.querySelector('#srplttl')) overlay.querySelector('#srplttl').value = Number.isFinite(Number(c.rpLongTermLongTtl)) ? Number(c.rpLongTermLongTtl) : '';
            if (overlay.querySelector('#srplchars')) overlay.querySelector('#srplchars').value = Number.isFinite(Number(c.rpLongTermInjectionMaxChars)) ? Number(c.rpLongTermInjectionMaxChars) : '';
            // 회상 가중치 / 선별 / 주입 예산 — 저장된 값으로 채운다.
            if (overlay.querySelector("#swmode")) overlay.querySelector("#swmode").value = String(c.weightMode || 'auto') === 'custom' ? 'custom' : 'auto';
            if (overlay.querySelector("#swsim")) overlay.querySelector("#swsim").value = Number.isFinite(Number(c.weights?.similarity)) ? Number(c.weights?.similarity) : '';
            if (overlay.querySelector("#swimp")) overlay.querySelector("#swimp").value = Number.isFinite(Number(c.weights?.importance)) ? Number(c.weights?.importance) : '';
            if (overlay.querySelector("#swrec")) overlay.querySelector("#swrec").value = Number.isFinite(Number(c.weights?.recency)) ? Number(c.weights?.recency) : '';
            if (overlay.querySelector("#sreg")) overlay.querySelector("#sreg").value = ['off', 'soft', 'strict'].includes(String(c.recallEvidenceGate || '').toLowerCase()) ? String(c.recallEvidenceGate).toLowerCase() : 'soft';
            if (overlay.querySelector("#sscprof")) overlay.querySelector("#sscprof").value = String(c.scoringProfile || 'balanced');
            const loadedScoringWeights = c.scoringWeights && typeof c.scoringWeights === 'object' ? c.scoringWeights : {};
            if (overlay.querySelector("#sscword")) overlay.querySelector("#sscword").value = Number.isFinite(Number(loadedScoringWeights.word)) ? Number(loadedScoringWeights.word) : '';
            if (overlay.querySelector("#sscchar")) overlay.querySelector("#sscchar").value = Number.isFinite(Number(loadedScoringWeights.char)) ? Number(loadedScoringWeights.char) : '';
            if (overlay.querySelector("#sscconcept")) overlay.querySelector("#sscconcept").value = Number.isFinite(Number(loadedScoringWeights.concept)) ? Number(loadedScoringWeights.concept) : '';
            if (overlay.querySelector("#ssclex")) overlay.querySelector("#ssclex").value = Number.isFinite(Number(loadedScoringWeights.lexicalCoverage)) ? Number(loadedScoringWeights.lexicalCoverage) : '';
            if (overlay.querySelector("#sscfocus")) overlay.querySelector("#sscfocus").value = Number.isFinite(Number(loadedScoringWeights.focus)) ? Number(loadedScoringWeights.focus) : '';
            if (overlay.querySelector("#smaxlimit")) overlay.querySelector("#smaxlimit").value = Number.isFinite(Number(c.maxLimit)) ? Number(c.maxLimit) : '';
            if (overlay.querySelector("#sthr")) overlay.querySelector("#sthr").value = Number.isFinite(Number(c.threshold)) ? Number(c.threshold) : '';
            if (overlay.querySelector("#ssimthr")) overlay.querySelector("#ssimthr").value = Number.isFinite(Number(c.simThreshold)) ? Number(c.simThreshold) : '';
            if (overlay.querySelector("#smempreset")) overlay.querySelector("#smempreset").value = String(c.memoryPreset || '');
            if (overlay.querySelector("#sinjbp")) overlay.querySelector("#sinjbp").value = String(c.injectionBudgetPreset || '');
            if (overlay.querySelector("#sinjbtok")) overlay.querySelector("#sinjbtok").value = Number.isFinite(Number(c.injectionBudgetMaxTokens)) ? Number(c.injectionBudgetMaxTokens) : '';

            renderCacheStats();
            renderHealthReview();
        };

        const closeGuiOverlay = () => {
            wmHealthOrchestrator?.clear();
            try {
                const activeEl = document.activeElement;
                if (activeEl instanceof HTMLElement && overlay.contains(activeEl)) {
                    activeEl.blur();
                }
            } catch {}
            overlay.style.pointerEvents = 'none';
            overlay.style.display = 'none';
            document.removeEventListener('keydown', onGuiKeydown);
            overlay.remove();
            try { R.hideContainer(); } catch {}
        };
        const onGuiKeydown = event => {
            if (event?.key !== 'Escape') return;
            event.preventDefault?.();
            closeGuiOverlay();
        };
        document.addEventListener('keydown', onGuiKeydown);
        bodyWrap.addEventListener('click', event => {
            if (event.target === bodyWrap) closeGuiOverlay();
        });
