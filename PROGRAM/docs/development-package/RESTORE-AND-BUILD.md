# Restore and build this development package

This GitHub tree is a filtered public derivative of an offline development candidate created by the actual release builder. The original checkpoint ZIP is unchanged. PUBLICATION-EXCLUSIONS.json records the omitted evidence bundle and the origin checkpoint identity. It is not an updater-eligible release. Full regression, actual-host qualification and production-provider qualification are not established by packaging success. The source snapshot remains an unfinished development candidate. Consult the dated qualification section of SOURCE-PROVENANCE.json for the exact verified fixes, active failures and pending current-source checks. A narrow timeout-recovery result is not proof of logical-read or host-anchor readiness.

Consult SOURCE-PROVENANCE.json in this directory for the exact capture time, source identity and Git basis. Later working-tree changes are excluded.

## Safe restoration

1. For the full original checkpoint ZIP, verify its SHA-256 against its saved receipt. For this filtered GitHub export, verify the checked-out commit and the regenerated SHA256SUMS.txt; this tree is not the complete original ZIP.
2. Extract into a new empty directory. Do not overwrite an installed PROGRAM or an existing DATA directory. Preserve the ZIP and existing backups.
3. From the extracted package root, verify SHA256SUMS.txt using your platform's SHA-256 tool. PROGRAM/program-manifest.json independently records program-file hashes and sizes.
4. ZIP names are UTF-8. POSIX .sh/.command launchers are executable (0755); other ZIP files are 0644. Use an extraction tool that preserves those modes, or restore the executable bit only on those launchers.

The package DATA directory is a newly generated empty scaffold, never a backup of user data. Opening source files or running integrity checks does not require starting the server. Do not activate a server, provider, model or data migration merely to inspect this package.

## Source layout

PROGRAM/plugins contains seven readable Full artifacts: Flashback, HAYAKU, LIBRA, LIA, RETRACE, GRADIA and World Manager. PROGRAM/wm/src contains editable World Manager modules; wm/references contains required hash-pinned historical build/test inputs. Historical dist files in those references are not current release artifacts. Current Min artifacts are not included.

PROGRAM/tools, PROGRAM/tests and PROGRAM/wm/tools preserve builders and tests. The synthetic SQLite, WAL, SHM and hot-journal golden files under tests/fixtures/authority-preserved are required source fixtures, never live runtime stores. The repaired source builder preserves and verifies them and the thirteen current WM contract/inventory documents.

## Rebuild

Use Node.js 22.13 or newer with node:sqlite. Packaging was performed with Node.js 24.19.0. Python 3 is needed for the regression batch runner. Install the locked optional development tools when needed:

```sh
npm ci --prefix PROGRAM/wm/build-support
export NODE_PATH="$PWD/PROGRAM/wm/build-support/node_modules"
export WM_TOOLCHAIN="$NODE_PATH"
```

On Windows, set NODE_PATH and WM_TOOLCHAIN to that absolute node_modules directory. Dependencies are not vendored. From PROGRAM:

```sh
node tools/build_plugins.cjs --profile source --out ../../development-Full
node -e "require('./tools/build_distribution.cjs').buildOfflineCandidate({profile:'source',outputDir:'../../development-packages'})"
```

The ordinary build_distribution.cjs --profile source route additionally runs publication smoke checks. Those checks are not claimed for this package. Run only the test suites you intend to exercise and respect their prerequisites; packaging integrity is not an all-regression pass. Some historical evidence-dependent tests may require separately retained development records.

## Public evidence exclusion

The entire selected-mock-results bundle (510 selected records plus its mapping, 511 files total) is intentionally absent from this public export. It contains raw synthetic prompts, request/result records, storage traces and fault evidence. The original full checkpoint is preserved separately. PUBLICATION-EXCLUSIONS.json records the scope and origin; do not infer missing verification records are present in this checkout. Maintained source fixtures and build/test tools remain included. No product code was changed for this filtering step.

## Restore the required reference separately

The current normalization candidate is explicitly unqualified. The historical f64 reference has confirmed updater dependency and WM handoff/rollback defects; restoration is for reference and comparison, not production update. Current fail-closed safety fixes do not establish complete handoff support. This package also contains a finite, hash-bound reverse delta to reference commit f64ef26e1bc6dcd94e160ee4be8d7b66356079a7. It needs neither an older ZIP nor a .git directory. With Python 3 and the Git command-line executable installed, run from the extracted package root:

```sh
python3 PROGRAM/docs/development-package/reference-restore/restore_reference.py --package-root . --output-dir ../reference-source --quarantine-dir ../candidate-preserved
```

Both destination directories must be new. The original candidate package stays unchanged. The helper verifies every package checksum, applies only the sealed reverse source delta in the new directory, preserves candidate-only files and metadata in the separate quarantine, restores the complete required reference source hashes and Git file modes, and regenerates two integrity inventories. Exact historical manifest/checksum bytes remain preserved separately; regenerated metadata is not represented as the historical Git tree. The clean DATA scaffold is retained, never live user DATA. Use `bash script.sh` if a restored reference shell file has its historical non-executable Git mode. Restoring the reference does not establish release, performance or actual-host qualification.
