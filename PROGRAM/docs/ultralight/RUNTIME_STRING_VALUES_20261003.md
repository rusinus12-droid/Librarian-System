# Runtime string values in release builds

This follow-up starts at frozen builder commit `20a703f947cb708b330689832d127849dce49a55`.
The product files and both existing size tables are unchanged. Current-source validation
uses product commit `36610ff49589b6051ed3125f197dfccc7b082b34`, with this builder overlaid
in a separate Temp clone. The frozen 20a artifacts and their PASS evidence remain intact.
The current-source 20a build remains an accurately recorded FAIL: LIA was 1,006,327 B,
1,859 B above the standalone gate of 1,004,468 B.

## Change and preservation boundary

The existing same-function property-key pass also considers repeated runtime string
Literal **values**. Each generated alias is a fresh `let` binding initialized to the
exact UTF16 value inside that function body, after its directive prologue and before
any generated read. Declaration cost and exact replacement bytes must be profitable.
The original group ordering, minifier options, region policy and release floors remain.

The value path excludes directives, every syntactic key subtree (including member,
object, method and class computed keys), parameter/default subtrees, classes,
expression arrows, templates/tagged templates, and direct `delete` Literal operands.
Separately collected functions inside key/template/parameter subtrees also exclude
value pooling. All object accessor bodies and descendant functions are protected
conservatively; descriptor aliases and computed descriptor calls need no flow guesses.
Existing dynamic-scope and bounded local function-source observation protections stay
in force. Computed literal method names participate in source-observation protection;
they are not new pooled key sites. The prior ordinary data-key policy remains.

Literal replacements retain the entire original Literal AST. The generated output is
parsed, every introduced name is checked as its declaration or mapped read, and writes,
updates, delete references and binding positions refuse. Required token separators
preserve compact forms such as `return"value"`, `throw"value"` and `"value"in obj`.
Inverse normalization visits parsed child offsets before restoring original keys, then
restores each original Literal and compares the full AST except location/raw fields.
The pure initializer keeps exact lone surrogates, NUL, line breaks, prompts and schemas.

Inverse AST equality is a structural check. Execution evidence below covers the stated
local seams and adversarial controls; it does not claim universal equivalence for every
external function-source consumer or dynamic JavaScript program.

## Actual current-source artifact 06

Directory: `C:/Users/rusin/AppData/Local/Temp/LIB-Release-Current-Artifact-20261003-36610ff-06`.
Pinned helper SHA256: `1bba21b3760d4437506358e5f25fc7782731ab7b261862984023a4d007c70864`.

| Owner | Current 20a bytes | Final bytes | Additional saving | Builder floor | Standalone floor | Standalone headroom |
|---|---:|---:|---:|---:|---:|---:|
| HAYAKU | 1,769,943 | 1,743,970 | 25,973 | 1,788,914 | 1,880,936 | 136,966 |
| Flashback | 1,464,400 | 1,443,252 | 21,148 | 1,499,680 | 1,509,247 | 65,995 |
| LIBRA | 2,802,814 | 2,750,308 | 52,506 | 3,400,888 | 3,234,572 | 484,264 |
| LIA | 1,006,327 | 991,271 | 15,056 | 1,024,058 | 1,004,468 | 13,197 |
| RE:TRACE | 595,158 | 588,813 | 6,345 | 609,054 | 603,578 | 14,765 |

Total: 7,517,614 B; additional saving 121,028 B. Both unchanged gates PASS 5/5.
All output parses and inverse AST checks pass. VALUE reads replaced: HAYAKU 4,207,
Flashback 3,635, LIBRA 10,004, LIA 2,995, RE:TRACE 1,280. Existing stripping remains
HAYAKU 1 block/17,866 B; Flashback 116/15,682 B; LIBRA 0; LIA 0; RE:TRACE 1/2,473 B;
embedded regions removed 0. Object accessors in the exact five pre-pool minified
controls: 0, so the conservative accessor exclusion costs 0 artifact bytes here.

| Artifact | SHA256 |
|---|---|
| HAYAKU_Locator_Continuity.js | `0f35d3a7242e061804915a3b8ef0f20571e07f2a681b06cecee329a85bddd782` |
| Flashback_Memory.js | `7be516eb5cd5314d3eac12e70df2e21251e392d4bf79d9bfb79950fb2f607f5a` |
| LIBRA.js | `b6c960605ac5292d9cdc1a65910558626c3de8d74fee42ae400cafc9feebba88` |
| LIA_Persona_Linker.js | `dfdfb22d200f417803f44273e8c6401d4a3e7eefb656e71e257c59cb5daa192d` |
| RETRACE.js | `9480dbbbb9ea544dde19431a0e4973c47901826c98e67f5ba47fe9a0277705e4` |

