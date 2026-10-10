# Server migration catalog proof implementation plan

Goal: logical export must preserve the scope inventory promised by its frozen backup manifest, or refuse publication.

Spec: S01/S02 install-wide storage transition plan and the 2026-10-02 recovery plan require complete accessible inventory and verified transfer before authority changes. This is one server snapshot boundary unit; global authority remains open.

Files: `server/portable/logical_migration.cjs` owns export validation; `tests/portable_logical_migration_catalog_proof_test.cjs` uses real five-namespace SQLite/files and archive import readback.

Constraints: exact base `2058bce52dd0088c7eae2c7204b849ce581144f1`; no product embeddings, original DATA/settings, model, embedding, external request or original promotion. Keep schema, timeouts, namespace coverage and legacy no-catalog compatibility.

- [x] Reproduce advertised missing catalog, changed digest, changed byte count and incomplete metadata as failing assertions. Check that refusal leaves source bytes and an existing destination archive intact.
- [x] Validate the advertised catalog file, SHA256 and optional byte count before exporting; retain the existing explicit no-catalog legacy fallback.
- [x] Read back a valid catalog and authority-cleared member digest from the imported real SQLite backup; preserve scope membership, tombstones, local vectors and owner values.
- [x] Run the new test and existing logical migration/transfer, physical identity, catalog fallback and metadata restore regressions under the no-model network guard.
- [x] Record exact outcomes, source/log hashes, remaining global gaps and commit the isolated unit.

Review focus: an unreadable/missing promised inventory must not become empty; self-consistent owner records cannot certify changed catalog bytes; catalog file length must match its proof when supplied; transformed authority fields must update member digests; backups without catalog metadata remain explicitly legacy evidence rather than all-scope proof.

Verification: final unchanged six assertions on exact BASE give 2 PASS / 4 FAIL (exit 1); the four negative cases report missing expected rejection. The same six assertions pass with the implementation. Ten scoped files give 39 PASS / 0 FAIL (exit 0): catalog proof, logical roundtrip, actual portable transfer, catalog fallback, offline metadata restore/recovery, prepared-state export refusal, physical DATA identity, both canonical SDK bindings and manager control. Source/test syntax and `git diff --check` pass. Guard events: zero. Logs and SHA256 index live in the private clone's `PROGRAM/evidence-server-authority/`.

Historical fixture correction: the first fixture used live WAL mode; read-only SQLite opened ephemeral sidecars and the positive exact-directory assertion failed. The fixture now produces a frozen standalone DELETE-mode image before snapshot hashing. No product assertion or budget changed; both initial and corrected RED logs are retained.

Remaining: this proves catalog snapshot integrity at logical export, not owner semantic dependency completeness or global plugin/server authority. Installation inventory/journal/GUI evidence exists in previous backup units but is not established by this server unit. Import namespace-reference validation, per-owner actual caller graphs, global all-scope transitions/resume/new-chat, native host inventory and host-wide atomic authority remain separate. Actual model/embedding/external calls: zero. Full repository suite, release build and native Risu acceptance: UNRUN under the delegated scoped-only boundary.
