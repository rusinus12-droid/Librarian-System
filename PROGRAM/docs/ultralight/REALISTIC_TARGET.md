# Librarian System — Ultralight: realistic target reset

Status: **measured, evidence-backed** · 2026-09-17 · branch `ultralight-slim`
Supersedes the design's §12 byte budget table (`ULTRALIGHT_DESIGN_v1.0`, 1,000,000 B hard cap per plugin).

> **⚠️ PARTIAL RETRACTION.** The floor table and the reset targets in this document were
> computed by stripping the embedded SDK regions. Verification then showed those regions
> contain **live, called** code (`createMemorySuiteStorageBridge` / `createMemorySuiteComputeBridge`
> are invoked by the plugin body), so removing them deletes working product behaviour.
> **Use `FLOOR_CORRECTED.md` for the floor and the targets.** Everything else here — the
> withdrawal of the 1,000,000 cap, the lever measurements, and the preservation contract —
> stands.

## Why the original target is withdrawn

The design set a hard cap of **< 1,000,000 B per plugin** plus an internal 950,000 B goal.
That target is **not reachable** for any of the three plugins, and the reason is arithmetic,
not effort:

| plugin | minified now | of which is **code** | of which is **string literals** | hard cap |
|---|---:|---:|---:|---:|
| HAYAKU | 2,001,293 | 1,396,454 | 574,704 | 1,000,000 |
| Flashback | 1,608,408 | 1,010,391 | 518,281 | 1,000,000 |
| LIBRA | 3,427,905 | 1,867,596 | **1,529,402** | 1,000,000 |

Source: `esbuild --minify` on the readable sources, split by a string/regex/comment-aware
scanner whose byte accounting reconciles exactly (`code + strings + comments == total`).

**LIBRA cannot reach 1,000,000 B even if every line of executable code is deleted**: its
string literals alone are 1,529,402 B — 1.53× the cap. For HAYAKU and Flashback the cap
requires deleting ~71% and ~60% of all surviving code respectively, which is not slimming
but product removal.

## Levers that were measured, and what each is actually worth

| lever | measured result | available today? |
|---|---|---|
| **L1 comments/headers** | HAYAKU 148,650 B (4%), Flashback 129,417 B, LIBRA 199,254 B | yes — but already counted inside L3; **not additive** |
| **L2 embedded-region strip** | HAYAKU 558,466 B source (15%) → **293,291 B** after re-minify | yes |
| **L3 minify** | HAYAKU −47%, Flashback −47%, LIBRA −42% | yes |
| **L4 `_test` developer surface** | HAYAKU 17,805 B, Flashback 6,509 B, LIBRA 0 B | measured only — release exclusion must be done by the builder, never by regex on the source of truth |
| **bundler tree-shaking** | **impossible** | no `import`/`export`/`require` anywhere; the SDK is inlined IIFE text, so no bundler can see the reachable closure |
| **duplicate-implementation collapse** | 4 recovery orchestrators share **0 identical lines**; scaffolding is 2–33% of each body; the low-level helpers are already extracted | no material saving |
| **code splitting / modularisation** | all three are a single top-level IIFE with 2,000–2,600 nested declarations; LIBRA's `LibraMemoryCore` alone wraps 2,079,076 B (37%) | reorganises bytes, does not remove them |

The design's engineering strategy (comments → SDK closure → duplicate collapse → dev-code
removal → subsystem replacement) was walked in order. Only **L2 + L3** produce bytes, and
together they are not enough.

## Achievable floor — the new baseline target

`tools/ultralight_floor.cjs` builds the floor honestly: strip embedded regions, re-minify,
take the best candidate. Numbers are uncompressed installed bytes.

| plugin | source | floor (L2+L3) | reduction | over cap by |
|---|---:|---:|---:|---:|
| HAYAKU | 3,559,264 | **1,583,263** | 55.5% | 583,263 (37% of floor) |
| Flashback | 2,810,487 | **1,213,607** | 56.8% | 213,607 (18% of floor) |
| LIBRA | 5,556,848 | **2,934,237** | 47.2% | 1,934,237 (66% of floor) |
| total | 11,926,599 | **5,731,107** | 51.9% | 2,731,107 |

Reproduce with:

```bash
node tools/ultralight_floor.cjs          # all three
node tools/ultralight_floor.cjs --json   # machine-readable
```

## The reset targets

Targets are set **at the measured floor**, so they are achievable with the levers that are
proven to exist, and they cannot be met by deleting a user-facing capability.

| plugin | previous target | **new target** | basis |
|---|---:|---:|---|
| HAYAKU | < 1,000,000 | **≤ 1,583,263 B** | measured L2+L3 floor |
| Flashback | < 1,000,000 | **≤ 1,213,607 B** | measured L2+L3 floor |
| LIBRA | < 1,000,000 | **≤ 2,934,237 B** | measured L2+L3 floor |

**Ratchet rule.** A floor is a ceiling to be tightened, not a licence to regress: after any
change the plugin must be **at or below** its current floor, and every improvement lowers the
recorded floor. `tools/check_plugin_size.cjs` enforces the cap; the floor is the review gate.

**Stretch target (optional, feature-preserving).** L4 (release-time `_test` exclusion via the
builder) and any future verified dependency-closure work may push HAYAKU and Flashback toward
~1.55 MB and ~1.20 MB. LIBRA has no such headroom: its floor is dominated by product strings.

## What would be needed to reach 1,000,000 B — for the record

Reaching the original cap requires **explicit user approval to remove user-facing
capabilities**. Per the design's own strategy step 6 that is the only remaining lever. The
required scale, in minified code:

- HAYAKU: delete **71%** of all surviving code
- Flashback: delete **60%**
- LIBRA: **impossible** (strings alone exceed the cap)

No such approval has been given, and this document does not assume one. If it is ever given,
the affected feature IDs must be named explicitly from
`docs/ultralight/preservation_inventory_rebased.json` before any code is touched.

## Preservation contract (unchanged)

Every non-negotiable from `00_START_HERE.md` still applies in full: standalone `plugin_only`
operation, `mirror`/`server_only` authority semantics, native-branch isolation, no
retained-local re-adoption, revision/worldline/source-identity protection, explicit
source-edit consent, no automatic cold start, non-destructive handoff, retry/idempotency and
readback verification, and GRADIA staying inside LIBRA. **A size win that breaks a
preservation test is a failure** — the reset targets are lower bounds on size, never
permission to drop behaviour.

## Evidence trail

| artifact | what it establishes |
|---|---|
| `tools/lib/ultralight_scan.cjs` | string/template/regex/comment-aware scanner shared by all reports (offsets preserved; brace counting is only valid on the masked form) |
| `tools/ultralight_layer_report.cjs` | byte attribution by layer, with embedded-region and comment accounting |
| `tools/ultralight_feasibility.cjs` | per-lever feasibility, including the "not additive" reasoning |
| `tools/ultralight_floor.cjs` | the achievable floor this target is set at |
| `tools/check_plugin_size.cjs` | the size gate (uncompressed bytes, missing artifact = failure) |
| `docs/ultralight/size_baseline.json` | baseline bytes + sha256 per plugin |
| `docs/ultralight/preservation_inventory_rebased.json` | 70-row rebased preservation inventory (current tree, not the 0.3.60 handoff) |

### Measurement rules (unchanged, enforced)

Uncompressed installed JS bytes only. ZIP/gzip, `.length` and line counts are never a
substitute. A missing artifact is a failure. A test pass without a fresh byte measurement is
not a size-gate pass.
