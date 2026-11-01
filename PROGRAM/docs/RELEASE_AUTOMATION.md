# Release automation recovery

The `release-builder-gate` job validates pull requests. The `main-release` job
publishes only after a push to `main`; the two jobs are intentionally separate.

`main-release` serializes runs with `cancel-in-progress: false`. A release
commit (`chore(release): vX.Y.Z`) is a durable transaction marker. If a run
fails after that commit is pushed, rerunning the workflow rebuilds the exact
version and reuses an existing tag or GitHub Release when it points to the
same commit. It never increments the version again. A tag or Release pointing
to a different commit is treated as a collision and stops safely.

The workflow requires `contents: write` for `GITHUB_TOKEN`. Repository rulesets
or branch protection must allow the GitHub Actions bot to push the release
commit to `main` and create tags, or the workflow will stop with the push
error. The workflow never disables protection or force-pushes. If direct
pushes
to `main` are prohibited, use an approved repository policy that permits this
specific workflow, or replace the push step with a reviewed human/PR promotion
process before enabling publication.

Every publication run executes the release-builder checks plus the targeted
Release Builder, GRADIA native-input/read-session, Updater, and Migration
regressions. Build reports, the target commit, tag, Release URL, and a
rerun procedure are written to the GitHub Actions Job Summary.
