# HAYAKU hash builtin access

Base: `2058bce52dd0088c7eae2c7204b849ce581144f1`; baseline HAY SHA256 `2fd0de9e45596ca5c3d63d1a91aaeb82a07d465af68011c9fef18d6aed230076`.

The owner VM resolved `Math` three times for each UTF-16 character in its exact FNV-1a/64 loop. Capture the same `floor` and `imul` builtins once per hash invocation. Keep every input character, the arithmetic and base36 output, BigInt/fallback behavior, complete raw-source validation, provider readback and canonical admission unchanged. No cache or host revision assumption is introduced.

The new control fails on the baseline with 169,200 global lookups for 56,400 validated characters. Exact FNV oracle vectors and actual registered cold/warm hooks pass on the baseline. The candidate passes all three controls; cold/warm hooks still validate all 12 raw sources without a trusted host revision. Targeted existing hash, source policy, provider-fence and stale-writer checks pass together: 13/13.

Diagnostic attribution, not release timing: the overlapping instrumented 2000-source run records 39,194,342 hash characters and 138,923,571 VM Math reads in the cold hook. Its ledger persistence also includes 2000 independent source-evidence reads, writes and exact readbacks. That IO, common evidence fingerprints, canonical packet preparation and scope switching remain separate costs. Full cold/scope preparation is not declared solved by this bounded hash change.

Evidence directory: `C:/Users/rusin/AppData/Local/Temp/LIB-HAYAKU-Cold-Preparation-Evidence-20261003`. Original promotion, bundle/build and frozen release timing belong to the controller.
