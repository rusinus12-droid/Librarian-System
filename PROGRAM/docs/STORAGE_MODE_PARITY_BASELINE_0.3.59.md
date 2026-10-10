# Storage-Mode Feature Parity Baseline — Librarian System 0.3.59

> Task 1 of `Librarian-System-0.3.60-STORAGE-MODE-FEATURE-PARITY-PLAN.md`.
> This document is the immutable reference for every later phase. Any byte change to a hashed
> file after this baseline must be attributable to this project (R01/R02/R03, version bump, or
> parity remediation), not to an unknown pre-existing change.

**Baseline captured:** 2026-09-16
**Package version at baseline:** `0.3.59` (`PROGRAM/VERSION.txt`)
**Node runtime used:** `v24.18.0` (win32)

---

## 1. Baseline hashes

### 1.1 Plugin byte streams

| File | SHA-256 | Bytes | Header version |
|---|---|---|---|
| `PROGRAM/plugins/LIBRA.js` | `51F4C2CE6B1BC4102433C46556B1E2B6FDEAC612071DD1104116146300802188` | 5527118 | `2.3.124` |
| `PROGRAM/plugins/HAYAKU_Locator_Continuity.js` | `7071D0D1572A324E343A81ADD01B8A332673BC600D1814C4D00F525A35BC3C0D` | 3541711 | `3.0.132` |
| `PROGRAM/plugins/Flashback_Memory.js` | `B90C870A4C15CDCEC21F511DC62BDC9CA494B6DE8A1100CCB549C5CA9D8E47C7` | 2786123 | `1.0.94` |
| `PROGRAM/plugins/LIA_Persona_Linker.js` | `C8FA26F01E9BF39F3D0D14F48DA125F677A8EFB61E5BF5EFC3150FBBC1F049AB` | 1664338 | `0.26.79` |
| `PROGRAM/plugins/RETRACE.js` | `1397867482012E45C28FD02DFC8080606F456166432E47D086CE0A10AF2E24AF` | 1058253 | `1.9.81` |

Version headers observed (all five plugins use `//@version` plus an internal `PLUGIN_VERSION`):

- LIBRA: `//@version 2.3.124`, `const PLUGIN_VERSION = '2.3.124'`
- HAYAKU: `//@version 3.0.132`, `const PLUGIN_VERSION = '3.0.132'`
- Flashback: `//@version 1.0.94`, `const PLUGIN_VERSION = '1.0.94'`
- LIA: `//@version 0.26.79`, `const PLUGIN_VERSION = "0.26.79"`
- RETRACE: `//@version 1.9.81`, `const PLUGIN_VERSION = '1.9.81'`

### 1.2 Shared Storage SDK / Native Branch sources

| File | SHA-256 | Bytes |
|---|---|---|
| `PROGRAM/sdk/MemorySuiteStorageClient.source.js` | `4A158AEE7CD14A2ACF74309E9031A1BEC2AD9F638E84860030E5B59E5BAAABE7` | 336136 |
| `PROGRAM/sdk/MemorySuiteStorageClient.libra.source.js` | `A571EC6684D2F9F472021DE5BBCA49E493F4C75C3F8C19CD22AE5C2B839D5E37` | 351384 |
| `PROGRAM/sdk/MemorySuiteNativeBranchTargetStorage.source.js` | `7C6BBD6B2F500321FEF166EE5C56634EF0BB01DC2E9F36A364D9389B8DC9879B` | 6355 |
| `PROGRAM/sdk/MemorySuiteHostLineage.source.js` | `B1F7592C1933753C1537BB1925017A1DC930C52B92886B81D8317DAF25651615` | 12913 |

### 1.3 Server validator and Release Builder

| File | SHA-256 | Bytes |
|---|---|---|
| `PROGRAM/server/core/host-lineage-metadata.cjs` | `B1468AFE627BC64BC992E63B6DBF055CA793F9FB7E31DE96F91CBECB0C1EC8B6` | 8556 |
| `PROGRAM/tools/build_distribution.cjs` | `93FE4214DF41937F2CD60A9531EB2AE3405661A13338A8F728C20DCFA4812703` | 37191 |

### 1.4 Existing native-branch tests (23 files)

