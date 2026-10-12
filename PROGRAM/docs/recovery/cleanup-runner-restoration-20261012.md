# Cleanup runner restoration record (2026-10-12)

## Scope and provenance

This change restores `PROGRAM/run_regression_batch.py` from the supplied Library source. The restored file is byte-identical to that input: 33,945 bytes, SHA-256 `435c75dea13831912ec06f598788b12892669d2344f8fffd13599bcb2d7a92f2`.

The historical `PROGRAM/tests/regression_owned_process_cleanup_test.cjs` was not recovered. Its reported identity is 13,734 bytes, SHA-256 `3799b16c40b0c632967d4ad85a50e43e9fb3523a17c1c18a3fc9f017152250ce`; commit `a62b15c` was unavailable. The same-named test present at the starting commit is an older, different test and is not the source of this replacement. The added test is a new **alternative implementation**, not the lost test or a reconstruction claimed to be byte-identical.

## Focused Linux verification

On Linux x86_64 with Node.js v24.19.0 and Python 3.12.14, the replacement test ran the four process shapes (tokenless child; token-holding child with environment-replaced grandchild; three-generation descendants; parent-exits-first orphan) across normal completion, SIGINT, SIGTERM, and timeout. All 16 conditions passed. Each condition also verified that an independently started control process survived. A Popen-root probe verified that exit code 23 was preserved and reported as failure. The runner's Linux subreaper, SIGSTOP/termination cleanup, recursive descendant discovery, orphan reaper, and root PID protection are covered by these focused checks.

A negative control used the starting-commit runner on the orphan scenario. The test observed the expected orphan remaining after the old runner reported PASS, then cleaned up only the recorded test-owned process after checking its start time and command-line identity using pidfd. The control establishes that this scenario distinguishes the baseline runner from the restored runner.

Additional checks passed:

- `node PROGRAM/tests/program_data_layout_test.cjs`
- `node PROGRAM/tests/manifest_clean_tree_file_set_test.cjs` (2 checks; 2,165 manifest entries)
- `sha256sum -c SHA256SUMS.txt` (2,208 entries)

The candidate manifest and root checksum list were regenerated after adding the replacement test and this record. The former records candidate state; it does not overwrite or claim to reproduce the supplied original manifest/checksum inputs.

## Limits and review notes

This verification was performed on Linux only. Non-Linux behavior is unverified. The full 1,139-test product regression was not run. No real model calls were made.

Static review found a narrow PID-reuse race in cleanup: the runner records bare PIDs and may later send SIGSTOP/SIGKILL without rechecking process start time; it also calls `killpg(proc.pid, ...)` after the root test process has completed. The focused checks did not reproduce PID reuse. The restored runner was preserved unchanged; this record does not imply that the race is fixed.
