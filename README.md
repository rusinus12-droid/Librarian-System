# Librarian System development source

Development snapshot of package **0.3.71**, captured on **2026-10-09 at 14:27:30 UTC**.
This branch contains seven readable **Full** plugins and the source, server, SDK, updater,
build tools, locked development dependencies, documentation, and synthetic test fixtures.

## Qualification

This is an **offline development candidate**. The source builder's SDK synchronization,
syntax, source integrity, clean-data, manifest, checksum, and ZIP readback checks passed.
Full regression, the publication/release gate, and actual-host qualification are **not complete**.
Known regression work remains open. Later fixes in the ongoing working tree are outside this
snapshot. A disclosed metadata-generator-only correction records the existing core3 plugin-global
policy accurately; runtime, plugin and SDK source bytes remain frozen. No release, tag, deployment,
or updater-eligible release asset is published by this branch.

All seven `PROGRAM/plugins/*.js` files are Full developer artifacts. The World Manager Full
artifact was assembled from its pinned sources. No current Min artifacts are included; do not
infer that an older Min artifact is current with these sources.

## Layout

- `PROGRAM/plugins/`: Flashback, HAYAKU, LIBRA, LIA, RETRACE, GRADIA, World Manager
- `PROGRAM/sdk/` and `PROGRAM/server/`: shared source and server runtime
- `PROGRAM/wm/src/`: editable World Manager modules
- `PROGRAM/wm/references/`: hash-pinned build/test inputs required by the existing builder
- `PROGRAM/tools/`, `PROGRAM/tests/`, `PROGRAM/wm/tools/`: builders and regression tests
- `PROGRAM/wm/build-support/`: pinned npm dependency manifest and lockfile
- `DATA/`: newly generated empty distribution scaffold only
- `UPDATER/`: updater source

The historical files under `PROGRAM/wm/references/*/dist/` are required, hash-pinned test/build
fixtures, not current release assets. Synthetic SQLite fixtures under
`PROGRAM/tests/fixtures/authority-preserved/` are test data, never user runtime DATA.

## Prerequisites

Use Node.js **22.13 or newer with `node:sqlite`**. Packaging was checked with Node.js 24.19.0.
Python 3 is needed for `PROGRAM/run_regression_batch.py`. Install the locked development tools:

```sh
npm ci --prefix PROGRAM/wm/build-support
export NODE_PATH="$PWD/PROGRAM/wm/build-support/node_modules"
export WM_TOOLCHAIN="$NODE_PATH"
```

On Windows, set `NODE_PATH` and `WM_TOOLCHAIN` to the absolute
`PROGRAM\wm\build-support\node_modules` directory. Dependencies are not vendored.

## Build readable sources

From `PROGRAM/`:

```sh
node tools/build_plugins.cjs --profile source --out ../../development-Full
```

Create a bounded development candidate with the existing release builder:

```sh
node -e "require('./tools/build_distribution.cjs').buildOfflineCandidate({profile:'source',outputDir:'../../development-packages'})"
```

The ordinary `node tools/build_distribution.cjs --profile source` additionally runs its
publication smoke gate. That gate is not claimed for this snapshot. See
`PROGRAM/docs/RELEASE_BUILDER_20260912.md` for the established builder workflow.

The current builder omits four required synthetic SQLite fixture files from source ZIPs.
This repository restores those exact baseline files after extraction and regenerates its
manifest/checksums. See `DEVELOPMENT-SOURCE-PROVENANCE.json` for the explicit post-packaging
closure and exact hashes. A newly generated source ZIP needs the same closure for those tests.

## Testing and integrity

The preserved test suites are under `PROGRAM/tests/` and `PROGRAM/wm/tools/`.
Run only the intended suites and consult their prerequisites; packaging checks are not a
full regression pass. For one Node test file, for example:

```sh
node --test --test-concurrency=1 PROGRAM/tests/authority_t6a1_admission.test.cjs
```

`PROGRAM/program-manifest.json` records program file hashes; `SHA256SUMS.txt` records the
source package files. The existing repository `LICENSE` is preserved unchanged.
Private work logs, conversation data, diagnostic dumps, credentials, installed dependencies,
and unrelated backup trees are excluded from this publication.
