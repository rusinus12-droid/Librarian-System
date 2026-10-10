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
        const renderCommonAnalysisSelection = (value = '') => {
            const select = overlay.querySelector('#sllmdefault');
            if (!select) return;
            const selected = normalizeVisibleLLMProfileValue(value);
            const options = [['', '(선택 필요)'], ...buildLLMRouteProfileOptions(false)];
            if (selected && !options.some(([name]) => name === selected)) options.push([selected, `${selected} (사용 불가)`]);
            setSelectOptions(select, options, selected);
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
        // Private editor state stays in this GUI only; never put it in settings, logs or exports.
        const commonAiDraftControlIds = ['sllmpname', 'sllmpp', 'sllmpu', 'sllmpk', 'sllmpm', 'sllmpfmt', 'sllmprp', 'sllmpre', 'sllmpgt', 'sllmpst', 'sllmpstream'];
        const readCommonAiDraftSnapshot = () => JSON.stringify(commonAiDraftControlIds.map(id => {
            const node = overlay.querySelector('#' + id);
            return node?.type === 'checkbox' ? node.checked : String(node?.value ?? '');
        }));
        let commonAiDraftBaseline = null, commonAiEditorName = '', commonAiDraftIsNew = false;
        let commonAiDraftSource = {}, commonAiDraftFieldBaseline = new Map();
        let commonAiEditorIdentity = { name: '' };
        let commonAiLeaveRequest = null;
        const hasCommonAiDraftChanges = () => commonAiDraftIsNew || (commonAiDraftBaseline !== null && readCommonAiDraftSnapshot() !== commonAiDraftBaseline);
        const writeLLMPresetEditorForm = (name = '', preset = {}, { keepIdentity = false } = {}) => {
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
            const compatibilityHint = overlay.querySelector('#llmp-compatibility-hint');
            if (compatibilityHint) compatibilityHint.textContent = source.portableConnectionPending === true ? '연결 정보 입력 필요 · 가져온 메타데이터입니다. URL·인증 정보를 확인하고 저장하세요. 로컬 기본 연결도 저장으로 확인합니다.' : ['primary', 'aux'].includes(name) ? '기본 호환 프리셋은 이름 변경·삭제할 수 없습니다. 복제 후 새 이름으로 저장하세요.' : '편집한 내용은 저장을 누르면 보관됩니다. 사용 중인 AI는 별도로 선택하세요.';
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
            setValue('#sllmprp', source.reasoningPreset || source.reasoning_preset || 'auto');
            setValue('#sllmpre', source.reasoningEffort || source.reasoning_effort || 'none');
            setValue('#sllmpgt', source.glmThinkingType || source.glm_thinking_type || source.glmThinking || 'enabled');
            setValue('#sllmpst', FlexTierPolicy.normalizeServiceTier(source.serviceTier || source.service_tier || 'off'));
            setChecked('#sllmpstream', source.stream === true || String(source.stream || '').toLowerCase() === 'true');
            syncLLMPresetModelDatalist();
            syncLLMPresetRequestFormatSupport({ keepInvalid: true });
            commonAiEditorName = String(overlay.querySelector('#sllmpresetselect')?.value || '');
            if (keepIdentity) commonAiEditorIdentity.name = commonAiEditorName;
            else commonAiEditorIdentity = { name: commonAiEditorName };
            commonAiDraftIsNew = false;
            commonAiDraftSource = safeClone(source);
            commonAiDraftFieldBaseline = new Map(commonAiDraftControlIds.map(id => { const node = overlay.querySelector('#' + id); return [id, node?.type === 'checkbox' ? node.checked : String(node?.value ?? '')]; }));
            commonAiDraftBaseline = readCommonAiDraftSnapshot();
        };
        const readLLMPresetEditorForm = () => {
            const fields = {
                sllmpp: ['provider', value => value], sllmpu: ['url', value => value], sllmpk: ['key', value => value],
                sllmpm: ['model', value => value], sllmpfmt: ['requestFormat', value => value],
                sllmprp: ['reasoningPreset', value => value], sllmpre: ['reasoningEffort', value => value],
                sllmpgt: ['glmThinkingType', value => value], sllmpst: ['serviceTier', value => FlexTierPolicy.normalizeServiceTier(value)],
                sllmpstream: ['stream', value => value === true]
            };
            const visible = {}, patch = {};
            for (const [id, [key, parse]] of Object.entries(fields)) {
                const node = overlay.querySelector('#' + id);
                if (!node) continue;
                const value = node.type === 'checkbox' ? node.checked : String(node.value ?? '');
                visible[key] = parse(value);
                if (!Object.is(value, commonAiDraftFieldBaseline.get(id))) patch[key] = visible[key];
            }
            // A blank key keeps the credential in its existing native location.
            if (!String(patch.key || '').trim()) delete patch.key;
            return {
                name: normalizeCustomLLMPresetName(overlay.querySelector('#sllmpname')?.value || ''),
                preset: normalizeLLMRuntimeProviderFromUI({ ...safeClone(commonAiDraftSource), ...visible }),
                patch
            };
        };
        const refreshLLMProfileSelects = ({ preserveEditor = false } = {}) => {
            const names = getCustomLLMPresetNames();
            const presetSelect = overlay.querySelector('#sllmpresetselect');
            const selectedPreset = preserveEditor ? commonAiEditorName : (normalizeCustomLLMPresetName(presetSelect?.value || '') || names[0] || '');
            const options = names.map(name => [name, name]);
            if (preserveEditor && !names.includes(selectedPreset)) options.unshift([selectedPreset, selectedPreset ? `${selectedPreset} (다시 확인 필요)` : '(새 프리셋)']);
            setSelectOptions(presetSelect, options.length ? options : [['', '(프리셋 없음)']], preserveEditor || names.includes(selectedPreset) ? selectedPreset : (names[0] || ''));
            const defaultSelect = overlay.querySelector('#sllmdefault');
            const currentDefault = normalizeVisibleLLMProfileValue(defaultSelect?.value || '');
            renderCommonAnalysisSelection(currentDefault);
        };
        // Editor fields are a private draft. Only explicit preset actions own these keys.
        let commonAiActionRevision = 0;
        let commonAiDraftRevision = 0;
        const COMMON_AI_SETTINGS_KEYS = ['llmPresets', 'llmDefaultPreset', 'llm', 'auxLlm'];
        const setCommonAiSaveStatus = (message, state = 'idle') => {
            const node = overlay.querySelector('#common-ai-save-status');
            if (node) { node.textContent = message; node.dataset.state = state; }
        };
        const preserveCommonAiSettings = (target, source) => {
            for (const key of COMMON_AI_SETTINGS_KEYS) {
                if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = safeClone(source[key]);
                else delete target[key];
            }
            return target;
        };
        const persistCommonAiAction = (mutate, { editorName = null, editorIdentity = null, isViewCurrent = null } = {}) => {
            const revision = ++commonAiActionRevision;
            const draftRevision = commonAiDraftRevision;
            const draftSnapshot = readCommonAiDraftSnapshot();
            const actionScope = String(MemoryState._activeScopeKey || '');
            const actionInitVersion = MemoryState.initVersion;
            const viewRevision = settingsViewReplacementRevision;
            setCommonAiSaveStatus('저장 확인 중… 기존 분석 AI를 계속 사용합니다.', 'saving');
            const task = queueCommonPluginSettingsMutation(async () => {
                if (viewRevision !== commonSettingsReplacementRevision) throw new Error('설정 화면을 다시 열어 저장 상태를 확인하세요.');
                if (isViewCurrent && !isViewCurrent()) throw new Error('화면이 바뀌어 저장을 시작하지 않았습니다.');
                const current = await readSettingsForScoringMutation();
                if (isViewCurrent && !isViewCurrent()) throw new Error('화면이 바뀌어 저장을 시작하지 않았습니다.');
                const next = canonicalSettingsForStorage(mutate(current));
                try { await writeCommonPluginSettings(JSON.stringify(next)); }
                catch (error) {
                    if (error?.settingsStorageUnverified === true) commonSettingsReplacementRevision += 1;
                    throw error;
                }
                // No embedding publication, analysis cancellation or provider call belongs to a preset edit.
                preserveCommonAiSettings(MemoryEngine.CONFIG, next);
                preserveCommonAiSettings(_CFG, next);
                setLLMPresetBacking(next.llmPresets || {});
                // Rebase queued edits of this same draft after verified create/rename, even if a newer action owns the UI.
                if (editorIdentity && editorName !== null) {
                    editorIdentity.name = editorName;
                    if (commonAiEditorIdentity === editorIdentity) commonAiEditorName = editorName;
                }
                if (revision === commonAiActionRevision && overlay.isConnected && actionScope === String(MemoryState._activeScopeKey || '') && actionInitVersion === MemoryState.initVersion) {
                    refreshLLMProfileSelects({ preserveEditor: true });
                    renderCommonAnalysisSelection(next.llmDefaultPreset || '');
                    if (editorName !== null && draftRevision === commonAiDraftRevision && draftSnapshot === readCommonAiDraftSnapshot()) {
                        const names = getCustomLLMPresetNames();
                        const selected = Object.prototype.hasOwnProperty.call(next.llmPresets || {}, editorName) ? editorName : (names[0] || '');
                        const select = overlay.querySelector('#sllmpresetselect');
                        if (select) select.value = selected;
                        writeLLMPresetEditorForm(selected, next.llmPresets?.[selected] || {}, { keepIdentity: editorIdentity === commonAiEditorIdentity });
                        refreshLLMProfileSelects({ preserveEditor: true });
                    }
                    renderHome();
                    setCommonAiSaveStatus('저장 확인됨.', 'saved');
                }
                return true;
            });
            settingsAutoSaveQueue = task.catch(() => {});
            return task.catch(error => {
                if (revision === commonAiActionRevision && overlay.isConnected) {
                    renderCommonAnalysisSelection(MemoryEngine.CONFIG.llmDefaultPreset || '');
                    setCommonAiSaveStatus(`저장 실패 · ${error?.message || '저장 상태를 확인하세요.'}`, 'failed');
                }
                return false;
            });
        };
        const mergeLLMPresetDraft = (source, draft) => {
            const visibleDraft = { ...draft };
            // Hidden compatibility fields belong to the freshly saved definition, not an old editor draft.
            delete visibleDraft.enabled;
            delete visibleDraft.inherit;
            const merged = { ...safeClone(source || {}), ...visibleDraft };
            if (!String(draft.key || '').trim()) merged.key = source?.key || '';
            if (source?.portableConnectionPending === true && isProviderProfileConfigured({ ...merged, portableConnectionPending: false })) merged.portableConnectionPending = false;
            // An unsupported imported provider is displayed as custom, not silently renamed on save.
            if (draft.provider === 'custom' && source?.provider && !Array.from(overlay.querySelector('#sllmpp')?.options || []).some(option => option.value === source.provider)) merged.provider = source.provider;
            return merged;
        };
        const saveCommonAiDraft = ({ isViewCurrent = null } = {}) => {
            const editorIdentity = commonAiEditorIdentity;
            const selected = normalizeCustomLLMPresetName(editorIdentity.name);
            const form = readLLMPresetEditorForm();
            if (!form.name) { toast('프리셋 이름을 입력하세요.'); return Promise.resolve(false); }
            if (['primary', 'aux'].includes(selected) && form.name !== selected) {
                setCommonAiSaveStatus('기본 호환 프리셋은 이름 변경·삭제할 수 없습니다. 복제 후 새 이름으로 저장하세요.', 'blocked');
                return Promise.resolve(false);
            }
            return persistCommonAiAction(current => {
                const selected = normalizeCustomLLMPresetName(editorIdentity.name);
                const presets = safeClone(current.llmPresets || {});
                if (selected !== form.name && presets[form.name]) throw new Error('같은 이름의 프리셋이 있습니다.');
                if (selected && !presets[selected]) throw new Error('원래 프리셋을 다시 확인하세요.');
                presets[form.name] = mergeLLMPresetDraft(presets[selected] || commonAiDraftSource, form.patch);
                if (selected && selected !== form.name) delete presets[selected];
                return { ...current, llmPresets: presets, llmDefaultPreset: selected && current.llmDefaultPreset === selected ? form.name : current.llmDefaultPreset };
            }, { editorName: form.name, editorIdentity, isViewCurrent });
        };
        const dismissCommonAiLeaveRequest = () => {
            const request = commonAiLeaveRequest;
            if (!request) return;
            commonAiLeaveRequest = null;
            request.dialog.remove();
            bodyWrap.inert = request.wasInert;
            if (request.focus?.isConnected) request.focus.focus?.();
        };
        const discardCommonAiDraft = () => {
            const presets = getLLMPresetBacking();
            const name = Object.prototype.hasOwnProperty.call(presets, commonAiEditorName) ? commonAiEditorName : (getCustomLLMPresetNames()[0] || '');
            const select = overlay.querySelector('#sllmpresetselect');
            if (select) select.value = name;
            commonAiDraftRevision += 1;
            writeLLMPresetEditorForm(name, presets[name] || {});
        };
        const requestCommonAiDraftLeave = proceed => {
            if (!overlay.isConnected || commonAiLeaveRequest) return false;
            if (!hasCommonAiDraftChanges()) { proceed(); return true; }
            const dialog = document.createElement('div');
            dialog.id = 'common-ai-unsaved-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'common-ai-unsaved-title');
            dialog.setAttribute('aria-describedby', 'common-ai-unsaved-description');
            dialog.style.cssText = 'position:fixed;inset:0;z-index:10010;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:20px';
            dialog.innerHTML = '<section class="ss" style="max-width:480px;width:100%;background:var(--bg,#171a20);padding:24px;border-radius:12px">'
                + '<h3 id="common-ai-unsaved-title">편집한 프리셋을 저장할까요?</h3>'
                + '<p id="common-ai-unsaved-description">저장은 편집한 프리셋을 보관합니다. 지금 사용할 분석 AI는 바꾸지 않습니다. 폐기는 이 초안만 버리고, 취소는 계속 편집합니다.</p>'
                + '<p id="common-ai-unsaved-status" class="setting-note" aria-live="polite"></p>'
                + '<div class="toolbar"><button type="button" class="btn bs" id="common-ai-unsaved-save">저장하고 계속</button>'
                + '<button type="button" class="btn bd" id="common-ai-unsaved-discard">폐기하고 계속</button>'
                + '<button type="button" class="btn bs" id="common-ai-unsaved-cancel">취소 · 계속 편집</button></div></section>';
            const request = { dialog, focus: document.activeElement, wasInert: !!bodyWrap.inert, scope: String(MemoryState._activeScopeKey || ''), initVersion: MemoryState.initVersion, saving: false };
            commonAiLeaveRequest = request;
            const isCurrent = () => commonAiLeaveRequest === request && overlay.isConnected && request.scope === String(MemoryState._activeScopeKey || '') && request.initVersion === MemoryState.initVersion;
            const status = dialog.querySelector('#common-ai-unsaved-status');
            const saveButton = dialog.querySelector('#common-ai-unsaved-save');
            const discardButton = dialog.querySelector('#common-ai-unsaved-discard');
            const cancelButton = dialog.querySelector('#common-ai-unsaved-cancel');
            const currentOrStay = () => {
                if (isCurrent()) return true;
                // A cancelled async save no longer owns a newer confirmation or its status.
                if (commonAiLeaveRequest === request) {
                    dismissCommonAiLeaveRequest();
                    if (overlay.isConnected) setCommonAiSaveStatus('화면이 바뀌어 이동을 중단했습니다. 편집 내용과 저장 상태를 확인하세요.', 'blocked');
                }
                return false;
            };
            cancelButton.onclick = dismissCommonAiLeaveRequest;
            discardButton.onclick = () => {
                if (request.saving || !currentOrStay()) return;
                discardCommonAiDraft();
                dismissCommonAiLeaveRequest();
                proceed();
            };
            saveButton.onclick = async () => {
                if (request.saving || !currentOrStay()) return;
                request.saving = true;
                saveButton.disabled = true;
                discardButton.disabled = true;
                status.textContent = '저장 확인 중… 취소하면 화면 이동만 취소합니다. 이미 시작한 저장은 되돌리지 않습니다.';
                const ok = await saveCommonAiDraft({ isViewCurrent: isCurrent });
                if (!currentOrStay()) return;
                request.saving = false;
                saveButton.disabled = false;
                discardButton.disabled = false;
                if (!ok) { status.textContent = '저장을 확인하지 못해 이동하지 않았습니다. 초안은 남아 있습니다. 저장 상태를 확인하거나 계속 편집하세요.'; return; }
                if (hasCommonAiDraftChanges()) {
                    status.textContent = '저장 중 편집 내용이 바뀌어 이동하지 않았습니다. 남은 초안을 확인하세요.';
                    return;
                }
                dismissCommonAiLeaveRequest();
                proceed();
            };
            dialog.addEventListener('keydown', event => {
                if (event.key !== 'Tab') return;
                const buttons = [saveButton, discardButton, cancelButton].filter(button => !button.disabled);
                const index = buttons.indexOf(document.activeElement);
                if (event.shiftKey ? index <= 0 : index < 0 || index === buttons.length - 1) {
                    event.preventDefault();
                    buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
                }
            });
            overlay.appendChild(dialog);
            bodyWrap.inert = true;
            cancelButton.focus();
            return false;
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
                overlay.querySelector('#sllmdefault')?.addEventListener('change', event => {
                    const selected = normalizeVisibleLLMProfileValue(event.target.value);
                    void persistCommonAiAction(current => {
                        const presets = safeClone(current.llmPresets || {});
                        if (!selected || !Object.prototype.hasOwnProperty.call(presets, selected)) throw new Error('저장된 프리셋을 선택하세요.');
                        presets[selected].enabled = true;
                        return { ...current, llmPresets: presets, llmDefaultPreset: selected };
                    });
                });
                overlay.querySelector('#sllmpname')?.addEventListener('input', () => { commonAiDraftRevision += 1; });
                presetSelect.addEventListener('change', () => {
                    const name = normalizeCustomLLMPresetName(presetSelect.value || '');
                    presetSelect.value = commonAiEditorName;
                    if (name === commonAiEditorName) return;
                    requestCommonAiDraftLeave(() => {
                        commonAiDraftRevision += 1;
                        presetSelect.value = name;
                        const presets = getLLMPresetBacking();
                        writeLLMPresetEditorForm(name, presets[name] || {});
                    });
                });
                overlay.querySelector('#sllmpp')?.addEventListener('change', () => {
                    applyProviderPresetToLLMPresetEditor({ force: true });
                    syncVertexCredentialPanels();
                    commonAiDraftRevision += 1;
                });
                overlay.querySelector('#btn-llmp-refresh-models')?.addEventListener('click', refreshLLMPresetModels);
                ['#sllmpenabled', '#sllmpinherit', '#sllmpu', '#sllmpk', '#sllmpm', '#sllmpfmt', '#sllmprp', '#sllmpre', '#sllmpgt', '#sllmpst', '#sllmpstream'].forEach(selector => {
                    const node = overlay.querySelector(selector);
                    if (!node) return;
                    const handler = () => {
                                    if (selector === '#sllmpu') {
                            syncLLMPresetModelDatalist();
                            syncLLMPresetRequestFormatSupport({ keepInvalid: true });
                        }
                        if (selector === '#sllmpk') syncVertexCredentialPanels();
                        commonAiDraftRevision += 1;
                    };
                    node.addEventListener('input', handler);
                    node.addEventListener('change', handler);
                });
                overlay.querySelector('#btn-llmp-new')?.addEventListener('click', () => requestCommonAiDraftLeave(() => {
                    commonAiDraftRevision += 1;
                    const name = uniqueCustomLLMPresetName('profile');
                    setSelectOptions(presetSelect, [['', '(새 프리셋)'], ...getCustomLLMPresetNames().map(name => [name, name])], '');
                    writeLLMPresetEditorForm(name, readStoredLLMProfileSeed('primary'));
                    commonAiDraftIsNew = true;
                    setCommonAiSaveStatus('새 프리셋 편집 중 · 저장을 눌러 보관하세요.', 'draft');
                }));
                overlay.querySelector('#btn-llmp-clone')?.addEventListener('click', () => {
                    if (!commonAiEditorName || !getLLMPresetBacking()[commonAiEditorName]) {
                        setCommonAiSaveStatus('복제할 저장 프리셋을 선택하세요. 새 초안은 먼저 저장하세요.', 'blocked');
                        return;
                    }
                    requestCommonAiDraftLeave(() => {
                    const selected = normalizeCustomLLMPresetName(presetSelect.value || '');
                    const name = uniqueCustomLLMPresetName(selected ? `${selected}_copy` : 'profile_copy');
                    void persistCommonAiAction(current => {
                        if (!current.llmPresets?.[selected]) throw new Error('복제할 저장 프리셋을 선택하세요.');
                        if (current.llmPresets[name]) throw new Error('같은 이름의 프리셋이 있습니다.');
                        return { ...current, llmPresets: { ...current.llmPresets, [name]: safeClone(current.llmPresets[selected]) } };
                    }, { editorName: name });
                    });
                });
                overlay.querySelector('#btn-llmp-save')?.addEventListener('click', () => { void saveCommonAiDraft(); });
                overlay.querySelector('#btn-llmp-delete')?.addEventListener('click', () => {
                    if (!commonAiEditorName) { toast('삭제할 프리셋이 없습니다.'); return; }
                    if (MemoryEngine.CONFIG.llmDefaultPreset === commonAiEditorName) {
                        setCommonAiSaveStatus('다른 프리셋을 선택한 뒤 삭제하세요.', 'blocked');
                        return;
                    }
                    if (['primary', 'aux'].includes(commonAiEditorName)) {
                        setCommonAiSaveStatus('기본 호환 프리셋은 이름 변경·삭제할 수 없습니다. 복제 후 새 이름으로 저장하세요.', 'blocked');
                        return;
                    }
                    requestCommonAiDraftLeave(() => {
                    const selected = normalizeCustomLLMPresetName(presetSelect.value || '');
                    if (!selected) { toast('삭제할 프리셋이 없습니다.'); return; }
                    if (MemoryEngine.CONFIG.llmDefaultPreset === selected) {
                        toast('다른 프리셋을 선택한 뒤 삭제하세요.');
                        setCommonAiSaveStatus('다른 프리셋을 선택한 뒤 삭제하세요.', 'blocked');
                        return;
                    }
                    if (['primary', 'aux'].includes(selected)) {
                        setCommonAiSaveStatus('기본 호환 프리셋은 이름 변경·삭제할 수 없습니다. 복제 후 새 이름으로 저장하세요.', 'blocked');
                        return;
                    }
                    void persistCommonAiAction(current => {
                        if (current.llmDefaultPreset === selected) throw new Error('다른 프리셋을 선택한 뒤 삭제하세요.');
                        const presets = safeClone(current.llmPresets || {});
                        delete presets[selected];
                        return { ...current, llmPresets: presets };
                    }, { editorName: '' });
                    });
                });
                overlay.querySelector('#btn-test-llmp')?.addEventListener('click', async () => {
                    const form = readLLMPresetEditorForm();
                    const selected = form.name || normalizeCustomLLMPresetName(presetSelect.value || '') || 'draft';
                    const button = overlay.querySelector('#btn-test-llmp');
                    try {
                        if (button) button.disabled = true;
                        setLLMPresetTestStatus(`${selected} 호출 테스트 중...`, 'running');
                        const cfg = { ...MemoryEngine.CONFIG, llmPresets: { ...MemoryEngine.CONFIG.llmPresets, [selected]: mergeLLMPresetDraft(getLLMPresetBacking()[presetSelect.value] || {}, form.preset) }, llmDefaultPreset: selected };
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
            }
            refreshLLMProfileSelects();
            const names = getCustomLLMPresetNames();
            const selected = normalizeCustomLLMPresetName(presetSelect.value || '') || names[0] || '';
            if (presetSelect) presetSelect.value = selected;
            const presets = getLLMPresetBacking();
            writeLLMPresetEditorForm(selected, presets[selected] || {});
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
        // A closed control registry is the only authority for ordinary settings edits.
        // Preset drafts, common AI selection, storage controls and hidden defaults are separate owners.
        const generalSettingsControls = Object.freeze({
            's-use-llm': ['useLLM', 'boolean'], sactdash: ['activityDashboard', 'string'], sdebug: ['debug', 'boolean'],
            's-related-recall': ['hmeAssociativeGraphMode', 'graphIntent'],
            's-cold-archive': ['coldArchiveHydrationEnabled', 'boolean'], 's-rp-continuity': ['rpLongTermMemoryEnabled', 'boolean'],
            sinjbp: ['injectionBudgetPreset', 'string'],
            snsfwm: ['nsfwMode', 'string'], sngp: ['nsfwGuidancePromptEnabled', 'boolean'], sapf: ['assistantPrefillEnabled', 'boolean'],
            ssam: ['storyAuthorMode', 'string'], sdm: ['directorMode', 'string'], swamax: ['worldAdditionalMaxPerRequest', 'integer'],
            semotion: ['emotionEnabled', 'boolean'], svisual: ['entityVisualCanonEnabled', 'boolean'],
            ssecret: ['secretKnowledgeEnabled', 'boolean'], svault: ['entityKnowledgeVaultEnabled', 'boolean'],
            scbs: ['cbsEnabled', 'boolean'], screfl: ['characterSourceReflectionEnabled', 'boolean'], spsync: ['personaBindingSyncEnabled', 'boolean'],
            sswi: ['sectionWorldInferenceEnabled', 'boolean'], sworldconflict: ['worldAdjustmentMode', 'string'],
            sstream: ['responseStreamingCompatEnabled', 'boolean'], sbypass: ['bypassAuxRequests', 'boolean'],
            srag: ['useLorebookRAG', 'boolean'], sreg: ['recallEvidenceGate', 'string'], sapara: ['afterRequestParallelAnalysis', 'boolean'],
            scsp: ['coldStartScopePreset', 'string'], schl: ['coldStartHistoryLimit', 'integer'], saem: ['analysisEvidenceMode', 'string'],
            sfrm: ['flexRoutingMode', 'string'], sffb: ['flexFallbackToStandard', 'boolean'],
            svfm: ['vertexFlexMode', 'string'], scstp: ['customServiceTierPassthrough', 'boolean'],
            seenabled: ['embed.enabled', 'boolean'], sep: ['embed.provider', 'string'], seu: ['embed.url', 'string'], sek: ['embed.key', 'string'],
            sem: ['embed.model', 'string'], sedimension: ['embed.dimension', 'nullableInteger'], serevision: ['embed.modelRevision', 'string']
        });
        const generalSettingsPathControls = new Map(Object.entries(generalSettingsControls).map(([id, [path, type]]) => [path, { id, type }]));
        const generalSettingsOwnedPaths = new Set([...generalSettingsPathControls.keys(), 'nsfwEnabled', 'storyAuthorEnabled', 'directorEnabled',
            'hybridMemoryEngineEnabled', 'hybridScopeIndexEnabled', 'injectionBudgetMaxTokens', 'injectionBudgetTokens']);
        let generalSettingsView = null;
        const generalSettingsDirtyPaths = new Set();
        const readGeneralSettingsControlView = () => {
            const view = new Map();
            for (const [id, [path, type]] of Object.entries(generalSettingsControls)) {
                const node = overlay.querySelector('#' + id);
                if (!node) continue;
                view.set(path, (type === 'boolean' || type === 'graphIntent') ? node.checked === true : String(node.value ?? ''));
            }
            return view;
        };
        const markGeneralSettingsControlDirty = target => {
            const spec = generalSettingsControls[target?.id];
            if (spec) generalSettingsDirtyPaths.add(spec[0]);
        };
        const normalizeGeneralSettingsControlValue = (path, value) => {
            const { id, type } = generalSettingsPathControls.get(path);
            if (type === 'boolean') return value === true;
            if (type === 'graphIntent') return value === true ? 'light' : 'off';
            if (type === 'string') {
                const node = overlay.querySelector('#' + id);
                if (node?.tagName === 'SELECT' && !Array.from(node.options).some(option => option.value === value)) throw new Error(`설정 값을 확인해 주세요: ${id}`);
                return value;
            }
            const raw = String(value).trim();
            if (type === 'nullableInteger' && raw === '') return null;
            // The all-history selection intentionally has an empty numeric companion.
            if (path === 'coldStartHistoryLimit' && overlay.querySelector('#scsp')?.value === 'all') return 0;
            const number = raw === '' ? NaN : Number(raw);
            const node = overlay.querySelector('#' + id);
            const min = node?.getAttribute('min'), max = node?.getAttribute('max');
            if (!Number.isFinite(number) || ((type === 'integer' || type === 'nullableInteger') && !Number.isInteger(number))
                || (min !== null && min !== undefined && number < Number(min)) || (max !== null && max !== undefined && number > Number(max))) {
                throw new Error(`숫자 설정 값을 확인해 주세요: ${id}`);
            }
            return number;
        };
        const generalSettingsPatchFromView = view => {
            const initial = generalSettingsView || view;
            const patch = new Map();
            for (const [path, value] of view) {
                if (!generalSettingsOwnedPaths.has(path)) continue;
                if (initial.has(path) && !Object.is(value, initial.get(path))) generalSettingsDirtyPaths.add(path);
                if (generalSettingsDirtyPaths.has(path)) patch.set(path, normalizeGeneralSettingsControlValue(path, value));
            }
            if (patch.has('nsfwMode')) patch.set('nsfwEnabled', patch.get('nsfwMode') !== 'off');
            if (patch.has('storyAuthorMode')) patch.set('storyAuthorEnabled', patch.get('storyAuthorMode') !== 'disabled');
            if (patch.has('directorMode')) patch.set('directorEnabled', patch.get('directorMode') !== 'disabled');
            if (patch.has('coldStartScopePreset')) {
                const preset = patch.get('coldStartScopePreset');
                const value = view.get('coldStartHistoryLimit');
                if (preset !== 'custom' || value !== undefined) {
                    patch.set('coldStartHistoryLimit', resolveColdStartHistoryLimit(preset, preset === 'custom' ? normalizeGeneralSettingsControlValue('coldStartHistoryLimit', value) : 0));
                }
            }
            if (patch.get('hmeAssociativeGraphMode') === 'light') {
                patch.set('hybridMemoryEngineEnabled', true);
                patch.set('hybridScopeIndexEnabled', true);
            }
            if (patch.has('injectionBudgetPreset') && ['compact', 'large', 'max'].includes(patch.get('injectionBudgetPreset'))) {
                const tokens = getInjectionBudgetPresetTokens(patch.get('injectionBudgetPreset'));
                patch.set('injectionBudgetMaxTokens', tokens);
                patch.set('injectionBudgetTokens', tokens);
            }
            const errors = TypedRecallRollout.validateProductionRecallSettings(applyOwnedGeneralSettingsPatch({}, patch));
            if (errors.length) throw new Error('Invalid recall field: ' + errors.join(', '));
            return patch;
        };
        const applyOwnedGeneralSettingsPatch = (base, patch) => {
            const out = { ...(base || {}) };
            for (const [path, value] of patch) {
                if (!generalSettingsOwnedPaths.has(path)) throw new Error('settings_path_not_owned');
                const keys = path.split('.');
                let target = out;
                for (const key of keys.slice(0, -1)) {
                    const previous = target[key];
                    target[key] = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
                    target = target[key];
                }
                target[keys[keys.length - 1]] = value;
            }
            return out;
        };
        const acceptGeneralSettingsView = (view, revision) => {
            if (revision !== undefined && revision !== settingsAutoSaveChangeRevision) return;
            generalSettingsView = new Map(view);
            generalSettingsDirtyPaths.clear();
        };
        const isScoringSettingsObject = value => value && typeof value === 'object' && !Array.isArray(value);
        const scoringSettingsPatchFromImport = (incoming = {}) => {
            const patch = {};
            for (const key of ['scoringProfile', 'scoringWeights']) {
                if (Object.prototype.hasOwnProperty.call(incoming, key)) patch[key] = incoming[key];
            }
            return patch;
        };
        const withOwnedScoringSettings = (config, base, patch = {}) => {
            const out = { ...config };
            // Preserve absence as well as values; runtime arguments are not saved defaults.
            delete out.scoringProfile;
            delete out.scoringWeights;
            for (const key of ['scoringProfile', 'scoringWeights']) {
                if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
                if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
                out[key] = key === 'scoringWeights' && isScoringSettingsObject(patch[key])
                    ? { ...(isScoringSettingsObject(base[key]) ? base[key] : {}), ...patch[key] }
                    : patch[key];
            }
            return out;
        };
        const readSettingsForScoringMutation = async () => {
            const fallback = { ...MemoryEngine.CONFIG };
            delete fallback.scoringProfile;
            delete fallback.scoringWeights;
            return await readCommonPluginSettingsForMutation(fallback);
        };
        const syncDualRecallReadiness = () => {
            const node = overlay.querySelector('#sdual-readiness');
            if (!node) return;
            const state = TypedRecallRollout.inspect(), readiness = state.readiness;
            const configured = readiness.semanticConfigured === true ? '연결 설정 있음' : '연결 설정 확인 필요';
            const ready = readiness.semanticReady === true ? '뜻 검색 준비됨' : '뜻 검색 준비 미확인';
            node.textContent = `${configured} · ${ready} · ${readiness.reason || readiness.status || '상태 미확인'} · 현재 검색 경로: ${state.mode}. 연결 테스트 성공만으로 검색 색인 준비를 보장하지 않습니다.`;
        };
        const syncSimpleSettingsIntentStatus = () => {
            const config = MemoryEngine.CONFIG;
            const graph = overlay.querySelector('#s-related-recall-status');
            if (graph) graph.textContent = config.hmeAssociativeGraphMode !== 'off'
                ? `저장된 연결 방식: ${config.hmeAssociativeGraphMode || 'off'} · ${config.hybridMemoryEngineEnabled && config.hybridScopeIndexEnabled ? '필요한 엔진·색인 켜짐' : '엔진·색인 준비 필요'}`
                : '관련 기억 확장 꺼짐';
            const archive = overlay.querySelector('#s-cold-archive-status');
            if (archive) archive.textContent = ['legacy', 'shadow'].includes(config.dualRecallMode)
                ? `보관 기억 보충 ${config.coldArchiveHydrationEnabled !== false ? '켜짐' : '꺼짐'} · 기존 검색 경로에 적용${config.dualRecallMode === 'shadow' ? ' (새 검색은 비교 관찰만)' : ''}`
                : `보관 기억 보충 선택 ${config.coldArchiveHydrationEnabled !== false ? '켜짐' : '꺼짐'} · 현재 ${config.dualRecallMode || 'dual'} 검색 경로에는 이 보관소 보충이 연결되지 않았습니다.`;
            const budget = overlay.querySelector('#sinj-budget-status');
            if (budget) {
                const stored = savedInjectionBudgetSettings;
                const preset = stored?.injectionBudgetPreset ? normalizeInjectionBudgetPreset(stored.injectionBudgetPreset) : '';
                const saved = preset === 'custom' ? stored.injectionBudgetMaxTokens ?? stored.injectionBudgetTokens
                    : preset ? getInjectionBudgetPresetTokens(preset) : stored?.injectionBudgetMaxTokens ?? stored?.injectionBudgetTokens;
                budget.textContent = `저장된 목표: ${saved !== undefined && saved !== null && Number.isFinite(Number(saved)) ? Number(saved).toLocaleString() + ' 토큰' : stored === null ? '저장 상태 미확인' : '별도 저장값 없음'} · 현재 해석 목표: ${resolveInjectionBudgetMaxTokens(config).toLocaleString()} 토큰 · 실제 호스트 허용량: 요청 시 결정 (이 화면에서 측정값 미확인)`;
            }
            const guidance = overlay.querySelector('#s-adult-guidance-status');
            if (guidance) guidance.textContent = config.nsfwMode === 'off' ? '성인 장면 추가 지침 꺼짐'
                : config.nsfwGuidancePromptEnabled === false ? '강도 선택은 저장되어 있지만 전용 추가 지침 전달은 꺼져 있습니다.' : '선택한 강도의 추가 지침 전달 켜짐';
        };
        // Export/connectivity consumers get the live config plus only this view's intended edits.
        // This does not own or save the separate preset editor draft.
        const buildSettingsConfigFromUI = () => applyOwnedGeneralSettingsPatch(MemoryEngine.CONFIG, generalSettingsPatchFromView(readGeneralSettingsControlView()));
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
            const importedSelection = incoming.llmDefaultPreset ?? incoming.defaultPreset ?? incoming.defaultPresetName ?? merged.llmDefaultPreset ?? '';
            const commonNormalized = normalizeCommonAnalysisSettings({
                ...merged,
                llmPresets: importedPresetSource,
                llmDefaultPreset: importedSelection
            }).config;
            merged.llmPresets = commonNormalized.llmPresets;
            merged.llmDefaultPreset = commonNormalized.llmDefaultPreset;
            delete merged.llmRouting;
            delete merged.llmRoutingJson;
            delete merged.llm_routing_json;
            return normalizeMemoryRetentionSettings(normalizeSettingsAliases(merged));
        };
        const applyImportedSettingsToUI = (importedConfig) => {
            // The imported common selection is authoritative, including an explicit empty/unavailable value.
            // Do not let legacy GUI defaults make primary appear active after a verified import.
            const importedCommon = normalizeCommonAnalysisSettings(importedConfig).config;
            _CFG = normalizeImportedSettingsConfig(importedConfig);
            _CFG.llmDefaultPreset = importedCommon.llmDefaultPreset;
            loadSettings();
            renderCommonAnalysisSelection(importedCommon.llmDefaultPreset);
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
            const setValue = (id, value) => { const node = overlay.querySelector('#' + id); if (node) node.value = value; };
            const loadedPresetMap = normalizeLLMPresetMap(c.llmPresets || {}, c.llm || {}, c.auxLlm || {});
            const loadedDefaultPreset = normalizeVisibleLLMProfileValue(c.llmDefaultPreset ?? c.defaultPreset ?? c.defaultPresetName ?? 'primary');
            if (overlay.querySelector("#sllmpresets")) {
                overlay.querySelector("#sllmpresets").value = stringifySettingsJsonObject(loadedPresetMap);
            }
            initializeLLMPresetEditor();
            renderCommonAnalysisSelection(loadedDefaultPreset);
            if (overlay.querySelector("#sfrm")) overlay.querySelector("#sfrm").value = FlexTierPolicy.normalizeRoutingMode(c.flexRoutingMode || 'off');
            if (overlay.querySelector("#sffb")) overlay.querySelector("#sffb").checked = c.flexFallbackToStandard === true;
            if (overlay.querySelector("#svfm")) overlay.querySelector("#svfm").value = FlexTierPolicy.normalizeVertexFlexMode(c.vertexFlexMode || 'provisioned_then_flex');
            if (overlay.querySelector("#scstp")) overlay.querySelector("#scstp").checked = c.customServiceTierPassthrough === true;
            if (overlay.querySelector("#sactdash")) overlay.querySelector("#sactdash").value = normalizeActivityDashboard(c.activityDashboard || 'compact', 'compact');
            if (overlay.querySelector("#sdebug")) overlay.querySelector("#sdebug").checked = c.debug === true;
            if (overlay.querySelector("#s-use-llm")) overlay.querySelector("#s-use-llm").checked = c.useLLM !== false;
            syncAnalysisUseStatus();
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
            setValue('sep', (c.embed && c.embed.provider) || "voyageai");
            setValue('seu', (c.embed && c.embed.url) || "https://api.voyageai.com/v1/embeddings");
            setValue('sek', (c.embed && c.embed.key) || "");
            setValue('sem', (c.embed && c.embed.model) || "voyage-4-large");
            if (overlay.querySelector('#seenabled')) overlay.querySelector('#seenabled').checked=c.embed?.enabled===true;
            setValue('sedimension', c.embed?.dimension??'');
            setValue('serevision', c.embed?.modelRevision||'');
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
            setChk('s-related-recall', String(c.hmeAssociativeGraphMode || 'off') !== 'off');
            setChk('s-cold-archive', c.coldArchiveHydrationEnabled !== false);
            setChk('s-rp-continuity', c.rpLongTermMemoryEnabled);
            setChk('svisual', c.entityVisualCanonEnabled !== false);
            setValue('sworldconflict', c.worldAdjustmentMode || 'dynamic');
            setChk('sapara', c.afterRequestParallelAnalysis);
            // 회상 가중치 / 선별 / 주입 예산 — 저장된 값으로 채운다.
            if (overlay.querySelector("#sreg")) overlay.querySelector("#sreg").value = ['off', 'soft', 'strict'].includes(String(c.recallEvidenceGate || '').toLowerCase()) ? String(c.recallEvidenceGate).toLowerCase() : 'soft';
            const budgetSelect = overlay.querySelector('#sinjbp');
            if (budgetSelect) {
                const currentPreset = normalizeInjectionBudgetPreset(c.injectionBudgetPreset);
                const choices = [['compact', '간결하게 · 12,000 토큰'], ['large', '넉넉하게 · 20,000 토큰'], ['max', '최대한 · 32,000 토큰']];
                if (!choices.some(([value]) => value === currentPreset)) choices.unshift([currentPreset, `기존 사용자 설정 · ${currentPreset === 'custom' ? c.injectionBudgetMaxTokens ?? c.injectionBudgetTokens ?? '미확인' : 15000} 토큰 유지`]);
                setSelectOptions(budgetSelect, choices, currentPreset);
            }
            syncSimpleSettingsIntentStatus();

            // Preserve an explicit unavailable/empty common selection in the GUI. It must never look like primary is active.
            renderCommonAnalysisSelection(loadedDefaultPreset);
            acceptGeneralSettingsView(readGeneralSettingsControlView());
            renderCacheStats();
            renderHealthReview();
        };

        const closeGuiOverlay = () => requestCommonAiDraftLeave(() => {
            void flushPendingGlobalSettingsAutoSave('settings-overlay-close');
            disposeOperationalLogView();
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
        });
        const onGuiKeydown = event => {
            if (event?.key !== 'Escape') return;
            event.preventDefault?.();
            if (commonAiLeaveRequest) { dismissCommonAiLeaveRequest(); return; }
            closeGuiOverlay();
        };
        document.addEventListener('keydown', onGuiKeydown);
        bodyWrap.addEventListener('click', event => {
            if (event.target === bodyWrap) closeGuiOverlay();
        });

        const mountWmStorageSettings = () => {
            const root = overlay.querySelector('[data-wm-storage-panel]');
            if (!root) return;
            const panel = WmStorageUI.mountWmStoragePanel({root,viewModel:getWmStorageViewModel(),confirm:message=>Utils.confirmEx(message)});
            wmStoragePanels.add(panel);
            overlay.addEventListener('wm-gui-dispose', () => { panel.dispose(); wmStoragePanels.delete(panel); }, {once:true});
            return panel.ready;
        };
