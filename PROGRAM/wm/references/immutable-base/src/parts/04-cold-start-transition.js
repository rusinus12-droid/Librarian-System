    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Cold Start Manager
    // ══════════════════════════════════════════════════════════════
    const ColdStartManager = (() => {
        let isProcessing = false;
        const requestColdStartApproval = async (kind = 'cold_start', options = {}) => {
            if (options?.confirmationGranted === true) return { approved: true, source: 'preconfirmed' };
            const char = options?.char || await RisuCompat.getCharacter();
            const chat = options?.chat || (char ? await getActiveChatForCharacter(char) : null);
            const messageCount = chat ? getChatMessages(chat).length : 0;
            const lore = char && chat ? (MemoryEngine.getLorebook(char, chat) || []) : [];
            const libraEntryCount = LibraLoreConsolidator.unpack(Array.isArray(lore) ? lore : [])
                .filter(entry => /^lmai_/.test(String(entry?.comment || ''))).length;
            const estimatedCalls = messageCount > 0 ? Math.max(2, Math.ceil(messageCount / 24) + 2) : 2;
            const trigger = String(options?.trigger || 'manual').trim();
            const isReanalysis = kind === 'reanalysis';
            const title = isReanalysis ? '과거 대화 정본 재분석' : '초기 구조 분석/정본 보강';
            const reason = String(options?.reason || options?.reasonLabel || '').trim()
                || (trigger === 'periodic' ? '주기적 정본 보강 조건이 충족되었습니다.' : '사용자가 분석을 요청했습니다.');
            const approved = await Utils.confirmEx([
                `${title}을 실행할까요?`,
                '',
                `실행 이유: ${reason}`,
                `분석 대상 메시지: 약 ${messageCount}개`,
                `현재 LIBRA 데이터 항목: ${libraEntryCount}개`,
                `예상 LLM 호출: 약 ${estimatedCalls}회 이상 (대화 길이에 따라 증가)`,
                '',
                '기존 정본은 먼저 보존되며, 검증된 보강 결과만 병합됩니다.',
                '취소하면 아무 데이터도 변경하지 않습니다.'
            ].join('\n'));
            return { approved: approved === true, source: 'user_dialog', messageCount, libraEntryCount, estimatedCalls, trigger };
        };
        const STRICT_JSON_OUTPUT_RULES = `

[엄격 출력 규칙 / Strict Output Rules]
- 응답은 JSON 객체 또는 JSON 배열 하나만 반환하십시오.
- 절대로 사용자의 입력 내용을 그대로 반복하거나 출력에 포함하지 마십시오. NEVER echo, repeat, or include the user's input text in your output.
- 첫 글자는 반드시 { 또는 [ 이어야 합니다.
- 마지막 글자는 반드시 } 또는 ] 이어야 합니다.
- 코드블록, Markdown, 설명문, 인사말, 주석, 사고흐름, reasoning, analysis, note, explanation, prefix/suffix를 절대 출력하지 마십시오.
- JSON 앞뒤에 어떤 문자도 붙이지 마십시오.
- 확신이 낮아도 설명하지 말고, 빈 배열/빈 문자열/기본 필드로 유효한 JSON만 반환하십시오.
- JSON 외 텍스트를 한 글자라도 출력하면 실패입니다.`;

        const ColdStartSummaryPrompt = `당신은 과거 대화 내역을 분석하여 핵심 요약을 생성하는 전문가입니다.
제공된 대화 청크를 분석하여 다음 정보를 JSON 형식으로 추출하십시오.

{
    "events": ["주요 사건 리스트"],
    "characters": [
        { "name": "이름", "details": "외모/성격/배경 요약", "role": "서사 역할", "currentState": "현재 상태", "speechStyle": "말투 단서", "psychology": "심리/갈등 단서", "evidence": ["짧은 근거 단서"] }
    ],
    "relationships": [
        { "pair": ["A", "B"], "status": "관계 요약", "dynamics": ["관계 동역학"], "evidence": ["짧은 근거 단서"] }
    ],
    "world_rules": ["감지된 세계관 규칙"]
}

[보수적 추출 규칙 / Conservative Extraction Rules]
- Assistant/AI lines are canonical evidence for what happened. User messages are request metadata only and must not be treated as completed events unless confirmed by assistant evidence.
- If a user request conflicts with the assistant response, the assistant response is canonical.
- Stable appearance, personality, background, relationship, and world facts may be extracted only when they are explicitly established by the provided text.
- role, currentState, speechStyle, psychology, dynamics, and evidence must be short, grounded cues only; do not invent continuity.
- evidence must be a concise paraphrased source cue, not a long verbatim transcript.
- Lines under "[Auxiliary module hints]" are lower-priority runtime cues extracted from image commands. Use them only when they support or clarify visible prose; never let them override contradictory visible conversation.
- Do not infer physical traits, sexual body details, sexual attitudes, sexual preferences, identity labels, occupation, or current location from gender, genre convention, tone, or weak implication.
- Sexual body details, sexual preferences, and sexual attitudes must be recorded only if explicitly stated and necessary for later continuity; otherwise omit them.
- If a detail is unknown or merely plausible, leave it out rather than guessing.

[출력 언어 규칙 / Output Language Rules]
- 이름은 원문 또는 기존 LIBRA 정본 표기를 그대로 유지하십시오. 번역명·로마자·별칭은 동일 인물임이 확실할 때 aliases에만 기록하고, 이중언어 이름을 새로 합성하지 마십시오.
- 내부 데이터 언어 가드가 목표 언어를 지정하면 서술값에 그 언어를 사용하십시오. 가드가 없으면 원문 서술 언어를 일관되게 유지하십시오.

주의: 반드시 유효한 JSON 구조만 반환하십시오. 다른 설명은 생략하십시오.${STRICT_JSON_OUTPUT_RULES}`;

        const FinalSynthesisPrompt = `당신은 여러 개의 대화 요약본을 하나로 통합하는 마스터 편집자입니다.
분할된 요약 데이터들을 바탕으로, 이 채팅방의 현재 상태를 정의하는 최종 보고서를 JSON 형식으로 작성하십시오.

반환 형식:
{
    "narrative": "전체 줄거리 요약",
    "narrativeDetails": {
        "storylines": [
            { "name": "스토리라인 이름", "context": "현재 맥락", "keyPoints": ["핵심 포인트"], "ongoingTensions": ["진행 중 갈등"], "entities": ["관련 인물"] }
        ]
    },
    "entities": [
        {
            "name": "이름", "sex": "male|female|", "appearance": "외모", "personality": "성격", "background": "배경",
            "identity": { "age": "", "occupation": "", "affiliation": "", "roleInStory": "", "summary": "", "aliases": [], "honorifics": [] },
            "profile": { "personality": { "values": [], "fears": [], "likes": [], "dislikes": [], "boundaries": [] }, "speechStyle": { "defaultTone": "", "honorificStyle": "", "pressureMarkers": [], "catchphrases": [], "notes": [] }, "psychology": { "baseline": "", "currentConflict": "", "copingStyle": "", "notes": [] } },
            "currentState": { "summary": "", "sceneTime": "", "location": "", "physicalState": [], "emotionalState": [], "cognitiveFocus": [], "immediateGoal": "", "activeProblems": [] },
            "continuity": { "openThreads": [{ "label": "", "status": "active", "pressure": 0 }], "unresolvedNeeds": [], "commitments": [], "nextActionHints": [] },
            "povKnowledge": { "knownToSelf": [], "unknownToSelf": [], "knownToOthers": [], "visibleTo": [], "privateExperiences": [], "privacy": "" },
            "episodeLedger": [{ "turn": 0, "summary": "", "impact": "", "stability": "current_state" }],
            "evidence": [{ "sourceKind": "cold_start", "turn": 0, "snippet": "짧은 근거 단서", "confidence": 0.7 }],
            "quality": { "confidence": 0.7, "salience": 0.5, "importance": 0.5, "pressure": 0, "needsReview": false }
        }
    ],
    "relations": [
        {
            "entityA": "이름", "entityB": "이름", "type": "관계유형", "sentiment": "감정상태",
            "currentStatus": { "summary": "", "publicLayer": "", "privateLayer": "", "boundaryState": "" },
            "metrics": { "closeness": 0, "trust": 0, "tension": 0, "risk": 0, "ambiguity": 0, "pressure": 0 },
            "dynamics": { "fromAtoB": [], "fromBtoA": [], "unresolvedIssues": [], "recentChanges": [] },
            "sharedContext": { "location": "", "workplace": "", "privateThreads": [], "notes": [] },
            "eventLedger": [{ "turn": 0, "summary": "", "impact": "", "stability": "current_state" }],
            "evidence": [{ "sourceKind": "cold_start", "turn": 0, "snippet": "짧은 근거 단서", "confidence": 0.7 }],
            "quality": { "confidence": 0.7, "salience": 0.5, "importance": 0.5, "pressure": 0 }
        }
    ],
    "world": { "tech": "기술수준", "rules": ["규칙들"] }
}

[보수적 추출 규칙 / Conservative Extraction Rules]
- Assistant/AI-derived summaries are canonical evidence for what happened. User requests are not evidence that an event occurred unless confirmed by assistant evidence.
- If a user request conflicts with assistant evidence, assistant evidence wins.
- entities.sex, appearance, personality, background, and occupation must contain only stable details explicitly supported by the input summaries. sex must be exactly "male" or "female" only when explicitly supported; otherwise leave it empty.
- Current location is transient scene/world state; leave entity.currentState.location empty and never place current location in background.
- Use extended entity/relation fields when the summaries explicitly support current state, continuity, POV knowledge, psychology, relationship pressure, or evidence. Leave unsupported subfields empty.
- profile.psychology.baseline/currentConflict/copingStyle should capture supported inner posture, unresolved inner conflict, and recurring stress response; do not hide these in personality.
- continuity.openThreads should capture unresolved personal plot hooks, unanswered questions, pending promises/risks, or choices that should be recalled later.
- When legacy entity fields overlap with identity/profile/currentState, treat identity/profile/currentState as canonical and keep legacy fields as short compatible mirrors. Never write conflicting values between them.
- evidence.snippet must be a concise paraphrased evidence cue, not a long verbatim transcript.
- Auxiliary module hints from image-command cues are lower-priority evidence. Use them only to preserve scene/current-state hints that are compatible with visible conversation.
- Do not infer physical traits, sexual body details, sexual attitudes, sexual preferences, identity labels, occupation, or current location from gender, genre convention, tone, or weak implication.
- Sexual body details, sexual preferences, and sexual attitudes may be included only when explicitly stated and necessary for later continuity; otherwise omit them.
- If a detail is unknown, leave the field empty or omit the claim instead of guessing.
- If occupation is explicit and current, put it in background with an "Occupation: ..." label.

[출력 언어 규칙 / Output Language Rules]
- 이름은 원문 또는 기존 LIBRA 정본 표기를 그대로 유지하십시오. 번역명·로마자·별칭은 aliases로만 관리하고, 이중언어 이름을 새로 합성하지 마십시오.
- 내부 데이터 언어 가드가 목표 언어를 지정하면 서술값에 그 언어를 사용하십시오. 가드가 없으면 입력 요약의 주된 언어를 일관되게 유지하십시오.

주의: 반드시 JSON만 반환하십시오.${STRICT_JSON_OUTPUT_RULES}`;
        const COLD_START_CANONICAL_PACKET_SCHEMA = `{
  "canonicalPacket": ${CanonicalPacketContract.promptShape},
  "structuredSnapshot": {
    "narrative": "compatibility summary for current LIBRA storage",
    "narrativeDetails": { "storylines": [] },
    "entities": [],
    "relations": [],
    "world": { "tech": "", "summary": "", "rules": [] }
  }
}`;
        const ColdStartCanonicalPacketPrompt = `당신은 LIBRA 정본 델타 분석기입니다.
분할 요약본들을 한 번에 통합하여 메모리, 엔티티, 내러티브, 세계관을 모두 포함한 canonicalPacket을 작성하십시오.
또한 현재 LIBRA 저장소가 바로 병합할 수 있도록 같은 내용을 structuredSnapshot에도 투영하십시오.

반환 형식:
${COLD_START_CANONICAL_PACKET_SCHEMA}

[분석 규칙]
- 하나의 응답 안에서 memory/entity/world/narrative/guards를 모두 분석하십시오. 축별 추가 분석을 가정하지 마십시오.
- memory는 시간순 회상용 짧은 사건/사실/미해결 흐름입니다. 원문 대사 모음, 장면 전문, 장황한 요약을 저장하지 마십시오.
- narrative는 memory들을 묶는 스토리라인/아크/갈등/현재 맥락 지도입니다. 개별 턴 회상 저장소처럼 쓰지 마십시오.
- Assistant/AI-derived summaries are canonical evidence for what happened. User requests are not evidence that an event occurred unless confirmed by assistant evidence.
- If user request and assistant evidence conflict, assistant evidence wins.
- 시간순 기억이 나중에 꺼내 쓰일 수 있도록 memory.events는 대화 흐름 순서를 유지하십시오.
- 안정적이고 재사용 가치가 있는 기억, 현재 상태, 관계 변화, 세계 규칙, 미해결 서사만 남기십시오.
- entity.appearance에는 외형/복장/신체 특징만, entity.personality에는 성격/태도/행동 경향만, entity.background에는 출신/직업/소속/과거 같은 안정 배경만 넣으십시오.
- entity.background에 외모, 현재 장면 상태, 관계 상태, 말투, 서사 역할을 섞지 마십시오. 서사 역할은 role에만 넣으십시오.
- 현재 위치는 장면/월드 상태에서 다루고 entity의 안정 DB 필드로 저장하지 마십시오.
- relation의 closeness/trust 같은 수치는 명시 근거가 있을 때만 넣고, 근거가 약하면 비워 두십시오.
- 각 memory/entity/relation 변경에는 operation과 evidenceRefs를 기록하십시오. 빈 배열은 삭제를 뜻하지 않습니다.
- add/update/resolve는 원문 근거가 필요합니다. 변경이 없으면 no_change를 사용하고, 빈 배열로 삭제를 표현하지 마십시오.
- world는 영구 세계 구조만 저장하십시오. 장소/시설, 조직, 사회·문화 규칙, 초자연/시스템/물리 법칙, 특수 현상만 world 정본에 넣으십시오.
- world.time, world.location, world.scene, world.state, active_events, offscreen_threads는 현재 세계 상태로만 쓰고 영구 rules.exists/custom에 섞지 마십시오.
- 불확실하거나 근거가 약한 내용은 guards.uncertain 또는 guards.do_not_assume에 넣고 정본 필드에는 확정하지 마십시오.
- 이름은 원문 또는 기존 LIBRA 정본 표기를 유지하고 변형 표기는 aliases에 기록하십시오. 이중언어 이름을 새로 합성하지 마십시오.
- 내부 데이터 언어 가드가 목표 언어를 지정하면 서술값에 그 언어를 사용하십시오. 가드가 없으면 입력 데이터의 주된 언어를 일관되게 유지하십시오.
- 반드시 유효한 JSON만 반환하십시오.${STRICT_JSON_OUTPUT_RULES}`;
        const ColdStartCanonicalMergePrompt = `당신은 LIBRA 정본 델타 병합 편집자입니다.
여러 개의 canonicalPacket 또는 structuredSnapshot 부분 보고서를 하나의 최신 정본 canonicalPacket으로 병합하십시오.
병합 결과는 반드시 현재 LIBRA 저장소가 바로 적용할 수 있는 structuredSnapshot도 함께 포함해야 합니다.

반환 형식:
${COLD_START_CANONICAL_PACKET_SCHEMA}

규칙:
- 중복은 제거하고, 더 구체적이며 assistant evidence에 더 잘 지지되는 내용을 우선하십시오.
- 명백한 충돌은 guards.conflicts에 남기고, 확정하기 어려운 값은 정본 필드에 쓰지 마십시오.
- memory.events는 시간 흐름을 유지하십시오. 최신성 때문에 오래된 중요 사건을 삭제하지 마십시오.
- entity/world/narrative는 교체가 아니라 누적 병합 기준으로 작성하십시오.
- relation.recent_changes에는 이번 범위에서 발생한 관계 변화/사건을, relation.unresolved_issues에는 아직 열린 관계 긴장/질문/약속/위험을 넣으십시오.
- 이름은 기존 정본 표기를 유지하고 변형 표기는 aliases로만 병합하십시오.
- 반드시 JSON만 반환하십시오.${STRICT_JSON_OUTPUT_RULES}`;
        const ColdStartChunkArbiterPrompt = `당신은 과거 대화 청크 분석의 최종 판정자입니다.
원문 대화 청크와 보조 요약 초안을 함께 보고, 원문을 최우선 근거로 삼아 최종 청크 구조 요약을 JSON으로 반환하십시오.

반드시 다음 JSON 형식만 반환하십시오:
{
    "events": ["주요 사건 리스트"],
    "characters": [
        { "name": "이름", "details": "외모/성격/배경 요약", "role": "서사 역할", "currentState": "현재 상태", "speechStyle": "말투 단서", "psychology": "심리/갈등 단서", "evidence": ["짧은 근거 단서"] }
    ],
    "relationships": [
        { "pair": ["A", "B"], "status": "관계 요약", "dynamics": ["관계 동역학"], "recent_changes": ["관계 변화"], "unresolved_issues": ["미해결 관계 이슈"], "evidence": ["짧은 근거 단서"] }
    ],
    "world_rules": ["감지된 세계관 규칙"]
}

규칙:
- 원문 대화 청크를 가장 높은 우선순위로 사용하십시오.
- 원문 중 AI/Assistant lines are canonical evidence. User lines are request metadata and must not be treated as completed events unless the assistant line confirms them.
- 보조 요약 초안은 참고만 하되, 원문 근거와 일치할 때만 채택하십시오.
- 보조 초안이 누락했더라도 원문에 있으면 반드시 반영하십시오.
- role/currentState/speechStyle/psychology/dynamics/evidence는 원문에 근거가 있을 때만 짧게 작성하십시오.
- relationships.recent_changes에는 실제로 변화한 관계 사건을, unresolved_issues에는 열린 긴장/질문/약속/위험을 기록하십시오.
- evidence는 긴 원문 복사가 아니라 짧은 근거 단서로 작성하십시오.
- 반드시 JSON만 반환하십시오.${STRICT_JSON_OUTPUT_RULES}`;

        const MergeVerificationPrompt = `당신은 LIBRA 구조 데이터 병합 검증기입니다.
기존 구조 데이터와 새로 분석된 후보 데이터를 비교하여, 기존 정보를 최대한 보존하면서 새 정보만 누적 병합한 최종 JSON을 반환하십시오.

반드시 다음 JSON 형식만 반환하십시오:
{
  "narrative": "최종 줄거리 요약",
  "narrativeDetails": {
    "storylines": [
      { "name": "스토리라인 이름", "context": "현재 맥락", "keyPoints": ["핵심 포인트"], "ongoingTensions": ["진행 중 갈등"], "entities": ["관련 인물"] }
    ]
  },
  "entities": [
    {
      "name": "이름", "sex": "male|female|", "appearance": "외모", "personality": "성격", "background": "배경",
      "identity": { "age": "", "occupation": "", "affiliation": "", "roleInStory": "", "summary": "", "aliases": [], "honorifics": [] },
      "profile": { "personality": { "values": [], "fears": [], "likes": [], "dislikes": [], "boundaries": [] }, "speechStyle": { "defaultTone": "", "honorificStyle": "", "pressureMarkers": [], "catchphrases": [], "notes": [] }, "psychology": { "baseline": "", "currentConflict": "", "copingStyle": "", "notes": [] } },
      "currentState": { "summary": "", "sceneTime": "", "location": "", "physicalState": [], "emotionalState": [], "cognitiveFocus": [], "immediateGoal": "", "activeProblems": [] },
      "continuity": { "openThreads": [{ "label": "", "status": "active", "pressure": 0 }], "unresolvedNeeds": [], "commitments": [], "nextActionHints": [] },
      "povKnowledge": { "knownToSelf": [], "unknownToSelf": [], "knownToOthers": [], "visibleTo": [], "privateExperiences": [], "privacy": "" },
      "episodeLedger": [{ "turn": 0, "summary": "", "impact": "", "stability": "current_state" }],
      "evidence": [{ "sourceKind": "cold_start", "turn": 0, "snippet": "짧은 근거 단서", "confidence": 0.7 }],
      "quality": { "confidence": 0.7, "salience": 0.5, "importance": 0.5, "pressure": 0, "needsReview": false }
    }
  ],
  "relations": [
    {
      "entityA": "이름", "entityB": "이름", "type": "관계유형", "sentiment": "감정상태",
      "currentStatus": { "summary": "", "publicLayer": "", "privateLayer": "", "boundaryState": "" },
      "metrics": { "closeness": 0, "trust": 0, "tension": 0, "risk": 0, "ambiguity": 0, "pressure": 0 },
      "dynamics": { "fromAtoB": [], "fromBtoA": [], "unresolvedIssues": [], "recentChanges": [] },
      "sharedContext": { "location": "", "workplace": "", "privateThreads": [], "notes": [] },
      "eventLedger": [{ "turn": 0, "summary": "", "impact": "", "stability": "current_state" }],
      "evidence": [{ "sourceKind": "cold_start", "turn": 0, "snippet": "짧은 근거 단서", "confidence": 0.7 }],
      "quality": { "confidence": 0.7, "salience": 0.5, "importance": 0.5, "pressure": 0 }
    }
  ],
  "world": { "tech": "기술수준", "rules": ["규칙들"] }
}

규칙:
- 새 후보 데이터는 기본적으로 기존 데이터에 누적 병합하십시오.
- 원문 근거 없이 기존 정보를 삭제하지 마십시오.
- 명백한 충돌만 보수적으로 교정하십시오.
- narrativeDetails.storylines도 누적 병합하되, 같은 스토리라인은 더 구체적인 정보를 우선하십시오.
- 반드시 JSON만 반환하십시오.${STRICT_JSON_OUTPUT_RULES}`;

        const ANALYSIS_MAX_LINE_CHARS = 900;
        const ANALYSIS_MAX_CHUNK_CHARS = 9000;
        const SYNTHESIS_MAX_INPUT_CHARS = 12000;
        const REVIEW_DATA_MAX_CHARS = 3600;
        const IMPORT_KNOWLEDGE_MAX_ITEM_CHARS = 1800;
        const HIERARCHICAL_SYNTHESIS_MAX_BATCHES = 12;
        const HIERARCHICAL_SYNTHESIS_MAX_LAYERS = 4;

        const isColdStartPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
        const coerceColdStartTextArray = (value) => {
            if (value == null) return [];
            if (Array.isArray(value)) return value.flatMap(coerceColdStartTextArray);
            if (isColdStartPlainObject(value)) {
                const fields = [
                    value.summary,
                    value.details,
                    value.status,
                    value.text,
                    value.value,
                    value.description,
                    value.label,
                    value.name,
                    ...(Array.isArray(value.events) ? value.events : []),
                    ...(Array.isArray(value.keyPoints) ? value.keyPoints : []),
                    ...(Array.isArray(value.rules) ? value.rules : []),
                    ...(Array.isArray(value.notes) ? value.notes : [])
                ];
                return fields.flatMap(coerceColdStartTextArray);
            }
            const text = String(value || '').trim();
            return text ? [text] : [];
        };
        const coerceColdStartObjectArray = (value) => {
            if (value == null) return [];
            if (Array.isArray(value)) return value.flatMap(coerceColdStartObjectArray);
            if (!isColdStartPlainObject(value)) return [];
            const knownShape = [
                'name', 'details', 'summary', 'status', 'pair', 'entityA', 'entityB',
                'character', 'entity', 'role', 'appearance', 'personality', 'background'
            ].some(key => Object.prototype.hasOwnProperty.call(value, key));
            if (knownShape) return [value];
            return Object.entries(value)
                .map(([key, entry]) => {
                    if (isColdStartPlainObject(entry)) return { name: entry.name || key, ...entry };
                    const details = String(entry || '').trim();
                    return details ? { name: key, details } : null;
                })
                .filter(Boolean);
        };
        const compactTextArray = (items, maxItems = 6, maxItemChars = 240) => {
            return dedupeTextArray(coerceColdStartTextArray(items))
                .slice(0, maxItems)
                .map(item => truncateForLLM(item, maxItemChars, ' ...[TRUNCATED]... '));
        };

        const normalizeColdStart01 = (value, fallback = 0) => {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, Number(fallback || 0)));
            return Math.max(0, Math.min(1, numeric));
        };
        const compactColdStartText = (value = '', maxChars = 240) => {
            if (value == null) return '';
            if (Array.isArray(value)) {
                return compactTextArray(value.map(item => compactColdStartText(item, maxChars)).filter(Boolean), 6, maxChars).join('; ');
            }
            if (isColdStartPlainObject(value)) {
                const commonParts = [
                    value.summary, value.details, value.status, value.text, value.value, value.description, value.label, value.name,
                    ...(Array.isArray(value.features) ? value.features : []),
                    ...(Array.isArray(value.traits) ? value.traits : []),
                    ...(Array.isArray(value.history) ? value.history : []),
                    ...(Array.isArray(value.notes) ? value.notes : [])
                ].map(item => String(item || '').trim()).filter(Boolean);
                return compactColdStartText(
                    commonParts.join('; '),
                    maxChars
                );
            }
            return truncateForLLM(String(value || '').replace(/\s+/g, ' ').trim(), maxChars, ' ...[TRUNCATED]... ');
        };
        const compactColdStartList = (value, maxItems = 6, maxItemChars = 160) => {
            const out = [];
            const visit = (item) => {
                if (item == null || item === '') return;
                if (Array.isArray(item)) {
                    item.forEach(visit);
                    return;
                }
                if (isColdStartPlainObject(item)) {
                    const text = compactColdStartText(item, maxItemChars);
                    if (text) out.push(text);
                    return;
                }
                const raw = String(item || '').replace(/\s+/g, ' ').trim();
                if (!raw) return;
                const parts = raw.length <= maxItemChars && /[;,|]/.test(raw)
                    ? normalizeDelimitedList(raw)
                    : [raw];
                out.push(...(parts.length > 0 ? parts : [raw]));
            };
            visit(value);
            return dedupeTextArray(out.map(item => truncateForLLM(item, maxItemChars, ' ...[TRUNCATED]... ')).filter(Boolean)).slice(0, maxItems);
        };
        const compactColdStartObject = (value) => isColdStartPlainObject(value) ? value : {};
        const pickColdStartObject = (...values) => {
            for (const value of values) {
                if (isColdStartPlainObject(value) && Object.keys(value).length > 0) return value;
            }
            return {};
        };
        const compactColdStartEvidence = (value, options = {}) => {
            const source = Array.isArray(value) ? value : (value ? [value] : []);
            const out = [];
            const fallbackSnippet = compactColdStartText(options.fallbackSnippet || '', 220);
            for (const item of source) {
                if (item == null || item === '') continue;
                if (typeof item === 'string') {
                    out.push({
                        sourceKind: options.sourceKind || 'cold_start',
                        turn: Math.max(0, Number(options.turn || 0) || 0),
                        messageId: '',
                        snippet: compactColdStartText(item, 220),
                        confidence: normalizeColdStart01(options.confidence, 0.65)
                    });
                    continue;
                }
                if (isColdStartPlainObject(item)) {
                    out.push({
                        sourceKind: compactColdStartText(item.sourceKind || item.source_kind || item.kind || item.source || options.sourceKind || 'cold_start', 64),
                        turn: Math.max(0, Number(item.turn ?? item.sourceTurn ?? item.turnNumber ?? options.turn ?? 0) || 0),
                        messageId: compactColdStartText(item.messageId || item.m_id || item.sourceMessageId || '', 96),
                        snippet: compactColdStartText(item.snippet || item.quote || item.text || item.summary || item.evidence || fallbackSnippet, 220),
                        confidence: normalizeColdStart01(item.confidence, options.confidence ?? 0.65)
                    });
                }
            }
            if (out.length === 0 && fallbackSnippet) {
                out.push({
                    sourceKind: options.sourceKind || 'cold_start',
                    turn: Math.max(0, Number(options.turn || 0) || 0),
                    messageId: '',
                    snippet: fallbackSnippet,
                    confidence: normalizeColdStart01(options.confidence, 0.55)
                });
            }
            const seen = new Set();
            return out.filter(item => {
                if (!item.snippet && !item.sourceKind && !item.turn && !item.messageId) return false;
                const key = `${item.sourceKind}|${item.turn}|${item.messageId}|${item.snippet}`.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).slice(0, Math.max(1, Number(options.limit || 8) || 8));
        };
        const compactColdStartThreads = (value, maxItems = 6) => {
            const source = [];
            const visit = (item) => {
                if (item == null || item === '') return;
                if (Array.isArray(item)) {
                    item.forEach(visit);
                    return;
                }
                source.push(item);
            };
            visit(value);
            return source.map(item => {
                if (typeof item === 'string') {
                    const label = compactColdStartText(item, 180);
                    return label ? { label, status: 'active', pressure: 0 } : null;
                }
                if (!isColdStartPlainObject(item)) return null;
                const label = compactColdStartText(item.label || item.summary || item.text || item.name || '', 180);
                if (!label) return null;
                return {
                    label,
                    status: compactColdStartText(item.status || 'active', 48) || 'active',
                    pressure: normalizeColdStart01(item.pressure, 0)
                };
            }).filter(Boolean).slice(0, maxItems);
        };
        const compactColdStartEpisodes = (value, options = {}) => {
            const source = Array.isArray(value) ? value : (value ? [value] : []);
            const out = source.map(item => {
                if (typeof item === 'string') {
                    const summary = compactColdStartText(item, 220);
                    return summary ? { turn: Math.max(0, Number(options.turn || 0) || 0), summary, impact: '', stability: 'current_state' } : null;
                }
                if (!isColdStartPlainObject(item)) return null;
                const summary = compactColdStartText(item.summary || item.event || item.text || item.brief || '', 220);
                if (!summary) return null;
                return {
                    turn: Math.max(0, Number(item.turn ?? item.sourceTurn ?? item.turnNumber ?? options.turn ?? 0) || 0),
                    summary,
                    impact: compactColdStartText(item.impact || item.effect || '', 180),
                    stability: compactColdStartText(item.stability || item.scope || 'current_state', 64) || 'current_state'
                };
            }).filter(Boolean);
            return out.slice(0, Math.max(1, Number(options.limit || 8) || 8));
        };
        const compactColdStartEntityExtension = (entity = {}) => {
            const storedExtension = compactColdStartObject(entity.extension);
            const identity = pickColdStartObject(entity.identity, storedExtension.identity);
            const profile = pickColdStartObject(entity.profile, storedExtension.profile);
            const profileAppearance = compactColdStartObject(profile.appearance);
            const profilePersonality = compactColdStartObject(profile.personality || entity.profilePersonality);
            const profileSpeech = compactColdStartObject(profile.speechStyle || entity.speechStyle);
            const profilePsychology = compactColdStartObject(profile.psychology || entity.psychology);
            const currentState = pickColdStartObject(entity.currentState, entity.current_state, storedExtension.currentState);
            const continuity = pickColdStartObject(entity.continuity, storedExtension.continuity);
            const povKnowledge = pickColdStartObject(entity.povKnowledge, entity.pov_knowledge, entity.knowledge, storedExtension.povKnowledge);
            const quality = pickColdStartObject(entity.quality, storedExtension.quality);
            const evidence = compactColdStartEvidence(entity.evidence || entity.evidenceItems || entity.sourceEvidence || storedExtension.evidence || [], {
                fallbackSnippet: entity.details || entity.background || entity.personality || entity.appearance,
                sourceKind: 'cold_start',
                confidence: quality.confidence ?? 0.65,
                limit: 6
            });
            return {
                identity: {
                    age: identity.age ?? entity.age ?? '',
                    occupation: compactColdStartText(identity.occupation || entity.occupation || '', 120),
                    affiliation: compactColdStartText(identity.affiliation || identity.organization || entity.affiliation || '', 120),
                    roleInStory: compactColdStartText(identity.roleInStory || identity.role || entity.roleInStory || entity.role || '', 160),
                    summary: compactColdStartText(identity.summary || entity.identitySummary || entity.summary || '', 220),
                    aliases: compactColdStartList(identity.aliases || entity.aliases || [], 10, 100),
                    honorifics: compactColdStartList(identity.honorifics || entity.honorifics || [], 8, 80)
                },
                profile: {
                    appearance: {
                        features: compactColdStartList(profileAppearance.features || entity.appearance, 8, 140),
                        distinctiveMarks: compactColdStartList(profileAppearance.distinctiveMarks || profileAppearance.distinctive_marks || [], 6, 140),
                        clothing: compactColdStartList(profileAppearance.clothing || [], 6, 140),
                        confidence: normalizeColdStart01(profileAppearance.confidence, evidence.length ? 0.65 : 0)
                    },
                    personality: {
                        traits: compactColdStartList(profilePersonality.traits || entity.personality || entity.details, 10, 150),
                        values: compactColdStartList(profilePersonality.values || [], 8, 150),
                        fears: compactColdStartList(profilePersonality.fears || [], 8, 150),
                        likes: compactColdStartList(profilePersonality.likes || [], 8, 150),
                        dislikes: compactColdStartList(profilePersonality.dislikes || [], 8, 150),
                        boundaries: compactColdStartList(profilePersonality.boundaries || [], 8, 150),
                        confidence: normalizeColdStart01(profilePersonality.confidence, evidence.length ? 0.6 : 0)
                    },
                    speechStyle: {
                        defaultTone: compactColdStartText(profileSpeech.defaultTone || profileSpeech.tone || entity.speechStyle || '', 120),
                        honorificStyle: compactColdStartText(profileSpeech.honorificStyle || profileSpeech.honorifics || '', 120),
                        pressureMarkers: compactColdStartList(profileSpeech.pressureMarkers || profileSpeech.pressure_markers || [], 8, 100),
                        catchphrases: compactColdStartList(profileSpeech.catchphrases || profileSpeech.verbalTics || [], 8, 100),
                        notes: compactColdStartList(profileSpeech.notes || [], 8, 140)
                    },
                    psychology: {
                        baseline: compactColdStartText(profilePsychology.baseline || profilePsychology.defaultState || profilePsychology.default_state || profilePsychology.core || entity.psychology || entity.psyche || '', 200),
                        currentConflict: compactColdStartText(profilePsychology.currentConflict || profilePsychology.current_conflict || profilePsychology.innerConflict || profilePsychology.inner_conflict || profilePsychology.internalConflict || profilePsychology.internal_conflict || profilePsychology.conflict || entity.currentConflict || entity.current_conflict || entity.innerConflict || entity.inner_conflict || entity.internalConflict || entity.internal_conflict || entity.conflict || '', 200),
                        copingStyle: compactColdStartText(profilePsychology.copingStyle || profilePsychology.coping_style || profilePsychology.coping || entity.copingStyle || entity.coping_style || entity.coping || '', 160),
                        notes: compactColdStartList([profilePsychology.notes, profilePsychology.cues, profilePsychology.signals, entity.psychologicalNotes, entity.psychological_notes, entity.mentalNotes, entity.mental_notes], 8, 150)
                    }
                },
                currentState: {
                    summary: compactColdStartText(currentState.summary || currentState.current_state || entity.currentState || entity.current_state || '', 220),
                    sceneTime: compactColdStartText(currentState.sceneTime || currentState.scene_time || '', 80),
                    location: '',
                    physicalState: compactColdStartList(currentState.physicalState || currentState.physical_state || [], 8, 140),
                    emotionalState: compactColdStartList(currentState.emotionalState || currentState.emotional_state || [], 8, 140),
                    cognitiveFocus: compactColdStartList(currentState.cognitiveFocus || currentState.cognitive_focus || [], 8, 150),
                    immediateGoal: compactColdStartText(currentState.immediateGoal || currentState.immediate_goal || '', 180),
                    activeProblems: compactColdStartList(currentState.activeProblems || currentState.active_problems || [], 8, 150)
                },
                continuity: {
                    openThreads: compactColdStartThreads([continuity.openThreads, continuity.open_threads, continuity.activeThreads, continuity.active_threads, continuity.threads, continuity.unresolvedThreads, continuity.unresolved_threads, continuity.openLoops, continuity.open_loops, continuity.openHooks, continuity.open_hooks, continuity.plotHooks, continuity.plot_hooks, continuity.looseEnds, continuity.loose_ends, continuity.pendingQuestions, continuity.pending_questions, continuity.unresolved], 6),
                    unresolvedNeeds: compactColdStartList([continuity.unresolvedNeeds, continuity.unresolved_needs, continuity.needs, continuity.pendingNeeds, continuity.pending_needs], 8, 150),
                    commitments: compactColdStartList([continuity.commitments, continuity.promises, continuity.obligations], 8, 150),
                    nextActionHints: compactColdStartList([continuity.nextActionHints, continuity.next_action_hints, continuity.next_actions, continuity.nextActions, continuity.nextSteps, continuity.next_steps, continuity.plannedNextSteps, continuity.planned_next_steps], 8, 150)
                },
                povKnowledge: {
                    knownToSelf: compactColdStartList(povKnowledge.knownToSelf || povKnowledge.known_to_self || [], 8, 150),
                    unknownToSelf: compactColdStartList(povKnowledge.unknownToSelf || povKnowledge.unknown_to_self || [], 8, 150),
                    knownToOthers: compactColdStartList(povKnowledge.knownToOthers || povKnowledge.known_to_others || [], 8, 150),
                    visibleTo: compactColdStartList(povKnowledge.visibleTo || povKnowledge.visible_to || [], 8, 100),
                    privateExperiences: compactColdStartList(povKnowledge.privateExperiences || povKnowledge.private_experiences || [], 8, 150),
                    privacy: compactColdStartText(povKnowledge.privacy || povKnowledge.privacyLevel || '', 80)
                },
                episodeLedger: compactColdStartEpisodes(entity.episodeLedger || entity.episode_ledger || entity.events || storedExtension.episodeLedger || [], { limit: 8 }),
                evidence,
                quality: {
                    confidence: normalizeColdStart01(quality.confidence, evidence.length ? 0.65 : 0),
                    salience: normalizeColdStart01(quality.salience, 0),
                    importance: normalizeColdStart01(quality.importance, 0),
                    pressure: normalizeColdStart01(quality.pressure, 0),
                    needsReview: !!quality.needsReview
                }
            };
        };
        const compactColdStartRelationExtension = (relation = {}) => {
            const storedExtension = compactColdStartObject(relation.extension);
            const currentStatus = pickColdStartObject(relation.currentStatus, relation.current_state, relation.status, storedExtension.currentStatus);
            const metrics = pickColdStartObject(relation.metrics, storedExtension.metrics);
            const dynamics = pickColdStartObject(relation.dynamics, storedExtension.dynamics);
            const rawDynamicsItems = isColdStartPlainObject(relation.dynamics) ? [] : relation.dynamics;
            const sharedContext = pickColdStartObject(relation.sharedContext, relation.shared_context, storedExtension.sharedContext);
            const quality = pickColdStartObject(relation.quality, storedExtension.quality);
            const evidence = compactColdStartEvidence(relation.evidence || relation.evidenceItems || storedExtension.evidence || [], {
                fallbackSnippet: relation.status || relation.sentiment || relation.type,
                sourceKind: 'cold_start_relation',
                confidence: quality.confidence ?? 0.65,
                limit: 6
            });
            return {
                currentStatus: {
                    summary: compactColdStartText(currentStatus.summary || relation.status || relation.sentiment || relation.type || '', 200),
                    publicLayer: compactColdStartText(currentStatus.publicLayer || currentStatus.public_layer || '', 150),
                    privateLayer: compactColdStartText(currentStatus.privateLayer || currentStatus.private_layer || '', 160),
                    boundaryState: compactColdStartText(currentStatus.boundaryState || currentStatus.boundary_state || '', 120)
                },
                metrics: {
                    closeness: Number.isFinite(Number(metrics.closeness)) ? normalizeColdStart01(metrics.closeness, 0) : undefined,
                    trust: Number.isFinite(Number(metrics.trust)) ? normalizeColdStart01(metrics.trust, 0) : undefined,
                    tension: Number.isFinite(Number(metrics.tension ?? metrics.currentTension)) ? normalizeColdStart01(metrics.tension ?? metrics.currentTension, 0) : undefined,
                    risk: Number.isFinite(Number(metrics.risk)) ? normalizeColdStart01(metrics.risk, 0) : undefined,
                    ambiguity: Number.isFinite(Number(metrics.ambiguity)) ? normalizeColdStart01(metrics.ambiguity, 0) : undefined,
                    pressure: Number.isFinite(Number(metrics.pressure)) ? normalizeColdStart01(metrics.pressure, 0) : undefined
                },
                dynamics: {
                    fromAtoB: compactColdStartList([dynamics.fromAtoB, dynamics.from_a_to_b, relation.sentiment], 8, 150),
                    fromBtoA: compactColdStartList([dynamics.fromBtoA, dynamics.from_b_to_a], 8, 150),
                    unresolvedIssues: compactColdStartList([
                        dynamics.unresolvedIssues,
                        dynamics.unresolved_issues,
                        dynamics.openIssues,
                        dynamics.open_issues,
                        dynamics.pendingIssues,
                        dynamics.pending_issues,
                        dynamics.issues,
                        dynamics.unresolved,
                        dynamics.pendingQuestions,
                        dynamics.pending_questions,
                        relation.unresolvedIssues,
                        relation.unresolved_issues,
                        relation.openIssues,
                        relation.open_issues,
                        relation.pendingIssues,
                        relation.pending_issues,
                        relation.issues,
                        relation.unresolved
                    ], 8, 150),
                    recentChanges: compactColdStartList([
                        dynamics.recentChanges,
                        dynamics.recent_changes,
                        dynamics.changes,
                        dynamics.relationshipChanges,
                        dynamics.relationship_changes,
                        dynamics.relationshipDeltas,
                        dynamics.relationship_deltas,
                        relation.recentChanges,
                        relation.recent_changes,
                        relation.changes,
                        relation.relationshipChanges,
                        relation.relationship_changes,
                        relation.relationshipDeltas,
                        relation.relationship_deltas,
                        rawDynamicsItems,
                        relation.event,
                        relation.summary || relation.status
                    ], 8, 150)
                },
                sharedContext: {
                    location: compactColdStartText(sharedContext.location || '', 140),
                    workplace: compactColdStartText(sharedContext.workplace || '', 140),
                    privateThreads: compactColdStartList(sharedContext.privateThreads || sharedContext.private_threads || [], 8, 120),
                    notes: compactColdStartList(sharedContext.notes || [], 8, 150)
                },
                eventLedger: compactColdStartEpisodes(relation.eventLedger || relation.event_ledger || relation.events || storedExtension.eventLedger || [], { limit: 8 }),
                evidence,
                quality: {
                    confidence: normalizeColdStart01(quality.confidence, evidence.length ? 0.65 : 0),
                    salience: normalizeColdStart01(quality.salience, 0),
                    importance: normalizeColdStart01(quality.importance, 0),
                    pressure: normalizeColdStart01(quality.pressure, 0)
                }
            };
        };

        const normalizeColdStartChunkSummary = (summary = {}) => {
            const source = isColdStartPlainObject(summary) ? summary : {};
            const characters = coerceColdStartObjectArray(source.characters || source.entities || source.people)
                .map(ch => ({
                    name: compactColdStartText(ch?.name || ch?.character || ch?.entity || ch?.id || '', 80),
                    details: compactColdStartText(ch?.details || ch?.summary || ch?.description || ch?.appearance || ch?.personality || ch?.background || '', 420),
                    role: compactColdStartText(ch?.role || ch?.roleInStory || ch?.occupation || '', 160),
                    currentState: compactColdStartText(ch?.currentState || ch?.current_state || ch?.status || ch?.location || '', 240),
                    speechStyle: compactColdStartText(ch?.speechStyle || ch?.speech_style || '', 180),
                    psychology: compactColdStartText(ch?.psychology || ch?.currentConflict || ch?.motivation || '', 220),
                    evidence: compactColdStartList(ch?.evidence || ch?.evidenceItems || ch?.evidence_items || [], 4, 140)
                }))
                .filter(ch => ch.name || ch.details || ch.currentState);
            const relationships = coerceColdStartObjectArray(source.relationships || source.relations)
                .map(rel => {
                    const pair = Array.isArray(rel?.pair)
                        ? rel.pair
                        : [rel?.entityA || rel?.from || rel?.a || rel?.source, rel?.entityB || rel?.to || rel?.b || rel?.target];
                    const relDynamics = isColdStartPlainObject(rel?.dynamics) ? rel.dynamics : {};
                    const rawDynamics = isColdStartPlainObject(rel?.dynamics) ? [] : rel?.dynamics;
                    const statusText = compactColdStartText(rel?.status || rel?.type || rel?.sentiment || rel?.summary || rel?.details || '', 260);
                    const recentChanges = compactColdStartList([rawDynamics, relDynamics.recentChanges, relDynamics.recent_changes, relDynamics.changes, rel?.recentChanges, rel?.recent_changes, rel?.changes, statusText], 4, 150);
                    const unresolvedIssues = compactColdStartList([relDynamics.unresolvedIssues, relDynamics.unresolved_issues, relDynamics.openIssues, relDynamics.open_issues, rel?.unresolvedIssues, rel?.unresolved_issues, rel?.openIssues, rel?.open_issues, rel?.issues, rel?.unresolved], 4, 150);
                    return {
                        pair: pair.map(name => compactColdStartText(name || '', 80)).filter(Boolean).slice(0, 2),
                        status: statusText,
                        dynamics: recentChanges,
                        recent_changes: recentChanges,
                        unresolved_issues: unresolvedIssues,
                        evidence: compactColdStartList(rel?.evidence || rel?.evidenceItems || rel?.evidence_items || [], 4, 140)
                    };
                })
                .filter(rel => rel.pair.length === 2 || rel.status);
            return {
                events: compactTextArray(source.events || source.event || source.summary || source.narrative || source.keyPoints || source.memory_seeds, 10, 260),
                characters,
                relationships,
                world_rules: compactTextArray(source.world_rules || source.worldRules || source.rules || source.world?.rules || source.world?.custom, 12, 240),
                memory_seeds: Array.isArray(source.memory_seeds) ? source.memory_seeds.slice(-8) : []
            };
        };

        const compactChunkSummary = (summary) => {
            const normalized = normalizeColdStartChunkSummary(summary);
            return {
                events: compactTextArray(normalized.events, 6, 220),
                characters: normalized.characters
                    .slice(0, 8)
                    .map(ch => ({
                        name: truncateForLLM(ch?.name || '', 80, ' ... '),
                        details: truncateForLLM(ch?.details || '', 420, ' ...[TRUNCATED]... '),
                        role: truncateForLLM(ch?.role || ch?.roleInStory || '', 160, ' ...[TRUNCATED]... '),
                        currentState: truncateForLLM(ch?.currentState || ch?.current_state || '', 240, ' ...[TRUNCATED]... '),
                        speechStyle: truncateForLLM(ch?.speechStyle || ch?.speech_style || '', 180, ' ...[TRUNCATED]... '),
                        psychology: truncateForLLM(ch?.psychology || ch?.currentConflict || '', 220, ' ...[TRUNCATED]... '),
                        evidence: compactColdStartList(ch?.evidence || ch?.evidenceItems || [], 3, 140)
                    }))
                    .filter(ch => ch.name || ch.details),
                relationships: normalized.relationships
                    .slice(0, 8)
                    .map(rel => ({
                        pair: Array.isArray(rel?.pair) ? rel.pair.slice(0, 2).map(name => truncateForLLM(name || '', 80, ' ... ')) : [],
                        status: truncateForLLM(rel?.status || '', 260, ' ...[TRUNCATED]... '),
                        dynamics: compactColdStartList([rel?.dynamics, rel?.recent_changes, rel?.recentChanges], 4, 150),
                        recent_changes: compactColdStartList([rel?.recent_changes, rel?.recentChanges, rel?.dynamics], 4, 150),
                        unresolved_issues: compactColdStartList([rel?.unresolved_issues, rel?.unresolvedIssues], 4, 150),
                        evidence: compactColdStartList(rel?.evidence || rel?.evidenceItems || [], 3, 140)
                    }))
                    .filter(rel => rel.pair.length === 2 || rel.status),
                world_rules: compactTextArray(normalized.world_rules, 8, 220)
            };
        };

