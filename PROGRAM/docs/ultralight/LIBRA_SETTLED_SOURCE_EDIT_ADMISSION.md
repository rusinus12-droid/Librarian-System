> Historical design: LIBRA source-edit tracking and settled-task readmission are removed in the explicit-reanalysis candidate. See [current behavior](LIBRA_EXPLICIT_REANALYSIS.md). The remainder is retained as historical context.

# Same-request admission after a settled source edit

This private unit is based on main `37817d4f7d79eba78db4d7cfba8cb9e1ee13b2aa`.
The unchanged baseline LIBRA source SHA-256 is
`25f405982f99c8a8ae782ba3b013087745f596840c31f2913af79e8c1967091b`.
It admits an exactly settled repair through the request-local pending projection;
it does not change source-repair
transaction authority, task completion, model producers, storage SDK, or deadlines.

## Reproduced failure

The named unchanged three-mode test failed on its first mirror request with no
Classic block. The source replacement was physically present as revision 2, its
identity and canonical artifact were sound, and the prior revision was retained.
An isolated unchanged rerun failed too. A passive trace showed pending eligibility
captured at 10025 ms, actual task settlement at 10059 ms, and request return at
10265 ms. Thus the task applied before return while the request still used its
earlier masked projection. This is not evidence of raw loss or a changed producer.

The earlier 2058 control passed with mirror/server first requests of 10195/10141
ms. Neither that result nor this unit establishes a strict ten-second return
limit: ten seconds bounds preparation, followed by the existing recall guard.

## Bounded change

Only an originally captured RUNNING task can qualify. The task must now be
APPLIED, have an `ok` receipt, and retain its exact revisionId, digest,
sourceDigest, basis, and source identity. Its receipt revision must identify the
fresh committed manifest ref. A verified physical body must agree with the ref's
scope, memoryId, revision, source digest, artifact digest, source pairs, and turn
range. The actual canonical artifact must hash to the advertised digest.
Readback binds the complete physical body except its independently enrichable
embedding field; canonical source, artifact, identity, and provenance fields stay
exact. Prior revision bytes remain retained.

The request retains its serial, raw source, memory settings, runtime policy,
source preferences/epochs, host/provider references, effective mode/connection,
certified DATA binding, and original response boundary. It validates these around
the reads and after recall. A newer request, exception, missing proof, changed
source/scope/settings/provider/mode/binding, cancellation, or spent recall guard
leaves the original suppression in place.

One readmission attempt may rebuild the request-local worldline/frontier view,
receipts, query, provenance, and normal recall. It uses the same existing 30-second
guard. It does not await autoWork, poll, create a new deadline, mark a task applied,
retry a write, rebase a transaction, or admit the preserved previous revision as
current. Existing final response/consumed-data checks remain in place. Normal
derived recall caches retain their existing behavior.

All original asynchronous response-boundary and consumed-data delivery checks run
before the final handoff. The handoff rechecks original authority, then samples the
exact manifest ref and physical body last, under `runRecallStep` with only the
remaining original guard. After that wrapper returns, synchronous serial, live
raw source/IDs, settings, source-policy, provider, DATA binding, task receipt, and
guard checks immediately precede injection. The raw check reuses the live
character/chat objects returned by the last protected host context read. It does
not turn detached host snapshots or arbitrary native APIs into atomic reads.

The early candidate passed 13 controlled cases but admitted a body changed after
its body proof during a later authority await. That candidate RED is preserved in
`after-proof-red/` and its exact executable. The last physical sample now rejects
that mutation. The next candidate passed 14 cases and the unchanged three-mode
test, but its new final await needed an established watchdog. An actual captured
device getter held past the remaining guard returned at 46244 ms on that old
candidate, failing the unchanged upper bound. The guarded candidate returned at
40017 ms (ten-second preparation plus original thirty-second recall guard), with
no Classic block. Releasing the losing authority continuation afterward changed
neither the recall viewer/result nor returned messages and added no model call.

A further target-marked candidate RED changed the semantic manifest scope in both
actual mirror copies after completed final authority verification, before the
last physical sample. Unchanged ref/body digests alone admitted one Classic
block. Final readback now also requires the manifest's exact original scope. The
owned strict case requires that mutation boundary to have been reached and the
specific scope assertion to reject it. An earlier probe was suppressed by an
unrelated early mirror value mismatch before reaching the target; it is retained
as inconclusive, not counted as a scope PASS.

## Evidence and limits

Evidence root:
`C:/Users/rusin/AppData/Local/Temp/LIB-LIBRA-Source-Edit-Diagnosis-20261003-37817d4`.
The raw main-group RED, isolated unchanged RED, passive observer JSON, and prior
2058 PASS locator are preserved in `diagnosis-final.json`.

The owned boundary test uses the real plugin, registered beforeRequest, deployed
SDK, loopback HTTP, and SQLite. Its test-only gate holds actual task settlement
after the real pipeline, lets the existing ten-second preparation expire, then
releases real APPLIED settlement before resuming the real receipt reader's
dispatch. It neither fabricates a successful receipt nor replaces a canonical
read. The valid pre-change RED is `boundary-red-task-read-dispatch/` and its log;
the exact executable RED test is retained there.

