# Release static-key representation

This unit changes only the release builder and its tests. The five product source
files, public property names, schema strings, provider defaults, quotas, minifier
options and both existing size-floor tables remain unchanged. The private branch
starts at `2058bce52dd0088c7eae2c7204b849ce581144f1`.

## Cause and implementation

The retained baseline already uses offline Terser 5.51.2 with local/top-level
mangling, `unsafe=false`, three compression passes and `properties=false`.
Developer `_test` exclusion is already active. Repeated static member names and
ordinary data-property keys account for the remaining recoverable bytes; embedded
SDK regions are live code and this unit removes none of them.

After minification, the builder represents profitable repeated keys using an
unchanged string literal in a fresh lexical `let` binding inside the same function
block. For example, repeated `record.canonicalArtifactDigest` accesses can become
`record[A]`, with `let A="canonicalArtifactDigest"` in that body's prologue. The
key value and receiver/evaluation order stay the same. Optional receivers retain
`?.[A]`. The one declaration-prefix cost is counted once per body, and rejected
keys do not consume short names. A body is changed only when its exact UTF-8 byte
count decreases.

Bindings follow original directives and precede their references. Names are
reserved against every identifier in the complete original function subtree.
Parameter/default expressions and expression-arrow bodies are not rewritten.
Class subtrees, including initializers and method bodies, are excluded. Object
method/getter/setter keys, shorthand, `__proto__`, `constructor`, `prototype`,
`name` and `toString` keys remain unchanged. Other ordinary accesses in a function
containing default-parameter or meta syntax may still be pooled; those syntax
nodes themselves remain unchanged.

Source containing `eval`, `with` or `Function` reflection takes the conservative
unchanged path. Static function-source observations protect the observed function
and its descendants: local/shadowed/assigned/destructured aliases, object/global
member assignment, serializer arguments, factories, logical/coercion forms,
`arguments.callee`, extracted or computed `toString`, call/apply/bind/Reflect.apply,
and aliased/prefilled `String` are covered by regressions. Candidate bindings are
unioned conservatively. Graph traversal uses iterative worklists and seen sets,
without a hop limit or truncation.

The exact output is reparsed before writing. Its generated declarations must be
lexical `let` with the recorded literal initializers. Every introduced identifier
must occur only in its generated declarator or its recorded member/data-key read
site; assignment, update, destructuring writes and other uses refuse the result.
Removing those declarations and restoring those recorded accesses must reproduce
the entire original AST, including directive order, literal values, property
kinds and optional-chain structure. Normal release header collection and actual
artifact `node --check` then run as before. Non-minified builds skip this pass.

## Verification boundary

The owned VM suite preserves literal expectations and exact observed source text.
It exercises receiver/getter/call/update/delete order, property order and
descriptors, inferred names, strictness, TDZ/scope/hoisting, shadowing, class and
default-parameter exclusions, standalone exported function/method/accessor source
re-evaluation, reflection aliases and large valid alias graphs.

The artifact parity suite executes exact retained control files and exact newly
built files without source rewriting or `_test` injection. Identical Date, Math
and crypto host fixtures make lineage nonces deterministic. It compares public
API key sets, registered callbacks, real beforeRequest/afterRequest/output paths
for HAYAKU/Flashback/LIBRA/LIA, portal controls and every persisted storage value.
HAYAKU must actually inject its runtime packet contract. RETRACE exposes no
request-hook contract here; its public host-lineage read and registered portal
callback are exercised. One RETRACE nativeFetch attempt terminates in the offline
host stub. External-network guard events and actual model calls remain zero.

The separate negative control copies artifacts into its own disposable Temp
directory, corrupts the HAYAKU runtime marker there, and requires the unchanged
behavioral suite to fail its hook assertion. Final artifact files stay intact.
The existing actual-artifact startup/directive test is reported only as a startup
and directive check, not as hook or durable-memory proof. The actual LIBRA recall
suite retains all seven canonical/Classic/vector-currentness expectations and
uses controlled provider/vector fixtures, with no real model or embedding call.

This is evidence for the frozen five-plugin source set and exercised routes.
It does not replace HAYAKU production timing/gold or the parent's final build of
the subsequently integrated source HEAD.

## Retained failures

