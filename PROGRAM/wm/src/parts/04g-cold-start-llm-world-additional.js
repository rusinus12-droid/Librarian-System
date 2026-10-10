        const analyzeHistoricalWorldAdditional = async (structuredData, messages, targetChar, targetChat, taskLabel = 'cold-start', options = {}) => {
            const config = options.analysisConfig || captureWmAnalysisConfig(MemoryEngine.CONFIG);
            const mode = String(config.worldAdditionalMode || 'off').toLowerCase();
            if (config.worldAdditionalEnabled !== true || mode === 'off') return null;
            if (!(LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux'))) return null;
            try {
                const sanitized = sanitizeStructuredKnowledge(structuredData || {});
                const historyText = truncateForLLM(
                    buildAnalysisChunkText(Array.isArray(messages) ? messages : [], { evidenceMode: 'assistant_canonical' }),
                    32000,
                    '\n...[OLDER CHAT TRUNCATED]...\n'
                );
                if (!historyText) return null;
                let existingDirectives = '';
                try {
                    const targetLore = MemoryEngine.getLorebook(targetChar, targetChat) || [];
                    const entry = LibraLoreConsolidator.unpack(targetLore)
                        .find(item => item?.comment === 'lmai_world_additional');
                    existingDirectives = truncateForLLM(String(entry?.content || ''), 4000, ' ... ');
                } catch (_) {}
                const turn = Math.max(1, getColdStartSourceMessagesMaxTurn(messages) || deriveMaxTurnFromLorebook(MemoryEngine.getLorebook(targetChar, targetChat) || []) || 1);
                const result = await TurnMaintenanceOptimizer.runWorldAdditionalHistorical({
                    turn,
                    historyText,
                    worldPrompt: buildCompactStructuredJson(sanitized.world || {}, 6000),
                    worldStatePrompt: '',
                    narrativePrompt: buildCompactStructuredJson({
                        narrative: sanitized.narrative,
                        storylines: sanitized.narrativeDetails?.storylines || []
                    }, 5000),
                    entityContext: buildCompactStructuredJson({
                        entities: sanitized.entities || [],
                        relations: sanitized.relations || []
                    }, 6000),
                    existingDirectives,
                    customDirective: String(config.worldAdditionalCustomText || '').trim()
                }, config);
                return result?.payload ? result : null;
            } catch (error) {
                // World Additional is an independent enhancement DB. A provider or
                // JSON failure here must not roll back canonical cold-start data.
                recordRuntimeDebug('warn', `[LIBRA] ${taskLabel} World Additional historical analysis skipped:`, error?.message || error);
                return null;
            }
        };
        const verifyMergedStructuredKnowledge = async (currentData, incomingData, taskLabel = 'merge-verify', options = {}) => {
            const analysisConfig = options.analysisConfig || captureWmAnalysisConfig(MemoryEngine.CONFIG);
            const currentSnapshot = sanitizeStructuredKnowledge(currentData || {});
            const incomingSnapshot = sanitizeStructuredKnowledge(incomingData || {});
            if (!hasMeaningfulStructuredSnapshot(incomingSnapshot)) {
                return hasMeaningfulStructuredSnapshot(currentSnapshot) ? currentSnapshot : null;
            }
            if (!hasMeaningfulStructuredSnapshot(currentSnapshot)) {
                return incomingSnapshot;
            }
            const fallbackMerged = sanitizeStructuredKnowledge(
                mergeStructuredKnowledgeSnapshots(currentSnapshot, incomingSnapshot) || incomingSnapshot
            );
            if (!(LLMProvider.isConfigured(analysisConfig, 'primary') || LLMProvider.isConfigured(analysisConfig, 'aux'))) {
                return fallbackMerged;
            }
            const isFastTask = /^cold-(?:start|reanalysis)|merge-verify|import-verify/.test(String(taskLabel || ''));
            const fastLlm = isFastTask ? buildFastAnalysisProfile(analysisConfig, { maxCompletionTokens: 3000, routeKey: 'mergeVerification', fallbackProfile: 'primary' }) : null;
            try {
                const reviewInput = [
                    `[기존 구조 데이터 / Existing Structured Data]`,
                    buildCompactStructuredJson(currentSnapshot, REVIEW_DATA_MAX_CHARS),
                    ``,
                    `[새 후보 데이터 / Incoming Candidate Data]`,
                    buildCompactStructuredJson(incomingSnapshot, REVIEW_DATA_MAX_CHARS)
                ].join('\n');
                const profile = isFastTask ? fastLlm.profile : resolveAnalysisProfile(analysisConfig, 'mergeVerification', 'primary');
                const verified = await runMaintenanceLLM(() =>
                    LLMProvider.call(isFastTask ? fastLlm.config : analysisConfig, MergeVerificationPrompt, reviewInput, {
                        maxTokens: isFastTask ? 2400 : 3000,
                        profile,
                        label: `${taskLabel}-${profile}`,
                        domain: 'cold_start',
                        reason: `${taskLabel}-merge-verification`,
                    })
                , `${taskLabel}-${profile}`);
                const parsed = extractStructuredJson(verified?.content || '');
                const normalized = parsed ? coerceFinalSynthesisCandidate(parsed) : null;
                return hasMeaningfulStructuredSnapshot(normalized) ? normalized : fallbackMerged;
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Structured merge verification fallback:', e?.message || e);
                return fallbackMerged;
            }
        };

        const prepareColdStartPreflightPrompt = (domain, label, config, system, user, maxTokens) => {
            const preflight = AnalysisBudgetPreflight?.preparePrompt?.({
                domain,
                system,
                user,
                config,
                maxTokens
            }) || {
                domain,
                mode: 'full',
                reason: 'unavailable',
                system,
                user,
                maxTokens,
                originalUserChars: String(user || '').length,
                preparedUserChars: String(user || '').length
            };
            AnalysisBudgetPreflight?.debugPreflight?.(config || MemoryEngine.CONFIG || {}, label, preflight);
            return {
                preflight,
                user: preflight.user || user,
                maxTokens: Number(preflight.maxTokens || maxTokens) || maxTokens,
                meta: {
                    mode: preflight.mode,
                    reason: preflight.reason,
                    estimatedTokens: preflight.estimatedTokens,
                    preparedEstimatedTokens: preflight.preparedEstimatedTokens
                }
            };
        };
        const requireColdStartSelectionCurrent = async isCurrent => {
            let current = false;
            try { current = await isCurrent() === true; } catch (_) {}
            if (!current) throw Object.assign(new Error('historical_selection_changed'),{code:'historical_selection_changed'});
        };
        const callColdStartLLMWithPreflight = async (params = {}) => {
            if (typeof params.isCurrent === 'function') await requireColdStartSelectionCurrent(params.isCurrent);
            const label = String(params.label || params.reason || 'cold-start-analysis').trim();
            const prepared = prepareColdStartPreflightPrompt(
                params.preflightDomain || params.routeKey || 'coldStartChunkSummary',
                label,
                params.config || MemoryEngine.CONFIG,
                params.system || '',
                params.user || '',
                Number(params.maxTokens || 1600) || 1600
            );
            try {
                return await LLMProvider.call(params.config || MemoryEngine.CONFIG, params.system || '', prepared.user, {
                    maxTokens: prepared.maxTokens,
                    profile: params.profile,
                    label,
                    domain: params.domain || 'cold_start',
                    reason: params.reason || label,
                    analysisPreflight: prepared.meta
                });
            } catch (e) {
                AnalysisBudgetPreflight?.recordLengthFailure?.(params.config || MemoryEngine.CONFIG, label, e, prepared.preflight);
                throw e;
            }
        };

        const synthesizeStructuredKnowledge = async (rawTexts, taskLabel = 'knowledge-import', options = {}) => {
            const analysisConfig = options.analysisConfig || captureWmAnalysisConfig(MemoryEngine.CONFIG);
            const texts = (Array.isArray(rawTexts) ? rawTexts : [])
                .map(v => String(v || '').trim())
                .filter(Boolean);
            if (texts.length === 0) return null;

            const textChunks = [];
            const chunkSize = 8;
            for (let i = 0; i < texts.length; i += chunkSize) {
                textChunks.push(texts.slice(i, i + chunkSize));
            }

            const chunkRoute = buildFastAnalysisProfile(analysisConfig, { maxCompletionTokens: 2200, routeKey: 'coldStartChunkSummary', fallbackProfile: 'aux' });
            const chunkResults = await runResourceBoundSettledPool(textChunks, (chunk, i) => {
                const chunkText = chunk.map((text, idx) => `Knowledge ${idx + 1}: ${truncateForLLM(text, IMPORT_KNOWLEDGE_MAX_ITEM_CHARS, ' ...[TRUNCATED]... ')}`).join('\n\n');
                const chunkPreflight = prepareColdStartPreflightPrompt(
                    'coldStartChunkSummary',
                    `${taskLabel}-chunk-${i + 1}`,
                    chunkRoute.config,
                    ColdStartSummaryPrompt,
                    chunkText,
                    1800
                );
                return runMaintenanceLLM(() =>
                    LLMProvider.call(chunkRoute.config, ColdStartSummaryPrompt, chunkPreflight.user, {
                        maxTokens: chunkPreflight.maxTokens,
                        profile: chunkRoute.profile,
                        label: `${taskLabel}-chunk-${i + 1}`,
                        domain: 'knowledge_import',
                        reason: `${taskLabel}-chunk`,
                        analysisPreflight: chunkPreflight.meta
                    }).catch(e => {
                        AnalysisBudgetPreflight?.recordLengthFailure?.(chunkRoute.config, `${taskLabel}-chunk-${i + 1}`, e, chunkPreflight.preflight);
                        throw e;
                    })
                , `${taskLabel}-chunk-${i + 1}`);
            }, { label: `${taskLabel}-knowledge-pool`, maxConcurrency: 6 });

            const chunkSummaries = [];
            let settledChunkCount = 0;
            for (const result of chunkResults) {
                settledChunkCount += 1;
                if (result.status === 'fulfilled' && result.value.content) {
                    const parsed = extractStructuredJson(result.value.content);
                    if (parsed) chunkSummaries.push(parsed);
                }
            }
            if (chunkSummaries.length === 0) return null;

            let finalData = null;
            for (let attempt = 0; attempt < 2 && !finalData; attempt++) {
                let synthesisPreflight = null;
                try {
                    const synthesisInput = buildSynthesisInput(chunkSummaries);
                    synthesisPreflight = prepareColdStartPreflightPrompt(
                        'coldStartFinalSynthesis',
                        `${taskLabel}-synthesis-${attempt + 1}`,
                        analysisConfig,
                        FinalSynthesisPrompt,
                        synthesisInput,
                        3000
                    );
                    const synthesisResult = await runMaintenanceLLM(() =>
                        LLMProvider.call(
                            analysisConfig,
                            FinalSynthesisPrompt,
                            synthesisPreflight.user,
                            {
                                maxTokens: synthesisPreflight.maxTokens,
                                profile: resolveAnalysisProfile(analysisConfig, 'structuredMerge', 'primary'),
                                label: `${taskLabel}-synthesis-${attempt + 1}`,
                                domain: 'knowledge_import',
                                reason: `${taskLabel}-synthesis`,
                                analysisPreflight: synthesisPreflight.meta
                            }
                    )
                    , `${taskLabel}-synthesis-${attempt + 1}`);
                    if (synthesisResult?.content) {
                        const parsed = extractStructuredJson(synthesisResult.content);
                        const normalized = parsed ? coerceFinalSynthesisCandidate(parsed) : null;
                        if (hasMeaningfulStructuredSnapshot(normalized)) finalData = normalized;
                    }
                } catch (e) {
                    AnalysisBudgetPreflight?.recordLengthFailure?.(analysisConfig, `${taskLabel}-synthesis-${attempt + 1}`, e, synthesisPreflight?.preflight || {
                        domain: 'coldStartFinalSynthesis',
                        mode: 'unknown',
                        reason: `${taskLabel}-synthesis`
                    });
                    if (attempt === 0) recordRuntimeDebug('warn', '[LIBRA] Knowledge synthesis retry:', e?.message || e);
                }
            }

            if (!finalData) {
                finalData = fallbackChunkSummariesToStructured(chunkSummaries, "Imported knowledge summary applied.");
            }
            return finalData;
        };

        const buildAnalyzableMessagesWithAudit = (chat, options = {}) => {
            const sourceInfo = options.sourceInfo || null;
            const msgs_all = Array.isArray(options.sourceMessages)
                ? options.sourceMessages
                : (sourceInfo?.messages || getChatMessages(chat));
            const historyLimit = resolveColdStartHistoryLimit(
                MemoryEngine.CONFIG.coldStartScopePreset,
                MemoryEngine.CONFIG.coldStartHistoryLimit
            );
            const sourceMsgs = historyLimit > 0 ? msgs_all.slice(-historyLimit) : msgs_all;
            const messages = [];
            const audit = [];
            sourceMsgs.forEach((m, index) => {
                const normalized = normalizeColdStartMessageForAnalysis(m, index);
                const isUser = normalized.roleHint === 'user';
                const ignoredGreeting = getMessageSignature(m) === MemoryState.ignoredGreetingSignature;
                const metaLike = Utils.isMetaPromptLike(normalized.narrativeText || normalized.rawText);
                const tagOnlyTool = Utils.isTagOnlyToolResponse(normalized.narrativeText || normalized.rawText);
                const excludedMemory = !normalized.auxHintCount && Utils.shouldExcludeMemoryContent(normalized.text || normalized.narrativeText);
                let dropReason = '';
                if (!m) dropReason = 'missing_message';
                else if (ignoredGreeting) dropReason = 'ignored_greeting';
                else if (!normalized.text) dropReason = 'empty_after_artifact_strip';
                else if (isUser && metaLike && !normalized.auxHintCount) dropReason = 'user_meta_prompt';
                else if (!isUser && (metaLike || tagOnlyTool) && !normalized.auxHintCount) dropReason = tagOnlyTool ? 'ai_tag_only_tool' : 'ai_meta_prompt';
                else if (excludedMemory) dropReason = 'excluded_memory_content';

                const kept = !dropReason;
                audit.push({
                    index,
                    role: isUser ? 'user' : 'ai',
                    kept,
                    dropReason,
                    raw: coldStartMessageDigest(normalized.rawText),
                    narrative: coldStartMessageDigest(normalized.narrativeText),
                    final: coldStartMessageDigest(normalized.text),
                    metaLike,
                    tagOnlyTool,
                    ignoredGreeting,
                    imageCues: normalized.imageCues.length,
                    auxHintCount: normalized.auxHintCount
                });
                if (kept) {
                    messages.push({
                        msg: normalized.msg,
                        roleHint: normalized.roleHint,
                        text: normalized.text,
                        narrativeText: normalized.narrativeText,
                        auxiliaryHints: {
                            imageCues: normalized.imageCues,
                            count: normalized.auxHintCount
                        }
                    });
                }
            });
            return {
                messages,
                audit,
                summary: summarizeColdStartFilterAudit(audit),
                source: {
                    label: sourceInfo?.label || 'getChatMessages',
                    rawMessages: Array.isArray(msgs_all) ? msgs_all.length : 0,
                    scopedMessages: sourceMsgs.length,
                    historyLimit,
                    candidates: sourceInfo?.candidates || []
                }
            };
        };
        const buildAnalyzableMessages = (chat, options = {}) => {
            if (Array.isArray(options.sourceMessages) || options.sourceInfo) {
                return buildAnalyzableMessagesWithAudit(chat, options).messages;
            }
            const sourceInfo = resolveColdStartMessageSource(chat);
            return buildAnalyzableMessagesWithAudit(chat, {
                ...options,
                sourceInfo,
                sourceMessages: sourceInfo.messages
            }).messages;
        };

