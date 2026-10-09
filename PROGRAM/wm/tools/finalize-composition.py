from pathlib import Path
import hashlib,json
r=Path(__file__).resolve().parent.parent;e=r/'evidence';result=json.loads((r/'RESULTS.json').read_text());inputs=json.loads((e/'INPUT-MANIFESTS.json').read_text());pres=json.loads((e/'SOURCE-PRESERVATION.json').read_text());pins=json.loads((e/'PIN-CHECK-post.json').read_text())
def pin(p):return {'path':str(p.relative_to(r)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
art=result['artifacts'];full=art['LIBRA World Manager Full.js'];minimum=art['LIBRA World Manager.js'];report=f'''# WM resource composition: unadopted candidate

Status: SCOPED VERIFICATION PASS; independent composition review pending. This is a new reference candidate, not an adoption or performance result. The adopted WM remains oldrepair-fallback-r1.

## Exact result

Candidate: `{r}`

- Full SHA-256: `{full['sha256']}` ({full['bytes']:,} bytes)
- Min SHA-256: `{minimum['sha256']}` ({minimum['bytes']:,} bytes)

Exactly three production files were copied byte-for-byte from the independently reviewed components:
- Admission: `src/parts/10l-typed-recall-adapters.js`
- Coalescence: `src/parts/01f-lore-consolidation.js`
- Coalescence: `tools/runtime-factory-baseline-owner.source.js`

The complete 98-part source manifest is retained. All 522 remaining existing source/tool files are unchanged. The three explicitly documented reference-only test rebases are separate from that unchanged count. The six changed existing source/tool files therefore comprise three production copies and three path-only test changes. No production implementation was rewritten while combining them. No new shipping debug export or test seam is present.

The rebuilt Full artifact equals the nonoverlapping union of the two reviewed Full artifact deltas, byte for byte. Min was generated with the unchanged pinned Terser options and directly tested. The full 01f source fragment cannot be searched verbatim inside the bundle because the existing runtime factory transforms it; exact source-copy equality and the exact artifact-delta union were verified separately.

## Immutable inputs and build support

Immediate input: `{inputs['roots']['base']}`

- Base Full: `489c90c10d2e32181f6df7ef9c36870f7e8d2661db7ffc244d3317ad75832fa6`
- Base Min: `58df4e6fa756f23c71ae25afc2be5896fdb06c24b3d6fad229663a88b3fa1c9d`
- Admission Full/Min: `8496890179e12e70bccccba3ad6996c00a2c32f1665d259a03a8df58051a66a0` / `596f7aab6631002376af80be0b521f8ebef476a24a8a56dd0e73df3a441c8382`
- Coalescence Full/Min: `5a6d0c1e1d5cba75e8b0c330d4ea8a7cf690e7a2e0ad81fca814c463fda355c8` / `8c609b727bd18fe998bf8fb8c5511883128515ae98ea9963cb93211ca3d91901`

Both component reviews were scoped passes. The final coalescence review was confirmed before composition, with review SHA-256 `81db40d1d94aa390b37ccfd4e0a9c01c9f7a3e6847b6ed3ecdac888997b17eef`. Reports and pin metadata are retained under historical, clearly separate from this candidate's fresh evidence.

Before and after execution, all 554 immutable-base files, 599 admission-candidate files, 609 coalescence-candidate files, 36 admission-review files and 26 coalescence-review files matched the complete input manifest. The latter review count covers its top-level durable evidence, excluding its separate execution copy. The reviewed all-file manifests were verified before preparation; neither original candidate was changed.

The supported overlay builder itself is unchanged. BASE-PINS explicitly rebases its 530 source/tool/artifact dependencies to the complete restored immediate input. Missing historical cap-reference metadata, CANDIDATE.json and PRODUCT-SUPPORT-FREEZE.json were not fabricated. The three tests use the exact reviewed coalescence reference expressions, which resolve that same input through BASE-PINS. Admission had used equivalent absolute-path expressions; that static-preparation difference is documented in PREPARATION-NOTE. Assertions were not changed. Fresh parity is with checksum-use-candidate-1700, not the unavailable dispatch-repair artifact.

Node v24.19.0 and existing Terser 5.51.2 were used without installation or option changes. The existing toolchain lock matches the restored lock, SHA-256 `ffaf311c44002f7ccdbe4402ef9ca3890a5bd0e6e0df0294a7b7a8079bf5179e`. Lock/package definitions are included under build-support. The complete source/tool copy still requires its explicitly pinned immutable base and existing toolchain; see BUILDING.md.

## Fresh combined verification

After the LIB restore reviewer released runtime and the parent granted this window, one WM suite group ran at a time. No quiet-machine timing or total-memory inference is made.

Each of Full and Min passed, with exits 0:
- Existing critical/lifecycle coverage: 70 cases
- Admission coverage: 29 leaf cases, 30 reported including the parent
- Coalescence reference/candidate coverage: 13 cases
- Actual-shipping synthetic heap capture and structural assertion

This is 112 leaf cases, 113 Node-reported tests per artifact. The existing 52 shared critical cases are included once in 70, not added again. Full and Min repeat the same cases. The component reviewers' supplemental 7/3/4 controls were not rerun here. Causal RED results remain pinned component evidence; a fresh composition RED run was not performed.

Actual hook results preserve exact decisions, payloads, I/O and parser counts against the immutable base:
- Three MiB: 20 physical reads, 62,914,560 bytes, 2 parses
- Chunked: 140 physical reads, 62,927,820 bytes, 2 parses
- Over hydration cap: 20 physical reads, 83,886,100 bytes, 2 parses
- Target reads: 6 each; target checksums: 6 / 6 / 36
- Every output SHA-256: `6f3f7a7c03aef1c43a497d910524d6f24fb30aaf67adbd8a0d58b05dc1115056`
- Request owners, borrows and pending reads return to zero

Context and integrity callback mutations continue to reject as `integrity:checksum_mismatch`, with checksum getter counts 0 and 5. Mutable input, custom parser/validator, witness revocation, held-read currentness, scope/generation and fallback-fence controls pass. Full logs and generated synthetic hook observations are retained. The offline transport guard was loaded for every Node execution; no blocked transport was logged. Model-call assertions stayed zero in the relevant fixtures.

## Physical backing in the composed artifacts

Fresh Full and Min heap snapshots, taken before diagnostic string equality, show baseline.postRaw and readonlyReadProof.raw pointing to one actual flat-string root. Their combined backing self-size is 1,136,696 bytes for the 568,340-character two-byte synthetic canonical fixture. BeforeRaw remains a distinct root. The actual shipped owner/readVerified path preserves 3 physical reads, 1,136,812 physical bytes, 1 parse and the exact existing proof keys.

This confirms that composition preserves the component's demonstrated aliasing. The earlier pinned unmodified-base pair used two roots totaling 2,273,392 bytes; those old RED snapshots were not rerun. Thus the component's 1.084 MiB small-case reduction survives composition. Reachable backing self-size is not total-process or dominator retained heap.

Heap child processes received an explicit non-secret environment. Raw snapshots remain only in restricted /tmp and are absent from this candidate. Only fixed labels, node identities/types, sizes, lengths, links and boolean/equality structure are retained. No raw heap is included in deliverables.

## Reproduction, pins and remaining gates

- `tools/verify-composition.py` checks complete immutable inputs, exact production copies, unchanged files and the Full artifact union.
- `tools/run-composition-verification.py` builds and serially runs the bounded checks with explicit child environments. Coordinate runtime before rerunning; it overwrites generated evidence, so use an isolated copy to preserve this record.
- `tools/summarize-composition.py` validates exits/counts, hook outputs and heap structure.
- SOURCE-ARTIFACT-PINS, REVIEW-INPUT-PINS and FILE-PINS freeze the final files. The last manifest excludes only itself.

No original97, full historical137, timing benchmark, settled-heap acceptance, live host, real DATA, external model, network, merge, deployment or adoption occurred. The original approximately 142 MiB diagnostic growth, 128 MiB acceptance gate, five-second latency gate and added equality-comparison cost remain unresolved. This combination does not guarantee either resource goal. Independent composition review must precede any separately approved quiet acceptance run.
'''
(r/'REPORT.md').write_text(report)
source=[];review=[]
for p in sorted(r.rglob('*')):
 if not p.is_file() or p.name in ['SOURCE-ARTIFACT-PINS.json','REVIEW-INPUT-PINS.json','FILE-PINS.json']and p.parent==r:continue
 rel=str(p.relative_to(r));is_source=rel.startswith(('src/','dist/','build-support/'))or rel=='BASE-PINS.json'or rel in ['tools/build-overlay.cjs','tools/factory-edits.cjs','tools/build-libra-runtime-factory.cjs','tools/build-libra-world-manager.cjs']or rel.startswith('tools/')and rel.endswith('.source.js')
 (source if is_source else review).append(pin(p))
for name,entries in [('SOURCE-ARTIFACT-PINS.json',source),('REVIEW-INPUT-PINS.json',review)]:
 (r/name).write_text(json.dumps({'status':result['status'],'productionAllowlist':pres['productionAllowlist'],'files':entries},indent=2)+'\n')
allfiles=[pin(p)for p in sorted(r.rglob('*'))if p.is_file()and p!=r/'FILE-PINS.json'];(r/'FILE-PINS.json').write_text(json.dumps({'root':str(r),'excludes':['FILE-PINS.json'],'files':allfiles},indent=2)+'\n')
print(json.dumps({'report':pin(r/'REPORT.md'),'fileManifest':pin(r/'FILE-PINS.json'),'sourceArtifactPins':len(source),'reviewInputPins':len(review),'wholeCandidatePins':len(allfiles)},indent=2))
