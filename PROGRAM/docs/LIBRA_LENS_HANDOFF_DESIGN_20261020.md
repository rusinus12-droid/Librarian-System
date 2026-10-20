# LIBRA lens memory: next-session handoff (design, 2026-10-20)

Status: **design only, not implemented.** It extends `LIBRA_LENS_MEMORY_DESIGN_20261020.md`.

## Problem

RE:TRACE hands a chat's memory to a successor chat. LIBRA's handoff package carries the canonical
memory refs, the shared-archive lineage, the Micro archives, and the story-arc and State seeds. It
does not carry lens notes. A successor chat starts with the same lens definitions (they are global)
but an empty lens memory, so everything the lenses collected is lost at each handoff.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | What is carried | Notes of **active and paused** lenses. Trashed lenses are not carried. |
| 2 | Recall in the successor | Inherited notes are **recalled** inside the lens budget, marked as coming from a previous chat. They are also readable in the lens tab. |

## Model: the same shape as the Micro handoff archive

LIBRA already hands Micro records over as an immutable, digest-checked archive that the successor
keeps by reference (`microArchiveRefs`, `inheritedMicroArchives`). Lens notes use the same shape, so
the verification, the rollback and the RETRACE receipt steps stay the same kind of step.

```
source chat                                          successor chat
lens records (per lens) ─ prepareSessionHandoff ─▶  lens-handoff-archive:<transferId>:<lensId>
                          package.lensArchiveRefs ─▶ manifest.inheritedLensArchives
```

### Archive

- **One archive per transfer and lens.** Key `libra:v1:lens-handoff-archive:<transferId>:<lensId>`.
  The key is not bound to a chat scope, like `micro-handoff-archive`.
- **Content.**
  - The lens's records of the source chat's active worldline.
  - Only records that are still current at prepare time: the source digest matches the live chat.
  - The lens definition snapshot: name, labels, evidence mode, and the instruction text with its
    revision.
- **Schema.** `libra.lens_handoff_archive.v1`, with a records digest and an archive digest, built
  and validated like `makeMicroHandoffArchive` and `validateMicroHandoffArchive`.
- **Why one archive per lens.** Permanent delete of a lens removes that lens's archives by key
  across every chat, and no archive digest has to be rewritten.
- **Size bound.** A lens keeps at most 400 records per chat. If an archive would exceed the value
  size guard, only the newest records are kept and the ref carries `truncated: true`, shown to the
  user in the handoff preview.

### Package and manifest

- **Package fields.** `lensArchiveRefs` and `lensArchiveRefsDigest`. Each ref holds the archive key
  and digest, the lens id, the source scope key, the session epoch, and the record and item counts.
- **Inheritance chains.** The source's own `inheritedLensArchives` are carried forward after its
  own new archives, as `inheritedMicroArchives` are. A chat handed over twice still holds the notes
  of the first chat.
- **Successor manifest.** `manifest.inheritedLensArchives` holds the refs. The successor never
  rewrites an inherited archive.
- **Receipt and verification.** The handoff receipt gains `expectedLensArchives` and
  `expectedLensRecords`. Completion verification reads every archive back and compares the digests
  and counts, as it does for Micro (`readMicroHandoffArchive`).

### Source immutability

The handoff proves the source did not change: `sourceFingerprintBefore` equals
`sourceFingerprintAfter`. Lens runs write to the source chat's lens keys in the background, so they
could break that proof.

- **Freeze the lens queue during prepare.** Raise a freeze depth next to the existing
  `handoffSourceFreezeDepth`, and wait for the running lens call to finish or be discarded before
  the source is captured. Queued jobs wait and resume after the handoff.
- **Include lens records in the fingerprint.** The source fingerprint covers a digest of the lens
  records that go into the archives, so a change during prepare is detected like any other.

### Server-backed storage modes

`prepareSessionHandoff` already refuses to run when the storage mode is mirror or server-only
(`UNIFIED_BACKEND_NOT_SUPPORTED`), because the package contract is plugin-only. The lens archive
inherits that rule and adds none. When that contract is extended to server modes, the lens archives
follow the same route as the Micro archives, since they are ordinary plugin-space keys.

## The successor chat

- **Reading.** Inherited notes are read-only. They are validated by the archive digest, not by the
  live chat: their source turns belong to the previous chat, so the live-chat digest check used for
  a chat's own notes does not apply to them.
- **Lenses.** Definitions are global, so the successor already has them. An inherited note shows
  under its lens by lens id.
  - A trashed lens: its inherited notes are hidden and not recalled, like its own notes.
  - A permanently deleted lens: its archives are deleted too (see below), so nothing remains.
- **Instruction change.** If the lens instruction changed since the note was made, the note keeps
  the "이전 지침으로 생성" badge and its diff. The archive stores the instruction text that made it.

