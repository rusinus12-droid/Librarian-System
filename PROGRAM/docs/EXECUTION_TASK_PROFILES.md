# Execution-contract task profiles

`MemorySuiteExecutionContract.source.js` remains the common implementation. The build-time `sdk/MemorySuiteExecutionProfiles.json` assigns each existing embedding its intentional task policy. There is no runtime profile switch and no new analyzer, provider call, queue, storage authority, or model budget.

- `legacy-compatible`: shared source, Flashback, and HAYAKU retain every existing default, including legacy SGA declarations. A declaration is not an engine or a new caller.
- `libra`: retains every existing LIBRA default, including `canonical_memory` (32768 visible / 65536 total) for normal Librarian scanning; adds the already-used `micro_memory` (2048 / 4096) to the shared base and omits the five already-retired SGA task declarations. All other defaults remain unchanged. LIBRA is not micro-only.
- Unknown tasks, including omitted LIBRA SGA tasks, retain the exact `UNKNOWN_TASK_KIND` error. No fallback or task alias is introduced.

From PROGRAM:

    node tools/sync_execution_contract.cjs
    node tools/sync_execution_contract.cjs --check
    node tests/execution_task_profiles_test.cjs

Sync reads and validates the manifest, shared source, and all three target blocks before writing any target. Missing/duplicate contract or task blocks, mismatched marker versions, malformed shared/generated/target JavaScript, unsupported manifest versions, missing/extra products, unknown profiles/removals, duplicate removals, existing-task budget overrides, and invalid or sparse source budget pairs fail closed. The check compares the entire generated contract, so only the declared task table may differ between profiles. Filesystem write failures are still ordinary I/O failures; this tool does not promise a transactional multi-file filesystem commit.

Build actual Full and Min plugin artifacts with the existing pinned offline toolchain and run:

    EXECUTION_PROFILE_ARTIFACTS=/absolute/path/to/artifacts node tests/execution_task_profiles_artifact_test.cjs

The directory must contain `Full/plugins` and `Min/plugins`, produced by `tools/build_plugins.cjs --profile source` and `--profile release`. The test fails if either artifact is missing, extracts and evaluates the contract from each actual artifact, and checks the frozen pre-alignment policy matrix plus representative ledger/vector/terminal rejection semantics. This is offline execution-contract verification, not live host/provider certification or content-analysis replacement.
