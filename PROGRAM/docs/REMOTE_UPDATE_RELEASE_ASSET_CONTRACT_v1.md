# Librarian System GitHub Release Asset Contract v1

Official repository: `https://github.com/rusinus12-droid/Librarian-System`

## Stable release naming

- Git tag: `v<version>` (example `v0.3.52`)
- Release title: `Librarian System v<version>`
- Upload asset: **`Librarian-System-<version>.zip`**
- GitHub-generated source ZIP/TAR is not an updater payload.
- Timestamp/random suffixes are not used in the public release ZIP name. Build identity stays in the build report.

## One ZIP is both installer and updater payload

The official release ZIP contains:

```text
Librarian-System-<version>/
├─ PROGRAM/
├─ DATA/                    # clean install template only
├─ UPDATER/
├─ 업데이트.bat
├─ 업데이트.command
├─ 업데이트.sh
├─ update-manifest.json
├─ SHA256SUMS.txt
└─ 0_설치_안내.txt
```

The `DATA/` inside the release is a clean template for a new install. It is never copied over an existing user's active DATA by the updater.

## Verification order

1. GitHub stable Release and exact asset name.
2. GitHub release asset `sha256:` digest against the downloaded ZIP.
3. ZIP32/path/CRC boundaries.
4. Internal `update-manifest.json` repository, tag, version, asset name, compatibility and update policy.
5. Internal `SHA256SUMS.txt` against every other file in the extracted release.
6. PROGRAM component versions and clean DATA template.
7. Prepare a separate `PROGRAM.next` candidate. Phase 1 does not activate it.

## Release policy

Source-controlled `PROGRAM/release-policy.json` declares one of:

- `program_only`
- `migration_required`
- `manual_required`

The current Phase 1 package uses `manual_required`; actual install/apply remains disabled until rollback-first switching is implemented and tested.

## Builder output

The Release Builder emits in a version-specific output directory by default:

```text
RELEASES/v<version>/
├─ Librarian-System-<version>.zip
├─ Librarian-System-<version>.build-report.json
└─ Librarian-System-<version>.GITHUB_RELEASE_INFO.txt
```

The ZIP name is stable and exact. If the same version artifact already exists the builder refuses to overwrite it.
