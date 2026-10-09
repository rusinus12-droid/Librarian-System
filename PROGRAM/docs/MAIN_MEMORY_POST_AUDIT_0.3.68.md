# Main Memory post-audit — 0.3.68

**Scope:** Phase D status plus Phase E release provenance, Source portability, and package integrity. This report describes the readable Source profile; minified release plugin hashes and final ZIP hashes are recorded in the worker evidence packet outside the shipped Source tree.

## Release state

**Overall release verdict: BLOCKED.** Phase D's candidate-cancel responsiveness risk remains unresolved. The user-directed 750+ regression was not run. A43 (real external-model blind scoring) and A44 (live RisuAI host manipulation) were not run. The requested worker selector was `gpt-6-luna/xhigh`; no runtime receipt exposed the effective model, so it remains **UNVERIFIED**.

The current Source acceptance reporter accounts for all 44 cases across three modes (132 rows): **0 PASS, 122 BLOCKED, 10 EXIT_UNVERIFIED**. Its ten older action-evidence rows no longer match the current LIBRA source hash and are not carried forward as current evidence. A43 and A44 remain BLOCKED. The reporter only accounts for evidence; it does not launch acceptance suites.

## Phase E changes

- Package version is **0.3.68**. Version policy required advancing past the existing 0.3.67 Source archive.
- Source provenance is explicitly `profile: source`. It records six readable Source archives and 30 plugin rows. Five historical owner/version collisions remain disclosed as anomalies; historical ZIP records were preserved. The current rows are verified against all five readable plugin files.
- Flashback moved to 1.0.100, LIBRA to 2.3.145, LIA to 0.26.82, and RE:TRACE to 1.9.83 because their current version labels belonged to ambiguous historical byte streams. HAYAKU remains 3.0.136 because that owner/version has one historical Source digest. An ambiguous owner/version cannot be reused by a current release, even when its hash matches one old record. Unchanged bytes may retain an unambiguous version.
- The acceptance reporter's synthetic marker is named `acceptance_reporter_sample.jsonl.fixture`. Ordinary JSONL privacy filtering remains enabled. Its regression control is included in release smoke.
- Current Source fixture and portability checks pass. The focused replay/correction handle test exited naturally in all three storage modes; no hang reproduced at this snapshot.

## Measured plugin floors

The release profile used cached Terser 5.51.2 under Node v24.18.1. Each floor is set to the exact measured artifact size, with zero headroom. LIBRA source at 5,970,216 B (SHA-256 `ff6d2d648dddfbb3ed77d2a37d89cd7f4743b87e57a03e4a2285ffdda57c330e`) minified to 3,394,966 B (SHA-256 `f01b23ce2eae842fd5068bda038373a0059cffe5cf6119c2bc6aa3b3e4917b72`), which is **67,648 B** over its prior 3,327,318 B floor. The floor now equals the measured output; this does not resolve the separate D4 responsiveness risk.

| Plugin | Prior floor (B) | Measured output / new floor (B) | Change (B) |
|---|---:|---:|---:|
| HAYAKU | 1,788,914 | 1,788,914 | 0 |
| Flashback | 1,498,071 | 1,498,074 | +3 |
| LIBRA | 3,327,318 | 3,394,966 | +67,648 |
| LIA | 1,024,058 | 1,024,058 | 0 |
| RE:TRACE | 609,054 | 609,054 | 0 |

The LIBRA floor's prior basis was `0a6c5b98b33b37e9d3c019930c93ff6edd5959d0`. From that basis to the measured Source, `plugins/LIBRA.js` changed by 2,059 insertions and 197 deletions. The build gate was measured from a clean committed archive. The independent extraction readback, full per-plugin version/hash/byte rows, internal checksum results, and final archive digests are in `review_artifacts/PHASE_E_20260927/product-worker-result.v1.json` and its referenced evidence files.
