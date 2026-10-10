# Existing-card natural-language edits

Approved bounded completion of the original extension proposal §2.4, source attachment SHA-256 e5389ae71f8c319d5d3c8a53e95749fdeccdb528901fb81fefcf47509638ff9d.

## Flow and supported changes

The natural-language editor on an existing tracker card uses the existing `runUserDlcDirect` planner once. The complete response retains `bundleVersion:1`, empty `worldItems` and `adaptiveItems`, and `unresolved`; it additionally contains exactly one `trackerEdits` entry:

- Exact existing `trackerId`, never a name or newly generated identity.
- `editIntent`: `controls` or `instruction_only`.
- Sparse `patch`: `instruction` (string), `trackingEnabled` and `useEnabled` (booleans), plus `simulationEnabled`, `cycleEnabled`, `pregnancyEnabled` for an already configured fictional-cycle calculator.
- `sourceQuotes`: exact request substring for each proposed field.

Only fields present in the selected card's editable catalog are accepted. Unknown fields, invalid types, new items, extra targets, missing control patches for control intent, or any unresolved question block the whole edit. The natural-language path does not create a processor, change numerical parameters, retarget, grant consent, reset history/seed/anchors, or change visibility. Those outside this bounded edit contract remain in the existing structured editor or require clarification, never silently become instruction text.

The example “주기만 추적하고 임신 시뮬레이션은 하지 마” is planned as `pregnancyEnabled:false`. Existing cycle and simulation controls are omitted and preserved. This uses no substring-based language classifier. Model semantic correctness is not established by structural validation: the user reviews the concrete before/after controls. An instruction-only proposal explicitly states that functional settings do not change.

## Admission and apply

Preview is read-only and in-memory. It has no persistent new owner or job framework. It binds the displayed card's scope/chat before the provider request, rejects changed owner/source/input while it is pending, and rechecks overlay and request epoch after awaited context resolution. Close/Cancel/changed input cannot apply a stale result. No repair model call is made.

Apply is a separate explicit user action through the existing verified `saveDirectBundleOwner` path. It reloads the current owner and revalidates scope/chat, persisted owner bytes, target/canonical snapshots, tracker revision, current definition, controls, consent and membership. Calculator validation and application share `prepareExecutionDefinition` / `configureExecution`; tracking and response switches reuse existing setters. Old calculation records remain retained, but their projection waits for the changed definition. Instruction edits likewise mark prior interpretation stale.

Identity, target IDs, unrelated controls, values, history, event results, seed, anchor and visibility are preserved. A stopped card is not restarted by a simulation-only edit. The existing adult-fiction consent gate remains mandatory for calculator changes. There is no automatic promotion to canonical fact or new duplicate tracker.

## Verification boundary

Focused fake-planner/core/GUI tests cover explicit apply, persistence/reload, unsupported/ambiguous output, stale/repeated requests, owner/persona switches, cancellation/dismissal, rejected writes, pause/consent, manual v1 definitions and privacy. Existing nominal bundle workflow and deterministic/fictional calculator tests are rerun separately. No actual model, host, server, user DATA, credential, performance or whole-project regression qualification is implied. The final seven-plugin Full/Min rebuild remains a separate delivery step.
