# Server logical migration namespace proof plan

Goal: bind every v1 namespace record/history descriptor to its verified archive member before reading or publishing imported owner data.

Spec: S01/S02 recovery requirements preserve owner namespace, scope and complete verified readset through migration. The v1 producer already names records `namespaces/<namespace>.jsonl` and inactive history `history/<namespace>-operations.jsonl`; their member roles are `namespace_records` and `inactive_operation_history`. This unit preserves that existing serialization contract.

Base: catalog-proof unit `595ccd4ed9a38a3d97621f2cef2c1329d3c6df77`, original integration base `2058bce52dd0088c7eae2c7204b849ce581144f1`. Files: `server/portable/logical_migration.cjs`, `tests/portable_logical_migration_namespace_proof_test.cjs`, this note. No product/embedded SDK, DATA/settings or common build changes.

- [x] Reproduce wrong namespace record/history references, a reference outside the verified archive readset, and wrong member roles using self-consistent real archive files.
- [x] Extend `validateMigrationManifest` to require each existing v1 namespace file/history reference and role. Call the same validator on the producer manifest before packing.
- [x] Verify refusal occurs before extraction/manual backup allocation and retains existing backups; verify valid five-owner SQLite values, raw/vector identity, catalog digest and inactive operation history by fresh reads.
- [x] Run both new units and existing scoped migration/transfer/identity/catalog/metadata regressions; verify syntax/diff, retain RED and GREEN evidence, then commit.

Review focus: archive SHA256 alone does not bind a namespace descriptor to its member; valid generic JSON from another owner remains foreign; history is retained evidence and must keep its namespace; a referenced external file is outside the certified readset even when it exists; refusing bad references must precede extraction and destination publication.

Whole installation inventory, per-owner semantic graphs, durable global transition/adoption/currentness/resume/new-chat and registered native GUIs remain open. This unit does not certify global authority or models.

Final namespace RED on the previous catalog-only commit: 1 PASS / 5 FAIL, exit 1; all five negative assertions report missing expected rejection. The same assertions with the fix pass in the combined 11-file run: 45 PASS / 0 FAIL, exit 0. The initial path-escape diagnostic used a missing outside file and returned ENOENT from the external path. The final unchanged test supplies a real valid external row within its private fixture; the old importer accepts it, proving the readset bypass. Both logs remain available. Exact source/test syntax and diff checks pass. No guard events, models, embeddings or external requests occurred.

Guarded command from `Librarian-System/PROGRAM`, with `NODE_PATH=C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules` and inherited `NODE_OPTIONS=--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs`:

```text
C:/Program Files/nodejs/node.exe --test --test-concurrency=1 --test-reporter=tap --test-timeout=60000 tests/portable_logical_migration_namespace_proof_test.cjs tests/portable_logical_migration_catalog_proof_test.cjs tests/portable_logical_migration_roundtrip_test.cjs tests/portable_logical_transfer_runtime_test.cjs tests/scope_catalog_fallback_test.cjs tests/offline_migration_aux_restore_test.cjs tests/offline_migration_aux_crash_recovery_test.cjs tests/portable_migration_pending_state_guard_test.cjs tests/server_data_instance_identity_runtime_test.cjs tests/sdk_data_instance_binding_runtime_test.cjs tests/manager_control_runtime_test.cjs
```

Evidence root: private clone `PROGRAM/evidence-server-authority/`, with `namespace-final-assertions-RED.log`, `namespace-scoped-regression.log` and `namespace-proof-index.json`. The earlier unit has a separate catalog index and RED/GREEN logs. Full repository suite, release build/size acceptance, native Risu and original integration: UNRUN under this delegation. Cross-owner implementation was neither changed nor certified.
