# Release automation and manual publication guide

The repository uses separate GitHub Actions workflows for PR verification and
official release publication:

- `release-builder-gate.yml`: Validates all pull requests and pushes to `main` using
  the official release builder with non-destructive verification (`--check`). It has
  read-only permissions (`contents: read`) and never creates commits, tags, or GitHub Releases.
- `manual-release.yml`: Triggered strictly on demand via `workflow_dispatch` by an
  authorized administrator on the `main` branch.

## Manual release workflow

Official releases are created only when a maintainer runs the `Manual Release`
workflow on `main`:

1. **Serialization**: Runs serialize with `concurrency: group: librarian-manual-release, cancel-in-progress: false` to ensure two releases cannot run concurrently.
2. **Branch restriction**: Only executions on `refs/heads/main` are permitted.
3. **Transaction state resolution & stable seeds**:
   - In the normal case (`prepare` phase), the workflow reads the current package version from `PROGRAM/VERSION.txt` on the latest `main`, calculates the next patch version via `nextPatchVersion()`, and builds with `--version <nextVersion>`. The seed commit for build ID and generatedAt timestamp is `HEAD`.
   - If a previous execution committed `chore(release): vX.Y.Z` but failed before tag creation or asset upload, the workflow detects the existing release commit on `HEAD` and enters the `resume` phase for that exact version. The seed commit is set to `HEAD^` (the original source commit), ensuring that rebuilds use the identical build ID and timestamp as the initial build. Furthermore, `resume` executes with `--check`, ensuring metadata is refreshed temporarily while restoring the working tree to a pristine clean state matching the release commit.
4. **Idempotency**: If a release tag or GitHub Release already exists on the release commit, existing assets are SHA-256 verified against the current build. Matching assets remain untouched; only missing assets are uploaded.
5. **Publication gate & regressions**: Every publication run executes the official release builder publication gate and full targeted release regressions (release transaction, release-profile reproducibility with `--profile release`, builder profiles, qualification runtime, version input, GRADIA native-input/read-session, Updater migration, and ZIP runtime tests).
6. **Atomic release commit**: Only version transaction files defined in `VERSION_TRANSACTION_RELATIVE_FILES` are committed. If any builder or regression check fails, no commit, tag, or release is created.

## How to trigger a release

1. Navigate to the repository **Actions** tab on GitHub.
2. Select **Manual Release** from the left-hand workflow list.
3. Click **Run workflow**, ensure the branch is set to `main`, and confirm.