| Test | SHA-256 |
|---|---|
| `native_branch_0357_storage_migration_test.cjs` | `F856980081CFE9C86150A7A3B7AA8095A334DABBD40ED6152EDDC273A64F37A3` |
| `native_branch_flashback_runtime_test.cjs` | `FBA1B2101A92E10DF8B6EF88C2EC497B543A6EB1DB7F6ED668EB303348D11E00` |
| `native_branch_flashback_storage_modes_runtime_test.cjs` | `DC6E876970882605AACA6FA017B07586190BDDDB97306A0F7BB918B832F51B8A` |
| `native_branch_hayaku_runtime_test.cjs` | `725B92CA0E48F2DADC41D5886C54EF7DA36DF5261343D7E917CC14F108C5BB7D` |
| `native_branch_hayaku_storage_modes_runtime_test.cjs` | `901DADA6DFDF2408FE3B288D740EBCEBE846455585A835A10B114EC4762CCF37` |
| `native_branch_host_lineage_test.cjs` | `B00C26DCF7A157BC440A9F3F614171EFA77F9311289FE7FC764848AD33889BE4` |
| `native_branch_lia_runtime_test.cjs` | `76CF830DA342DB24EC0B1C3651B275853E8F93D8BC0373516CAFF741B60E732E` |
| `native_branch_lia_storage_modes_runtime_test.cjs` | `19B65847383EE89222D0EDE8E5120A94E2C8CC1EA098B1561DF293924260DA6D` |
| `native_branch_libra_precanonical_fork_test.cjs` | `1580DF3FD8DBD0B8DF6819DE578548488A73C5D31B8DAA1FF64E777BB00CE207` |
| `native_branch_libra_prefix_test.cjs` | `349A634D1AAF8C3AA2074DBF9CB17C39A988434E8F116E84A94BD18709EDFA9B` |
| `native_branch_libra_runtime_test.cjs` | `92830794B8E97BBE9259D1E779747B10EBF904B70DF92689701E52AB0C1802E2` |
| `native_branch_libra_storage_modes_runtime_test.cjs` | `35140644D2C9194B8AE3047B22644D6D94B727672DFCD91C66A5EEB2789CA276` |
| `native_branch_libra_t7_continue_test.cjs` | `46900288A90690F096FD852D3FDC949147EFB2F4BD659B41FA226A7AEA432A29` |
| `native_branch_libra_worldline_conflict_test.cjs` | `4572E36010AD50C298CE50BC0EB52DDEC2D2F4442B101CE0E1CC61CAA1D2BCB7` |
| `native_branch_libra_worldline_legacy_migration_test.cjs` | `CC7F65599CE02B86AC1A01F7C224177C4F50CE50F4CEF2D8C159C89B9EBB6503` |
| `native_branch_libra_worldline_meta_test.cjs` | `C510DD580BD6658CC84F85821A82039EDBB6B9306AAE3FA94E538894E4B5E81C` |
| `native_branch_release_gate_contract_test.cjs` | `318E374B5433B7BFDBBEAA7E44A482730AFFFF2B4C411488D23E47E1EB6202BB` |
| `native_branch_retrace_gui_scope_test.cjs` | `3E172EA711B70DEDF2020CD188094958B61D986A567F8A68DBD621CEF9583AA6` |
| `native_branch_server_metadata_test.cjs` | `E3F3E365B0BE90EBF7CA19F4F67DED48B770E6098DBEB6EC6EBDC637F2D63C54` |
| `native_branch_storage_binding_server_test.cjs` | `26190E83232C9001DBD4DE62EB3E3773D0DDC7A807522960AEC797567566E0C5` |
| `native_branch_storage_design_contract_test.cjs` | `CB4F224BD02048B4B67E500DE671814CC28D9BB5AB959866C24ED05EFF3556DD` |
| `native_branch_storage_mode_inheritance_test.cjs` | `6F196F23B9E39D1FCC0AC36F1244C12298B3DBA0DD091C2E4BCF9EE5522E4B9D` |
| `native_branch_storage_modes_matrix_test.cjs` | `525B03F135FE0999CA1AA2CC0AC2E8CF0049F77B8501A1AC986B6DB10F5FD7F1` |

---

## 2. Pre-change gate verification (Task 1 Step 2)

All four mandatory native-branch gates were run against the untouched 0.3.59 tree before any
code change.

| Test | Result | Counts |
|---|---|---|
| `native_branch_storage_design_contract_test.cjs` | PASS | `passed:37, violations:0` |
| `native_branch_storage_modes_matrix_test.cjs` | PASS | `passed:12` (4 owners × 3 modes) |
| `native_branch_0357_storage_migration_test.cjs` | PASS | `passed:7, origin:migrated` |
| `native_branch_storage_binding_server_test.cjs` | PASS | `passed:15` |

---

## 3. Release smoke suite (Task 1 Step 3)

Suite enumerated from `RELEASE_SMOKE_TESTS` in `PROGRAM/tools/build_distribution.cjs` (lines 20–86).

| Metric | Value |
|---|---|
| Entries in `RELEASE_SMOKE_TESTS` | **63** |
| Executed | 63 |
| PASS | **63** |
| FAIL | 0 |
| Wall time | ~91 s |

### Deviation from plan text

The plan (Task 1 Step 3 and Global Constraints) references a "64 mandatory release-smoke
tests" baseline. The actual frozen array in 0.3.59 contains **63 unique `.cjs` entries**.

- This discrepancy is recorded as a baseline fact, not a defect introduced by this project.
- No entry is missing on disk; `PASS=63 FAIL=0 MISSING=0`.
- Task 6 (pre-audit gate) will add the new R01/R02/R03/provenance tests to this array. After
  that change the expected count becomes `63 + 4 = 67` unless a task adds additional focused
  tests, in which case the count is recorded explicitly at Task 6.

Raw stdout/stderr for the 63-test run was captured during execution; the result is reproducible
with:

```bash
node --test PROGRAM/tests/<entry>.cjs
```

---

## 4. Exit condition

Later failures can be attributed to this work rather than an unknown pre-existing change:

- Every plugin/SDK/validator/builder/native-branch-test byte stream in scope is pinned above.
- The pre-change gate is green (4/4).
- The pre-change release smoke is green (63/63).
- Checkpoint 0 ZIP contains this untouched tree plus this report.
