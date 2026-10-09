        const buildHybridWritePathMetadata = (payload = {}, meta = {}, searchText = '', currentTurn = 0, options = {}) => {
            const tempEntry = {
                key: '',
                comment: 'lmai_memory',
                content: `[META:${JSON.stringify(meta || {})}]\n${CompactMemoryCodec.serialize(payload || {})}\n`
            };
            let row = null;
            try { row = buildHybridMemoryRow(tempEntry, 0, currentTurn); } catch (_) { row = null; }
            const fallbackKindInfo = classifyHybridKinds(payload || {}, meta || {}, searchText || '', currentTurn);
            const sourceTurns = uniqLimit([
                currentTurn,
                meta?.t,
                meta?.turnAnchorTurn,
                payload?.turn,
                payload?.firstSeenTurn,
                ...(Array.isArray(options.sourceTurnIds) ? options.sourceTurnIds : [])
            ].map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0), 12);
            const kind = String(row?.primaryKind || fallbackKindInfo.primaryKind || 'memory').trim() || 'memory';
            const retrospectiveClass = CompactMemoryCodec.normalizeRetrospectiveClass(
                row?.retrospectiveClass || payload?.retrospectiveClass || meta?.hme?.retrospectiveClass || fallbackKindInfo.retrospectiveClass || ''
            );
            const recallProfile = String(row?.recallProfile || payload?.recallProfile || (retrospectiveClass ? 'continuity_only' : '')).trim();
            const ledgerProjection = getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            const compatSubjects = isLedger ? ledgerProjection.entities : [...asHybridArray(payload?.mentionedEntityNames), ...asHybridArray(meta?.ent)];
            const compatTags = isLedger ? ledgerProjection.tags : [...asHybridArray(payload?.tags), payload?.arcKey, payload?.arcRole, payload?.causalRole];
            return {
                schema: 'libra.hme.typed_row_meta.v1',
                version: 1,
                engineVersion: HYBRID_MEMORY_ENGINE_POLICY.version,
                source: 'write_path_adapter',
                kind,
                primaryKind: kind,
                kinds: uniqLimit([...(row?.kinds || []), ...(fallbackKindInfo.kinds || []), kind], 10),
                baseBucket: String(row?.baseBucket || (retrospectiveClass ? 'retrospective' : fallbackKindInfo.bucket) || '').trim(),
                subjects: uniqLimit([...(row?.subjects || []), ...compatSubjects, ...ledgerProjection.entities], 32),
                aliases: uniqLimit([...(row?.aliases || []), ...compatSubjects, ...ledgerProjection.entities], 32),
                tags: uniqLimit([...(row?.tags || []), ...compatTags, ...ledgerProjection.tags], 32),
                sceneTags: uniqLimit(row?.sceneTags || [], 16),
                emotionTags: uniqLimit(row?.emotionTags || [], 16),
                relationTags: uniqLimit(row?.relationTags || [], 16),
                worldTags: uniqLimit(row?.worldTags || [], 16),
                narrativeTags: uniqLimit(row?.narrativeTags || [], 16),
                retrospectiveClass,
                recallProfile,
                arcKey: String(row?.arcKey || payload?.arcKey || '').trim(),
                arcRole: String(row?.arcRole || payload?.arcRole || '').trim(),
                causalRole: String(row?.causalRole || payload?.causalRole || '').trim(),
                sourceTurnIds: sourceTurns,
                firstSeenTurn: Number(payload?.firstSeenTurn || sourceTurns[0] || currentTurn || 0) || 0,
                turn: Number(payload?.turn || meta?.t || currentTurn || 0) || 0,
                importance: Math.max(0, Math.min(1, Number(meta?.imp || payload?.importance || 5) / 10)),
                salience: Math.max(0, Math.min(1, Number(payload?.impression || 0.5) || 0.5)),
                confidence: 0.78,
                worldDedicated: Boolean(row?.worldDedicated || fallbackKindInfo.worldDedicated),
                stale: false,
                supersededBy: '',
                staleCandidateIds: uniqLimit(asHybridArray(options.staleCandidateIds), 8),
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
        };

        const duplicateTokenSet = (text = '') => new Set(TokenizerEngine.tokenize(String(text || '')).filter(token => token && token.length >= 2));
        const duplicateOverlapScore = (a = '', b = '') => {
            const A = duplicateTokenSet(a);
            const B = duplicateTokenSet(b);
            if (!A.size || !B.size) return 0;
            let inter = 0;
            for (const t of A) if (B.has(t)) inter += 1;
            return inter / Math.max(1, Math.min(A.size, B.size));
        };
        const scoreDuplicateCandidateFast = (existingContent = '', newContent = '') => {
            const a = String(existingContent || '').replace(/\s+/g, ' ').trim();
            const b = String(newContent || '').replace(/\s+/g, ' ').trim();
            if (!a || !b) return { score: 0, reject: true, accept: false, reason: 'empty' };
            if (a === b) return { score: 1, reject: false, accept: true, reason: 'exact' };
            const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length, 1);
            if (lenRatio < 0.34) return { score: 0, reject: true, accept: false, reason: 'length_mismatch' };
            const idxA = TokenizerEngine.getIndexKey(a);
            const idxB = TokenizerEngine.getIndexKey(b);
            const indexMatch = idxA && idxB && idxA === idxB;
            const overlap = duplicateOverlapScore(a, b);
            const anchorA = extractExactRecallAnchors(a);
            const anchorB = extractExactRecallAnchors(b);
            const anchorOverlap = anchorA.filter(x => anchorB.includes(x)).length;
            const score = Math.min(1, (overlap * 0.72) + (lenRatio * 0.14) + (indexMatch ? 0.10 : 0) + Math.min(0.18, anchorOverlap * 0.06));
            return {
                score,
                reject: score < 0.18 && !indexMatch,
                accept: score >= 0.92 || (indexMatch && score >= 0.82),
                reason: indexMatch ? 'index_match' : 'token_overlap',
                overlap,
                lenRatio,
                anchorOverlap
            };
        };

        const findHybridStaleCandidates = (content = '', existingList = [], limit = 6) => {
            const ranked = [];
            const pool = Array.isArray(existingList) ? existingList.slice(-80) : [];
            for (const item of pool) {
                if (!item || String(item.comment || '') !== 'lmai_memory') continue;
                const existingContent = CompactMemoryCodec.buildSearchTextFromEntry(item);
                if (!existingContent) continue;
                const fast = scoreDuplicateCandidateFast(existingContent, content);
                if (fast.score >= 0.48 && fast.score < 0.92) {
                    ranked.push({ id: getSafeKey(item), score: fast.score, reason: fast.reason });
                }
            }
            return ranked.sort((a, b) => b.score - a.score).slice(0, Math.max(0, Number(limit || 0))).map(item => item.id).filter(Boolean);
        };

        const queryHasHybridEntity = (query = '', names = []) => {
            const q = normalizeHybridToken(query).replace(/\s+/g, '');
            return (Array.isArray(names) ? names : []).filter(name => {
                const n = normalizeHybridToken(name).replace(/\s+/g, '');
                return n && q.includes(n);
            }).slice(0, 8);
        };
        const isHybridWorldPrimary = (row = {}) => {
            const kinds = new Set(Array.isArray(row?.kinds) ? row.kinds : []);
            return row?.worldDedicated === true
                || String(row?.baseBucket || '').trim() === 'world'
                || (String(row?.primaryKind || '').trim() === 'world' && !kinds.has('relationship') && !kinds.has('narrative'));
        };
        const hybridKindMatchesIntent = (row = {}, recallIntent = {}, queryPlan = {}) => {
            const kinds = new Set(Array.isArray(row.kinds) ? row.kinds : []);
            const primary = String(row.primaryKind || 'memory');
            const matches = [];
            if ((recallIntent?.worldRule || (queryPlan.strongAnchors || []).some(a => /규칙|금지|세계관|시스템/.test(a))) && isHybridWorldPrimary(row)) matches.push('world');
            if ((recallIntent?.origin || recallIntent?.transition || recallIntent?.aftermath) && (kinds.has('narrative') || primary === 'narrative')) matches.push('narrative');
            if (recallIntent?.relationship && (kinds.has('relationship') || primary === 'relationship')) matches.push('relationship');
            if (recallIntent?.current && primary === 'memory') matches.push('memory');
            return matches;
        };
