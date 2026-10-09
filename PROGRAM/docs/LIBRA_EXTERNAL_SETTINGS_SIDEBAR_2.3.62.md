# LIBRA 2.3.62 — external settings sidebar

Existing reading pages and memory/storage/analysis pipelines are unchanged. The visible sidebar now directly exposes agent workbench/detail, performance/recall settings, character-lore exclusions, module lore, combined lore/author notes, custom workshop, server, AI, embedding, JSON transfer and diagnostics. Backup, input-writer, State-application and execution-log entries remain accessible.

Each entry calls an existing settings panel and its existing save handlers. AI and embedding compatibility navigation now opens the main settings workspace; the quick drawer remains available through its explicit Quick Settings action. The nested settings-room index and reference tabs are hidden in the restored sidebar workspace. A narrow-screen settings selector reaches the same destinations without marking settings dirty.

Navigation retains unsaved settings, closes a previously open quick drawer, refreshes lore catalogs only for their respective selections, and blocks sidebar/selector navigation while quick-settings saving is active. No new persistence schema, AI call, canonical data migration or backend route is introduced.

Verification uses production GUI/navigation functions with DOM substitutes plus existing GUI lifecycle/save/routing and memory runtime tests. Actual RisuAI rendering remains a separate live check. Task evidence and the standalone installable plugin are in `review_artifacts/libra_sidebar_settings_20260908` outside the package.