Each controlled admission case records one synthetic source-edit Librarian call;
readmission adds no generation or helper LLM call. The existing normal recall
query-embedding path, cache, vector validation, provider policy, and defaults are
preserved. A configured production cache miss may use that normal query-embedding
path; this unit does not claim or force zero production query embeddings. Actual
model/embedding services were not used. The active network guard covers Node and
inherited children; authorized loopback HTTP/SQLite fixture traffic is separate.

Earlier fixture attempts held a GET inside the SDK owner IO lane, preventing the
source task from finishing. These readiness failures are preserved and excluded
from the product RED count. The final gate holds reader dispatch outside that
lane. The candidate's first attempt had an incorrect Classic enum lookup and
failed the same assertion; that implementation failure is also retained.

The first frozen candidate's unchanged full three-mode run also failed with a
task still RUNNING at first return and APPLIED about 210 ms later. That is a
genuine unsettled timing limitation; a refresh cannot manufacture the missing
completion receipt. The failure remains in `three-mode-frozen.log`. Its published
initial recall phase list does not prove capture was null: publication precedes
readmission. A passive mirror control recorded a captured RUNNING task and a
successful settled-before-dispatch first request. No queued/pending state was
newly made eligible.

The later 14-case checkpoint's unchanged three-mode test passed with first
requests at 306/10585/10427 ms (plugin/mirror/server). Its truly delayed 12-second
task still returned no Classic at 10270 ms, then delivered the replacement after
settlement on a new request. Neither that quiet PASS nor the final results imply
that every asynchronous repair will finish before the first send.

Final source SHA-256:
`24e4ce5da10c01b699f1a7050d28184ecf191b02b448a168b0cc528d6b18514d`.
Owned test SHA-256:
`0352d6eded7998268084a4141ad47dc066d29d0774911c4e74b249160e59fad0`.

| Validation | Actual result | Evidence |
| --- | --- | --- |
| Owned settled/admission/authority cases | 16 PASS, 0 FAIL; one original mock Librarian per case, at most one refresh | `final-frozen-16.log` and its JSON folder |
| Eight unchanged scoped regression files | 13 Node tests PASS, 0 FAIL; vector gold 7, ResponseContext 6, provider-budget file PASS | `scoped8-scope-final.log` |
| Unchanged three-mode run after the regression group | FAIL: mirror first request at 10206 ms still RUNNING; APPLIED shortly later and follow-up delivered replacement | `three-mode-scope-final.log` |
| One authorized quiet unchanged three-mode replay | PASS: first requests 310/11085/10918 ms, seven corrupt-body variants rejected per mode | `three-mode-scope-one-quiet.log` |
| Truly delayed 12-second repair in that quiet replay | First mirror request 10238 ms, RUNNING, no Classic; replacement delivered on new request after settlement | Same quiet log |
| Held actual device getter and losing continuation | Original guard expires, no block; release cannot change viewer/recall/messages or add an LLM call | `final-frozen-16/handoff_budget_spent-losing-continuation.json` |
| Exact source preservation | 3,778,300 leading bytes, including entire old SDK/producer code, and all four other plugin sources unchanged | `source-preservation-proof.json` |
| Syntax, patch whitespace, active network guard | PASS; guard events 0 | Private commit verification and `owner-final.json` |

The same final source's earlier FAIL is retained as an acceptance/timing
limitation, not overwritten by the quiet PASS. A genuinely unsettled task must
remain suppressed. No source/gold/deadline changed between these two runs. The
quiet run is a tested first-request result, not a latency acceptance claim.

`owner-final.json` contains the exact private commit/base/branch, three file
hashes, evidence hashes, per-case results, and pending independent-review status.
Root must apply only the owner-core hunks to its newer SDK composition, validate
that composition, and handle backup/restore and promotion.

This is bounded offline request-currentness evidence, not atomic host snapshots,
native GUI verification, real-model latency, a universal guarantee about arbitrary
unanalysed host APIs, or release-artifact acceptance. Root owns integration,
backup/restore, current-source release build, both size gates, and later timings.
The separately observed 1205 GET pipeline cost remains unresolved; this unit does
not claim duplicate-IO reduction or a faster source-repair pipeline.

## Resumed fixture diagnosis on the held composition

The resumed private checkout starts at
`15b40a5c8477b55a73384fff4737efe67072d7ea` and overlays only this unit's three
paths from the actual held `73c491fe57bca91c4841147e98c103963b9d0571`
composition. Its LIBRA source is preserved byte for byte at
`1eb384f713077ea0108d74df60cbd591addf224ad3a0a06f5180bff427b5a9f3`
(5,594,125 bytes). This assembled pin includes the reviewed shared SDK/consent
composition and differs from the original component pin above. The resumed fix
changes the owned test fixture and this documentation, with no new product,
shared fixture, SDK, producer, or deadline change.

