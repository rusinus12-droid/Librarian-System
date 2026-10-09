# Storage-Mode Feature Audit Schema

> Task 7 of `Librarian-System-0.3.60-STORAGE-MODE-FEATURE-PARITY-PLAN.md`.
> Every owner feature is recorded with the same vocabulary so a result can never
> hide "not tested" as "unsupported".

## Feature record

```json
{
  "owner": "libra",
  "featureId": "LIBRA-CANONICAL-COMMIT",
  "userFeature": "5 U+A canonical memory commit",
  "entryPoints": ["functionName", "GUI control or request hook"],
  "inputs": ["chat transcript"],
  "expectedSemanticResult": "one committed canonical per complete 5-pair range",
  "storageSchemas": ["vector_rag_memory.scope_manifest.v2"],
  "storageKeys": ["vector_rag_memory:scope:<scopeKey>:..."],
  "storageClass": "owner_authoritative",
  "localOnlyConfig": false,
  "branchSensitive": true,
  "sourceEditSensitive": true,
  "pluginOnlyStatus": "verified_supported",
  "mirrorStatus": "unverified",
  "serverOnlyStatus": "unverified",
  "tests": ["PROGRAM/tests/....cjs"],
  "evidence": ["PROGRAM/plugins/LIBRA.js:1234"],
  "requiredWork": []
}
```

### Required fields
`owner`, `featureId`, `userFeature`, `entryPoints`, `expectedSemanticResult`,
`storageClass`, `pluginOnlyStatus`, `mirrorStatus`, `serverOnlyStatus`.

## Status enum

| Value | Meaning |
|---|---|
| `verified_supported` | the mode's real path and semantic result plus durable readback pass |
| `conditionally_supported` | works only under an explicit, tested precondition |
| `intentionally_unsupported` | code/UI deliberately blocks it |
| `defect` | same input produced a different result than the storage contract |
| `unverified` | not enough evidence; never inferred from failure or absence |

## Storage classification

| Value | Meaning |
|---|---|
| `owner_authoritative` | canonical owner data whose loss/corruption is a data defect |
| `owner_derived` | regenerable index/vector/episode projection of authoritative data |
| `local_configuration` | provider keys, GUI prefs — intentionally local, not canonical |
| `credential` | tokens, signing/pairing keys |
| `transient_cache` | rebuildable in-flight cache |
| `diagnostic` | logs/status only |
| `archive_reference` | pointer into a shared/portable archive |

## Per-mode observations

- `plugin_only`: Librarian backend calls for owner data = 0 (external LLM/embedding provider calls counted separately).
- `mirror`: local/server logical digest agreement for authoritative data.
- `server_only`: local authoritative write count = 0; fail-closed on server failure; reload restores.
- common: parent/sibling data unchanged; explicit user mode survives reload; source-edit consent honored.
