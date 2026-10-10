# Required scope inventory proof correction

Goal: refuse logical export without the catalog proof produced by tracked current backup writers; do not infer a legacy producer from missing metadata.

Base: `bf5c636b673ac90b3f397f7550980cf4af773288`. The first catalog unit's no-metadata compatibility assumption was rejected during parent review. That commit and its logs remain unchanged historical evidence.

Contract tracing: earliest tracked producer `990e7b2` (initial 0.3.60 tree) and current `server.cjs` both obtain a catalog through `readScopeCatalogFromDisk`, whose last result is a schema-valid empty catalog, and write it to canonical `scope-catalog.json` with SHA256/bytes in the backup manifest. Restore readers conditionally accept absent catalog metadata, but that permissive reader is not evidence of a tracked no-catalog producer/version suitable for certifying complete logical migration. No tracked producer justifies alternate catalog file names. No supported legacy version discriminator was found. Existing raw snapshot restore compatibility remains separate.

Files: `server/portable/logical_migration.cjs`, `tests/portable_logical_migration_catalog_proof_test.cjs`, this note. Preserve owner schemas, source values, transfer timeouts and the original environment.

- [x] RED: omitted metadata, null metadata, noncanonical file, missing byte proof and versionless file-plus-metadata loss must refuse export while preserving source and destination bytes. Numeric/string/array metadata is also covered.
- [x] Remove empty-catalog fabrication and require canonical file plus digest/byte proof, matching the tracked producer contract.
- [x] Run the exact previous 11 scoped files, source/test syntax and diff checks; preserve previous evidence and commit the correction separately.

Whole-store authority, owner graph completeness/global migrations, SDK installation inventory integration, native GUIs, full-suite/build/release/native/model acceptance remain open or unrun under the scoped task.

Final unchanged catalog assertions on `bf5c636`: 8 PASS / 5 FAIL, exit 1. The five newly reproduced failures are omitted/null metadata, noncanonical file, absent byte-count proof, and versionless file-plus-metadata loss. The same assertions with the correction pass in the previous exact named 11-file command: 52 PASS / 0 FAIL, exit 0. Normal five-owner raw/local vectors/tombstones, catalog member digests, sanitized authority metadata, inactive history, actual portable restore, physical DATA/epoch guards and both SDK binding suites remain checked. Source/test syntax and diff checks pass; guard events and model/embedding/external calls are zero.

Evidence: private clone `PROGRAM/evidence-server-authority/catalog-required-final-assertions-RED.log`, `catalog-required-scoped-regression.log`, `catalog-required-proof-index.json`. Earlier 595ccd/bf5c evidence remains historical and unchanged; this correction supersedes the undocumented legacy fallback, including its initial positive expectation. The exact 11-file command is in `SERVER_MIGRATION_NAMESPACE_PROOF_20261003.md` and the JSON index. No supported legacy logical-export mode is claimed.
