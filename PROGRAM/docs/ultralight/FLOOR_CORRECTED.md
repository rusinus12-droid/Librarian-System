# Ultralight floor — corrected measurement

Status: **measured** · 2026-09-17 · supersedes the floor table in `REALISTIC_TARGET.md`

## What was wrong

A first floor figure was produced by stripping the four embedded SDK regions from the
source and re-minifying (HAYAKU 1,583,263 B, Flashback 1,213,607 B, LIBRA 2,934,237 B).
**That figure is invalid**, and writing it into a target document was a mistake. Verification
of the strip showed why:

```
region      factory defined                    referenced OUTSIDE the region?
storage     createMemorySuiteStorageBridge     YES  (all three plugins)
compute     createMemorySuiteComputeBridge     YES  (all three plugins)
lineage     —                                  no factory; still product code
portable    —                                  product code (backup/import/restore)
```

The embedded regions are not additive decoration — they are **the plugin's live storage and
compute client**, called by the plugin body. Deleting them removes working product code and
would break `plugin_only`, `mirror` and `server_only` operation outright. A text-level strip
also produced output that terser refused to parse during the investigation, which is
independent evidence that naive removal is unsafe.

**Corollary:** the "SDK closure" lever in the design (§6, strategy 2) cannot be executed as
text subtraction. It could only be executed by a real rebuild that keeps the reachable
closure — and no bundler can help, because the regions contain no `import`/`export`/`require`.

## The corrected floor

The only levers that remove bytes **without deleting product behaviour** are:

| lever | what it does | verified safe? |
|---|---|---|
| **L3 minify** | whitespace, comments, identifier compression | yes — artifact passes `node --check` |
| **L4 `_test` exclusion** | drops the developer-only export property from the release object | yes — `_test` is the documented dev harness surface (design §11.5), not a product API |

Everything else (embedded regions, product layers) stays.

| plugin | source | **release artifact** | reduction | directives |
|---|---:|---:|---:|---:|
| HAYAKU | 3,559,264 | **1,880,936** | 47.2% | 51 |
| Flashback | 2,810,487 | **1,509,247** | 46.3% | 89 |
| LIBRA | 5,558,443 | **3,234,515** | 41.8% | 110 |
| LIA | 1,681,891 | **1,004,406** | 40.3% | 10 |
| RE:TRACE | 1,074,548 | **603,578** | 43.8% | 12 |
| **total** | **14,684,633** | **8,232,682** | **43.9%** | 272 |

### Shipped: dev/release split

`tools/build_distribution.cjs` builds **two** artifacts from one code standard:

| profile | plugin payload | who it is for |
|---|---|---|
| `release` (`배포본_만들기.sh`) | the 8,232,112 B minified set | users; ZIP shrinks 3.86 MB → 2.85 MB |
| `source` (`개발본_만들기.sh`) | the readable 14,683,038 B sources | development and debugging |

The readable `PROGRAM/plugins/*.js` are never modified — the swap happens on the staged
tree — so the 164 source-text contract tests keep reading exactly what they always read.

All five plugins ship minified. LIA and RE:TRACE were added to the target set: a release
that is half minified and half readable is worse for support than either extreme, and an
ungated plugin has no ceiling.

`tests/ultralight_release_runtime_test.cjs` verifies the artifact SET that is actually
packaged (5/5 load, expose their API, keep every host directive).

### Host directives are part of the floor, not overhead

An earlier floor was measured with a header step that read only the FIRST 512 BYTES of each
plugin. Real plugins declare their directives in two places, so that step silently deleted
107 of LIBRA's 110 directives — including all 104 `//@arg` lines that RisuAI turns into the
plugin's **user-facing settings UI**, plus `//@allowed-ipc` (peer bridge) and `//@update-url`
(update check). The defect is invisible to source-text tests because they all read the
readable source and never the artifact; it was found by comparing directive counts between
source and artifact. Those ~4–9 KB are a product requirement, so the floor now includes them
and the runtime test asserts **directive parity with the source** (duplicates included:
HAYKU legitimately declares `//@allowed-ipc` twice).

### Recorded gap: `_test` exclusion is deferred

`_test` removal was attempted with three text-level strategies and **all three produced
unparsable output**:

1. cutting the `_test: { … }` property extent — the literal shares a LINE with its parent
   object literal, so comma/brace handling kept corrupting the parent;
2. cutting follow-up `publicApi._test.x = y;` statements — left the property undefined and
   the plugin threw `Cannot set properties of undefined (setting 'buildUiHtml')` at load;
3. rewriting the property opener — shifted the following property list out of its object.

Design §11.5 requires an AST/builder step for exactly this and forbids regex surgery.
Until that step exists the build **keeps `_test` and claims no bytes for it**, and
`tests/ultralight_release_runtime_test.cjs` records the surface so the gap cannot be
forgotten. The three attempts are also the reason the build pipeline now verifies the
ARTIFACT (`node --check` plus a real load), not just the readable source.

Reproduce (writes `dist/plugins/`):

```bash
node tools/build_plugins.cjs
node tools/build_plugins.cjs --no-minify     # readable release shape
node tools/build_plugins.cjs --strip-regions # experiment; REFUSES to write unparsable output
```

Every artifact is verified with `node --check` **on the artifact itself**, and the plugin
header (`//@name`, `//@api`, `//@version`, display metadata) is extracted first and
re-assembled on top, so header stripping can never lose it.

## What this means for the target

The reachable reduction is **roughly half the source**, not the ~85–90% the 1,000,000 B cap
implies. Set targets against the corrected floor:

| plugin | **current floor (enforced)** | deferred potential | withdrawn cap |
|---|---:|---:|---:|
| HAYAKU | **≤ 1,876,661 B** | −17,805 B if `_test` is AST-removed | 1,000,000 |
| Flashback | **≤ 1,501,509 B** | −6,509 B if `_test` is AST-removed | 1,000,000 |
| LIBRA | **≤ 3,224,626 B** | — | 1,000,000 |

These are ceilings to tighten, never licence to regress, and they are reachable **with zero
loss of user-facing capability**.

## The one idea that could go further — and its honest cost

The embedded regions are byte-identical across plugins where they are the same SDK
(`storage-sdk` is 352,430 B in both HAYAKU and Flashback; `compute-sdk` is 63,087 B in all
three). A **rebuild** that replaces the inlined text with a genuinely smaller equivalent
implementation of the same contract is the only remaining feature-preserving path.

That is a real engineering project, not a mechanical step, and it must preserve: the
`plugin_only`/`mirror`/`server_only` routing, the owner schema separation, fence/readback
semantics, and the native-branch capability model. It is **not** attempted here, and no bytes
are claimed for it. It would be planned and verified like any other subsystem replacement
(freeze behaviour in tests → implement behind the same contract → prove equivalence → remove
the superseded path).

## Measurement rules (unchanged)

Uncompressed installed JS bytes only; ZIP/gzip, `.length` and line counts never substitute.
A missing artifact is a failure. A build that only parses the readable source is not verified.
A test pass without a fresh byte measurement is not a size-gate pass.