### Lens tab

Inherited notes appear in a separate group, "이전 대화에서 넘어온 기록", under the lens filter.

- Each note shows the same card as a normal note, with a "이전 대화" badge and the source chat's
  turn range (the source chat's name is shown when the scope manager knows it).
- The source excerpt and the quote are shown from the archive. The note's refs name turns of the
  previous chat, so the "근거 · 출처 보기" fold shows the stored quote and basis, and no live turn.
- Inherited notes cannot be edited or deleted one by one. They go away when the lens is
  permanently deleted, or with the whole handoff when RE:TRACE rolls it back.
- The lens card in the studio counts inherited notes separately from this chat's notes.

### Recall

- **Budget.** Inherited notes compete inside the existing lens budget. They never use canonical
  budget and never raise the lens cap.
- **Order.** A note made in the current chat ranks above an inherited note of equal relevance, so
  the current story is not crowded out by the previous one.
- **Relevance.** The same floor applies: an inherited note needs words in common with the input.
  The "recent" recall mode counts only the current chat's records.
- **Label.** `[lens:이름 · 이전 대화]`, or `[lens:이름 · 이전 대화 · 해석]` for an interpretation.
  The block header is unchanged: lens notes never override canonical memory.
- **Sanitizing.** The same one-line sanitizing applies to archive text; it is applied again when a
  note is rendered, not trusted from the archive.
- **Recall viewer.** Skipped inherited notes use the same reason labels. A new reason,
  `inherited_archive_unavailable` ("이전 대화 기록을 읽지 못함"), covers an archive that failed its
  digest check; it is shown, and recall continues without that archive.

## Permanent delete and privacy

A permanent delete of a lens must leave nothing of it behind.

- Delete the lens's `lens-handoff-archive:*:<lensId>` keys everywhere.
- Remove the matching refs from every `manifest.inheritedLensArchives` that lists them.
- A successor chat that is not currently loaded is cleaned the next time it is opened, from the
  lens registry's list of purged lens ids. The purged id stays in that list so late copies are
  ignored until they are removed.

## RE:TRACE

- **Handoff preview.** The preview lists lens notes: "렌즈 기억 N개 · 렌즈 M개", with a truncation
  warning when it applies.
- **Verification and receipt.** The receipt shows the verified lens archive and record counts next
  to the Micro counts. A mismatch fails the handoff the way a Micro mismatch does.
- **Rollback.** Rolling a handoff back removes its lens archives and the successor's refs.
- **Scope manager.** `lens-handoff-archive` keys are listed as "렌즈 승계 보관" and deleted with
  the handoff. They are classified through the same path as `micro-handoff-archive`.
- **Version gate.** The required handoff contract version rises, so an older RE:TRACE does not
  silently drop the lens part of a package.

## Native chat copy

A chat copy made by the host is a branch of the same history, so the source's own lens notes are
valid there. `nativeChatCopy` already carries the source's inherited Micro archives. For lenses,
the copy builds lens archives from the source's own records, in the same way as a handoff, and
carries the source's inherited lens archives along. This is phase 2 below.

## Phases

1. **Archive and package.** Build, validate and store the lens archives. Add the package fields,
   the receipt fields, the verification, the rollback, and the queue freeze during prepare.
2. **Successor reading.** Read inherited archives. Add the lens tab group, the recall integration,
   and the purge handling.
3. **RE:TRACE and native copy.** Add the preview, the receipt rows, the scope manager entry, the
   contract version gate, and the native copy.

## Tests to add

- **Round trip.** Notes of active and paused lenses reach the successor; trashed lenses do not;
  the archive digest and the counts verify.
- **Immutability.** A lens run that starts before prepare is settled first; a lens write during
  prepare is detected; queued runs resume after the handoff.
- **Chains.** A second handoff carries the first chat's notes forward.
- **Recall.** Inherited notes stay inside the lens budget, rank below the current chat's notes,
  carry the label, are sanitized again, and a corrupted archive is skipped with the reason shown.
- **Isolation.** The handoff never changes canonical memory, State or the people cards.
- **Delete.** Permanent delete removes the archives and the refs, including in a chat that is not
  loaded; a rolled-back handoff leaves no lens archives.
- **Browser.** The lens tab group, the badges and the read-only cards at 1280 and 390 px.

## Risks

- **Archive size.** A busy lens can approach the value size guard. The newest-records rule and the
  visible truncation flag bound it; a very large transfer may need chunked storage, as the Micro
  archive already uses.
- **Source of truth for deleted notes.** A note a user deleted in the source chat before the
  handoff is not carried (the archive is built from the current records), but a note deleted after
  the handoff stays in the archive. That is intended: the handoff is a snapshot.
- **Contract version.** Raising the handoff contract version forces RE:TRACE and LIBRA to update
  together.
