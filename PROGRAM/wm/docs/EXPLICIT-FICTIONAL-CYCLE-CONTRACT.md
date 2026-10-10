# Explicit fictional cycle and episode calculator, version 1

Status: IMPLEMENTED_PROVISIONAL_FEATURE_FIRST. This is the explicit-input E06 subset, not the full proposed reproductive simulator, a medical model, or actual-host qualification.

## Consent and owner

A single `reproductive_health` tracker uses the existing grouped card, owner, committed journal and save/readback. The tracker must already have scoped adult-fiction observation consent for one exact registered adult character in the current chat scope. A separate unchecked-by-default `simulationEnabled` control permits code calculations from the user's supplied fictional parameters. Saving a definition does not turn on tracking, injection, generation or a provider. Observation-only mode remains supported. The old snapshot, seed, anchor, counters and legacy defaults are not migrated or overwritten.

The closed processor is `fictional_cycle`, execution schema `wm.extension-execution.v1`, fictional calculator version `1`. There is no code evaluation, random sample, biological preset or automatically initialized pregnancy. Missing/invalid parameters, dates, facts, rules or permission leave the affected computation waiting. All new state is management-private, including when persisted visibility is inconsistent. Neither ordinary response projection nor model-facing DLC catalog exports the simulated values. The existing common analysis can receive only the observer contract and exact configured rule references; this creates no extra model task or call.

## Explicit inputs

The same card accepts `calendarId`, cycle `anchorDay` and positive integer `lengthDays`, optional user-named inclusive phase intervals (`label | startDay | endDay`), a separately enabled fictional pregnancy episode with `episodeId`, `episodeStartDay` and positive integer `durationDays`, and optional nonnegative `implantationDelayDays`. Phase intervals must be within the cycle and cannot overlap. Integer day coordinates are the units, not PC dates or turn counts. No month-to-day conversion is supplied.

Cycle day is elapsed days modulo the explicitly supplied length, plus one. Unnamed intervals are `unspecified`; the engine does not infer biological phase names or ovulation. The running cycle retains its length/phases until its boundary, then subsequent cycles use newly configured parameters. The fictional episode's original origin and duration/implantation parameters are locked; editing a definition cannot rebase that episode. A genuinely new user-specified episode needs a different ID and an origin later than a known prior termination. Invalid intermediate settings and simulation-off preserve stored prior state.

## Two axes

`executionState.reproductive.observed` holds direct canonical observations: `unknown`, `confirmed`, `ended`, `birth_confirmed`. Structured `pregnancy_confirmed`, `pregnancy_ended` and `birth_confirmed` events require one exact target, subject role, stable occurrence and episode IDs, grounded evidence, explicit story time and permitted visibility. `fields.originDay` is optional. Confirmation time never substitutes for an unknown origin. A later confirmation preserves an existing origin. Contradictory origins, unsupported ordering and same-day conflicting observations wait for review; packet arrival does not decide in-world order. Terminal episode locks prevent older successes from reviving an ended episode, including after reload. Elapsed days for an ended observed episode stop at its explicit termination.

`executionState.reproductive.simulated` is separate and fictional. The user explicitly names any simulated episode and its baseline. Its stage is `in_progress`, an explicit pre/post implantation coordinate, or `duration_elapsed`; none asserts an observed pregnancy, implantation or birth. No child, parent, health, name, knowledge or count is generated. Conflicting confirmed observation suspends the simulated episode. No conception sampling, exposure inference, paternity selection, contraceptive probability or recovery-time assumption is implemented. The cycle is a user-defined timetable, not a medical inference about recovery.

## World effect adapter

A separately selected adapter may allow or block the cycle or fictional episode projection for an explicit integer-day item-use interval. It requires the exact current node ID, rule ID and version, matching references on the committed event, exact item ID, `used=true`, direct evidence, subject target and explicit use time. The journal now preserves an optional supplied `nodeId`; a historical reference without one cannot satisfy this stronger adapter. Same-event scalar conditions retain the generic effect guard. Missing use/rule/time remains waiting; possession and availability never start an effect.

`block` suppresses that calculation's current projection during the interval; `allow` permits it only during the interval. The clock itself is not paused and the effect does not become a contraceptive or biological claim. Overlap uses the existing conservative wait policy unless an already explicit replacement policy is present. Numeric world effects continue through the unchanged generic processor; this sensitive adapter does not reinterpret them as pregnancy probability or physiology.

## Locks and currentness

Existing immutable semantic rows retain event keys, episode bases and terminal markers, and target/story-day result groups within scope/tracker identity. Repeated identical facts/days reuse results. Changed locked occurrences or same-day definition/evidence changes wait rather than silently rewriting history. New definitions retain the existing future-packet activation boundary. Exact current rule/permission, registered target, off/on state and projection freshness checks still apply. Stable day locks do not provide physical cold paging or cross-runtime CAS.

## Verification boundary

Focused offline pure and fake-owner/card/maintenance/reload checks plus source-only development assembly and syntax. No actual model/provider, network, listener, live DATA, credentials, Git publication, deployment, Library upload or backup. No full/deep regression, independent review, performance or actual-host claim. Distribution Full/Min and generated metadata remain stale; activation and qualified profiles remain closed. Full E06 exposure/day sampling, late-evidence replay/reversal, advanced rules and complete biological simulation policy remain separate work.
