# Six-plugin regression checkpoint

This checkpoint preserves the active six-plugin source plus current test-only work. The active test runner still contains all 1,138 original root identities. Read REGRESSION-STATUS.json for the fixed cutoff and bounded outcomes. The test-successors directory is not an active runner input.

Successors 001 and 002 were verified on isolated inputs. Successor 003 is prepared and not executed. Three fully duplicated wrapper tests are eligible for retirement after coverage-preserving documentation changes; no whole-file retirement has been applied. Original tests remain in PROGRAM/tests, so these candidates are reversible without an earlier ZIP or Git history.

Failures, profile blockers, timing limits and host requirements remain open; this source package is not a full-regression approval. Raw synthetic evidence is private and is not part of the public source supplement.
