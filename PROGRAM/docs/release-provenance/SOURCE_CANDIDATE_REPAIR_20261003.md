# Source candidate version and byte provenance repair

The 38946c7 source tree failed the existing byte-provenance gate with five `current_row_mismatch` errors. Refreshing only its digests and lengths still failed with four `current_version_collision` errors. Those owners already occupied their current version in the immutable historical ledger with different bytes.

The repair assigns the next unoccupied patch version to those four owners. HAYAKU 3.0.138 has no historical owner/version row, and its former currentRelease record explicitly described unpublished developer input. Its version is preserved and its actual current bytes are recorded. Package 0.3.71 is preserved; no package promotion or publication occurred.

| Owner | Before | Current candidate | Source bytes | Current SHA-256 |
| --- | --- | --- | ---: | --- |
| Flashback | 1.0.100 | 1.0.101 | 2990564 | `20b0520ebdb08f5e538b22c5bedd90e9a16a29afa28bafb57f3d95a673c5186a` |
| HAYAKU | 3.0.138 | 3.0.138 | 3821856 | `db7c1495795c8b8f6a59b4e0be03323a43543b1ca0d7af79a3bfb881b0dece9f` |
| LIBRA | 2.3.148 | 2.3.149 | 5594125 | `5225dca58ef2cdb638d19d5cbba4dda1e6b0434adf5a49603d76ab98bff61f78` |
| LIA | 0.26.82 | 0.26.83 | 1778424 | `05ccd4b6bac28a0532f64b2184da5e0d8082cb5b00d9edfc57ff94bd3fd49922` |
| RE:TRACE | 1.9.83 | 1.9.84 | 1149417 | `3ea9a20dd297e86ef42f0e1dc3e099a65374ea346d8d8b486e72463913f58c16` |

The source producer is `tools/plugin_version_provenance.cjs`. Its default invocation prepares a validated candidate without writing; `--check` rejects pending drift; `--write --backup <path>` backs up the former raw catalog before applying a candidate. The five-file source allowlist comes from `release_metadata.cjs:PLUGINS`. The write report names the four changed owner/file/version pairs. It changes only `//@version`, the single internal `PLUGIN_VERSION`, and already-versioned display names. LIA and RE:TRACE retain their unversioned display names.

After rewriting, the producer rereads the actual plugin files, checks declaration agreement, and validates the candidate against the existing validator before writing currentRelease. Missing/conflicting backups and invalid input fail before source writes. A write error restores every attempted source/catalog write, including a partially written failing file; any failed rollback is reported separately. These are in-process error controls, not a crash-consistency or power-loss claim.

The prior raw catalog is retained at `work/plugin-provenance/previous-unpublished-source-catalog.json` (11588 bytes, SHA-256 `1ff4359c6cdd1f27ff7750ec1d13b2af68e9834a965afaefb44d75f8eccd246c`). Its currentRelease remains a prior unpublished candidate in that backup. It is not appended to releases. All seven historical ledger entries, five anomalies, and coverage declarations are preserved verbatim, including their original status notes. The UTF-8 range from the `"releases"` key to immediately before the `"currentRelease"` key remains 9580 bytes with SHA-256 `1b4883da89e9627d1c2afe33ed7cf84a8a2ba9393d5abc1ce148c3bda74532ac`.

The three normal `release_metadata.cjs:GUIDES` are synchronized through the existing generator: `0_설치_안내.txt`, `PROGRAM/처음_읽어주세요.txt`, and `PROGRAM/PACKAGE_CONTENTS.txt`. Each diff changes only the four installation inventory version rows. Historical audit, release, and frozen byte receipts retain their original bytes and scope.

Run from this candidate's `Librarian-System/PROGRAM` directory with the existing recovery guard and dependencies:

```powershell
$env:NODE_PATH='C:/Users/rusin/AppData/Local/Temp/LIB-WM-Recovery-20261002/test-deps/node_modules'
$env:NODE_OPTIONS='--require=C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs'
$env:RECOVERY_NETWORK_LOG='C:/Users/rusin/AppData/Local/Temp/LIB-Plugin-Provenance-20261003/work/plugin-provenance/network-reproduction.jsonl'
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tools/plugin_version_provenance.cjs
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tools/plugin_version_provenance.cjs --check
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tools/plugin_version_provenance.cjs --write --backup '../../work/plugin-provenance/previous-unpublished-source-catalog.json'
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tools/release_metadata.cjs
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tests/plugin_version_provenance_producer_test.cjs
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tests/plugin_version_provenance_contract_test.cjs
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tests/plugin_version_byte_provenance_test.cjs
node --require 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs' tests/release_metadata_test.cjs
```

On the final private candidate the producer's 51 assertions, the unchanged contract's 10 controls, the existing byte gate's 11 assertions, metadata tests, and syntax parsing of all five plugins pass. Source and catalog partial-write injections restore their exact prior pins. A second normal producer/guide-sync execution changes no plugin, catalog, or guide bytes. The prior five stale rows and four collision failures remain recorded in the evidence.

This verifies readable Source candidate provenance and version metadata only. Reversing the ten changed version literals reproduces each base Git blob exactly, so behavior code and canonical prompts are untouched. No model, embedding, external network, original-tree write, native/global runtime, minified release artifact, full aggregate, or release build was executed. Final combined manifest/checksum regeneration and integration belong to the root owner; this candidate is not release-readiness evidence.
