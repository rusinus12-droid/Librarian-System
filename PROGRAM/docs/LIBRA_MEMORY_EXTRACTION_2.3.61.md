# LIBRA 2.3.61 — factual memory extraction and refusal diagnostics

## Request contract

The Librarian now explicitly extracts continuity-relevant facts from a quoted transcript rather than continuing a scene. Sensitive material is requested as non-graphic factual summaries; consent, refusal, coercion, harm and uncertainty must remain accurate. Proposals and attempts cannot become completed acts. Exact source input and the existing v4 evidence contract remain intact. Use minimal supporting quotations rather than decorative passages or unrelated names.

The wire system prompt keeps the fixed output/evidence contract and editable analysis profile, without repeating both runtime lock blocks and a final contract. Tests confirm the default system is shorter than the observed 11,200 characters. Fictional world identity remains distinct from the host chat worldline; scene time and current thread interpretations remain source-grounded. A kind-to-domain mapping addresses a common invalid-record shape. This does not establish acceptance or semantic accuracy by a live model.

## Refusal handling

Canonical requests classify explicit structured refusal fields, provider terminal refusal/filter signals, and narrowly recognized English/Korean first-person request refusals before JSON decoding. JSON records, quoted dialogue, and a narrative merely mentioning refusal are not classified by a bare keyword. Unrecognized prose remains a format error. This is deliberately conservative, not a universal natural-language refusal detector.

The completion ledger records a refusal rather than usable completion. Diagnostics preserve the response, source of classification, provider finish reason and measured usage. The failed range remains uncreated, prior memory/State remain unchanged, and no automatic analysis retry is made for refusal. The dismissible UI names the range and reports model refusal rather than JSON failure.

## State selection and compatibility

For confirmed current facts competing for a single-valued field on the same subject/target/dimension and source row, exactly one explicit State binding selects that fact. Other same-row facts stay in canonical memory and are listed as superseded in the derived Head. Their dependent State updates cannot silently become current. If neither or several candidates are bound, normal per-field conflict isolation applies. Newer rows are not suppressed by earlier selections. JSON order and quotation position are not used as event-order proof. Independent knowledge, permissions and affiliation updates retain their existing collection semantics.

Canonical artifacts, stored source, revisions, evidence rules and source/scope/worldline/readback gates are unchanged. Replay can rebuild derived State from saved facts without new analysis. Existing user corrections still use the correction journal. Version 2.3.60 header-menu changes are retained.

## Validation

Focused full-plugin tests cover plain/structured/terminal refusals, false positives, later-range refusal preserving existing data, actual wire prompt construction, explicit/absent/conflicting bindings, array-order independence, multiple knowledge entries, and local replay. A real local HTTP/SQLite restart test verifies the selected field and canonical byte preservation. The actual production notice builder is tested with DOM substitutes, including close behavior. No external model requests or live RisuAI GUI checks are included.
