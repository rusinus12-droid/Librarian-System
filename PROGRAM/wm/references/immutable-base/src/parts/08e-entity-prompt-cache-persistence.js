        const formatEntityForPrompt = (entity, options = {}) => {
            const sourceEntity = typeof entity === 'string'
                ? (entityCache.get(resolveCanonicalName(entity)) || entityCache.get(entity) || { name: entity })
                : entity;
            const safeEntity = sourceEntity && typeof sourceEntity === 'object' ? sourceEntity : {};
            if (!options.includeAbsorptionPending && !isPromptVisibleEntityRecord(safeEntity)) return '';
            const appearance = (safeEntity.appearance && typeof safeEntity.appearance === 'object') ? safeEntity.appearance : {};
            const personality = (safeEntity.personality && typeof safeEntity.personality === 'object') ? safeEntity.personality : {};
            const speechStyle = (safeEntity.speechStyle && typeof safeEntity.speechStyle === 'object') ? safeEntity.speechStyle : {};
            const background = (safeEntity.background && typeof safeEntity.background === 'object') ? safeEntity.background : {};
            const status = (safeEntity.status && typeof safeEntity.status === 'object') ? safeEntity.status : {};
            const identity = (safeEntity.identity && typeof safeEntity.identity === 'object') ? safeEntity.identity : {};
            const profile = (safeEntity.profile && typeof safeEntity.profile === 'object') ? safeEntity.profile : {};
            const currentState = (safeEntity.currentState && typeof safeEntity.currentState === 'object') ? safeEntity.currentState : {};
            const continuity = (safeEntity.continuity && typeof safeEntity.continuity === 'object') ? safeEntity.continuity : {};
            const povKnowledge = (safeEntity.povKnowledge && typeof safeEntity.povKnowledge === 'object') ? safeEntity.povKnowledge : {};
            const quality = (safeEntity.quality && typeof safeEntity.quality === 'object') ? safeEntity.quality : {};
            let timeProjection = null;
            try {
                timeProjection = TimeEngine.getProjection(safeEntity?.name || '', safeEntity) || null;
            } catch (_) {
                timeProjection = null;
            }
            const features = Array.isArray(appearance.features) ? appearance.features : [];
            const distinctiveMarks = Array.isArray(appearance.distinctiveMarks) ? appearance.distinctiveMarks : [];
            const traits = Array.isArray(personality.traits) ? personality.traits : [];
            const likes = Array.isArray(personality.likes) ? personality.likes : [];
            const dislikes = Array.isArray(personality.dislikes) ? personality.dislikes : [];
            const sexualPreferences = Array.isArray(personality.sexualPreferences) ? personality.sexualPreferences : [];
            const speechNotes = Array.isArray(speechStyle.notes) ? speechStyle.notes : [];
            const parts = [];
            parts.push(`【${safeEntity.name || '?'}】`);
            const sex = normalizeBiologicalSex(safeEntity.sex || safeEntity.biologicalSex || '');
            if (sex) parts.push(`  생물학적 성별/Biological Sex: ${sex}`);
            if (features.length > 0 || distinctiveMarks.length > 0) {
                parts.push(`  외모/Appearance: ${[...features, ...distinctiveMarks].join(', ')}`);
            }
            const visualPromptBlock = formatVisualCanonForPrompt(safeEntity);
            if (visualPromptBlock) {
                parts.push(`  시각 정본/Visual Canon:
${visualPromptBlock.split('\n').map(line => `    ${line}`).join('\n')}`);
            }
            if (traits.length > 0) parts.push(`  성격/Personality: ${traits.join(', ')}`);
            if (personality.sexualOrientation) parts.push(`  성관념/Sexual Attitude: ${personality.sexualOrientation}`);
            if (sexualPreferences.length > 0) parts.push(`  성적취향/Sexual Preferences: ${sexualPreferences.join(', ')}`);
            if (speechStyle.defaultTone) parts.push(`  말투 기본/Speech Tone: ${speechStyle.defaultTone}`);
            if (speechStyle.honorificStyle) parts.push(`  높임말 경향/Honorific Style: ${speechStyle.honorificStyle}`);
            if (speechStyle.toSuperiors) parts.push(`  윗사람에게/To Superiors: ${speechStyle.toSuperiors}`);
            if (speechStyle.toSubordinates) parts.push(`  아랫사람에게/To Subordinates: ${speechStyle.toSubordinates}`);
            if (speechStyle.toPeers) parts.push(`  동급·친구에게/To Peers: ${speechStyle.toPeers}`);
            if (speechStyle.toYounger) parts.push(`  동생·연하에게/To Younger: ${speechStyle.toYounger}`);
            if (speechNotes.length > 0) parts.push(`  말버릇/Speech Notes: ${speechNotes.join(', ')}`);
            if (likes.length > 0) parts.push(`  좋아하는 것/Likes: ${likes.join(', ')}`);
            if (dislikes.length > 0) parts.push(`  싫어하는 것/Dislikes: ${dislikes.join(', ')}`);
            if (background.origin) parts.push(`  출신/Origin: ${background.origin}`);
            if (background.occupation) parts.push(`  직업/Occupation: ${background.occupation}`);
            if (status.currentMood) parts.push(`  현재 기분/Current Mood: ${status.currentMood}`);
            if (status.currentLocation) parts.push(`  현재 위치/Current Location: ${status.currentLocation}`);
            const currentDate = String(timeProjection?.currentDate || status.currentDate || '').trim();
            const currentTime = String(timeProjection?.currentTime || status.currentTime || '').trim();
            if (currentDate || currentTime) parts.push(`  장면 시각/Scene Time: ${[currentDate, currentTime].filter(Boolean).join(' ')}`);
            const lastInteractionDate = String(timeProjection?.lastInteractionDate || '').trim();
            const lastInteractionTime = String(timeProjection?.lastInteractionTime || '').trim();
            if (lastInteractionDate || lastInteractionTime) parts.push(`  최근 상호작용 시각/Last Interaction Time: ${[lastInteractionDate, lastInteractionTime].filter(Boolean).join(' ')}`);
            if (status.healthStatus) parts.push(`  건강 상태/Health Status: ${status.healthStatus}`);
            if (status.notes) parts.push(`  상태 메모/Status Notes: ${status.notes}`);
            const identityFacts = [
                identity.age ? `age=${identity.age}` : '',
                identity.occupation ? `occupation=${identity.occupation}` : '',
                identity.affiliation ? `affiliation=${identity.affiliation}` : '',
                identity.roleInStory ? `role=${identity.roleInStory}` : '',
                identity.summary ? `identity=${identity.summary}` : ''
            ].filter(Boolean);
            if (identityFacts.length > 0) parts.push(`  정체성/Identity: ${identityFacts.join(' | ')}`);
            const profilePersonality = profile.personality && typeof profile.personality === 'object' ? profile.personality : {};
            const profileSpeech = profile.speechStyle && typeof profile.speechStyle === 'object' ? profile.speechStyle : {};
            const profilePsychology = profile.psychology && typeof profile.psychology === 'object' ? profile.psychology : {};
            const vulnerabilities = Array.isArray(profilePersonality.vulnerabilities) ? profilePersonality.vulnerabilities : [];
            const boundaries = Array.isArray(profilePersonality.boundaries) ? profilePersonality.boundaries : [];
            if (profilePersonality.workStyle || profilePersonality.socialStyle || vulnerabilities.length > 0 || boundaries.length > 0) {
                parts.push(`  인물 프로필/Profile: ${[
                    profilePersonality.workStyle ? `work=${profilePersonality.workStyle}` : '',
                    profilePersonality.socialStyle ? `social=${profilePersonality.socialStyle}` : '',
                    vulnerabilities.length ? `vulnerabilities=${vulnerabilities.join(', ')}` : '',
                    boundaries.length ? `boundaries=${boundaries.join(', ')}` : ''
                ].filter(Boolean).join(' | ')}`);
            }
            if (Array.isArray(profileSpeech.pressureMarkers) && profileSpeech.pressureMarkers.length > 0) parts.push(`  압박 말버릇/Pressure Markers: ${profileSpeech.pressureMarkers.join(', ')}`);
            if (profileSpeech.intimacyShift) parts.push(`  친밀도별 말투 변화/Intimacy Speech Shift: ${profileSpeech.intimacyShift}`);
            const psychologyNotes = Array.isArray(profilePsychology.notes) ? profilePsychology.notes : [];
            if (profilePsychology.baseline || profilePsychology.currentConflict || profilePsychology.copingStyle || psychologyNotes.length) {
                parts.push(`  심리/Psychology: ${[
                    profilePsychology.baseline ? `baseline=${profilePsychology.baseline}` : '',
                    profilePsychology.currentConflict ? `conflict=${profilePsychology.currentConflict}` : '',
                    profilePsychology.copingStyle ? `coping=${profilePsychology.copingStyle}` : '',
                    psychologyNotes.length ? `notes=${psychologyNotes.slice(-3).join(', ')}` : ''
                ].filter(Boolean).join(' | ')}`);
            }
            const currentStateFacts = [
                currentState.summary ? `state=${currentState.summary}` : '',
                currentState.location ? `location=${currentState.location}` : '',
                Array.isArray(currentState.physicalState) && currentState.physicalState.length ? `physical=${currentState.physicalState.join(', ')}` : '',
                Array.isArray(currentState.emotionalState) && currentState.emotionalState.length ? `emotion=${currentState.emotionalState.join(', ')}` : '',
                Array.isArray(currentState.cognitiveFocus) && currentState.cognitiveFocus.length ? `focus=${currentState.cognitiveFocus.join(', ')}` : '',
                currentState.activity ? `activity=${currentState.activity}` : '',
                currentState.immediateGoal ? `goal=${currentState.immediateGoal}` : ''
            ].filter(Boolean);
            if (currentStateFacts.length > 0) parts.push(`  현재 상태판/Current State: ${currentStateFacts.join(' | ')}`);
            const stateTimeline = Array.isArray(safeEntity.stateTimeline) ? safeEntity.stateTimeline : [];
            if (stateTimeline.length > 0) {
                const stateLines = stateTimeline.slice(-3)
                    .map(item => item?.summary ? `T${Number(item.turn || 0) || '?'}:${item.summary}` : '')
                    .filter(Boolean);
                if (stateLines.length > 0) parts.push(`  최근 상태 로그/Recent State Log: ${stateLines.join(' / ')}`);
            }
            const threads = Array.isArray(continuity.openThreads) ? continuity.openThreads : [];
            if (threads.length > 0) parts.push(`  열린 인물 스레드/Open Threads: ${threads.slice(-4).map(thread => `${thread.label}${thread.status ? `(${thread.status})` : ''}`).join(' / ')}`);
            const nextHints = Array.isArray(continuity.nextActionHints) ? continuity.nextActionHints : [];
            if (nextHints.length > 0) parts.push(`  다음 행동 힌트/Next Hints: ${nextHints.slice(-4).join(' / ')}`);
            const unknownToSelf = Array.isArray(povKnowledge.unknownToSelf) ? povKnowledge.unknownToSelf : [];
            const knownToSelf = Array.isArray(povKnowledge.knownToSelf) ? povKnowledge.knownToSelf : [];
            if (knownToSelf.length > 0 || unknownToSelf.length > 0) {
                parts.push(`  POV 지식/POV Knowledge: ${[
                    knownToSelf.length ? `knows=${knownToSelf.slice(-4).join(', ')}` : '',
                    unknownToSelf.length ? `unknown=${unknownToSelf.slice(-4).join(', ')}` : ''
                ].filter(Boolean).join(' | ')}`);
            }
            const ledger = Array.isArray(safeEntity.episodeLedger) ? safeEntity.episodeLedger : [];
            if (ledger.length > 0) parts.push(`  최근 사건 장부/Recent Entity Events: ${ledger.slice(-3).map(event => event.summary).filter(Boolean).join(' / ')}`);
            const evidence = Array.isArray(safeEntity.evidence) ? safeEntity.evidence : [];
            if (evidence.length > 0) {
                const evidenceTurns = dedupeTextArray(evidence.map(item => item.turn ? `T${item.turn}` : item.sourceKind).filter(Boolean)).slice(-5);
                if (evidenceTurns.length > 0) parts.push(`  근거/Evidence: ${evidenceTurns.join(', ')}${quality.confidence ? ` | conf=${Number(quality.confidence).toFixed(2)}` : ''}`);
            }
            const output = parts.join('\n');
            return options?.viewerId
                ? SecretKnowledgeCore.redactForViewer(output, options.viewerId)
                : output;
        };

        const formatRelationForPrompt = (relation) => {
            const safeRelation = relation && typeof relation === 'object' ? relation : {};
            const details = safeRelation.details && typeof safeRelation.details === 'object' ? safeRelation.details : {};
            const sentiments = safeRelation.sentiments && typeof safeRelation.sentiments === 'object' ? safeRelation.sentiments : {};
            const currentStatus = safeRelation.currentStatus && typeof safeRelation.currentStatus === 'object' ? safeRelation.currentStatus : {};
            const metrics = safeRelation.metrics && typeof safeRelation.metrics === 'object' ? safeRelation.metrics : {};
            const dynamics = safeRelation.dynamics && typeof safeRelation.dynamics === 'object' ? safeRelation.dynamics : {};
            const relationState = safeRelation.state && typeof safeRelation.state === 'object' ? safeRelation.state : {};
            const relationAxes = safeRelation.axes && typeof safeRelation.axes === 'object' ? safeRelation.axes : {};
            const sharedContext = safeRelation.sharedContext && typeof safeRelation.sharedContext === 'object' ? safeRelation.sharedContext : {};
            const assessment = safeRelation.relationshipAssessment && typeof safeRelation.relationshipAssessment === 'object' ? safeRelation.relationshipAssessment : {};
            const parts = [];
            parts.push(`【${safeRelation.entityA || '?'} ↔ ${safeRelation.entityB || '?'}】`);
            if (safeRelation.relationType) parts.push(`  관계/Relation: ${safeRelation.relationType}`);
            if (assessment.label || Number.isFinite(Number(assessment.definitionConfidence))) {
                const confidence = normalizeNullableRelationScore(assessment.definitionConfidence);
                parts.push(`  관계 정의도/Definition: ${assessment.label || '관찰 중'}${confidence != null ? ` (${Math.round(confidence * 100)}%)` : ''}`);
                if (assessment.note) parts.push(`  정의 메모/Definition Note: ${assessment.note}`);
            }
            if (currentStatus.summary || currentStatus.publicLayer || currentStatus.privateLayer || currentStatus.boundaryState) {
                parts.push(`  관계 상태판/Relation State: ${[
                    currentStatus.summary ? `state=${currentStatus.summary}` : '',
                    currentStatus.publicLayer ? `public=${currentStatus.publicLayer}` : '',
                    currentStatus.privateLayer ? `private=${currentStatus.privateLayer}` : '',
                    currentStatus.boundaryState ? `boundary=${currentStatus.boundaryState}` : ''
                ].filter(Boolean).join(' | ')}`);
            }
            const howMet = String(safeRelation.howMet || details.howMet || '').trim();
            const duration = String(safeRelation.duration || details.duration || '').trim();
            if (howMet) parts.push(`  성립/변화 계기/How Met: ${howMet}`);
            if (duration) parts.push(`  지속 기간/Duration: ${duration}`);
            const closeness = normalizeNullableRelationScore(details.closeness);
            const trust = normalizeNullableRelationScore(details.trust);
            if (closeness == null) parts.push(`  친밀도/Closeness: 판단 보류/Insufficient Evidence`);
            else if (closeness > 0.7) parts.push(`  친밀도/Closeness: 매우 가까움/Very Close`);
            else if (closeness > 0.4) parts.push(`  친밀도/Closeness: 보통/Moderate`);
            else parts.push(`  친밀도/Closeness: 낮음/Low`);
            if (trust == null) parts.push(`  신뢰도/Trust: 판단 보류/Insufficient Evidence`);
            else if (trust > 0.7) parts.push(`  신뢰도/Trust: 매우 높음/Very High`);
            else if (trust > 0.4) parts.push(`  신뢰도/Trust: 보통/Moderate`);
            else parts.push(`  신뢰도/Trust: 낮음/Low`);
            if (Number.isFinite(Number(sentiments.currentTension))) {
                const tension = Math.max(0, Math.min(1, Number(sentiments.currentTension)));
                const label = tension >= 0.7 ? '높음/High' : (tension >= 0.4 ? '중간/Moderate' : '낮음/Low');
                parts.push(`  현재 긴장도/Current Tension: ${label} (${tension.toFixed(2)})`);
            }
            const metricParts = [
                Number(metrics.risk) > 0 ? `risk=${Number(metrics.risk).toFixed(2)}` : '',
                Number(metrics.ambiguity) > 0 ? `ambiguity=${Number(metrics.ambiguity).toFixed(2)}` : '',
                Number(metrics.pressure) > 0 ? `pressure=${Number(metrics.pressure).toFixed(2)}` : ''
            ].filter(Boolean);
            if (metricParts.length > 0) parts.push(`  관계 압력/Relation Pressure: ${metricParts.join(' | ')}`);
            const stateSignals = ['distance', 'trust', 'pull', 'tension']
                .filter(key => Number.isFinite(Number(relationState[key])))
                .map(key => `${key}=${normalizeRelationAxis01(relationState[key], 0).toFixed(2)}`);
            if (stateSignals.length > 0) parts.push(`  관계 상태 축/Relation State: ${stateSignals.join(' | ')}`);
            if (safeRelation.axes && typeof safeRelation.axes === 'object') parts.push(`  관계 감정/인지 8축/Relation Axes: ${formatRelationAxesText(safeRelation.axes)}`);
            const speechDynamicsText = formatRelationSpeechDynamicsText(safeRelation);
            if (speechDynamicsText) parts.push(`  호칭·말투 동역학/Speech Dynamics: ${speechDynamicsText}`);
            if (sentiments.fromAtoB) parts.push(`    - ${safeRelation.entityA || '?'} → ${safeRelation.entityB || '?'}: ${sentiments.fromAtoB}`);
            if (sentiments.fromBtoA) parts.push(`    - ${safeRelation.entityB || '?'} → ${safeRelation.entityA || '?'}: ${sentiments.fromBtoA}`);
            const unresolvedIssues = Array.isArray(dynamics.unresolvedIssues) ? dynamics.unresolvedIssues : [];
            const activeTimelineChanges = Array.isArray(safeRelation?.relationTimeline?.events)
                ? safeRelation.relationTimeline.events.filter(isActiveRelationEvent).map(item => item.event).filter(Boolean)
                : [];
            const recentChanges = normalizeEntityList([...(Array.isArray(dynamics.recentChanges) ? dynamics.recentChanges : []), ...activeTimelineChanges], 12, 180);
            if (unresolvedIssues.length > 0) parts.push(`  미해결 관계 이슈/Unresolved Issues: ${unresolvedIssues.slice(-5).join(' / ')}`);
            if (recentChanges.length > 0) parts.push(`  최근 관계 변화/Recent Changes: ${recentChanges.slice(-4).join(' / ')}`);
            const contextBits = [
                sharedContext.location ? `location=${sharedContext.location}` : '',
                sharedContext.workplace ? `workplace=${sharedContext.workplace}` : '',
                Array.isArray(sharedContext.privateThreads) && sharedContext.privateThreads.length ? `threads=${sharedContext.privateThreads.slice(-4).join(', ')}` : ''
            ].filter(Boolean);
            if (contextBits.length > 0) parts.push(`  공유 맥락/Shared Context: ${contextBits.join(' | ')}`);
            const eventList = Array.isArray(details.events) ? details.events.filter(item => normalizeRelationEventStatus(item?.status) === 'active') : [];
            const latestEvent = eventList.length > 0 ? eventList[eventList.length - 1] : null;
            const eventText = String(safeRelation.event || latestEvent?.event || '').trim();
            const eventSentiment = String(safeRelation.eventSentiment || latestEvent?.sentiment || '').trim();
            if (eventText) {
                const eventLine = eventSentiment ? `${eventText} (${eventSentiment})` : eventText;
                parts.push(`  최근 관계 사건/Latest Event: ${eventLine}`);
            }
            const eventLedger = Array.isArray(safeRelation.eventLedger) ? safeRelation.eventLedger.filter(isActiveRelationLedgerItem) : [];
            if (eventLedger.length > 0) parts.push(`  관계 사건 장부/Relation Event Ledger: ${eventLedger.slice(-3).map(event => event.summary).filter(Boolean).join(' / ')}`);
            return parts.join('\n');
        };
        const formatProjectionFacts = (facts = [], max = 420) => clampEntityText(
            (Array.isArray(facts) ? facts : [facts])
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .join(' | '),
            max
        );
        const formatEntityForProjection = (entity, options = {}) => {
            const safeEntity = entity && typeof entity === 'object' ? entity : {};
            const profile = safeEntity.profile && typeof safeEntity.profile === 'object' ? safeEntity.profile : {};
            const identity = safeEntity.identity && typeof safeEntity.identity === 'object' ? safeEntity.identity : {};
            const status = safeEntity.status && typeof safeEntity.status === 'object' ? safeEntity.status : {};
            const currentState = safeEntity.currentState && typeof safeEntity.currentState === 'object' ? safeEntity.currentState : {};
            const personality = profile.personality && typeof profile.personality === 'object' ? profile.personality : {};
            const speech = profile.speechStyle && typeof profile.speechStyle === 'object' ? profile.speechStyle : {};
            const psychology = profile.psychology && typeof profile.psychology === 'object' ? profile.psychology : {};
            const psychologyNotes = Array.isArray(psychology.notes) ? psychology.notes : [];
            const continuity = safeEntity.continuity && typeof safeEntity.continuity === 'object' ? safeEntity.continuity : {};
            const povKnowledge = safeEntity.povKnowledge && typeof safeEntity.povKnowledge === 'object' ? safeEntity.povKnowledge : {};
            const name = clampEntityText(safeEntity.name || safeEntity.canonicalName || safeEntity.displayName || '?', 80) || '?';
            const parts = [`- ${name}`];
            const identityFacts = formatProjectionFacts([
                identity.summary ? `identity=${identity.summary}` : '',
                identity.roleInStory ? `role=${identity.roleInStory}` : '',
                identity.occupation ? `job=${identity.occupation}` : '',
                identity.affiliation ? `affiliation=${identity.affiliation}` : ''
            ], 360);
            if (identityFacts) parts.push(identityFacts);
            const currentFacts = formatProjectionFacts([
                currentState.summary || status.currentState ? `state=${currentState.summary || status.currentState}` : '',
                currentState.location || status.currentLocation ? `location=${currentState.location || status.currentLocation}` : '',
                Array.isArray(currentState.emotionalState) && currentState.emotionalState.length ? `emotion=${currentState.emotionalState.slice(-3).join(', ')}` : '',
                Array.isArray(currentState.cognitiveFocus) && currentState.cognitiveFocus.length ? `focus=${currentState.cognitiveFocus.slice(-3).join(', ')}` : '',
                currentState.activity ? `activity=${currentState.activity}` : '',
                currentState.immediateGoal ? `goal=${currentState.immediateGoal}` : ''
            ], 420);
            if (currentFacts) parts.push(currentFacts);
            const characterFacts = formatProjectionFacts([
                personality.workStyle ? `work=${personality.workStyle}` : '',
                personality.socialStyle ? `social=${personality.socialStyle}` : '',
                psychology.baseline ? `psych=${psychology.baseline}` : '',
                psychology.currentConflict ? `conflict=${psychology.currentConflict}` : '',
                psychology.copingStyle ? `coping=${psychology.copingStyle}` : '',
                psychologyNotes.length ? `psychNotes=${psychologyNotes.slice(-3).join(', ')}` : ''
            ], 360);
            if (characterFacts) parts.push(characterFacts);
            const speechFacts = formatProjectionFacts([
                speech.defaultTone ? `tone=${speech.defaultTone}` : '',
                speech.honorificStyle ? `honorific=${speech.honorificStyle}` : '',
                speech.intimacyShift ? `speechShift=${speech.intimacyShift}` : '',
                Array.isArray(speech.pressureMarkers) && speech.pressureMarkers.length ? `pressure=${speech.pressureMarkers.slice(-3).join(', ')}` : ''
            ], 300);
            if (speechFacts) parts.push(speechFacts);
            const threads = Array.isArray(continuity.openThreads) ? continuity.openThreads : [];
            if (threads.length > 0) {
                parts.push(`threads=${threads.slice(-3).map(thread => clampEntityText(thread?.label || thread?.summary || thread, 80)).filter(Boolean).join(' / ')}`);
            }
            const knownToSelf = Array.isArray(povKnowledge.knownToSelf) ? povKnowledge.knownToSelf : [];
            const unknownToSelf = Array.isArray(povKnowledge.unknownToSelf) ? povKnowledge.unknownToSelf : [];
            const povFacts = formatProjectionFacts([
                knownToSelf.length ? `knows=${knownToSelf.slice(-3).join(', ')}` : '',
                unknownToSelf.length ? `unknown=${unknownToSelf.slice(-3).join(', ')}` : ''
            ], 300);
            if (povFacts) parts.push(`pov=${povFacts}`);
            const ledger = Array.isArray(safeEntity.episodeLedger) ? safeEntity.episodeLedger : [];
            if (ledger.length > 0) {
                const recentEvents = ledger.slice(-2).map(event => clampEntityText(event?.summary || event?.event || event, 120)).filter(Boolean);
                if (recentEvents.length > 0) parts.push(`recent=${recentEvents.join(' / ')}`);
            }
            const output = parts.join(' | ');
            return options?.viewerId
                ? SecretKnowledgeCore.redactForViewer(output, options.viewerId)
                : output;
        };
        const formatRelationForProjection = (relation, options = {}) => {
            const safeRelation = relation && typeof relation === 'object' ? relation : {};
            const details = safeRelation.details && typeof safeRelation.details === 'object' ? safeRelation.details : {};
            const sentiments = safeRelation.sentiments && typeof safeRelation.sentiments === 'object' ? safeRelation.sentiments : {};
            const currentStatus = safeRelation.currentStatus && typeof safeRelation.currentStatus === 'object' ? safeRelation.currentStatus : {};
            const dynamics = safeRelation.dynamics && typeof safeRelation.dynamics === 'object' ? safeRelation.dynamics : {};
            const relationState = safeRelation.state && typeof safeRelation.state === 'object' ? safeRelation.state : {};
            const relationAxes = safeRelation.axes && typeof safeRelation.axes === 'object' ? safeRelation.axes : {};
            const sharedContext = safeRelation.sharedContext && typeof safeRelation.sharedContext === 'object' ? safeRelation.sharedContext : {};
            const assessment = safeRelation.relationshipAssessment && typeof safeRelation.relationshipAssessment === 'object' ? safeRelation.relationshipAssessment : {};
            const entityA = clampEntityText(safeRelation.entityA || '?', 80) || '?';
            const entityB = clampEntityText(safeRelation.entityB || '?', 80) || '?';
            const parts = [`- ${entityA} ↔ ${entityB}`];
            const tensionValue = Number(sentiments.currentTension);
            const definitionConfidence = normalizeNullableRelationScore(assessment.definitionConfidence);
            const closeness = normalizeNullableRelationScore(details.closeness);
            const trust = normalizeNullableRelationScore(details.trust);
            const relationFacts = formatProjectionFacts([
                safeRelation.relationType ? `type=${safeRelation.relationType}` : '',
                assessment.label ? `definition=${assessment.label}${definitionConfidence != null ? `:${definitionConfidence.toFixed(2)}` : ''}` : '',
                currentStatus.summary ? `state=${currentStatus.summary}` : '',
                currentStatus.publicLayer ? `public=${currentStatus.publicLayer}` : '',
                currentStatus.boundaryState ? `boundary=${currentStatus.boundaryState}` : '',
                Number.isFinite(tensionValue) ? `tension=${Math.max(0, Math.min(1, tensionValue)).toFixed(2)}` : '',
                closeness != null ? `closeness=${closeness.toFixed(2)}` : '',
                trust != null ? `trust=${trust.toFixed(2)}` : '',
                Number.isFinite(Number(relationState.pull)) ? `pull=${normalizeRelationAxis01(relationState.pull, 0).toFixed(2)}` : '',
                Number.isFinite(Number(relationState.distance)) ? `distance=${normalizeRelationAxis01(relationState.distance, 0).toFixed(2)}` : ''
            ], 460);
            if (relationFacts) parts.push(relationFacts);
            const activeProjectionChanges = Array.isArray(safeRelation?.relationTimeline?.events)
                ? safeRelation.relationTimeline.events.filter(isActiveRelationEvent).map(item => item.event).filter(Boolean)
                : [];
            const projectionChanges = normalizeEntityList([...(Array.isArray(dynamics.recentChanges) ? dynamics.recentChanges : []), ...activeProjectionChanges], 10, 160);
            const contextFacts = formatProjectionFacts([
                sharedContext.location ? `location=${sharedContext.location}` : '',
                sharedContext.workplace ? `workplace=${sharedContext.workplace}` : '',
                Array.isArray(dynamics.unresolvedIssues) && dynamics.unresolvedIssues.length ? `issues=${dynamics.unresolvedIssues.slice(-3).join(' / ')}` : '',
                projectionChanges.length ? `changes=${projectionChanges.slice(-3).join(' / ')}` : ''
            ], 360);
            if (contextFacts) parts.push(contextFacts);
            if (Object.keys(relationAxes || {}).length) parts.push(`axes=${formatRelationAxesText(relationAxes)}`);
            const speechFacts = formatRelationSpeechDynamicsText(safeRelation);
            if (speechFacts) parts.push(`speech=${speechFacts}`);
            const eventList = Array.isArray(details.events) ? details.events.filter(item => normalizeRelationEventStatus(item?.status) === 'active') : [];
            const latestEvent = eventList.length > 0 ? eventList[eventList.length - 1] : null;
            const eventText = clampEntityText(safeRelation.event || latestEvent?.event || '', 140);
            if (eventText) parts.push(`latest=${eventText}`);
            const output = parts.join(' | ');
            return options?.viewerId
                ? SecretKnowledgeCore.redactForViewer(output, options.viewerId)
                : output;
        };
        const formatRelationsForPrompt = (entityName) => {
            const target = String(entityName || '').trim();
            if (!target) return [];
            return Array.from(relationCache.values())
                .filter(relation => {
                    if (!relation || !(relation.entityA === target || relation.entityB === target)) return false;
                    const entityA = entityCache.get(relation.entityA);
                    const entityB = entityCache.get(relation.entityB);
                    return isPromptVisibleEntityRecord(entityA) && isPromptVisibleEntityRecord(entityB);
                })
                .map(formatRelationForPrompt)
                .filter(Boolean);
        };

        const clearCache = () => { entityCache.clear(); relationCache.clear(); };

        const rebuildCache = (lorebook, { scopeKey = MemoryState?._activeScopeKey || '' } = {}) => {
            clearCache();
            for (const entry of LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])) {
                try {
                    if (entry.comment === ENTITY_COMMENT) {
                        let entity = JSON.parse(entry.content);
                        const integrity = IntegrityMetaManager.validateIntegrityMeta(entity, {
                            domain: 'entity',
                            recordId: entity?.name || '',
                            scopeKey
                        });
                        if (!integrity.ok) {
                            IntegrityMetaManager.debugValidationFailure('entity.rebuildCache', integrity, {
                                domain: 'entity',
                                recordId: entity?.name || '',
                                scopeKey
                            });
                            continue;
                        }
                        // Validate the signed stored record before compatibility normalization adds legacy fields.
                        entity = normalizeEntityShape(entity);
                        if (isEntityAbsorptionApplied(entity)) continue;
                        entity.id = entity.id || TokenizerEngine.simpleHash(normalizeName(entity.name || ''));
                        entity.meta = entity.meta || { created: 0, updated: 0, confidence: 0.5, source: '' };
                        if (!Array.isArray(entity.meta.m_ids) && entity.meta.m_id) entity.meta.m_ids = [entity.meta.m_id];
                        entity.meta.aliases = Array.isArray(entity.meta.aliases) ? entity.meta.aliases : [];
                        const canonicalName = resolveCanonicalName(entity.name, lorebook);
                        if (!canonicalName || isBlockedEntityName(canonicalName, lorebook) || isBlockedEntityName(entity.name, lorebook)) continue;
                        try {
                            const legacyTracking = normalizeEntityTimeTracking(entity.timeTracking, entity);
                            if (Object.values(legacyTracking).some(Boolean)) {
                                TimeEngine.ingestEntityTracking(entity.name || canonicalName, legacyTracking, entity);
                            }
                            const projection = TimeEngine.projectEntity(entity);
                            if (projection?.currentDate) entity.status.currentDate = projection.currentDate;
                            if (projection?.currentTime) entity.status.currentTime = projection.currentTime;
                        } catch (e) {
                            if (MemoryEngine.CONFIG?.debug) console.warn('[LIBRA] TimeEngine rebuildCache skipped:', e?.message);
                        }
                        if (entityCache.has(canonicalName)) {
                            entityCache.set(canonicalName, mergeEntityRecords(entityCache.get(canonicalName), entity));
                        } else {
                            entityCache.set(canonicalName, entity);
                        }
                    } else if (entry.comment === RELATION_COMMENT) {
                        const relation = JSON.parse(entry.content);
                        const integrity = IntegrityMetaManager.validateIntegrityMeta(relation, {
                            domain: 'relation',
                            recordId: relation?.id || [relation?.entityA, relation?.entityB].filter(Boolean).join('::'),
                            scopeKey
                        });
                        if (!integrity.ok) {
                            IntegrityMetaManager.debugValidationFailure('relation.rebuildCache', integrity, {
                                domain: 'relation',
                                recordId: relation?.id || [relation?.entityA, relation?.entityB].filter(Boolean).join('::'),
                                scopeKey
                            });
                            continue;
                        }
                        relation.entityA = resolveCanonicalName(relation.entityA || '', lorebook);
                        relation.entityB = resolveCanonicalName(relation.entityB || '', lorebook);
                        if (!relation.entityA || !relation.entityB || isBlockedEntityName(relation.entityA, lorebook) || isBlockedEntityName(relation.entityB, lorebook)) continue;
                        if (!hasEntityRecordForRelationEndpoint(relation.entityA, lorebook) || !hasEntityRecordForRelationEndpoint(relation.entityB, lorebook)) continue;
                        relation.id = makeRelationId(relation.entityA || '', relation.entityB || '', lorebook);
                        relation.meta = relation.meta || { created: 0, updated: 0, confidence: 0.3, source: '' };
                        if (!Array.isArray(relation.meta.m_ids) && relation.meta.m_id) relation.meta.m_ids = [relation.meta.m_id];
                        normalizeRelationV2Fields(relation);
                        if (relationCache.has(relation.id)) {
                            relationCache.set(relation.id, mergeRelationRecords(relationCache.get(relation.id), relation));
                        } else {
                            relationCache.set(relation.id, relation);
                        }
                    }
                } catch (e) {
                    if (typeof MemoryEngine !== 'undefined' && MemoryEngine.CONFIG?.debug) {
                        recordRuntimeDebug('warn', '[LIBRA] rebuildCache entry parse error:', e?.message);
                    }
                }
            }
            pruneBlockedEntries(lorebook);
            collapseClearlyDuplicateEntities();
        };

        const repairLegacyFieldMappings = (lorebook = []) => {
            if (!Array.isArray(lorebook)) return { changed: false, count: 0, fields: [] };
            let count = 0;
            const fields = new Set();
            for (const entry of lorebook) {
                if (!entry || entry.comment !== ENTITY_COMMENT) continue;
                try {
                    const raw = JSON.parse(entry.content || '{}');
                    const integrity = IntegrityMetaManager.validateIntegrityMeta(raw, {
                        domain: 'entity',
                        recordId: raw?.name || '',
                        scopeKey: MemoryState?._activeScopeKey || ''
                    });
                    if (!integrity.ok) {
                        IntegrityMetaManager.debugValidationFailure('entity.field_mapping_migration', integrity, {
                            domain: 'entity',
                            recordId: raw?.name || '',
                            scopeKey: MemoryState?._activeScopeKey || ''
                        });
                        continue;
                    }
                    const before = JSON.stringify(raw?.meta?.fieldMappingMigration || null);
                    const normalized = normalizeEntityShape(raw);
                    const afterMeta = normalized?.meta?.fieldMappingMigration || null;
                    if (!afterMeta || afterMeta.schema !== ENTITY_FIELD_MAPPING_MIGRATION_SCHEMA || before === JSON.stringify(afterMeta)) continue;
                    for (const field of (afterMeta.recoveredFields || [])) fields.add(field);
                    IntegrityMetaManager.applyIntegrityMeta(normalized, {
                        domain: 'entity',
                        recordSchema: 'libra.entity.record.v1',
                        recordId: normalized.name || '',
                        scopeKey: MemoryState?._activeScopeKey || '',
                        turn: MemoryState?.currentTurn || 0,
                        source: normalized?.meta?.source || 'entity_field_mapping_migration'
                    });
                    entry.content = JSON.stringify(normalized, null, 2);
                    count += 1;
                } catch (error) {
                    recordSuppressedRuntimeError('entity.field_mapping_migration.entry_failed', error, {
                        key: String(entry?.key || ''),
                        comment: String(entry?.comment || '')
                    });
                }
            }
            return { changed: count > 0, count, fields: [...fields].sort(), schema: ENTITY_FIELD_MAPPING_MIGRATION_SCHEMA };
        };

        const saveToLorebookSync = (char, chat, lorebook) => {
            const targetProof = PersonaScopeIdentity.snapshotProof(char, chat);
            const targetIdentity = PersonaScopeIdentity.get(char, chat);
            if (!targetProof || !targetIdentity || targetProof.personaId !== targetIdentity.personaId) {
                throw new Error('entity_persistence_target_unverified');
            }
            pruneBlockedEntries(lorebook);
            const currentTurn = MemoryState.currentTurn;
            // Staged destination writes can precede activation of the target.
            // Integrity belongs to the explicit chat, not the active source.
            const targetScopeKey = getChatRuntimeScopeKey(chat, char);
            // §5-5 쓰기 시점 guard — 리롤·롤백된 턴의 엔티티·관계는 **저장하지 않는다**.
            //   다른 계층(기억·RP-LTM·세계선)은 이미 필터를 타는데 이것들만 안 탔다(실측 결함).
            //   worldline 상태를 못 얻으면 종전과 완전히 동일하게 동작한다(fail-open).
            const worldlineState = (() => {
                try {
                    const WL = (typeof LibraTurnWorldline !== 'undefined' && LibraTurnWorldline)
                        || (typeof globalThis !== 'undefined' ? globalThis.LibraTurnWorldline : null);
                    if (!WL || typeof WL.get !== 'function') return null;
                    const scopeKey = LibraDataStorage.scopeKeyFor(char, chat, targetProof.personaId);
                    return WL.get(scopeKey) || null;
                } catch (_) { return null; }
            })();
            const writeFilter = (() => {
                try {
                    const WL = (typeof LibraTurnWorldline !== 'undefined' && LibraTurnWorldline)
                        || (typeof globalThis !== 'undefined' ? globalThis.LibraTurnWorldline : null);
                    return WL && typeof WL.filterSupersededEntityRecords === 'function'
                        ? WL.filterSupersededEntityRecords : null;
                } catch (_) { return null; }
            })();
            const droppedEntityNames = new Set();
            const droppedRelationIds = new Set();
            if (writeFilter && worldlineState) {
                try {
                    const liveEntities = Array.from(entityCache.values());
                    const filteredEntities = writeFilter(liveEntities, worldlineState);
                    const keptNames = new Set((filteredEntities.items || []).map(e => String(e?.name || '')));
                    for (const e of liveEntities) {
                        const name = String(e?.name || '');
                        if (name && !keptNames.has(name)) droppedEntityNames.add(name);
                    }
                    const liveRelations = Array.from(relationCache.values());
                    const filteredRelations = writeFilter(liveRelations, worldlineState);
                    const keptIds = new Set((filteredRelations.items || []).map(r => String(r?.id || '')));
                    for (const r of liveRelations) {
                        const id = String(r?.id || '');
                        if (id && !keptIds.has(id)) droppedRelationIds.add(id);
                    }
                } catch (_) {}
            }
            const liveEntityNames = new Set(Array.from(entityCache.keys())
                .filter(name => name && !droppedEntityNames.has(String(name))));
            const liveRelationIds = new Set(Array.from(relationCache.keys())
                .filter(id => id && !droppedRelationIds.has(String(id))));

            for (let i = lorebook.length - 1; i >= 0; i--) {
                const entry = lorebook[i];
                if (!entry || typeof entry !== 'object') continue;
                try {
                    if (entry.comment === ENTITY_COMMENT) {
                        const parsed = JSON.parse(entry.content || '{}');
                        const canonicalName = resolveCanonicalName(parsed.name || '', lorebook);
                        if (!canonicalName || !liveEntityNames.has(canonicalName)) {
                            lorebook.splice(i, 1);
                        }
                    } else if (entry.comment === RELATION_COMMENT) {
                        const parsed = JSON.parse(entry.content || '{}');
                        const entityA = resolveCanonicalName(parsed.entityA || '', lorebook);
                        const entityB = resolveCanonicalName(parsed.entityB || '', lorebook);
                        const relationId = makeRelationId(entityA || parsed.entityA || '', entityB || parsed.entityB || '', lorebook);
                        if (!relationId || !liveRelationIds.has(relationId) || !liveEntityNames.has(entityA) || !liveEntityNames.has(entityB)) {
                            lorebook.splice(i, 1);
                        }
                    }
                } catch {
                    if (entry.comment === ENTITY_COMMENT || entry.comment === RELATION_COMMENT) {
                        lorebook.splice(i, 1);
                    }
                }
            }

            for (const [name, entity] of entityCache) {
                // 리롤·롤백된 턴에 생성된 엔티티는 캐시에서도 빼고 저장하지 않는다.
                //   캐시에 남겨두면 다음 저장에서 다시 살아난다(가드가 무의미해진다).
                if (droppedEntityNames.has(String(entity?.name || name || ''))) {
                    entityCache.delete(name);
                    continue;
                }
                entity.meta = entity.meta || { created: currentTurn, updated: currentTurn, confidence: 0.5, source: '' };
                entity.meta.updated = currentTurn;
                normalizeEntityV2Fields(entity);
                try {
                    TimeEngine.ingestEntityTracking(entity.name || name || '', {
                        currentDate: entity?.status?.currentDate || '',
                        currentTime: entity?.status?.currentTime || '',
                        notes: entity?.status?.notes || ''
                    }, entity);
                    const projection = TimeEngine.projectEntity(entity);
                    if (projection?.currentDate) entity.status.currentDate = projection.currentDate;
                    if (projection?.currentTime) entity.status.currentTime = projection.currentTime;
                } catch (e) {
                    if (MemoryEngine.CONFIG?.debug) console.warn('[LIBRA] TimeEngine saveToLorebook projection skipped:', e?.message);
                }
                IntegrityMetaManager.applyIntegrityMeta(entity, {
                    domain: 'entity',
                    recordSchema: 'libra.entity.record.v1',
                    recordId: entity.name || name,
                    scopeKey: targetScopeKey,
                    turn: currentTurn,
                    source: entity?.meta?.source || ''
                });
                const entry = {
                    key: LibraLoreKeys.entityFromName(entity.name || name),
                    comment: ENTITY_COMMENT,
                    content: JSON.stringify(entity, null, 2),
                    mode: 'normal',
                    insertorder: 50,
                    alwaysActive: false
                };
                const matchingEntityIndexes = [];
                lorebook.forEach((e, idx) => {
                    if (e.comment !== ENTITY_COMMENT) return false;
                    try {
                        const parsed = JSON.parse(e.content || '{}');
                        if (resolveCanonicalName(parsed.name || '', lorebook) === name) matchingEntityIndexes.push(idx);
                    } catch {
                        return false;
                    }
                });
                const existingIdx = matchingEntityIndexes[0] ?? -1;
                for (let i = matchingEntityIndexes.length - 1; i >= 1; i--) {
                    lorebook.splice(matchingEntityIndexes[i], 1);
                }
                if (existingIdx >= 0) lorebook[existingIdx] = entry;
                else lorebook.push(entry);
            }

            for (const [id, relation] of relationCache) {
                // 리롤·롤백된 턴에 생성된 관계도 같은 규칙으로 제외한다.
                if (droppedRelationIds.has(String(relation?.id || id || ''))) {
                    relationCache.delete(id);
                    continue;
                }
                const entityA = resolveCanonicalName(relation.entityA || '', lorebook);
                const entityB = resolveCanonicalName(relation.entityB || '', lorebook);
                if (!entityA || !entityB || !liveEntityNames.has(entityA) || !liveEntityNames.has(entityB)) continue;
                relation.entityA = entityA;
                relation.entityB = entityB;
                relation.id = makeRelationId(entityA, entityB, lorebook);
                relation.meta = relation.meta || { created: currentTurn, updated: currentTurn, confidence: 0.3, source: '' };
                relation.meta.updated = currentTurn;
                normalizeRelationV2Fields(relation);
                IntegrityMetaManager.applyIntegrityMeta(relation, {
                    domain: 'relation',
                    recordSchema: 'libra.relation.record.v1',
                    recordId: relation.id || id,
                    scopeKey: targetScopeKey,
                    turn: currentTurn,
                    source: relation?.meta?.source || ''
                });
                const entry = {
                    key: LibraLoreKeys.relationFromNames(relation.entityA, relation.entityB),
                    comment: RELATION_COMMENT,
                    content: JSON.stringify(relation, null, 2),
                    mode: 'normal',
                    insertorder: 60,
                    alwaysActive: false
                };
                const matchingRelationIndexes = [];
                lorebook.forEach((e, idx) => {
                    if (e.comment !== RELATION_COMMENT) return false;
                    try {
                        const parsed = JSON.parse(e.content || '{}');
                        const parsedA = resolveCanonicalName(parsed.entityA || '', lorebook);
                        const parsedB = resolveCanonicalName(parsed.entityB || '', lorebook);
                        const parsedId = makeRelationId(parsedA || parsed.entityA || '', parsedB || parsed.entityB || '', lorebook);
                        if (parsedId === id || parsedId === relation.id) matchingRelationIndexes.push(idx);
                    } catch {
                        return false;
                    }
                });
                const existingIdx = matchingRelationIndexes[0] ?? -1;
                for (let i = matchingRelationIndexes.length - 1; i >= 1; i--) {
                    lorebook.splice(matchingRelationIndexes[i], 1);
                }
                if (existingIdx >= 0) lorebook[existingIdx] = entry;
                else lorebook.push(entry);
            }
        };

        const saveToLorebook = async (...args) => saveToLorebookSync(...args);
        // Only used around known synchronous management preparation bodies.
        const withTemporaryState = callback => {
            const previous = { entities: [...entityCache], relations: [...relationCache], identityState,
                entityCacheRevision, entityLookupIndexCache, resolved: [...entityResolveCache] };
            const restoreMap = (map, entries) => { Map.prototype.clear.call(map); for (const [key, value] of entries) Map.prototype.set.call(map, key, value); };
            try {
                restoreMap(entityCache, safeClone(previous.entities));
                restoreMap(relationCache, safeClone(previous.relations));
                identityState = { ...identityState, userAliases: new Set(identityState.userAliases) };
                invalidateEntityResolveCaches();
                const result = callback();
                if (result && typeof result.then === 'function') throw new Error('management_prepare_must_be_synchronous');
                return result;
            } finally {
                restoreMap(entityCache, previous.entities); restoreMap(relationCache, previous.relations);
                identityState = previous.identityState; entityCacheRevision = previous.entityCacheRevision;
                entityLookupIndexCache = previous.entityLookupIndexCache; restoreMap(entityResolveCache, previous.resolved);
            }
        };
        return {
            refreshIdentity,
            normalizeName, resolveCanonicalName, makeRelationId, getOrCreateEntity, getOrCreateRelation,
            renameEntity, updateEntity, updateRelation, applyManualRelationProjection, checkConsistency, formatEntityForPrompt,
            formatRelationForPrompt, formatEntityForProjection, formatRelationForProjection,
            formatRelationsForPrompt, clearCache, rebuildCache, repairLegacyFieldMappings, saveToLorebook, saveToLorebookSync, withTemporaryState,
            normalizeEntityRecord: normalizeEntityShape,
            normalizeVisualCanon: normalizeEntityVisualCanon,
            normalizeEntityVisualCanon,
            mergeEntityVisualCanon,
            buildVisualProfilePayload,
            formatVisualCanonForPrompt,
            normalizeCurrentVisualState,
            normalizeMoodText: normalizeEntityMoodText,
            normalizeMoodAtoms: normalizeEntityMoodAtoms,
            mentionsEntity,
            recomputeRelationProjection, retractRelationTimelineEvents,
            getEntityCache: () => entityCache, getRelationCache: () => relationCache,
            pruneEntitiesForReanalysis, pruneBlockedEntries, isBlockedEntityName,
            collapseDuplicates: collapseClearlyDuplicateEntities,
            markEntityAbsorption, cancelEntityAbsorption, applyEntityAbsorption,
            listEntityAbsorptions, listPendingEntityAbsorptions,
            isActiveEntityRecord, isPromptVisibleEntityRecord,
            ENTITY_ABSORPTION_COMMENT
        };
    })();

    const normalizeRuntimeList = (items = [], limit = 20, itemMax = 220) => dedupeTextArray(
        (Array.isArray(items) ? items : [items])
            .map(item => String(item || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .map(item => item.length > itemMax ? item.slice(0, Math.max(0, itemMax - 1)).trimEnd() + '…' : item)
    ).slice(0, Math.max(0, Number(limit || 0)) || 20);
    const buildScopedManagedLoreKey = (comment = '', scopeKey = '') => {
        const normalizedComment = String(comment || 'lmai').trim() || 'lmai';
        const normalizedScope = String(scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
        const hash = typeof TokenizerEngine?.simpleHash === 'function'
            ? TokenizerEngine.simpleHash(normalizedScope)
            : stableHash(normalizedScope);
        return normalizedComment + '::' + hash;
    };
    const getManagedScopedEntryScope = (entry = null, parsed = null) => {
        const payload = parsed || (() => {
            try { return JSON.parse(entry?.content || '{}'); }
            catch { return null; }
        })();
        return String(
            payload?.scopeKey
            || payload?.scopeId
            || payload?.runtimeScopeId
            || payload?.engineState?.scopeKey
            || entry?.scopeKey
            || entry?.meta?.scopeKey
            || ''
        ).trim();
    };
    const findManagedScopedEntryIndex = (lorebook = [], comment = '', scopeKey = '') => {
        const normalizedComment = String(comment || '').trim();
        const normalizedScope = String(scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
        const matches = [];
        for (let i = 0; i < (Array.isArray(lorebook) ? lorebook.length : 0); i++) {
            const entry = lorebook[i];
            if (String(entry?.comment || '').trim() !== normalizedComment) continue;
            let parsed = null;
            try { parsed = JSON.parse(entry?.content || '{}'); } catch (error) {
                recordSuppressedRuntimeError('managed_scope.find_entry_parse_failed', error, {
                    comment: normalizedComment,
                    scopeKey: normalizedScope,
                    key: String(entry?.key || '').trim()
                });
            }
            matches.push({ index: i, entry, parsed, scope: getManagedScopedEntryScope(entry, parsed) });
        }
        const exact = matches.find(item => item.scope === normalizedScope);
        if (exact) return exact.index;
        const legacy = matches.find(item => !item.scope);
        return legacy ? legacy.index : -1;
    };
    const upsertManagedScopedEntry = (lorebook = [], comment = '', entry = {}, scopeKey = '') => {
        if (!Array.isArray(lorebook)) return -1;
        const idx = findManagedScopedEntryIndex(lorebook, comment, scopeKey);
        if (idx >= 0) {
            lorebook[idx] = entry;
            return idx;
        }
        lorebook.push(entry);
        return lorebook.length - 1;
    };

    // ══════════════════════════════════════════════════════════════
