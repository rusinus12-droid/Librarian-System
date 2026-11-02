# Release automation recovery

The `release-builder-gate` job validates pull requests. The `main-release` job
publishes only after a push to `main`; the two jobs are intentionally separate.

`main-release` serializes runs with `cancel-in-progress: false`. The workflow
checks out the triggering `GITHUB_SHA` and searches the complete `main` history
for a release commit whose parent is that event commit. This preserves recovery
when later commits have already landed on `main`; the recovery commit is not
recomputed from the newest unrelated change. A release commit
(`chore(release): vX.Y.Z`) is a durable transaction marker. If a run fails
after that commit is pushed, rerunning the workflow rebuilds the exact version
and reuses an existing tag or GitHub Release when it points to the same commit.
It never increments the version again. A tag or Release pointing to a
different commit is treated as a collision and stops safely. If the recovery
commit is already reachable from current `main`, the push step is a no-op.

The workflow requires `contents: write` for `GITHUB_TOKEN`. Repository rulesets
or branch protection must allow the GitHub Actions bot to push the release
commit to `main` and create tags, or the workflow will stop with the push
error. The workflow never disables protection or force-pushes. If direct
pushes
to `main` are prohibited, use an approved repository policy that permits this
specific workflow, or replace the push step with a reviewed human/PR promotion
process before enabling publication.

If a GitHub Release already exists, each local asset is downloaded and
SHA-256 compared with the current verified build. Matching assets remain
untouched; only missing assets are uploaded. A same-name asset with different
content stops the retry rather than overwriting it.

Every publication run executes the release-builder checks plus the targeted
Release Builder, GRADIA native-input/read-session, Updater, and Migration
regressions. Build reports, the target commit, tag, Release URL, and a
rerun procedure are written to the GitHub Actions Job Summary.
