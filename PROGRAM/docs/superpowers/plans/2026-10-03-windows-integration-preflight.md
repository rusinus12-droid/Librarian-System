# Windows Integration Preflight Implementation Plan

> **For agentic workers:** Use the approved inline execution method and bounded
> Temp fixtures. Root reviews and decides integration; this unit never changes
> the original repository, main, ACLs, or persistent Git configuration.

**Goal:** Windows에서 통합 전 상태를 읽어 mode-only 차이, 실제 내용/EOL 변경,
Git branch 점유, frozen ref 오류, sandbox 권한의 불확실성을 구분한다.

**Architecture:** 의존성 없는 Node CLI가 exact source/target commit, ancestor,
대상 작업 트리와 staged 상태, 디스크 바이트, 보존 receipt를 검사한다. Git 통합
조건과 쓰기 권한은 별도 판정하며, checker는 실제 통합이나 권한 probe를 수행하지
않는다.

**Tech Stack:** Node built-ins, local Git read commands, Windows read-only Get-Acl.

**Spec:** 부모가 승인한 두 파일 범위의 설계를 이 문서에 기록한다.
Base: `37817d4f7d79eba78db4d7cfba8cb9e1ee13b2aa`.

## Global constraints

- 제품 변경은 `tools/check_windows_integration_preflight.cjs`와 이 문서만.
- 모델, 네트워크, fetch, hook, 외부 diff/textconv, 의존성 설치를 실행하지 않는다.
- reset, stash, checkout, merge, push, write probe, ACL/config/security 변경을
  checker에서 실행하지 않는다. 테스트의 Git 초기화/변경은 본인 Temp fixture만.
- 기존 691 후보와 원본 `.git`, 설정, dirty 사용자 파일은 수정하지 않는다.
- 모든 Git 인자는 배열로 전달하며 `shell:false`, `windowsHide:true`,
  `GIT_OPTIONAL_LOCKS=0`을 사용한다. hook/fsmonitor/filter는 command 범위에서만
  비활성화하고, resolved repo의 safe.directory만 그 command에 지정한다.

## Review focus

Mode 차이에 content/EOL 또는 staged 변경이 섞이면 무조건 차단한다. source의
dirty 파일은 임의 승인하지 않고 exact byte backup receipt가 승인한 범위만 별도
보존한다. main의 다른 worktree 점유는 차단하며 명시된 본인 target worktree는
허용한다. ACL owner 정보, read 성공, 다른 작업의 승인으로 `.git` write 허용을
추정하지 않는다. snapshot 또는 byte 증명을 읽을 수 없으면 차단/unknown이다.

## Implementation and proof

- [x] full pre-main bundle의 SHA를 검증하고 별도 Temp branch를 base378에서 준비.
- [x] 제품 코드 전에 Temp real Git fixture 제어를 작성하고 missing checker RED.
- [x] frozen refs/HEAD/ancestor, raw/cached/status, branch 점유, 보존 snapshot 구현.
- [x] mode/content/EOL byte 검증과 opaque dirty-source physical backup receipt 구현.
- [x] declared sandbox, actual read-only ACL, exact reported action/approval 분리.
- [x] 최종 source로 전체 fixture 16 GREEN, syntax/diff 검증.
- [x] source Git clean 및 exact 두 파일 commit을 확인하고 root에 manifest 인계.

## Interface

`checkIntegration(request)`를 export하며 CLI는 다음처럼 읽기만 수행한다.

```powershell
node Librarian-System/PROGRAM/tools/check_windows_integration_preflight.cjs --request C:/Temp/request.json
```

```json
{
  "source": {
    "repo": "C:/Temp/frozen-source",
    "ref": "refs/heads/source",
    "pin": "<exact 40-character commit SHA>",
    "files": [{"path": "relative/path.cjs", "sha256": "<exact file SHA-256>"}]
  },
  "target": {
    "repo": "C:/Temp/known-main-worktree",
    "ref": "refs/heads/main",
    "pin": "<exact current main commit SHA>",
    "branch": "main",
    "ownedWorktree": "C:/Temp/known-main-worktree"
  },
  "allowCommandFilemodeFalse": false,
  "permissionContext": {
    "sandboxMode": "workspace-write",
    "writeRoots": ["C:/Temp"],
    "readOnlyPaths": ["C:/Original/.git"],
    "approvalRequiredPaths": ["C:/Original/.git", "C:/Users/example/Downloads"]
  }
}
```

