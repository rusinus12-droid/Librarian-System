# Flashback Pending Vector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Bind already-durable local pending vector groups to one-shot common physical repair, reusing the existing bounded embedding engine.

**Architecture:** A private Flashback adapter captures strict read-only scope/settings/source/storage proof and selected durable groups. Its opaque one-shot controller ticket executes the existing queue with a private strict context, guards at candidate and manifest publication boundaries, and independent effect receipts. Other maintenance modes retain their old route.

**Tech Stack:** Embedded JavaScript plugin, canonical shared HealthRecovery SDK, Node VM fake-host runtime tests, Full/Min artifact builder.

**Spec:** ../specs/2026-10-05-flashback-pending-vector-design-ko.md and ../specs/COMMON-RECOVERY-STANDARD-KO.md

## Global Constraints
- Separate candidate copy; no adopted-tree or user-PC edits, adoption, publication, real provider/network requests, credential/settings writes, migration, server implementation or source deletion.
- Only existing durable pending groups; failures, unknown attempts, archives and migration-required groups remain excluded, with counts.
- Preview is strictly read-only. Execution proof is private and one-shot, source/settings/host/storage-bound.
- Existing raw records and historical generations are preserved; issued effects cannot be represented as rollback.
- Verify actual Full and Min public routes. Synthetic host/provider verification is not real-host certification.

## Review Focus
- Cancellation during internal manifest backup/read work must stop the main publication, but an already-issued publication remains reported.
- Reservation acknowledgement loss before the reserve function returns must retain commit evidence and block provider submission/retry.
- Only progress-journal writes followed by cancellation must not become a no-write result.
- Mixed pending, failed, unknown and migration-required groups must execute only eligible groups.
- Existing credential/settings readers must not silently reconcile storage on the strict execution path.

### Task 1: Common physical-action controller
Files: sdk/MemorySuiteHealthRecovery.source.js; tests/health_action_orchestrator_test.cjs (or focused test).
Interfaces: physicalRepair adapter; action physical_storage_repair; per-operation guard.sealResult(result), guard.isCurrent(). Public proof counts only.
- [x] Add tests for one-shot duplicates, clear-with-running-lock, exact immutable sealed receipt and forged/cross-operation receipts.
- [x] Run the focused tests and observe missing-action/sealing failures.
- [x] Implement physical adapter route and private per-operation receipt identity with no status promotion.
- [x] Run existing and new orchestrator tests; sync canonical embedded regions after all plugin edits.

### Task 2: Strict engine and publication boundaries
Files: plugins/Flashback_Memory.js; tests/flashback_pending_vector_physical_repair_test.cjs.
Interfaces: private physical recovery context threaded through readEmbeddingWorkBoundary, queue, reserve, embedding credential reads and saveOptions; no public bypass.
- [x] Add runtime tests for eligible/excluded grouping, preview zero writes/network, no settings/credential mutation.
- [x] Observe failing missing physical preview/action test.
- [x] Add strict local preview/read context and existing-engine adapter; selected sourceGroups flow through queue and reservation, skip migration only under authentic private context.
- [x] Add guards before candidate writes and after internal manifest awaits, with pre-reservation validation distinct from attempt validation.
- [x] Add fake-host cancellation and lost-ACK tests before implementing corresponding edge handling.
- [x] Preserve separate journal/candidate/manifest/provider receipts through all queue outcomes; never infer success from helper return.
- [x] Run targeted tests and relevant existing Flashback suites.

### Task 3: Existing UI route and artifact verification
Files: plugins/Flashback_Memory.js UI maintenanceRunBtn reembed branch; artifact/manifests; verification reports outside LIB.
Interfaces: healthRecovery.previewPhysicalRepair(), repair(ticket); read-only exclusions/cost warning and independent result counts.
- [x] Add UI/public-path tests before wiring reembed selection to common physical action.
- [x] Build Full/Min from candidate, run public-path fake-host tests on both.
- [x] Run repository-wide Node tests where safe, report every failure/blocked stage by name.
- [x] Update candidate manifests/hashes; produce exact diff, verification logs and reviewer handoff.

## Execution ledger
- Isolated snapshot copy is used because supplied source has no Git metadata. No commit/adoption is performed; exact diff and SHA256 manifest provide review provenance.
- Implementation follows already approved design and delegated execution. Parent owns independent final review.

## Verification rulings
- The supplied source has no Git metadata; a separate snapshot copy, exact diff and SHA256 manifests replace commits. No adoption or publication is performed.
- The project has no package.json test command. Run the complete Flashback/common-health Node test glob, and separately run cross-owner health/source-edit compatibility files. Broader unrelated product tests are not claimed.
- Existing archivePending naming is retained for compatibility, but means total excluded linked archive records, not measured pending archive work; see verification contract.
- All scope-specific implementation steps are complete; final report generation and the independent artifact review are tracked in candidate-root evidence.
