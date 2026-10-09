//@name libra_world_manager
//@display-name LIBRA World Manager v6.0.0
//@author rusinus12@gmail.com
//@api 3.0
//@version 6.0.0
//@update-url https://raw.githubusercontent.com/rusinus12-droid/libra_world_maker/main/dist/LIBRA%20World%20Manager.js
//@arg story_author_enabled string Enable Story Author layer: true|false
//@arg story_author_mode string Story Author mode: disabled|supportive|proactive|aggressive
//@arg director_enabled string Enable Director layer: true|false
//@arg director_mode string Director mode: disabled|light|standard|strong|absolute
//@arg entity_visual_canon_enabled string Reflect entity visual canon (appearance) into prompts: true|false
//@arg llm_request_format string Main LLM request format override (default leaves provider default)
//@arg aux_llm_request_format string Auxiliary LLM request format override (default leaves provider default)
//@arg resource_governor_enabled string Enable the resource governor: true|false
//@arg resource_working_set_soft_bytes int Working-set soft threshold in bytes (range 32MB-1GB) (default 96MB)
//@arg resource_working_set_hard_bytes int Working-set hard threshold in bytes (range 48MB-2GB (and >= soft + 16MB)) (default 160MB)
//@arg resource_pending_queue_soft_bytes int Pending-queue soft threshold in bytes (range 1MB-128MB) (default 8MB)
//@arg resource_pending_queue_hard_bytes int Pending-queue hard threshold in bytes (range 2MB-160MB (and >= soft + 1MB)) (default 24MB)
//@arg resource_sample_interval_ms int Resource sampling interval in ms (range 500-15000) (default 2000)
//@arg resource_pressure_hold_ms int Hold time after pressure detection in ms (range 500-30000) (default 3500)
//@arg resource_recovery_hold_ms int Hold time after recovery in ms (range 3000-120000) (default 15000)
//@arg resource_target_task_slice_ms int Target task slice in ms (range 4-30) (default 10)
//@arg resource_normal_maintenance_concurrency int Maintenance concurrency under normal load (range 1-6) (default 3)
//@arg resource_pressure_maintenance_concurrency int Maintenance concurrency under pressure (range 1-4) (default 2)
//@arg resource_critical_maintenance_concurrency int Maintenance concurrency under critical load (range 1-2) (default 1)
// Runtime source is assembled from src/build-manifest.json. Historical patch notes live outside the executable bundle.
//@arg max_limit int Maximum memory entries (range 20-5000) (default 360)
//@arg threshold int Memory importance threshold (range 1-10) (default 2; memory_preset overrides when preset != custom)
//@arg sim_threshold string Similarity threshold (range 0.01-1) (default 0.10; memory_preset overrides when preset != custom)
//@arg analysis_evidence_mode string Assistant-response analysis scope: assistant_only|user_and_assistant
//@arg memory_preset string Memory preset: general|sim_small|sim_medium|sim_large|custom
//@arg world_adjustment_mode string World adjustment mode: off|static|soft|dynamic|strict|hard
//@arg gc_batch_size int Garbage-collection batch size (range 1-200) (default 16; memory_preset overrides when preset != custom)
//@arg weight_mode string Recall weight mode: auto|custom
//@arg w_sim string Custom similarity weight (weight_mode=custom)
//@arg w_imp string Custom importance weight (weight_mode=custom)
//@arg w_rec string Custom recency weight (weight_mode=custom)
//@arg cold_start_scope_preset string Cold-start scope preset
//@arg cold_start_history_limit int Cold-start history limit
//@arg debug string Enable recent-turn debug capture/export, default false: true/false
//@arg secret_knowledge_enabled string Enable secret knowledge guard: true/false
//@arg entity_knowledge_vault_enabled string Enable per-entity POV knowledge guard: true/false
//@arg rp_long_term_memory_enabled string Enable RP long-term continuity ledger: true/false
//@arg rp_long_term_llm_enrichment string Enrich RP long-term memory in the existing maintenance LLM pass: true/false
//@arg rp_long_term_injection_max_chars int Maximum RP long-term continuity injection characters (range 400-12000)
//@arg rp_long_term_long_ttl int Turn TTL for durable long-term RP memories (range 120-100000)
//@arg rp_long_term_medium_ttl int Turn TTL for medium-term RP memories (range 60-50000)
//@arg activity_dashboard string Realtime activity indicator in the GUI header: off|compact|full
//@arg background_maintenance_delay_ms int Delay background maintenance after afterRequest in ms (range 0-600000)
//@arg after_request_maintenance_mode string afterRequest maintenance mode: background|foreground
//@arg after_request_foreground_timeout_ms int Foreground afterRequest maintenance timeout in ms
//@arg after_request_analysis_budget_ms int Bounded wall-clock budget for detached afterRequest analysis in ms (default 480000, max 900000)
//@arg after_request_parallel_analysis string Split afterRequest LLM analysis into parallel packet + maintenance workers: true/false
//@arg libra_injection_mode string LIBRA injection mode: direct|lorebook_projection (retired hybrid maps to direct)
//@arg libra_projection_always_active string Enable LIBRA projection lorebook entries: true|false
//@arg libra_projection_max_chars int Maximum characters per LIBRA projection lorebook entry (range 400-20000)
//@arg libra_projection_recall_bundle string LIBRA recall bundle projection: off|projection_only|always (retired hybrid maps to off)
//@arg cbs_enabled string Enable CBS compatibility: true/false
//@arg entity_blocklist string Comma/newline separated blocked entity names
//@arg bypass_aux_requests string Skip LIBRA for auxiliary/plugin requests (memory/emotion/translate and explicit helper prompts): true/false
//@arg response_streaming_compat_enabled string Commit LIBRA data after RisuAI response streaming: true/false
//@arg use_lorebook_rag string Enable lorebook RAG: true/false
//@arg emotion_enabled string Enable emotion tracking: true/false
//@arg nsfw_enabled string Enable mature creative-writing guidance: true/false
//@arg nsfw_mode string NSFW guidance mode: off|soft|direct|explicit
//@arg nsfw_guidance_prompt_enabled string Include NSFW guidance prompt when nsfw_mode is active: true/false
//@arg assistant_prefill_enabled string Include assistant prefill block for NSFW/autocontinue contexts: true/false
//@arg world_additional_max_per_request int Max World Additional directives injected per request (range 1-6)
// Retired World Additional switches (world_additional_enabled / _mode / _user_impact_limit /
// _auto_integrate / _custom_text / _custom_force, world_canon_custom_*): these were declared
// here but no code ever read them as arguments, so they could not actually be changed —
// automatic candidate injection is always on and force mode is fixed at 'firm'. User-authored
// additions now enter through the User DLC / World Additional records instead (see GUI
// '유저 DLC' tab), where each item can be inspected and toggled individually.
//
// The global user-impact cap was also retired outright: it was designed as a ceiling but its
// only enforcement helper (isImpactAllowed) had zero call sites, so it never constrained
// anything. Per-item userImpact is still stored and shown as a GUI badge; the global cap is
// gone rather than wired, because the injection prompt deliberately lets the response model
// choose portrayal intensity from canon and scene conditions.
//@arg section_world_inference_enabled string Enable section world inference: true/false
//@arg injection_budget_preset string LIBRA prompt injection budget preset: compact|balanced|large|max|custom
//@arg injection_budget_max_tokens int LIBRA prompt injection custom max tokens
//@arg injection_budget_tokens int LIBRA prompt injection token budget (legacy alias)
//@arg flex_routing_mode string Flex routing mode: off|background|all
//@arg flex_timeout_ms int Flex request timeout ms for latency-tolerant background calls
//@arg flex_fallback_to_standard string Retry once without Flex on throttling/timeout: true|false
//@arg vertex_flex_mode string Vertex Flex mode: provisioned_then_flex|flex_only
//@arg custom_service_tier_passthrough string Allow service_tier passthrough for custom OpenAI-compatible provider: true|false
//@arg llm_provider string Main LLM provider
//@arg llm_url string Main LLM base URL
//@arg llm_key string Main LLM API key
//@arg llm_model string Main LLM model
//@arg llm_temp string Main LLM temperature
//@arg llm_timeout int Main LLM timeout ms
//@arg llm_timeout_ms int RE-compatible main LLM timeout alias
//@arg llm_reasoning_preset string Main LLM reasoning preset: auto|gpt|gemini|claude|deepseek|kimi|glm|custom
//@arg llm_reasoning_effort string Main LLM reasoning effort
//@arg llm_reasoning_budget_tokens int Main LLM reasoning budget tokens
//@arg llm_max_completion_tokens int Main LLM max completion tokens
//@arg llm_glm_thinking_type string Main LLM GLM thinking type
//@arg llm_glm_thinking string RE-compatible main LLM GLM thinking alias
//@arg llm_stream string RE-compatible main LLM stream flag: true/false
//@arg llm_service_tier string Main LLM service tier: off|auto|default|flex|priority|scale
//@arg aux_llm_enabled string Enable auxiliary LLM: true/false
//@arg aux_llm_provider string Auxiliary LLM provider
//@arg aux_llm_url string Auxiliary LLM base URL
//@arg aux_llm_key string Auxiliary LLM API key
//@arg aux_llm_model string Auxiliary LLM model
//@arg aux_llm_temp string Auxiliary LLM temperature
//@arg aux_llm_timeout int Auxiliary LLM timeout ms
//@arg aux_llm_timeout_ms int RE-compatible auxiliary LLM timeout alias
//@arg aux_llm_reasoning_preset string Auxiliary LLM reasoning preset: auto|gpt|gemini|claude|deepseek|kimi|glm|custom
//@arg aux_llm_reasoning_effort string Auxiliary LLM reasoning effort
//@arg aux_llm_reasoning_budget_tokens int Auxiliary LLM reasoning budget tokens
//@arg aux_llm_max_completion_tokens int Auxiliary LLM max completion tokens
//@arg aux_llm_glm_thinking_type string Auxiliary LLM GLM thinking type
//@arg aux_llm_glm_thinking string RE-compatible auxiliary LLM GLM thinking alias
//@arg aux_llm_stream string RE-compatible auxiliary LLM stream flag: true/false
//@arg aux_llm_service_tier string Auxiliary LLM service tier: off|auto|default|flex|priority|scale
//@arg llm_presets_json string JSON object of named LLM presets, e.g. {"fast":{"model":"glm-5:cloud","timeout":45000}}
//@arg model_presets_json string SGA-compatible alias for llm_presets_json
//@arg provider_presets_json string SGA-compatible alias for llm_presets_json
//@arg default_preset string SGA-compatible default LLM preset name used when a LIBRA task has no explicit route
//@arg llm_default_preset string Default LLM preset name used when a LIBRA task has no explicit route
//@arg llm_routing_json string JSON object mapping LIBRA task keys to LLM presets, e.g. {"turnMaintenanceBundle":"deep","liveExtraction":"fast"}
//@arg embed_provider string Embedding provider
//@arg embed_url string Embedding base URL
//@arg embed_key string Embedding API key
//@arg embed_model string Embedding model
//@arg embed_timeout int Embedding timeout ms
//@arg embedding_enabled string Enable RE-compatible embedding provider: true/false
//@arg embedding_provider string RE-compatible embedding provider alias
//@arg embedding_url string RE-compatible embedding base URL alias
//@arg embedding_key string RE-compatible embedding API key alias
//@arg embedding_model string RE-compatible embedding model alias
//@arg embedding_timeout_ms int RE-compatible embedding timeout alias
//@arg embedding_dimension int Explicit expected embedding dimension (1-8192); blank is unknown
//@arg embedding_model_revision string Explicit embedding model revision (max 256 characters); blank is unknown
//@arg dual_recall_mode string Recall mode: legacy|shadow|dual (default dual)
//@arg dual_recall_heuristic_depth int Independent heuristic depth (1-32, default 32)
//@arg dual_recall_semantic_depth int Independent semantic depth (1-32, default 32)
//@arg dual_recall_rrf_k int RRF rank constant (1-1000, default 60)
//@arg dual_recall_query_budget_ms int Query deadline ms (1-1500, default 1500)
//@arg dual_recall_admission_json string Per-family admission JSON; uncalibrated operational default
//@arg scoring_profile string RE strengthened Jaccard profile: balanced|lexical|strict|semantic|salience|recency|entity_focus|custom
//@arg scoring_word_weight string RE strengthened Jaccard word weight
//@arg scoring_char_weight string RE strengthened Jaccard character ngram weight
//@arg scoring_concept_weight string RE strengthened Jaccard concept weight
//@arg scoring_lexical_coverage_weight string RE strengthened Jaccard lexical coverage weight
//@arg scoring_focus_weight string RE strengthened Jaccard focus-name weight
//@arg recall_evidence_gate string Recall evidence gate: off|soft|strict
//@arg recall_anchor_bonus string Maximum anchor bonus used by evidence-aware recall scoring
//@arg recall_sentence_window string Use best sentence-window excerpts in Related Memories: true|false
//@arg recall_sentence_window_chars int Maximum characters per memory sentence-window excerpt (range 80-1200)
//@arg recall_injection_max_tokens int Dedicated token budget for Related Memories injection (range 320-6000)
//@arg recall_scoring_text_max_chars int Maximum characters per memory used for first-pass recall scoring (range 160-4000)
//@arg recall_scoring_v2 string Enable Recall Scoring V2 final gate/ranking: true|false
//@arg recall_domain_guard string Block unrelated external-domain recall queries: true|false
//@arg hybrid_memory_engine string Enable LIBRA World Manager Hybrid Memory Engine skeleton: true|false
//@arg hybrid_read_path string Enable hybrid typed-row read-path bucket shortlist: true|false
//@arg hybrid_read_path_max_rows int Max typed rows sent to heavy recall scoring (range 1-256)
//@arg hybrid_write_path string Persist Hybrid Memory Engine typed row metadata on new memories: true|false
//@arg hybrid_duplicate_fast string Use Hybrid Memory Engine duplicate fast scoring: true|false
//@arg hybrid_duplicate_max_heavy int Max expensive duplicate similarity checks (range 0-200)
//@arg hybrid_scope_index string Persist compact HME scope index and use it for read-path preselection: true|false
//@arg hme_associative_graph string HME associative graph recall: off|light|balanced|deep
//@arg hme_graph_max_seeds int Max HME graph seed rows (range 0-32)
//@arg hme_graph_max_candidates int Max HME graph-expanded candidate rows (range 0-96)
//@arg hme_graph_max_nodes int Hard cap for HME graph nodes (range 64-2400)
//@arg hme_graph_max_edges int Hard cap for HME graph edges (range 128-4096)
//@arg hme_graph_max_hops int Max HME graph traversal hops (range 0-2)
//@arg hme_graph_bonus_cap string Max HME graph bonus added to Recall Scoring V2
//@arg hme_graph_debug string HME graph recall debug: off|compact|full
//@arg character_source_reflection_enabled string Reflect character description/lorebook into LIBRA data: true|false
//@arg persona_binding_sync_enabled string Sync RisuAI persona binding into LIBRA user identity: true|false
//@arg module_lorebook_reflection_enabled string Reflect selected module lorebooks into LIBRA data: true|false
//@arg module_lorebook_selected_ids string Selected module IDs/names/namespaces for lorebook reflection

(async () => {