`source.ref`와 `target.ref`의 resolved commit, 두 worktree HEAD, source file의
committed bytes를 각각 pin과 비교한다. ancestor가 성립해도 target에 incoming
source commit 또는 incoming tree/blob 객체가 없으면 local fast-forward 조건을
충족하지 않는다.
source/target의 index/config/status/dirty-file SHA와 worktree 등록 상태를 전후에
비교하며 raw config 값과 파일 내용은 출력하지 않는다.

`allowCommandFilemodeFalse:true`는 Git `core.filemode`의 영구 변경을 승인하는
옵션이 아니다. HEAD/index mode는 같고 Windows disk mode만 다른 ordinary `.M`
행이어야 하며, 모든 target tracked file의 index blob과 disk bytes가 정확히 같고
staged/untracked/unmerged 변경이 없어야 한다. 이후 그 read command에만
`-c core.filemode=false`를 적용한다. raw와 effective 상태를 둘 다 남긴다.
autocrlf가 Git 상태를 clean으로 보이게 해도 raw EOL bytes가 다르면 차단한다.
16 MiB 초과 blob, submodule/symlink, 읽기 불가 등 exact byte 판정이 불확실한
경우도 통과시키지 않는다. 이는 conservative preflight이며 일반적인 Git clean
정의보다 엄격하다.

## Dirty source receipt

source가 dirty이면 `source.dirtyReceipt:{path,sha256}`를 명시한다. receipt는
`windows-integration-dirty-source-receipt.v1` schema와 exact repo/head,
statusSHA256/indexSHA256/configurationSHA256, 모든 dirty file의 path/kind/bytes/
sha256를 담아야 한다. 각 regular file은 별도 `backupPath`와 `backupSHA256`가
필요하며 checker가 실제 backup bytes와 current bytes를 비교한다. 삭제는 missing
행으로 기록한다. source/backup/receipt가 이후 달라지거나 승인 범위 밖의 dirty
파일이 생기면 차단한다. symlink 등의 backup 의미가 불명확하면 차단한다.

source와 backup은 lstat에서 symlink가 아닌 ordinary regular file이어야 한다.
canonical path가 같거나 Node BigInt dev/ino가 같은 파일은 다른 이름이어도
독립 backup으로 승인하지 않는다. 두 파일 모두 nonzero physical identity가
확인되어야 하며 identity가 제공되지 않으면 차단한다. Windows에서는 별도 읽기
전용 Get-Item -LiteralPath로 두 파일의 reparse attribute를 확인한다. reparse
point, 조회 실패, 누락/불명확한 attribute 결과도 차단한다. path는 encoded
PowerShell의 environment JSON 데이터로 전달한다. exact snapshot/byte/hash
검사는 이 physical-file 조건에 추가로 계속 필요하다.

이 receipt는 부모가 이미 승인한 user patch/backup 범위를 표현한다. checker가
임의 dirty 내용을 승인하지 않으며, 보존된 dirty bytes는 frozen source commit에
포함되지 않는다. source 보존 상태와 target 통합 가능성을 혼동하지 않는다.

## Permission results and failures

ACL/owner는 read-only Get-Acl을 시도한 결과로 기록한다. 성공한 record만 실제 ACL
관측이며 모든 record가 실패하면 ACL status도 unknown이다. 검증 환경에서
Get-Acl의 Security module 로드 오류가 기록됐고, 별도 Get-Item file attribute
조회는 성공했다. 실패한 ACL 조회를 owner 관측으로 확대하지 않으며 effective
write는 unknown으로 유지한다. declared sandbox write root와 read-only/approval-required
경로는 별도 정보다. 원본 `.git` 또는 Downloads가 OS에서 writable처럼 보여도
현재 tool sandbox의 write 승인을 대체하지 않는다.

기본 `requestedAction`은 target Git common directory의
`{id:"integrate-frozen-refs",kind:"write",path:".../.git"}`다. 실제 요청한 작업의
결과가 있으면 caller가 `actionResult`로 exact id/kind/path/outcome/authority/reason을
전달한다. 실패한 action/reason은 그대로 남기고 재시도나 권한/config 변경을
지시하지 않는다. read 성공, 다른 path/action, ACL authority는 write proof가 아니다.
성공 결과는 `authority:"reported-tool-result"` 또는
`"user-performed-action-result"`만 해당 작업의 보고로 취급한다. declared scope가
approval-required/read-only/unknown이면 추가
`approval:{outcome:"approved",authority:"sandbox-auto-review"}` 또는 user 승인
receipt가 있어야 한다. 이 입력은 caller의 외부 receipt이며 checker가 인증한
새로운 승인이나 다음 작업에 재사용할 권한이 아니다.

