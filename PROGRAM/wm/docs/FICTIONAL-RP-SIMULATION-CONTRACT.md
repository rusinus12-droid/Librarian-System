# Fictional RP simulation v1

This contract implements the approved fictional preset and E06/E07 calculation path from the extension proposal, sections 8–9. It is a fictional role-play rule system, not a medical prediction, diagnosis, contraceptive recommendation, or qualified actual-host release. The numerical preset was approved on 2026-10-09. Legacy explicit calculator version 1 remains available.

## Consent, defaults, and preservation

A reproductive_health card must have current, target-specific adult-fiction observation permission. Simulation has a separate default-off opt-in. Only enabled simulation for a canonically supported humanlike target receives missing preset values. Nonhuman targets need an explicitly approved, versioned target-specific template; unknown applicability waits. Every actual exposure participant must resolve to a registered adult. Names, relationships, scene presence, and appearance are not applicability or exposure evidence.

fictional_rp_v1 supplies: cycle length 28 days, variation 2 days, period 5 days, luteal range 10–16 days, supported ovulation-relative interval -5 through 0, implantation delay 6–12 days, modeled duration 266 days, common-cycle coefficient 0.4, and conditional exposure-day coefficient 0.7. These are fictional parameters. The supported interval uses a flat conditional coefficient; no medical day-specific curve or annual failure-rate conversion is implied.

Explicit values win; existing supported values and seeds are retained. Invalid explicit values wait instead of being replaced with defaults. The card displays preset identity, version, source and overrides, with optional value editing. No numerical input is needed to accept the preset. A missing story calendar or anchor remains unknown. An existing manual version-one card can adopt the preset through one action without re-entering its saved values or enabling stopped tracking. Running cycle parameters and episode duration/implantation parameters remain fixed; new definitions ordinarily apply to later cycles/events.

## Time and deterministic encoding

Only grounded integer story-calendar days are calculation coordinates. PC time and turn counts never become simulation dates. Ranges and absent dates are preserved as pending evidence, with no selected day or draw. Confirmation time never replaces an unknown origin. No calendar-month conversion or implicit recovery interval exists.

The draw contract is wm.fictional-draw.utf8-fnv1a-avalanche-u32.v1. Canonical JSON recursively sorts object keys using ECMAScript string ordering, preserves array order and exact Unicode strings, normalizes negative zero, and uses UTF-8. The fixed FNV-1a 32-bit hash is followed by fixed unsigned avalanche operations. A draw is unsigned integer / 2^32, in [0,1). Inclusive integer choices use floor(draw × (maximum − minimum + 1)) + minimum. The implementation is common JavaScript for both storage routes. This hash is not a cryptographic security primitive.

A seed is initialized once from stable canonical scope/target lineage when no saved seed exists, then stored as authoritative model state. It is not based on a display name, running clock, runtime timestamp, or current screen ID. Existing saved seeds keep their exact JSON value. Keys bind calculator/draw version, seed, stable target lineage, calendar, baseline anchor, cycle number and draw purpose. Scope/tracker ownership is separate from draw identity. Exposure draws additionally bind the target's exact story day, rather than individual occurrence IDs.

Cycle length variation, luteal coordinate and implantation delay use distinct draw purposes. One common-cycle condition is shared across all exposure days in that cycle. Actual events on the same target/day form one condition set and one fixed day draw. Experience counters remain the separate occurrence-based mechanism.

## Evidence, revisions, and replay

Only verified canonical source tokens enter the existing maintenance path. reproductive_exposure requires a stable occurrence ID, exact subject target, actual participant IDs, direct completed evidence, supported exposure type, grounded contraception status and exact story time. Unknown or unsupported contraception waits; it never silently becomes an unprotected model. Plans, hypotheses, reported claims and negated/cancelled facts cannot create a new exposure contribution.

Existing journal history owns immutable cycle bases, event versions, result versions, episode-bearing checkpoints, and revision heads. Revision transitions bind their exact predecessor, including A → B → A. Old semantic locks remain immutable. Paged writes admit only a validated revision head whose new immutable version already exists in the same root and binds the previous head. The root's normal canonical save publishes the candidate. This is not a new owner, distributed transaction, or host CAS claim.

