# Restore and build this development package

This ZIP is an offline development candidate created by the actual release builder. It is not an updater-eligible release. Full regression, actual-host qualification and production-provider qualification are not established by packaging success. The recorded plugin_only timeline passed 65/65 batches, while the supported server_only timeline failed with out-of-memory after 50/65 batches at 332.43 seconds (about 1.97 GiB retained Node heap and sampled RSS 2.78 GiB). This is an active release blocker, not a legacy mirror exclusion. Later source changes do not clear it without a matching successful rerun.

Consult SOURCE-PROVENANCE.json in this directory for the exact capture time, source identity and Git basis. Later working-tree changes are excluded.

## Safe restoration

1. Verify the downloaded ZIP's SHA-256 against the saved package receipt.
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