Product SHA256 pins (current validation files unchanged):

- HAYAKU `9e4bdefd5f1d40b2d40dac9085d562ed9e36da4a09e40ed05185888404ec0895`
- Flashback `5f84bc6434d16688e5de22c14b3a163d68cd35e825acaa482a12cbf7b06c1112`
- LIBRA `25f405982f99c8a8ae782ba3b013087745f596840c31f2913af79e8c1967091b`
- LIA `0efa1fc91e7a3cd000c354fb16ca67a8a041070114d7e71bdd74129fb97f6fd7`
- RE:TRACE `00cc7df50b8ecc03e9763fc1323e95d4d0d7172acfeaf6319e5f28583f9d5575`

## LIBRA artifact fixture readiness

The old artifact harness waited 80 ms after the registered settings callback. That
callback awaits `showSettingsGui`, which schedules separate zero-delay hydration.
A 250 ms offline-host delay reproduced a snapshot with the initial nonterminal status
and no manifest while reading the exact artifact bytes. A same-SHA self-comparison
alone was not used as proof. DOM/storage tracing established the real order: terminal
hydration event, later same-scope manifest write after a background render clears the
status, then another queued receipt-status render. A simultaneous status/manifest
predicate therefore timed out. Sequential terminal/manifest alone still captured the
receipt panel before its original retry button appeared; exact full equality caught it.

The owned fixture now observes the exact terminal status event with MutationObserver
on its fresh DOM, then waits for the durable manifest at the scope registry entry for
the exact fixture character/chat. Namespace, key, schema, scope, character and chat
must match. It also requires the same-scope T1 missing receipt card and unchanged
literal retry button in this known two-message, zero-receipt fixture. All conditions
use the existing 15,000 ms deadline; no fixed wait was enlarged. Every original API,
hook result, registration, DOM id/button/heading and stored value comparison remains.
The 250 ms delayed-host case preserves the full expected snapshot. Product GUI and
source bytes were not edited.

## Verification and retained failures

Owned VM controls: prior property-key 38/38 and new value 29/29 PASS. Independent
controls: value 37/37, inherited reflection/boundary 53/53, exact pinned-Terser 5/5,
and 12,001-node alias graphs 3/3 PASS on the pinned helper. Actual artifact LIBRA
Classic/canonical/vector gold 7/7 PASS and startup/header/directive controls 5/5 PASS.
Actual current-source pre-pool controls versus final artifact hook/portal/storage parity
PASS 5/5. HAYAKU, Flashback, LIBRA and LIA execute their registered before/after/output
paths; all five execute setting portals and storage. RE:TRACE executes its public
lineage API rather than a request hook. Original returned API keys, hooks, registration,
portal ids/buttons/headings/containers, accessed storage keys and every stored value
remain equal. RE:TRACE attempts one mocked offline fetch; model calls are 0 for all five.

Meaningful HAYAKU packet-marker corrupted-copy negative PASS 1 (expected child exit 1
at the exact hook assertion). LIBRA readiness PASS 2: delayed 250 ms full snapshot
equality, and corrupted manifest schema refusal. The latter observes the terminal
event and loaded receipt panel, but the exact same-scope manifest contains the corrupted
schema and is refused under the unchanged 15 s deadline. Both gates PASS 5/5; four
changed JavaScript files pass syntax checking and the complete diff passes whitespace
checking. NODE_OPTIONS propagates the external guard to the negative-control child.

Preserved failure evidence includes current 20a's standalone LIA FAIL, the new VALUE
missing-feature RED, token-boundary/offset inverse refusals, computed accessor source
reflection REDs, delete reference-context REDs, old 80 ms delayed-host RED, simultaneous
15 s readiness timeout and sequential receipt-panel equality FAIL. Logs with earlier
`green` filenames that contain errors remain classified FAIL. None were relabeled.

Evidence roots:

- `C:/Users/rusin/AppData/Local/Temp/LIB-Release-Current-Validation-20261003-36610ff`
- `C:/Users/rusin/AppData/Local/Temp/LIB-Release-String-Values-Safe-20261003-20a`
- `C:/Users/rusin/AppData/Local/Temp/LIB-Release-Current-Independent-Review-20261003`

External network/model guard logs contain zero calls. All adapters are offline host
fixtures; no actual model/embedding or native GUI run was performed. Later integrated
product/SDK builds and production timing remain the parent's separate validation.