Late evidence revises the condition set with the same fixed draw. Removing a source contribution, moving its date, negating an occurrence or omitting it from a revision of its original canonical packet invalidates the affected contribution. Moved-date tombstones rewrite now-empty old-day checkpoints. Repeated supporting packets do not create multiple contributions. Necessary reprojection starts at the last checkpoint strictly before the earliest affected day, in story-day and stable occurrence order. Explicit within-day order is used where available; conflicting episode transitions or effects with unknown ordering wait. Arrival order is not in-world causality.

Settings changes do not resample old events. A subsequent canonical correction to an already processed older packet can still invalidate it after a settings cutoff. Running and archived cycles use their saved parameters and effects retain their originally approved rule version. There is no automatic whole-history rerun under a newly edited rule.

## Episodes and observations

Observed and modeled axes remain separate. The observed axis accepts direct pregnancy confirmation, explicit termination and birth confirmation, preserving independently known origin or unknown origin. A model's origin is never promoted into observed fact merely by confirmation. Conflicting canonical origin/episode evidence suspends the model while keeping canonical observations.

A model episode has stable cycle-derived identity, original occurrence provenance, fixed duration and implantation delay. Late canonical corrections can revise its source-derived origin without drawing again. Invalidated contributions cannot remain current through a stale checkpoint. Termination closes an episode and prevents old successes from reviving it. A directly grounded cycle_resumed event provides a new explicit anchor and starts a new cycle namespace. No recovery duration is guessed.

Modeled duration elapsed is only a stage. No birth, child, name, sex, health, personality, feelings, knowledge, count or other person attribute is generated. Canonical birth facts can be displayed on the observed axis; legacy counters are not rewritten by this calculator.

Paternity candidates come only from actual participants in eligible episode-linked exposure events. Multiple candidates remain candidates. Explicit canonical paternity confirmation is a separate event and never becomes automatic character knowledge. Model state remains management-private, including simulated values, seeds and internal draws. Common model analysis receives only a minimal observation contract and the applicable permission/rule references, not simulated evidence.

Observation processing continues when simulation is paused or missing parameters. The paused observation path carries the most recent valid observation checkpoint, and resume replays its committed observations rather than restoring stale observations. Stopped trackers remain stopped.

## World effects

The closed adapter accepts actual item_use_observed facts, used=true, an exact item ID, exact node/rule/version references and an integer-day interval. Existence, possession or recommendation cannot activate an effect. New uses require the current rule version; an existing effect and historical result keep their saved version after later edits.

Approved fictional exposure probability supports set/add/multiply/allow/block. Cycle and episode functions support allow/block. Numeric effects must yield a finite coefficient in [0,1]; invalid output waits rather than being clamped. Scalar equality conditions require the same explicit state version on use and dependent exposure. Unknown conditions, units, applicability or rules are not ignored. Overlap waits unless replacement was explicitly configured; same-day replacement follows explicit story order or waits. An expired functional allow window gates both evaluation and projection.

## Storage bounds and verification boundary

Inline ownership remains the default. The existing opt-in paged history adds indexed, bounded prefix windows and predecessor lookup; it does not decode the full archive for replay. A window contains at most 48 rows. One day group and active effect window also use that existing 48-entry safety bound. Oversize inputs wait rather than truncating. Individual revision records have an explicit limit derived from the existing history record ceiling. Only the current state/episode/effects and cycle are resident on the tracker; older records are retrieved through the existing owner.

A single maintenance call advances at most 48 previously unmaterialized cycles. A longer jump preserves progress and reports fictional_cycle_catchup_pending so the existing retry/maintenance path can continue. No fabricated current result is published before catch-up. Replay is limited by its affected interval and streams bounded pages; total historical storage and total work are not claimed constant or globally RSS-qualified.

Verification is focused pure JavaScript and synthetic existing-owner/card/maintenance/reload/paged-history checks plus source-only development assembly and syntax. There are no real provider/model calls, network/listeners, live host DATA, host-core modifications, deployment, Git publication, Library upload or full backup in this change. Actual activation and production qualification remain closed. Full/Min distribution and generated release metadata remain stale. Full regression, production performance, actual host/all-writer qualification, broad source-retcon matrices and complete E08/E11 migration/restore qualification remain separate.