`gitIntegration.status`는 `ready`/`blocked`다. 전체 `status`는 Git 조건이나
exact action 실패 시 `BLOCKED`(exit 1), write proof 불명 시 `UNKNOWN`(exit 2),
조건과 exact reported action/필요 승인까지 충족한 경우 `READY`(exit 0)다.
읽기만 성공한 정상 점검이 `UNKNOWN`을 반환하는 것은 의도한 동작이다.
권한 실패를 받으면 실제 action/reason과 declared approval boundary를 사용자에게
설명하고 멈춘다. ACL 변경, global safe.directory, 전역 Git 설정 수정 또는 무조건
반복 실행을 해결책으로 제안하지 않는다.

## Limits

checker는 read-only sample이며 통합을 예약하거나 ref CAS를 제공하지 않는다.
실제 승인된 통합 직전에 frozen refs/status를 다시 확인해야 한다. bundle의 완전한
closure/fsck/actual restore는 별도 root checkpoint 책임이다. 외부 action receipt의
진위를 독립 인증하지 않는다. ACL 해석으로 sandbox write 권한을 추론하지 않는다.

최종 16개 제어는 clean/unknown-write, actual Windows mode-only,
content/EOL/staged mode+content, occupied/owned main worktree, commit/file pin,
dirty-source exact backup/changed source/changed backup, action denial/read-only
성공/path mismatch/ACL authority/필요 승인 없음/explicit approved receipt,
target incoming object 없음, CLI exit 의미를 검증한다. 최초 missing checker
12 RED, 중간 12 GREEN, 추가 경계 2 RED와 승인 경계 1 RED/1 positive,
최종 16 GREEN을 Temp evidence에 보존한다. root의 전체 제품 회귀나 통합 수행을
이 checker fixture 결과로 대체하지 않는다.

## Physical backup follow-up

고정 bd97aaa7a734eb0cf598651e168d59abff439208의 독립 16 PASS 이후 실제
Windows hardlink 제어에서 dirty source와 backup이 동일한 physical file이어도
승인되는 RED를 확인했다. source를 변경하면 backup도 함께 변경되므로 이
후속 수정은 regular file, canonical path, physical identity와 Windows reparse
정보를 모두 확인한다. 원래 차단된 review packet과 RED는 별도 Temp evidence에
동결했다. copied backup positive와 exact bytes 기준은 유지한다.

추가 회귀는 실제 copied backup/hardlink/junction/directory 제어와 synthetic
OS metadata seam을 구분한다. source/backup reparse, unavailable identity,
symlink/nonregular, read-only metadata failure와 all-failed ACL UNKNOWN을 검증한다.
이 결과는 actual requested original write 또는 sandbox approval 증명이 아니다.

## Backup bytes bound to physical identity

The frozen b037afc10d3d24212654cd7e7a531ff2d1b84d8f follow-up passed its
30 controls, but independent review reproduced an actual filesystem replacement
after the identity/Get-Item sample: the copied backup path became a source
hardlink before its path-based bytes read. That exact blocked review and RED are
retained separately; the 30 PASS receipt does not erase this finding.

The child fix opens source and backup read-only and reads their bytes through
those descriptors. Regular-file fstat evidence must match the path observations,
including nonzero dev/ino, size, mtime and ctime. Both byte hashes must match the
receipt's current source pin. The descriptor identities and canonical/path
identities are checked again after the read; Windows reparse observation is also
repeated, with a subsequent lstat check to detect replacement during Get-Item.
Unavailable identity or attribute evidence, changed backing files and changed
bytes refuse preservation approval.

After the remaining Git and ACL observations, the checker takes its final
source/target snapshots and rechecks each accepted physical backup against its
original identity and byte pin. A detected change revokes dirty-preservation
approval and blocks Git prerequisites. ACL observation now occurs before this
final preservation sample, so a replacement during that later read is covered.

The new seven controls preserve the same executable RED/GREEN test source:
actual hardlink replacement at bytes read, after Get-Item and during later ACL;
actual same-byte copied backup replacement during ACL; actual backup rewrite
after bytes return; actual same-byte source replacement at backup read; and a
synthetic unavailable opened-fd identity. The original path-reader-only review
control is retained as historical RED; the new read-boundary control activates
both the old path reader and the descriptor reader, without requiring the new
implementation to retain the old path-based read.

These are bounded read samples. They do not lock files, perform ref CAS, prove
future immutability, authenticate an external permission receipt, or authorize
an original repository write. Root owns the separate child review and any
integration decision.