No previous failure is relabeled as a pass. The original
`work/recovery-20261002/LIB-FINAL-BUILD.json` and retained
`LIB-final-build-2058bce52dd0.log` report four builder-floor failures. The standalone
`check_plugin_size.cjs` has a different, pre-existing floor table; its LIA floor
is 1,004,468 B versus the builder's 1,024,058 B. Neither table is changed.

Private logs retain the initial missing-helper RED, the earlier class/reflection
review REDs, the first parity fixture's nondeterministic nonce failure and the
actual artifact-04 recursive candidate-graph failure. The graph failure is also
reproduced by a valid 16,000-node alias-chain RED. Earlier artifact-01/02 standalone
LIA size failures and the later conservative-const LIA measurement (+451 B) are
retained. Correcting fixtures or representation does not weaken their value,
source-text, canonical identity, call-count or size expectations.

## Final evidence

Final builder SHA-256:
`a7992526ece39cd405484e5514d465da8314b27f2b3950ca028d821349b192be`.
Exact artifacts are in
`C:/Users/rusin/AppData/Local/Temp/LIB-Release-Size-Artifact-20261003-05`.
Both existing gates exit 0, with all five actual artifacts below both ceilings.
All five inverse-AST checks and artifact syntax checks pass; embedded regions
removed: 0 B. Total actual JS: 7,636,369 B.

| Owner | Retained baseline B | Final B | Saved B | Builder ceiling B | Standalone ceiling B |
| --- | ---: | ---: | ---: | ---: | ---: |
| HAYAKU | 1,854,559 | 1,769,963 | 84,596 | 1,788,914 | 1,880,936 |
| Flashback | 1,539,938 | 1,464,400 | 75,538 | 1,499,680 | 1,509,247 |
| LIBRA | 2,940,779 | 2,802,814 | 137,965 | 3,400,888 | 3,234,572 |
| LIA | 1,038,272 | 1,004,034 | 34,238 | 1,024,058 | 1,004,468 |
| RETRACE | 621,722 | 595,158 | 26,564 | 609,054 | 603,578 |

LIA has only 434 B of headroom under the stricter standalone ceiling. This unit
does not approve a release from a later source set: the parent must rebuild and
rerun both gates after integrating subsequent product changes.

| Artifact | SHA-256 |
| --- | --- |
| HAYAKU_Locator_Continuity.js | `76e5047ceddf7b5942985301341e0f8f7ea2457964ac6eed845b9332da6b7f55` |
| Flashback_Memory.js | `1ca3fc7406757826068c025fcf9a85022e58b30df507fa7b64e88c2806eabae4` |
| LIBRA.js | `3223bff8e99943708b386798b74d39b5c99fdcd0dce71dc69c6806ecfab75dda` |
| LIA_Persona_Linker.js | `9d0dde6d51a1436a84fb6b42de0c89e68416771ac6cfeb34ff3fc41d4498c868` |
| RETRACE.js | `9f18129c40e1c45630ad52f9ca32f25d35dc59981c361963492d809a361a0133` |

Guarded serial final checks pass: 38 owned VM cases; exact artifact behavior
parity for all five; one forbidden-literal negative control (expected child exit
1); all seven actual-artifact LIBRA recall/vector cases; startup/version/directive
checks for all five; both minifier-refusal scenarios; the existing release-profile
contract; builder and three owned test syntax checks; `git diff --check`.
The independent reviewer also passes 53 VM cases, five actual pinned-Terser
reflection cases and three 12,001-node graph cases on the same builder bytes.
External-network guard events: 0. Actual models and embeddings: 0.

Final logs are retained in
`C:/Users/rusin/AppData/Local/Temp/LIB-Release-Size-Safe-20261003-2058`:

- `release-static-key-pool-05.log`, `release-size-gate-final.log`;
- `property-key-pool-graph-green.log`, `build-refusal-final.log`, `build-profiles-final.log`;
- `artifact-behavior-parity-final.log`, `artifact-behavior-negative-final.log`;
- `libra-release-recall-vector-final.log`, `artifact-startup-directives-final.log`.

Independent review evidence remains in
`C:/Users/rusin/AppData/Local/Temp/LIB-Release-Builder-Independent-Review-20261003`.
All earlier failure logs remain preserved. HAYAKU production timing/gold, a build
of the parent's latest integrated HEAD, original promotion, bundle, restore and
publishing were not performed by this unit.