The held composition's original full validation remains 658 PASS and 1 FAIL;
its admission file printed 14 PASS before `handoff_budget_spent` failed to reach
the actual final getter. The following `manifest_scope_after_authority` case was
UNRUN. The subsequent unchanged targeted replay remains 1 PASS and 1 FAIL: the
getter case passed, but the scope case failed to reach its mutation boundary.
These failures and their frozen executable are retained, rather than replaced
by the two fresh unchanged target PASS results.

The earlier refusal occurred before the intended final boundary because a
verified mirror read sampled the replacement's local body before its normal
derived metadata publication and the server body afterward. A controlled
test-only gate outside the SDK IO lane reproduced that exact path using the
actual local sample, existing conditional writer, loopback HTTP, and SQLite.
The local sample was 31,711 bytes, SHA-256
`32822bb4623097edc93004850eeed0d57e9594cd1f6d053862da967b39177049`;
the server sample was 31,747 bytes, SHA-256
`5348fdffd34524b75319745bc5d23fef0fb66098f01b71c764abbfc69fc43f5c`.
Both bodies had logical revision 2. Only `embedding.status`, `embedding.reason`,
and `embedding.vectorCount` differed (`pending` to `disabled`, missing API key).
The complete body excluding embedding was identical, with normalized SHA-256
`6b6b5b9ec0be5e9d5f2a17b33ec24b513ded2808dd736585139a2e119384e15e`.
The genuine conditional publication produced the exact newer sampled bytes;
production correctly refused `LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH`.

APPLIED certifies the canonical replacement, while the owner's independently
scheduled derived write can still be in flight. The fixture now awaits the
public `retryPendingUnifiedVectors()` operation and reads back both actual
mirror copies before applying a targeted authority/body mutation. The same
precondition is required before capturing the initial revision's immutable byte
baseline. An intermediate run passed the scope/getter/positive cases, then
failed the unchanged prior-byte assertion in `body_changed_after_hydration`:
the initial revision's legitimate derived publication was still finishing.
Its real conditional expected digest exactly identifies the earlier pending
body; publication changes only embedding metadata, from 31,689 to 31,725 bytes.
Raw byte immutability is tested from the settled baseline, while complete
logical canonical equality is checked separately across each owner drain.

The old dispatch gate also sat inside the reader's 1,500 ms step, letting its
timeout start readmission before the test released dispatch. The test gate now
sits immediately before invoking the unchanged reader step. The real reader's
1,400 ms deadline, its 1,500 ms step, and the original 30,000 ms recall guard
retain their exact literals and behavior. A new assertion requires readmission
to remain unstarted until the fixture has applied its controlled mutation and
released dispatch. The getter case retains its original 39,000–45,000 ms bound
and losing-continuation assertions. Real post-hydration and post-proof body
mutations now also require the exact boundary to be reached in both copies.

The additional `derived_metadata_overlap` negative deliberately leaves the
replacement's derived publication undrained, preserves the actual old local
sample, and resumes its real server read only after the existing writer has
committed and published both copies. It requires the precise production
storage mismatch refusal, no Classic block, identical complete logical bodies,
unchanged prior bytes, and one original mock Librarian call. This retains the
safe refusal instead of weakening verified reads to admit mixed samples.

Resumed evidence is kept in the private `LIB-LIBRA-Settled-Resume-*` folder:
`deterministic-vector-overlap-red-*` contains the valid causal RED and physical
samples/readset/operation order; `r1-derived-operation-cause.json` binds the
initial pending body to its actual certified write condition. The first heavy
diagnostic attempt introduced a distinct readiness failure through synchronous
snapshot overhead and is explicitly excluded from product RED evidence.
The intermediate drain-only GREEN is not accepted as a dispatch proof because
its trace showed readmission preceding the explicit gate release.

The resumed frozen admission run passed all 16 existing cases and the additional
mixed-sample negative: 17 PASS, 0 FAIL, 0 UNRUN, exit 0, active guard events 0.
Its exact owned test SHA-256 is
`0b0dd5e34a6c38a370468a2f27f1b4768abc2267f4a2bd89b20d829cb3f7888c`.
Every case preserved the settled prior body bytes, used one original mock
source-edit Librarian, and began readmission after the actual dispatch release.
The final held getter returned at 40,031 ms with no Classic block; its released
losing continuation left the viewer, recall, messages, and model-call count
unchanged. Both body mutation boundaries and the exact final semantic scope
mutation were reached and rejected. Actual model/embedding service calls are 0.
`final-frozen-17-summary.json` indexes task receipts, both physical copies,
sample SHA/size, consumed readsets, and the original guard for every case.

The eight unchanged scoped regression files also passed: 13 Node tests PASS,
0 FAIL, 0 skipped, exit 0, guard events 0. They cover main-memory currentness in
three storage modes, provider budget, ResponseContext (6 internal cases), bounded
raw reads, exception impact, policy epoch, recall/vector independence (7 internal
cases), and unified source edit. This group does not include
`libra_source_edit_final_injection_3mode_test.cjs`; its original first-request
three-mode gold is UNRUN in this resumed fixture unit and belongs to root's
fresh assembly verification. Broad aggregate commands, actual model/embedding
measurements, release builds, promotion, and external requests remain UNRUN.
The original aggregate counts and prior failures are not rewritten.
