# GRADIA HypaV3 reader removal

The active GRADIA plugin no longer reads native HypaV3 chat storage, host selection metrics, or injected Past Events Summary aggregates. The removal covers snapshot capture, SHADOW/AIDE shared-reference assembly, canonical reference packing, engine planning, budget reservations, settings/import/export fields, Materials navigation, catalog loaders, and the Hypa-specific public/debug APIs.

Host-injected summary blocks are removed from GRADIA's system/developer context before private stage prompts are built. Other system rules remain, and ordinary user/assistant message text is unchanged. Host memory messages marked `hypaMemory` or `supaMemory` remain excluded from ordinary lore; such system/developer memory messages are also excluded from private system context.

The ordinary recent-turn reader and the separate LIBRA/HAYAKU/Flashback read-only server integration remain in place. Retired exclusion settings are ignored on import. The change does not delete stored user data or modify historical frozen fixtures. Prior release-history comments describe their historical versions, not the current reader contract.

The focused regression `tests/gradia/hypav3-removal.test.cjs` covers poisoned raw-property getters, live SHADOW/AIDE transport payloads, system aggregate and memo-only sentinels, native recent-turn preservation, stale canonical/engine packets, ignored imports, absent APIs, and Materials navigation. Transport is deterministic and offline; no real provider request is sent.
