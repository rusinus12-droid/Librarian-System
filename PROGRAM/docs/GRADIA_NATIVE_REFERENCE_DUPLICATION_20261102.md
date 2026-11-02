# GRADIA native reference duplication patch

Branch: `codex/gradia-native-reference-binding`.

The supplied GRADIA 0.28.13 debug export reports response evidence unavailable
with `LIB_READ_NATIVE_ID_UNAVAILABLE`, and `lastNativeBindFailure` identifies
`turn_ref_not_unique`, stage `shadow_act`, matches `2`. The export does not
identify the conflicting rows, so their origin remains unconfirmed.

Completed-turn selection already keeps the last assistant variant for a native
ID. Evidence capture previously searched the entire request and rejected even
identical copies of that selected reference. It now accepts repeated copies
only when their full reference, native ID, role and effective raw content agree.
It emits one source record. Conflicting raw content or roles still fail closed;
host binding still rejects duplicate IDs in the actual host transcript.

The regression test fails before the patch. After the patch the native binding
suite passes 42 tests, including a beforeRequest pipeline case with a repeated
assistant and controlled owner evidence reaching all four model requests.
Negative tests cover conflicting raw content and duplicate host IDs.

This is a local source patch, not a new plugin release. It does not establish
live RisuAI/provider success. The input writer's separate
`LIB_READ_UNIFIED_UNAVAILABLE` remains unresolved: the supplied GRADIA export
does not retain the underlying LIBRA error. Diagnose that with the matching
LIBRA `lastGradiaUnifiedRead` record rather than relaxing owner verification.
