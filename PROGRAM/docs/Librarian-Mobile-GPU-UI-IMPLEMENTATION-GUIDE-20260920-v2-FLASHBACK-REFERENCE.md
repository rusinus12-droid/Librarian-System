# RisuAI API v3 플러그인 GUI — 모바일 고비용 효과 제거 및 시각 품질 유지 가이드

- 작성일: 2026-09-20
- 대상: Librarian System 계열 플러그인 GUI
- 우선 대상:
  - LIBRA
  - HAYAKU
  - Flashback Memory
- 목적:
  - RisuAI API v3의 iframe 기반 GUI에서 모바일 GPU/공유 메모리 부담이 큰 효과를 제거한다.
  - 특히 `backdrop-filter` 계열을 제거한다.
  - 단순히 효과를 빼서 평평하고 투박한 UI로 만들지 않고, 더 저렴한 시각 요소로 세련된 깊이감과 계층을 유지한다.
  - 이후 AI-assisted coding 과정에서 같은 효과가 다시 들어오지 않도록 Release Gate로 막는다.

---

# 1. 배경

RisuAI API v3 플러그인은 보안 강화를 위해 메인 RisuAI 페이지와 분리된 iframe 환경에서 동작한다.

구조를 단순화하면 다음과 같다.

```text
RisuAI 메인 페이지
└─ Plugin iframe
   └─ 플러그인 GUI
      └─ 모달 / 팝업 / 진행 오버레이
```

이 구조에서 iframe 자체는 피할 수 없는 실행 경계다.

문제는 플러그인 내부 GUI에서 다음과 같은 효과를 추가할 때 발생한다.

```css
backdrop-filter: blur(...);
-webkit-backdrop-filter: blur(...);
filter: blur(...);
```

특히 `backdrop-filter`는 자기 요소만 그리는 효과가 아니라,
**요소 뒤에 이미 그려진 화면을 별도 합성 대상으로 읽어 다시 처리해야 하는 효과**다.

모바일에서는 데스크톱처럼 독립 VRAM이 넉넉한 경우가 드물고,
GPU와 CPU가 공용 RAM을 사용하는 구조가 일반적이다.

따라서 큰 영역의 backdrop blur는:

```text
큰 offscreen/compositor surface
+ 추가 픽셀 읽기/필터링
+ 메모리 bandwidth
+ 추가 합성 layer
+ WebView/Safari memory pressure
```

를 유발할 수 있다.

정확한 내부 buffer 수와 메모리 배수는 브라우저 엔진 및 디바이스에 따라 달라지지만,
실무적으로 중요한 결론은 다음과 같다.

> RisuAI API v3의 fullscreen/large iframe GUI에서는 장식용 backdrop blur의 시각적 이득보다 모바일 메모리·합성 비용 위험이 더 크다.

따라서 Librarian System에서는 이를 **디자인 금지 규칙**으로 관리한다.

---

# 2. 프로젝트 디자인 원칙

## 2.1 금지 원칙

Librarian 계열 플러그인 GUI에서 다음을 기본 금지한다.

```css
backdrop-filter: blur(...);
-webkit-backdrop-filter: blur(...);
filter: blur(...);
```

특히 다음 조합은 금지한다.

```text
position: fixed / absolute
+
inset: 0 또는 화면 대부분을 덮는 크기
+
backdrop-filter
```

이는 Release Gate 실패 대상으로 취급한다.

## 2.2 예외 원칙

예외는 원칙적으로 두지 않는다.

정말 필요한 경우에도:
- 화면 전체가 아닌 매우 작은 장식 요소
- 실제 모바일 프로파일 측정 완료
- 명시적 allowlist
- iOS/WebView 포함 회귀 검증

을 거쳐야 한다.

현재 LIBRA / HAYAKU / Flashback에는 그런 예외가 필요하지 않다.

---

# 3. 현재 코드 조사 결과

## 3.1 HAYAKU

현재 가장 우선적으로 수정해야 한다.

실제 대형 오버레이에 blur가 남아 있다.

### A. Confirm Overlay

현재:

```css
.hv-confirm-overlay {
    position: absolute;
    inset: 0;
    background: rgba(12,20,36,.46);
    backdrop-filter: blur(2px);
}
```

문제:

- viewer 대부분을 덮는다.
- modal이 떠 있는 동안 large-area backdrop surface가 필요하다.
- 모바일에서는 시각적 이득에 비해 합성 비용이 크다.

### B. Job Overlay

현재:

```css
.hv-job-overlay {
    position: absolute;
    inset: 72px 0 0;
    background: rgba(12,20,36,.42);
    backdrop-filter: blur(2px);
}
```

이쪽은 더 우선순위가 높다.

이유:
- 진행 작업 동안 비교적 오래 유지될 수 있다.
- 화면의 대부분을 덮는다.
- 정적인 확인창보다 지속시간이 길 수 있다.

### HAYAKU 판정

```text
P1 — 반드시 제거
```

---

# 4. LIBRA

LIBRA는 이미 상당 부분 방어되어 있다.

fullscreen GUI root에는:

```css
backdrop-filter: none !important;
-webkit-backdrop-filter: none !important;
```

가 적용되어 있고,
sticky top/tabs에도 동일한 override가 존재한다.

JS에서도 root에:

```js
root.style.setProperty('backdrop-filter', 'none', 'important');
root.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
```

를 적용한다.

따라서 fullscreen 전체 blur는 현재 막혀 있다.

## 남은 항목

`.sga-status`에 다음과 같은 잔존 효과가 있다.

```css
.sga-status {
    background: rgba(10,16,27,.72);
    backdrop-filter: blur(10px);
}
```

이 요소는 fullscreen은 아니므로 HAYAKU보다 위험도가 낮다.

하지만:
- 시각적 필요성이 낮고
- 모바일에서는 불필요한 compositing layer가 될 수 있으며
- 프로젝트 규칙을 단순하게 유지하려면 예외를 만들 이유가 없다.

### LIBRA 판정

```text
P2 — 제거 권장
```

---

# 5. Flashback Memory

현재 조사 범위에서는 다음 효과가 없다.

```text
backdrop-filter
-webkit-backdrop-filter
backdropFilter
filter: blur(...)
```

Flashback은 overlay를 사용할 때 주로:

```css
position: fixed;
inset: 0;
background: rgba(...);
```

방식을 사용한다.

이는 단순 반투명 레이어로,
뒤쪽 픽셀을 blur 처리하는 `backdrop-filter`보다 훨씬 안전하다.

### Flashback 판정

```text
변경 불필요
```

다만 향후 AI 코딩 중 blur가 다시 추가되지 않도록 공통 Gate 대상에는 포함한다.

---


# 6. 시각적 기준 레퍼런스 — Flashback Memory

이 작업에서 “세련됨”의 기준 레퍼런스는 **현재 Flashback Memory GUI**로 삼는다.

중요한 점은 Flashback의 색상을 그대로 복제하는 것이 아니다.

참고해야 하는 것은 다음 디자인 철학이다.

```text
Blur로 고급스러움을 만드는 UI가 아니라,
Surface / Border / Typography / Spacing / Concept Motif로 고급스러움을 만드는 UI
```

Flashback은 현재 조사 범위에서:

```text
backdrop-filter: blur(...)
filter: blur(...)
```

를 사용하지 않으면서도 충분히 완성도 높은 화면을 만든다.

따라서 LIBRA와 HAYAKU의 고비용 효과 제거 후 시각 품질을 판단할 때
Flashback을 **실제 구현 기준(reference implementation)** 으로 사용한다.

---

## 6.1 Flashback이 세련돼 보이는 핵심 이유

### A. 한 번에 이해되는 명확한 컨셉

Flashback은 단순히 “예쁜 관리자 화면”이 아니라:

```text
기억
→ 사진
→ 필름
→ 아카이브
→ 오래된 기록물
```

이라는 시각 언어를 유지한다.

예를 들어 실제 UI에는:

```css
.fb-film-strip {
    background:#2c2d2b;
    border-top:5px dashed #a99f8b;
    border-bottom:5px dashed #a99f8b;
}
```

와 같은 필름 스트립 표현이 들어간다.

즉 장식 효과를 무작정 많이 넣는 대신,
**플러그인의 기능 자체와 연결된 한두 개의 강한 시각적 비유**를 사용한다.

이 원칙을 다른 플러그인에도 적용한다.

### LIBRA

```text
책 / 문서 / 서고 / 기록 카드 / 페이지
```

### HAYAKU

```text
연속성 추적 / 작업 보드 / 전달 경로 / 상태 기록
```

시각 요소는 각 컨셉에서 파생해야 한다.

`glassmorphism`은 컨셉이 아니다.

---

## 6.2 고불투명 Surface를 기본으로 사용

Flashback의 핵심 surface는 불투명하거나 거의 불투명하다.

실제 warm paper theme:

```css
.vrmDesign {
    --bg:#e9e5dd;
    --surface:#faf8f2;
    --surface2:#f0ece3;
    --surface3:#e6e0d4;
    --border:#d6d0c4;
    --border2:#bbb2a3;
    --text:#302b28;
    --text2:#62594f;
    --accent:#915044;
}
```

그리고 주요 영역은:

```css
.main {
    background:var(--surface);
    border:1px solid var(--border);
    border-radius:10px;
}

.card {
    background:var(--surface);
    border:1px solid var(--border);
    border-radius:8px;
}
```

처럼 구성된다.

여기에는 blur가 필요 없다.

### 참고할 것

```text
배경색의 단계 차이
+
1px border
+
충분한 padding
+
typography hierarchy
```

만으로도 표면의 깊이가 만들어진다.

---

## 6.3 Shadow는 “모든 카드”가 아니라 필요한 곳만

Flashback은 모든 카드에 큰 그림자를 주지 않는다.

실제 theme에서:

```css
.card {
    box-shadow:none;
}
```

이다.

대신 정말 떠 있어야 하는 요소에만 shadow를 준다.

예:

```css
.top-more-menu {
    box-shadow:0 18px 44px rgba(0,0,0,.4);
}
```

또는 modal:

```css
.vrmDialogBox {
    background:#121722;
    border:1px solid #334155;
    box-shadow:0 24px 70px rgba(0,0,0,.45);
}
```

즉:

```text
일반 surface = border 중심
떠 있는 메뉴/modal = 제한된 shadow
```

라는 명확한 규칙이 있다.

이 방식이 blur보다 저렴하면서도 더 정돈돼 보인다.

---

## 6.4 Overlay는 Blur가 아니라 명암으로 분리

Flashback의 modal backdrop은:

```css
.vrmDialogBackdrop {
    position:fixed;
    inset:0;
    background:rgba(0,0,0,.62);
}
```

이다.

중요:

```text
backdrop-filter 없음
```

그리고 dialog 자체를:

```css
background:#121722;
border:1px solid #334155;
border-radius:16px;
box-shadow:0 24px 70px rgba(0,0,0,.45);
```

로 분리한다.

이것이 이번 HAYAKU 수정에서 직접 참고해야 할 패턴이다.

즉:

```text
뒤 화면을 흐리게 해서 modal을 띄움
```

이 아니라

```text
뒤 화면의 명도를 낮춤
+
modal 자체의 surface 대비를 높임
```

으로 시선을 분리한다.

---

## 6.5 Active State는 효과보다 대비를 사용

Flashback sidebar active item:

```css
.nav-item.active {
    background:#332e2a;
    color:#fff9ee;
    border-color:#332e2a;
    box-shadow:none;
}
```

이것도 중요한 레퍼런스다.

선택 상태를 알리기 위해:

```text
Glow
Blur
Animated halo
```

를 쓰지 않는다.

대신:

```text
명확한 background contrast
+
text contrast
```

를 사용한다.

LIBRA/HAYAKU에서도 선택/활성 상태는 이 원칙을 우선한다.

---

## 6.6 아주 작은 shadow와 색 변화는 허용

Flashback recall card는:

```css
.recall-card-item {
    background:#fffdf7;
    border:1px solid var(--border);
    box-shadow:0 3px 8px #34291709;
}
```

처럼 아주 작은 그림자를 사용한다.

즉 이 프로젝트의 목표는:

```text
shadow 전면 금지
```

가 아니다.

목표는:

```text
큰 반투명 표면 + 큰 blur + 큰 합성효과
```

를 제거하는 것이다.

작고 정적인 local shadow는
시각적 깊이를 유지하는 데 사용할 수 있다.

---

## 6.7 Gradient도 “기능적 강조”에만 사용

Flashback은 다음처럼 아주 약한 gradient를 사용한다.

```css
.sidebar-health {
    background:
        linear-gradient(
            145deg,
            rgba(80,211,148,.08),
            rgba(80,211,148,.025)
        );
}
```

이것은:
- 작은 상태 카드
- 매우 낮은 alpha
- 정적 gradient

이다.

따라서 합리적이다.

반대로 피해야 하는 것은:

```text
fullscreen animated gradient
large moving glow
blurred gradient blob
```

이다.

---

## 6.8 Typography가 디자인의 상당 부분을 담당

Flashback은 시각 계층을 효과가 아니라 글자 크기/굵기/서체 조합으로 만든다.

예:

```css
.page-title {
    font-size:28px;
    letter-spacing:-1px;
}

.page-eyebrow {
    font:10px Consolas,monospace;
    letter-spacing:1.7px;
}

.overview-stat-card strong {
    font:27px Consolas,monospace;
}
```

즉:

```text
Title
Eyebrow / Metadata
Body
Mono diagnostic/value
```

가 명확히 구분된다.

LIBRA/HAYAKU에서도 효과를 줄이는 대신
typography hierarchy를 더 명확히 만든다.

---

## 6.9 여백과 정렬이 고급스러움의 핵심

Flashback의 세련됨은 효과보다:

```text
padding
section gap
grid alignment
consistent radius
baseline alignment
```

에서 온다.

대표적으로:

```css
.main {
    margin:16px 18px 16px 0;
    padding:28px 30px;
}

.card {
    padding:22px;
}

.page-head {
    padding:0 0 22px;
}
```

와 같이 공간 체계가 일관된다.

따라서 blur 제거 뒤 UI가 허전해 보이면
먼저 다음을 조정한다.

```text
spacing
surface hierarchy
typography
border contrast
```

그 다음 shadow를 고민한다.

Blur를 다시 넣지 않는다.

---

## 6.10 모바일에서는 더 과감하게 평면화

Flashback은 모바일에서 outer frame의 비용을 줄인다.

실제:

```css
@media (max-width:760px) {
    .vrmDesign {
        width:100%;
        height:100%;
        border-radius:0;
        border:0;
        box-shadow:none;
    }
}
```

즉 데스크톱에서 쓰던 외곽 shadow까지 모바일에서는 제거한다.

이 부분은 LIBRA/HAYAKU에도 그대로 참고할 가치가 있다.

### 모바일 원칙

```text
PC:
작은 outer shadow 허용

Mobile:
outer shadow 제거
surface/border 대비로만 깊이 표현
```

---

## 6.11 Reduced Motion도 레퍼런스로 유지

Flashback은:

```css
@media(prefers-reduced-motion:reduce) {
    .vrmDesign * {
        animation:none!important;
        transition:none!important;
        scroll-behavior:auto!important;
    }
}
```

를 사용한다.

이는 성능뿐 아니라 접근성 측면에서도 좋은 구현이다.

LIBRA/HAYAKU의 신규 overlay/modal 디자인에도 동일 정책을 적용한다.

---

# 7. Flashback 스타일을 참고할 때 복제하면 안 되는 것

Flashback의 색과 형태를 그대로 다른 플러그인에 복사하지 않는다.

예를 들어:

```text
Flashback = warm paper / film archive
LIBRA     = book / reference library
HAYAKU    = continuity / operational tracking
```

이므로 같은 갈색/베이지 palette를 쓰면
플러그인별 정체성이 사라진다.

복제해야 하는 것은 색이 아니라:

```text
1. 명확한 컨셉
2. 제한된 palette
3. solid surface hierarchy
4. border 중심의 깊이
5. 필요한 곳만 shadow
6. 강한 active-state 대비
7. 명확한 typography
8. 충분한 spacing
9. 모바일에서 효과 축소
10. blur 없이도 완성되는 구조
```

이다.

---

# 8. 구현자용 Flashback Reference Checklist

LIBRA/HAYAKU 수정 결과를 아래 기준으로 Flashback과 비교한다.

## Surface

- [ ] 배경 / secondary surface / card surface가 명확히 구분되는가?
- [ ] backdrop blur 없이도 레이어가 구분되는가?
- [ ] 1px border가 계층을 충분히 보여주는가?

## Modal

- [ ] overlay는 단순 alpha dimming인가?
- [ ] dialog 자체는 solid/high-opacity surface인가?
- [ ] shadow는 dialog 크기에만 제한되는가?

## Navigation

- [ ] active 상태가 색 대비만으로 명확한가?
- [ ] glow/blur 없이 선택 상태를 즉시 알 수 있는가?

## Typography

- [ ] page title / metadata / body / diagnostic value가 구분되는가?
- [ ] 효과를 줄인 대신 typography hierarchy가 강화됐는가?

## Spacing

- [ ] card padding이 일정한가?
- [ ] section gap이 충분한가?
- [ ] 요소가 blur 없이도 답답하지 않은가?

## Mobile

- [ ] outer frame shadow가 제거/축소되는가?
- [ ] full-screen overlay에 blur가 없는가?
- [ ] reduced-motion 대응이 있는가?

---

# 9. 플러그인별 적용 방향 — Flashback을 기준으로

## 9.1 LIBRA

Flashback의 레퍼런스에서 가져올 것:

```text
solid paper-like surface
thin border
strong typography
minimal local shadow
concept motif
```

LIBRA의 컨셉은 책이므로:

```text
페이지
책갈피
주석
서고 카드
문헌 색인
```

같은 시각 언어를 사용한다.

권장:

```css
.sga-status {
    background:rgba(248,246,240,.98); /* 실제 theme에 맞게 변수화 */
    border:1px solid var(--book-border);
    box-shadow:0 4px 14px rgba(35,28,22,.12);

    backdrop-filter:none;
    -webkit-backdrop-filter:none;
}
```

다크모드에서는 같은 구조만 유지하고 색만 변환한다.

### 목표

```text
Glass panel
→ Book / archival panel
```

---

## 9.2 HAYAKU

Flashback modal 패턴을 가장 직접적으로 참고한다.

현재 blur overlay:

```text
삭제
```

대신:

```text
solid dim overlay
+
high-opacity job/confirm card
+
thin border
+
small local shadow
```

를 사용한다.

예:

```css
.hv-confirm-overlay,
.hv-job-overlay {
    background:rgba(8,14,26,.68);
    backdrop-filter:none;
    -webkit-backdrop-filter:none;
}
```

dialog/job card:

```css
.hv-confirm-dialog,
.hv-job-card {
    background:#111a2a;
    border:1px solid #34425b;
    border-radius:12px;
    box-shadow:0 10px 28px rgba(0,0,0,.28);
}
```

HAYAKU는 Flashback처럼 종이 느낌을 복사하지 않고:

```text
control room
continuity board
operational log
```

느낌을 유지한다.

### 목표

```text
Glass dashboard
→ Precision operational interface
```

---

## 9.3 Flashback

Flashback은 이번 작업의 reference implementation이므로
시각적으로 큰 변경을 하지 않는다.

현재 유지할 핵심:

```text
warm paper hierarchy
film-strip motif
solid modal
blur-free overlay
restrained local shadow
mobile flattening
reduced-motion
```

Release Gate로 이 상태를 보호한다.

---

# 10. 블러를 제거하면서도 세련됨을 유지하는 디자인 규칙

단순히:

```css
backdrop-filter: none;
```

만 하고 끝내면 UI가 밋밋해질 수 있다.

따라서 blur가 하던 역할을 다음 네 가지 저비용 요소로 분산한다.

```text
1. 고불투명 Surface
2. 얇은 경계선
3. 제한적인 작은 그림자
4. 약한 단방향/방사형 gradient
```

핵심은:

> “뒤 화면을 가공해서 깊이를 만드는 방식” 대신
> “자기 표면 자체를 잘 디자인해서 깊이를 만드는 방식”

으로 전환하는 것이다.

---

# 11. 권장 Overlay 디자인

## 7.1 Fullscreen / large overlay

기존:

```css
background: rgba(12,20,36,.42);
backdrop-filter: blur(2px);
```

권장:

```css
background: rgba(8, 13, 24, .68);
backdrop-filter: none;
-webkit-backdrop-filter: none;
```

또는 약간 더 세련되게:

```css
background:
    linear-gradient(
        180deg,
        rgba(8, 13, 24, .62),
        rgba(8, 13, 24, .74)
    );
backdrop-filter: none;
-webkit-backdrop-filter: none;
```

이 gradient는 overlay 자신의 background만 그리므로 backdrop blur보다 훨씬 저렴하다.

### 권장 범위

```text
alpha 0.60 ~ 0.76
```

너무 투명하면 뒤쪽 UI가 산만해지고,
너무 불투명하면 plugin context가 끊어진 느낌이 난다.

---

# 12. Modal Card 디자인

Blur가 사라진 뒤 핵심은 modal card 자체다.

권장:

```css
.modal-card {
    background: rgba(18, 26, 42, .97);
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 14px;

    box-shadow:
        0 8px 24px rgba(0,0,0,.28),
        inset 0 1px 0 rgba(255,255,255,.035);
}
```

## 중요한 원칙

`box-shadow`도 공짜는 아니다.

따라서 다음은 피한다.

```css
box-shadow: 0 30px 100px rgba(...);
```

화면 전체 크기의 거대한 shadow도 피한다.

권장:

```text
blur radius 16~28px
작은 modal/card에만 사용
```

fullscreen overlay에는 shadow를 쓰지 않는다.

---

# 13. Panel / Status 디자인

LIBRA `.sga-status`는 blur 없이 다음처럼 처리하는 것을 권장한다.

기존:

```css
.sga-status {
    background: rgba(10,16,27,.72);
    backdrop-filter: blur(10px);
}
```

권장:

```css
.sga-status {
    background:
        linear-gradient(
            180deg,
            rgba(16, 23, 38, .96),
            rgba(11, 17, 29, .96)
        );

    border: 1px solid rgba(255,255,255,.08);

    box-shadow:
        0 6px 18px rgba(0,0,0,.20),
        inset 0 1px 0 rgba(255,255,255,.03);

    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}
```

이 방식이면 glassmorphism은 사라지지만,
오히려 책/도구 패널 같은 **밀도 있고 정돈된 UI**가 된다.

LIBRA의 BOOK_UX 컨셉에도 더 잘 맞는다.

---

# 14. HAYAKU 권장 수정

## 10.1 Confirm Overlay

기존:

```css
.hv-confirm-overlay {
    background: rgba(12,20,36,.46);
    backdrop-filter: blur(2px);
}
```

권장:

```css
.hv-confirm-overlay {
    background:
        linear-gradient(
            180deg,
            rgba(8, 14, 26, .64),
            rgba(8, 14, 26, .72)
        );

    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}
```

Confirm dialog 본체는:

```css
.hv-confirm-dialog {
    background: rgba(17, 25, 41, .98);
    border: 1px solid rgba(255,255,255,.10);

    box-shadow:
        0 10px 26px rgba(0,0,0,.30),
        inset 0 1px 0 rgba(255,255,255,.035);
}
```

으로 보완한다.

## 10.2 Job Overlay

기존:

```css
.hv-job-overlay {
    background: rgba(12,20,36,.42);
    backdrop-filter: blur(2px);
}
```

권장:

```css
.hv-job-overlay {
    background:
        linear-gradient(
            180deg,
            rgba(9, 15, 27, .58),
            rgba(9, 15, 27, .70)
        );

    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}
```

여기서는 card보다 **작업 상태 패널 자체를 명확하게 보여주는 것**이 중요하다.

예:

```css
.hv-job-card {
    background: rgba(20, 29, 46, .98);
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 14px;

    box-shadow:
        0 8px 22px rgba(0,0,0,.24),
        inset 0 1px 0 rgba(255,255,255,.03);
}
```

---

# 15. 세련됨을 유지하는 저비용 시각 요소

## 적극 사용 가능

### A. Hairline border

```css
border: 1px solid rgba(255,255,255,.06);
```

다크 UI에서 depth를 만드는 가장 싼 수단 중 하나다.

### B. Inset highlight

```css
box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
```

금속/유리처럼 과하지 않으면서 표면감을 준다.

### C. 아주 약한 gradient

```css
background:
  linear-gradient(
    180deg,
    rgba(25,34,52,.98),
    rgba(15,22,36,.98)
  );
```

### D. Accent edge

상단 1~2px만 브랜드 색/밝은 선을 사용:

```css
border-top-color: rgba(255,255,255,.14);
```

### E. 작은 card shadow

```css
box-shadow: 0 8px 24px rgba(0,0,0,.24);
```

단 fullscreen 요소에는 사용하지 않는다.

---

# 16. 사용을 자제해야 하는 효과

Backdrop blur만 제거하고 다른 비싼 효과를 넣으면 의미가 없다.

다음도 큰 면적에서는 자제한다.

```text
filter: blur(...)
filter: drop-shadow(...) on large surfaces
mix-blend-mode
background-attachment: fixed
큰 영역의 animated gradient
다수의 반투명 중첩 layer
큰 box-shadow radius
여러 개의 무한 CSS animation
```

특히:

```text
fullscreen iframe
→ translucent root
→ large overlay
→ modal glass surface
→ nested transparent panel
```

식의 반투명 중첩은 피한다.

---

# 17. 애니메이션 가이드

Blur를 빼면서 UI가 덜 세련돼 보이는 경우,
애니메이션을 강하게 넣어 보완하지 않는다.

권장:

```text
opacity
transform: translateY / scale
```

짧게 사용.

예:

```css
.modal-card {
    animation: modal-in 140ms ease-out;
}

@keyframes modal-in {
    from {
        opacity: 0;
        transform: translateY(4px) scale(.99);
    }
    to {
        opacity: 1;
        transform: translateY(0) scale(1);
    }
}
```

피할 것:

```text
continuous blur animation
continuous shadow breathing
large background movement
```

---

# 18. 모바일 최적화 규칙

모바일 media query에서는 추가로 다음을 권장한다.

```css
@media (max-width: 720px) {
    .modal-card,
    .status-card,
    .job-card {
        box-shadow: 0 6px 16px rgba(0,0,0,.20);
    }
}
```

즉 PC보다:
- shadow radius 작게
- opacity 조금 높게
- 투명 중첩 줄이기
- animation 짧게

간다.

목표는 모바일에서:

```text
합성 layer 수 감소
GPU/공유 RAM pressure 감소
WebView 안정성 증가
```

다.

---

# 19. 구현 규칙 — 공통 CSS Safety Contract

Librarian System에 다음 규칙을 코드 정책으로 추가한다.

```text
Librarian Mobile GPU Contract v1
```

## MUST

- fullscreen/large overlay는 solid/alpha/gradient background만 사용
- popup depth는 border + small shadow + inset highlight로 표현
- 모바일에서는 large drop-shadow 제거 또는 축소
- `backdrop-filter`는 명시적으로 `none`

## MUST NOT

```text
backdrop-filter: blur(...)
-webkit-backdrop-filter: blur(...)
filter: blur(...)
```

## LARGE SURFACE MUST NOT

- large `drop-shadow`
- mix-blend-mode
- animated filter
- animated backdrop
- fixed background effects

---

# 20. Release Gate 추가

신규 테스트 권장:

```text
mobile_gpu_effect_contract_test.cjs
```

대상:

```text
LIBRA
HAYAKU
Flashback Memory
LIA
RE:TRACE GUI가 있다면 함께
```

## 기본 검사

다음 패턴을 발견하면 실패:

```regex
backdrop-filter\s*:\s*(?!none)
-webkit-backdrop-filter\s*:\s*(?!none)
filter\s*:\s*blur\s*\(
```

JS style API도 검사한다.

예:

```regex
backdropFilter\s*=
setProperty\(\s*['"]backdrop-filter['"]\s*,\s*(?!['"]none)
```

## 허용

다음은 허용:

```css
backdrop-filter: none;
-webkit-backdrop-filter: none;
```

## 추가 경고

다음은 warning 또는 수동 review 대상으로 둔다.

```text
filter: drop-shadow
mix-blend-mode
background-attachment: fixed
box-shadow blur radius > 40px
무한 animation
```

단 이들은 즉시 fail보다 면적/용도를 보고 판단한다.

---

# 21. TDD 권장

수정 전에 테스트를 먼저 작성한다.

## RED

현재 HAYAKU:

```text
.hv-confirm-overlay
.hv-job-overlay
```

와 LIBRA:

```text
.sga-status
```

때문에 테스트가 실패해야 한다.

## GREEN

세 blur를 제거한 뒤:

```text
LIBRA PASS
HAYAKU PASS
Flashback PASS
```

가 되어야 한다.

이렇게 해야 이후 AI 코딩이 다시 blur를 넣어도 즉시 잡힌다.

---

# 22. 실제 수정 우선순위

## P1 — HAYAKU

제거:

```text
.hv-confirm-overlay backdrop-filter
.hv-job-overlay backdrop-filter
```

보완:
- overlay alpha 증가
- modal card border/shadow 강화
- subtle gradient 적용

## P2 — LIBRA

제거:

```text
.sga-status backdrop-filter: blur(10px)
```

보완:
- 더 불투명한 surface
- hairline border
- inset highlight
- 작은 shadow

## P3 — Flashback

현재 수정 없음.

단 Release Gate를 통해 blur-free 상태를 고정한다.

---

# 23. 시각 품질 Acceptance Criteria

단순히 “blur가 없어졌다”가 완료 조건이 아니다.

다음이 동시에 만족돼야 한다.

## 시각적 계층

- overlay와 modal의 경계가 명확함
- modal이 배경과 붙어 보이지 않음
- 텍스트 대비가 충분함
- button/primary action이 바로 보임
- dark surface가 한 덩어리로 뭉개지지 않음

## 디자인 일관성

### LIBRA

- BOOK_UX의 절제된 종이/도구/패널 인상 유지
- glassmorphism보다 “책 위에 놓인 카드/도구” 느낌 강화

### HAYAKU

- 작업/진행/연속성 도구라는 기술적 인상 유지
- overlay는 어둡고 안정적
- job card가 화면 중심의 작업 상태로 보임

### Flashback

- 기존 Film/Archive 컨셉 유지
- blur 추가 없이 현재 방식 유지

---

# 24. 성능 Acceptance Criteria

최소 조건:

```text
LIBRA active backdrop blur = 0
HAYAKU active backdrop blur = 0
Flashback active backdrop blur = 0
```

추가:

- fullscreen overlay에 `filter` 없음
- 모바일에서 large drop-shadow 없음
- modal open/close 시 GUI freeze 없음
- scroll 중 repaint 이상 없음
- iOS WebView/Safari에서 plugin 강제 reload 증가 없음
- Android WebView에서 동일 기능 정상

---

# 25. 실제 기기 확인 권장

가능하면 다음 순서로 확인한다.

```text
1. Desktop Chrome
2. Android Chrome / WebView
3. iPhone Safari / PocketRisu WebView
```

특히 iPhone에서는:

- 모달 반복 열기/닫기
- 긴 설정 페이지 scroll
- job overlay 장시간 유지
- 다른 플러그인 iframe과 함께 사용

을 확인한다.

---

# 26. 추가 운영 메모 — “플러그인이 무응답” 제보

GUI 최적화와 별개로,
사용자가:

```text
플러그인 GUI가 안 뜸
버튼이 무응답
iframe 통신이 안 되는 것 같음
```

이라고 제보하면,
플러그인 자체 버그만 가정하지 않는다.

일부:
- Ad blocker
- privacy extension
- aggressive content blocker
- script/frame blocker

가 iframe/plugin API 통신을 의심스러운 frame/script로 차단할 수 있다.

따라서 지원 문서에 다음 진단 항목을 넣는다.

```text
RisuAI 사이트를 광고 차단/콘텐츠 차단 예외로 등록한 뒤 재시도
```

주의:
이 문제는 플러그인 코드가 backdrop blur를 제거하는 것으로 해결되는 문제가 아니다.

---

# 27. 완료 정의

이 작업은 다음이 모두 만족되면 완료다.

- [ ] HAYAKU `.hv-confirm-overlay` blur 제거
- [ ] HAYAKU `.hv-job-overlay` blur 제거
- [ ] LIBRA `.sga-status` blur 제거
- [ ] Flashback blur-free 상태 확인
- [ ] 기존 LIBRA root/header `none!important` 유지
- [ ] 대체 디자인 적용
- [ ] 모바일용 shadow 축소
- [ ] `mobile_gpu_effect_contract_test.cjs` 추가
- [ ] 수정 전 RED 확인
- [ ] 수정 후 GREEN 확인
- [ ] Release mandatory smoke 포함
- [ ] iOS/Android에서 modal/job overlay 수동 확인

---

# 28. 구현자에게 전달할 최종 원칙

> **Backdrop blur를 제거하는 목적은 디자인을 단순화하는 것이 아니라, 모바일에서 고비용의 “뒤 화면 재합성”을 없애는 것이다.**

따라서 결과 UI는:

```text
Glass UI
→ 삭제

Flat UI
→ 아님

Dense / refined surface UI
→ 목표
```

이어야 한다.

시각적인 깊이는:

```text
blur
```

가 아니라

```text
surface opacity
+ hairline border
+ subtle gradient
+ small local shadow
+ spacing
+ typography hierarchy
```

로 만든다.

이 원칙을 LIBRA / HAYAKU / Flashback 전체 GUI 공통 규칙으로 유지한다.

---

# 29. 코드 대조 검토 결과 — 2026-09-20 추가

**검토 결론: 이 가이드의 디자인 방향은 채택하되, 실제 수정 범위·선택자·테마·검사 방법을 아래와 같이 보완한다.**

이 절은 가이드와 실제 소스를 대조한 검토 결과이며, GUI 구현 완료 보고가 아니다. 검토 기준은 HEAD `690ed0c`와 당시 작업 트리다. HAYAKU, LIBRA, `program-manifest.json`에 기존 미커밋 변경이 있으므로 구현 착수 시 이를 보존하고 최신 상태를 다시 확인한다. 아래 경로는 `Librarian-System/PROGRAM/` 기준이며, 줄번호보다 선택자와 함수 이름을 우선해 위치를 찾는다.

이번 검토에서는 소스·기존 테스트 구조·CSS 적용 순서를 읽고, 제안된 정규식의 오탐을 메모리 내에서 재현했다. 브라우저의 실제 계산 스타일, 시각 품질, 모바일 GPU 사용량은 아직 측정하지 않았다.

## 29.1 실제 수정 범위: 3개 플러그인에서 5개 검사 대상으로 확대

| 플러그인 | 소스의 backdrop blur 선언 | 확인한 선택자 | 적용 방향 |
|---|---:|---|---|
| HAYAKU | 2 | `.hv-confirm-overlay`, `.hv-job-overlay` | 우선 수정. 단순 dim 배경과 기존 테마의 불투명 카드로 교체 |
| LIBRA | 2 | `.sga-status`, `.sga-top` | 상태창 수정 및 뒤에서 비활성화되는 옛 헤더 선언 정리 |
| LIA | 7 | `.lia-header`, `#dpg-status`, `.lia-drawer-head`, `.lia-drawer-backdrop`, `.lia-persona-panel-backdrop`, `.lia-sidebar`, `.lia-shell .lia-persona-panel-backdrop` | 헤더·서랍·모바일 내비게이션을 함께 수정 |
| RE:TRACE | 2 | `.retrace-dialog-layer`, `.top` | 대화상자 배경과 상단바 수정 |
| Flashback | 0 | blur 선언 없음 | 시각적 기준 유지. 모바일 외곽 그림자의 최종 적용값 확인 |

위 **13건은 소스 선언 수이며, 현재 화면에서 활성화된 효과 수가 아니다.** LIBRA의 `.sga-top`은 뒤쪽 `none!important`에 의해 이미 비활성화된다. 다만 금지 선언 자체를 검사하는 Release Gate를 도입할 때에는 남은 옛 선언도 정리해야 한다.

확인 위치:

- `plugins/HAYAKU_Locator_Continuity.js:54031` — confirm/job overlay와 dialog CSS
- `plugins/LIBRA.js:62551` — 상태창, `62579` — 옛 상단바 blur
- `plugins/LIA_Persona_Linker.js:25448` 이후 — 헤더·상태줄·서랍·모바일 CSS
- `plugins/RETRACE.js:15388` — dialog layer, `15398` — 상단바
- `plugins/Flashback_Memory.js:41634`, `41857` — 모바일 그림자 제거와 뒤쪽 테마 재지정

따라서 §20의 공통 검사 대상을 5개로 삼으면서 HAYAKU/LIBRA만 고치면 검사는 완료될 수 없다. LIA와 RE:TRACE를 실제 구현 범위에도 포함한다.

## 29.2 HAYAKU 선택자와 테마 보정

§9.2와 §14의 `.hv-job-card`는 현재 제품의 작업창 선택자가 아니다. 실제 HTML과 CSS는 **`.hv-job-dialog`**를 사용한다. 보완 스타일과 브라우저 검사는 이 선택자에 적용한다.

현재 HAYAKU의 최종 테마에는 다음 밝은 작업 보드 색상이 지정돼 있다.

```css
--hv-bg: #edf2f3;
--hv-card: #f9fbfc;
--hv-line: #cad7dc;
--hv-text: #17313d;
--hv-primary: #166e61;
```

문서의 짙은 남색 dialog 예시는 구조를 설명하는 예로 취급하고 그대로 복사하지 않는다. 카드 배경·본문·경계선은 기존 `--hv-*` 변수를 사용하고, 녹색 강조와 작업 보드의 인상을 유지한다. 호스트 테마 연동과 고정 테마의 실제 CSS 우선순위도 함께 확인한다.

fullscreen root의 반투명 배경과 내부 confirm/job overlay는 별개다. 기존 `hayaku_viewer_transparent_backdrop_contract_test.cjs`가 보호하는 root 배경, 외부 클릭 차단, job overlay의 창 내부 배치는 유지하면서 내부 overlay의 blur를 제거한다.

## 29.3 Flashback 모바일 평면화는 최종 계산값 확인 필요

§6.10에 인용된 모바일 `.vrmDesign { box-shadow:none }`은 실제로 존재한다. 하지만 뒤쪽 warm-paper 테마가 같은 `.vrmDesign`에 `box-shadow:0 20px 70px #30251333`을 다시 지정한다.

따라서 앞의 모바일 규칙이 존재한다는 사실만으로 최종 그림자가 없다고 판단할 수 없다. 모바일 화면에서 `getComputedStyle()`로 확인하고, 큰 그림자가 살아 있다면 최종 테마 뒤의 모바일 규칙에서 외곽 그림자만 제거한다. Flashback의 색상·필름 모티프·카드 배치는 그대로 유지한다.

이는 §5와 §9.3의 “시각적으로 큰 변경 불필요”와 양립하지만, “모바일에서도 어떤 수정도 필요 없다”는 확정은 보류한다.

## 29.4 Release Gate 정규식 보정

§20의 다음 정규식은 그대로 사용하면 안 된다.

```regex
backdrop-filter\s*:\s*(?!none)
```

직접 실행한 결과:

| 입력 | 문서의 정규식 판정 | 의도한 판정 |
|---|---|---|
| `backdrop-filter:none;` | 허용 | 허용 |
| `backdrop-filter: none;` | 실패 | 허용 |
| `backdrop-filter: none !important;` | 실패 | 허용 |
| `backdrop-filter:blur(2px);` | 실패 | 실패 |

원인은 `\s*`가 역추적하면서 공백을 남기면 `(?!none)`이 참이 되기 때문이다. 또한 `backdropFilter\s*=`만 검사하면 `style.backdropFilter = 'none'` 같은 안전한 대입도 실패한다.

새 검사는 CSS 속성·값을 분리하고 공백, 대소문자, `!important`를 정규화한 뒤 판정한다. JS 스타일 대입과 `setProperty`도 값까지 확인한다. 주석이나 예시 문자열과 실제 스타일 선언을 구분하며, 문자열 검사만으로 최종 화면을 보증하지 않는다.

검사 정책:

- 일반·WebKit backdrop-filter의 명시적 `none`은 허용한다.
- 활성 backdrop-filter와 CSS `filter`에 포함된 `blur()`는 실패시킨다.
- JS를 통한 금지 효과 설정도 검출한다.
- 큰 그림자, 무한 애니메이션 등은 면적과 용도를 확인하는 검토 항목으로 보고한다.
- 허용 문법 대조군과 금지 문법 반례를 함께 검사해 Gate 자체의 오탐·미탐을 확인한다.

---

# 30. 검토를 반영한 GUI 수정 실행 계획

이 절은 앞으로 수행할 계획이다. 아래 항목은 아직 구현·검증 완료를 뜻하지 않는다.

## 단계 1 — 현재 화면과 CSS 기준선 확보

- 착수 시점의 작업 트리와 기존 미커밋 변경을 확인한다.
- 일반 화면, 확인창, 작업 진행창, 오류 상태, 서랍을 각각 기록한다.
- 기본 CSS, 뒤쪽 테마, media query, JS 스타일 설정의 적용 순서를 추적한다.
- 실제 열린 요소의 선택자, 배경·텍스트·테두리·그림자·filter 계산값을 기록한다.
- 기준 화면은 1440px 데스크톱과 390px 모바일로 시작하고, 기존 반응형 경계 전후 및 낮은 화면 높이도 포함한다.

**산출물:** 수정 전 화면과 계산 스타일 기록, 플러그인별 변경 선택자 목록.

## 단계 2 — 공통 회귀 검사 작성 및 RED 확인

신규 파일: `tests/mobile_gpu_effect_contract_test.cjs`.

- 5개 플러그인의 실제 GUI 스타일과 JS 스타일 설정을 검사한다.
- 현재 HAYAKU/LIBRA/LIA/RE:TRACE의 금지 선언을 검출하고 Flashback의 blur-free 상태를 확인한다.
- `none`, 공백이 있는 `none`, `none !important`, WebKit 속성, JS의 안전한 대입은 통과시킨다.
- 금지 효과를 넣은 별도 입력은 반드시 실패시키고, 위반 파일·위치·속성·값을 출력한다.
- 선언 개수 13을 고정하는 테스트가 아니라, 금지 효과가 0인지 확인하는 테스트로 만든다.

**완료 조건:** 실제 기존 결함에서 RED, 허용 대조군은 PASS. 브라우저 확인은 별도 단계로 남긴다.

## 단계 3 — HAYAKU 우선 수정

수정 파일: `plugins/HAYAKU_Locator_Continuity.js`.

- 오래 표시되는 `.hv-job-overlay`부터 blur를 제거하고 단순 dim 배경으로 교체한다.
- overlay alpha는 `.64~.70`을 시작점으로 삼고 기존 밝은 카드와의 대비를 화면에서 조정한다.
- `.hv-job-dialog`와 `.hv-confirm-dialog`는 `--hv-card`, `--hv-line`, `--hv-text`를 사용한다.
- 현재 70~75px 범위의 큰 dialog 그림자는 작은 지역 그림자로 줄인다. 데스크톱 blur 반경은 대략 16~28px, 모바일은 그보다 작게 시작한다.
- `.hv-confirm-overlay`에도 같은 원칙을 적용한다.
- 기존 inset, z-index, `[hidden]`, 클릭 차단, 최소화·닫기·취소 버튼의 동작을 확인한다.
- reduced-motion에서 진행 상태가 계속 이해 가능하고 장식 애니메이션은 억제되는지 확인한다.

**완료 조건:** 일반·확인·작업 상태에서 blur 없음, 카드와 배경 구분 유지, 작업창 조작 회귀 없음.

## 단계 4 — LIBRA, LIA, RE:TRACE 순차 적용

### LIBRA

수정 파일: `plugins/LIBRA.js`.

- `.sga-status`를 BOOK_UX의 종이색 상태 카드로 정리한다.
- 책 화면에서는 `--book-paper-2`, `--book-line`, `--book-ink`를 활용하고, 그 밖의 문맥에는 기존 `--sga-*` 표면 변수를 사용한다.
- 정상·성공·오류 상태, 빠른 저장 상태, 빈 상태의 숨김을 각각 확인한다.
- `.sga-top`의 옛 blur 선언도 제거하고 root/header의 일반·WebKit `none!important` 방어는 유지한다.

### LIA

수정 파일: `plugins/LIA_Persona_Linker.js`.

- 기존 연보라 표면과 페르소나 화면의 인상을 유지한다.
- 헤더·상태줄·서랍 헤더·모바일 내비게이션은 자체 표면색으로 구분한다.
- world/persona 서랍의 backdrop은 단순 alpha dim으로 교체한다.
- 기본 CSS와 뒤쪽 `.lia-shell` 규칙을 함께 수정해 같은 효과가 다시 덮어써지지 않게 한다.
- 서랍 개폐, 페르소나 선택, 하단 내비게이션, 편집 중 내용 보존을 검증한다.

### RE:TRACE

수정 파일: `plugins/RETRACE.js`.

- `.retrace-dialog-layer`는 단순 dim으로, `.top`은 기존 어두운 관리화면의 고불투명 표면으로 처리한다.
- dialog는 기존 `--lra-*` 색상을 사용하고 경계선과 작은 그림자로 분리한다.
- 확인/취소 버튼, 긴 대화상자 내용, 모바일 상단바와 스크롤을 확인한다.

**완료 조건:** 플러그인별 수정 직후 관련 GUI 회귀 통과. 고유 색상과 정보 배치는 유지한다.

## 단계 5 — 모바일·접근성·Flashback 기준 확인

- 기존 반응형 분기점을 유지하면서 모바일 외곽 frame의 그림자를 제거하거나 축소한다.
- 작은 modal/card의 그림자만 제한적으로 남긴다. 모든 카드에 일괄 그림자를 추가하지 않는다.
- Flashback은 최종 모바일 계산값에서 큰 외곽 그림자가 확인되는 경우에만 해당 규칙을 보정한다.
- 긴 설명, 작은 화면 높이, 가로 화면, 키보드 표시, reduced-motion 상태를 확인한다.
- 제목·본문·메타데이터의 계층, 선택 상태, 정상·오류 문구와 버튼 대비를 확인한다.
- host theme 설정과 플러그인 고유 테마의 조합에서 글자가 배경과 섞이지 않는지 확인한다.

**완료 조건:** 버튼 접근성과 스크롤 유지, 텍스트 잘림·가로 넘침 없음, 모바일 효과 축소가 최종 CSS에서 유효함.

## 단계 6 — Release Gate 연결 및 최종 검증

수정 파일: `tools/build_distribution.cjs`.

- `RELEASE_SMOKE_TESTS`에 `mobile_gpu_effect_contract_test.cjs`를 등록한다.
- `gui_shared_theme_runtime_test.cjs`, `hayaku_viewer_transparent_backdrop_contract_test.cjs`, 각 플러그인의 GUI 계약·동작 테스트를 실행한다.
- 기존 LIBRA 모바일 스크롤/닫기 브라우저 테스트와 HAYAKU workspace 브라우저 하네스를 활용한다.
- 브라우저에서는 실제 UI를 열고 각 대상 요소의 일반·WebKit backdrop-filter 및 filter 계산값을 확인한다. 숨겨진 overlay는 실제 표시 상태에서도 검사한다.
- 매니페스트 등 필요한 메타데이터를 기존 절차로 갱신하고, 빌드 산출물 수·금지 효과·크기 floor를 확인한다.
- 회귀와 배포 빌드는 공유 출력 경로 충돌을 피하도록 직렬 실행한다.

**완료 조건:** 공통 Gate와 관련 회귀 통과, 실제 화면 계산값 확인, 5개 빌드 산출물 검증.

---

# 31. 보완된 완료 기준과 검증 범위

§27의 완료 정의에 다음 항목을 추가한다.

- [ ] LIA의 기본·모바일·후속 테마에 남은 blur 제거
- [ ] RE:TRACE의 dialog layer와 상단바 blur 제거
- [ ] LIBRA의 뒤에서 비활성화되는 옛 헤더 blur 선언 정리
- [ ] HAYAKU 작업창에 실제 선택자 `.hv-job-dialog` 적용
- [ ] HAYAKU의 현행 밝은 작업 보드 테마와 색상 변수 유지
- [ ] `none` 관련 Gate 오탐 대조군 통과
- [ ] Flashback 모바일 외곽 그림자의 최종 계산값 확인
- [ ] 실제 열린 overlay·drawer·상태창의 계산 스타일 확인
- [ ] reduced-motion, 작은 화면, 긴 내용, 키보드 표시 상태 확인
- [ ] 변경 전후 화면과 검증 결과 보관

성능은 정적 문자열 검사만으로 완료 판정하지 않는다. 같은 기기·같은 화면·같은 작업 조건에서 모달 반복 개폐, 긴 페이지 스크롤, 작업창 유지 상황을 비교하고 멈춤·강제 reload·긴 프레임 지연 여부를 기록한다. 도구가 제공하는 범위에서 paint/compositor 지표를 비교하되, 소스의 blur 제거만으로 GPU 메모리가 특정 비율 감소했다고 단정하지 않는다.

데스크톱 모바일 에뮬레이션, Android 실기기, iPhone Safari/PocketRisu WebView 결과는 따로 기록한다. 실기기 확인을 수행하지 못한 항목은 미검증으로 남기며, 데스크톱 통과를 해당 플랫폼 통과로 대체하지 않는다.

이 보충 계획의 GUI 변경 중심은 기존 CSS와 표면 토큰이다. 새 GUI 구조나 테마 체계를 도입하기보다, 각 플러그인의 현재 사용 흐름과 시각적 정체성을 보존하면서 고비용 효과와 그 재발 경로를 정리한다.


---

# 32. 추가 GUI 요청 — LIBRA 읽기 영역 확대 및 진단 정리 (2026-09-20)

이 절은 사용자가 첨부한 화면 8장과 추가 요청 7개를 기존 GUI 수정 범위에 포함한다. §29–31의 GPU 효과 제한과 기존 색상·접근성 원칙은 유지한다. 다만 LIBRA의 정보 배치 유지 원칙은 아래 요청 범위에서 확장한다. 헤더, 현재 상태 창, 작성실·설정실의 공간 배분 및 진단 탐색 구조를 변경한다.

**이번 문서 갱신의 상태:** 요구사항과 수정 계획을 추가했다. 제품 코드, CSS, 코드 주석은 아직 수정하지 않았다. 아래 완료 기준은 구현 후 확인할 항목이며 완료 보고가 아니다. 코드 대조 기준은 `cad55d6`의 `plugins/LIBRA.js`이다. 첨부 화면의 설치 버전과 현재 소스가 동일하다고 가정하지 않는다.

## 32.1 사용자 요청과 구현 범위

| 요청 | 첨부 근거 | 반영할 변경 | 완료 기준 |
|---|---|---|---|
| 1. 페이지 헤더가 커서 읽을 영역이 부족함 | 화면 1–3, 5–8 | 큰 영문 표제·제목·설명·여백을 압축한 공통 헤더. 제목과 필요한 동작을 같은 줄에 배치하고 긴 안내는 도움말로 이동 | 첫 화면에서 본문이나 첫 설정 입력을 바로 볼 수 있고, 제목을 읽기 위해 별도의 큰 영역을 쓰지 않음 |
| 2. 인물·세계·서사 현재 상태 창 축소 | 화면 1–3 | 페이지 헤더 오른쪽에 작은 `현재 상태 · 정상/확인 필요/조회 실패` 버튼과 `전체 상태 확인` 버튼 배치. 기존 큰 상태 카드는 상시 표시하지 않음 | 상태를 한눈에 읽고, 버튼 한 번으로 상세·설정에 접근. 실패 상태도 숨기지 않음 |
| 3. 현재 열람대 GUI 오류 복구 | 화면 4 | `buildBookHostLineagePanel`의 범위 밖 helper 참조 수정, 원인 주석과 실제 렌더링 회귀 추가 | LIBRA·GRADIA 양쪽 열람대에서 본문이 렌더링되고 같은 ReferenceError가 재발하지 않음 |
| 4. 작성실 작업 영역 확대 | 화면 5 | 큰 소개 헤더와 중첩 카드 여백 축소, 탭·저장줄을 짧게 유지하고 입력·결과 영역에 남은 높이를 배분 | 설정 입력과 긴 결과를 넓게 읽고 편집. 저장 버튼이 마지막 입력을 가리지 않음 |
| 5. 설정실 작업 영역 확대 | 화면 6–8 | `설정 → AI 연결 → AI 연결`처럼 반복되는 제목을 하나로 정리하고 외곽·내부 여백 축소 | 선택한 설정의 제목과 실제 필드가 첫 화면에 보이며, 설정 목록 탐색과 본문 스크롤이 자연스러움 |
| 6. 원문 수정 확인 독립 | 화면 7 | 기존 `source_edits` 독립 설정 경로를 사용하고 일반·진단의 중복 진입·렌더링 제거 | 독립 `원문 수정 확인` 화면에서 추적 모드·태그 규칙·보류 작업 확인과 저장 가능 |
| 7. 진단 확인창 통합 | 화면 8 | 여러 진단 카드를 하나의 `디버그 로그` 화면 안에서 필터·목록·선택 상세로 정리 | 일반·진단 진입 시 큰 진단 카드들이 늘어서지 않으며, 기존 진단 정보와 필요한 조작은 계속 접근 가능 |

## 32.2 헤더와 작업 공간 설계

- 공통 헤더는 `제목 | 상태·작업 버튼` 한 줄을 기본으로 한다. 짧은 설명이 꼭 필요한 페이지만 두 번째 줄을 허용한다. 장식용 영문 표제는 기본 헤더에서 제거하거나 도움말로 옮긴다.
- 종이색·잉크색·선택 강조는 유지한다. 본문 글자를 작게 만들어 공간을 확보하지 않는다. 외곽 패딩, 중복 제목, 설명, 카드 내부 여백부터 줄인다.
- 데스크톱의 기존 사이드바는 유지하되 주 작업 공간을 불필요하게 좁히지 않는다. 모바일에서는 기존 탐색 구조를 활용하고 상태 버튼 두 개가 제목과 함께 줄바꿈되어도 잘리지 않도록 한다.
- 버튼은 시각적으로 작게 만들되 터치 영역은 최소 44×44 CSS px을 확보한다. 상태는 색뿐 아니라 텍스트로도 구분한다.
- 작성실·설정실은 상단의 짧은 헤더/탭, 남은 공간을 채우는 본문, 짧은 저장줄로 구성한다. 본문 내부에 다시 고정 높이 스크롤 카드를 겹겹이 만들지 않는다. 사이드바 스크롤과 본문 스크롤은 각각 독립적으로 허용한다.
- 현재 코드에는 과거 `calc(82dvh - 270px)` 규칙과 이후 flex 기반 덮어쓰기가 함께 있다. 숫자 하나만 줄이는 수정 대신 실제 최종 계산값과 부모의 높이·`min-height:0`·`overflow`를 확인한다.
- 저장줄은 작업 영역 안에서 배치하고 본문 위를 덮지 않는다. 모바일 키보드, 가로 화면, 확대 상태에서 입력과 저장 동작에 접근할 수 있어야 한다.

**제안하는 측정 기준:** 동일 viewport·배율·탭·데이터로 변경 전후를 비교한다. 헤더부터 저장줄까지의 주 패널 높이 중 실제 본문 스크롤 영역이 차지하는 비율을 기록한다. 키보드가 닫힌 1280×800 및 390×844 CSS px에서 본문 비율 65% 이상을 초기 목표로 삼는다. 이는 사진에서 측정한 현행 수치가 아니라 구현 검수 목표다. 200% 확대나 키보드 표시 시에는 이 비율보다 내용 접근·스크롤·조작 가능성을 우선한다.

## 32.3 현재 상태 버튼과 상세 화면

- `현재 상태 · …` 버튼 자체가 해당 페이지의 요약 상태를 보여 준다. 인물·세계·서사 각각의 데이터 영역에 연결한다.
- `전체 상태 확인`은 세 영역의 상태를 하나의 화면에서 확인/새로고침하는 동작으로 정의한다. 조회만으로 재분석·복구·추가 LLM 호출을 시작하지 않는다.
- 상세 화면에는 상태, 기준 턴, 갱신 시각 또는 미확인 여부, 반영 결과, 조회 실패 이유와 재시도, 기존 상태 적용 설정과 고급 관리 진입을 배치한다. 사용자가 요청한 상세 보기와 설정이 같은 진입점에서 가능해야 한다.
- 데스크톱에서는 기존 drawer/dialog 패턴을 재사용하고 모바일에서는 넓은 상세 화면을 사용한다. blur 배경을 추가하지 않는다.
- 기존 현재 상태 조회 실패를 단순히 숨기거나 정상으로 표시하지 않는다. 이전 데이터가 있으면 `이전 결과 · 조회 실패`로 표시한다. 미조회·조회 중·성공·부분 반영·실패를 구분한다.
- 조회는 기존 snapshot/상태 API를 사용한다. 버튼을 열 때 필요한 정보를 읽고, 닫혀 있을 때 불필요한 반복 조회를 추가하지 않는다. 비동기 결과는 요청 당시 채팅/세계선과 일치할 때만 반영한다.
- drawer를 닫으면 호출 버튼으로 포커스를 되돌리고, 키보드 조작 및 편집 중 내용 보존을 확인한다. 복구·세계선 변경 같은 쓰기 동작은 기존 검증과 확인 절차를 유지한다.

# 33. 열람대 오류 조사 및 수정 지침

## 33.1 확인된 원인과 검증 범위

첨부 화면 4의 오류는 `ReferenceError: string is not defined`, 최초 발생 함수는 `buildBookHostLineagePanel`이다. 현재 소스에서도 이 함수의 다음 표현이 확인된다.

```js
const isHostBranch = !!string(hostWorldline?.parentWorldlineId || '')
  || lineage?.kind === 'native_branch';
```

소문자 `string` helper는 메모리 코어 내부 지역 함수이며 해당 GUI 함수에서 사용할 수 없다. 패널은 `buildBookDeskPanel`의 children 배열을 만드는 동안 즉시 호출되므로, 세계선 정보가 접힌 `<details>` 안에 있어도 열람대 전체 렌더링을 중단시킨다. 이는 CSS나 GPU 효과 문제가 아니다.

실제 소스에서 `buildBookHostLineagePanel`을 추출하고 snapshot/DOM 경계만 대체한 읽기 전용 실험에서 같은 ReferenceError를 재현했다. 별도 VM에서 해당 호출만 내장 `String()`으로 교체한 대조군은 section을 반환했다. 제품 파일은 변경하지 않았으며 실제 RisuAI 화면 복구를 검증한 것은 아니다.

기존 `libra_host_worldline_gui_contract_test.cjs`는 소스 문자열의 필드 존재를 검사한다. 이 함수의 실행 가능성을 확인하지 않아 이번 오류를 검출하지 못하는 검증 공백이 있다.

## 33.2 구현 시 필요한 수정과 코드 주석

- 해당 GUI 범위에서 사용 가능한 문자열 변환을 사용한다. 예: `String(hostWorldline?.parentWorldlineId ?? '').trim()`으로 빈 값 의미를 명시한다. 범위 밖 helper에 의존하거나 전역 `string` alias를 추가해 해결하지 않는다.
- 같은 GUI 범위의 helper 참조를 확인하되 이름이 같은 정상적인 코어 내부 호출까지 일괄 치환하지 않는다.
- **수정 지점 바로 위에 원인 주석을 남긴다.** 최소 내용은 아래와 같다. 실제 구현에 맞게 시험 파일명도 연결한다.

```js
// 열람대 렌더링 회귀: string()은 메모리 코어의 지역 helper이므로 GUI에서 접근할 수 없다.
// 접힌 세계선 details도 생성 시 이 builder를 실행하므로 ReferenceError가 열람대 전체를 막았다.
// 이 범위에서 사용 가능한 변환을 사용하고, helper를 주입하지 않는 패널 실행 테스트로 검증한다.
```

- 보조 패널 장애를 격리할 때에는 읽기 본문을 유지하면서 짧은 오류 상태와 디버그 로그 진입을 제공한다. 오류를 빈 화면이나 성공 상태로 바꾸지 않는다.
- 회귀는 기본 세계선, 분기 세계선, 미조회/빈 snapshot, LIBRA·GRADIA 모드에서 실제 builder와 열람대 진입을 실행한다. fixture에 `string`을 임의 주입해 오류를 가리지 않는다.
- 최종 브라우저 검증에서는 접힌 세계선 패널을 포함한 첫 진입, 다른 탭에서 복귀, 채팅 변경 후 재진입을 확인한다. 원본과 배포 산출물 둘 다 검사한다.

# 34. 원문 수정 설정 분리와 디버그 로그 통합

## 34.1 기존 독립 경로의 중복 정리

현재 소스에는 `BOOK_NATIVE_SETTINGS_SECTIONS`와 외부 사이드바의 `source_edits` 항목, `buildBookSettingsNativeInnerPanel('source_edits')` 분기가 이미 있다. 동시에 `buildGeneralSettingsPanel()`이 `buildSourceEditConsentPanel()`을 직접 호출해 중복 노출한다. 따라서 새 설정 저장소나 두 번째 동일 패널을 만들지 않는다.

- `설정 → 원문 수정 확인`을 독립 항목으로 유지하고 일반·진단에서 해당 패널 호출을 제거한다.
- 기존 추적 모드, 원문 태그, 비교 제외 규칙, 태그만 제거하는 규칙, 보류 작업 검토를 독립 화면에 모은다.
- LIBRA·GRADIA와 실제 사용하는 설정 진입 경로를 확인한다. 새 항목이 일부 사이드바에서만 보이거나 다른 경로에서 엉뚱한 기본 설정으로 돌아가지 않도록 route 정규화도 검증한다.
- 기존 설정 키·저장·되돌리기·재실행 후 복원과 사용자 동의 동작은 유지한다. 중복 DOM ID, 이벤트 이중 등록, 화면 이동으로 인한 미저장 값 유실이 없어야 한다.

## 34.2 진단 정보를 하나의 디버그 로그로 제공

현재 일반·진단은 `buildOperationalHealthPanel`, `buildSwallowedDiagPanel`, `buildWorldManagerDiagnosticsPanel`, `buildDebugTab`을 여러 표면으로 배치한다. 이 정보를 하나의 디버그 로그 화면에서 탐색하도록 재구성한다.

- 기본 화면은 짧은 상태 요약, 필터/검색, 시간·분류·수준·내용이 있는 목록, 선택 항목의 상세로 구성한다. Memory Lane, State Replay, 채팅 복사 연속성, 장기 채팅 캐시 등은 별도 큰 카드 대신 같은 화면의 분류로 제공한다.
- 실행 이벤트와 현재 상태 snapshot은 종류를 표시해 구분한다. snapshot을 과거에 실제 발생한 로그처럼 꾸미지 않으며, 수집 시각과 미조회 상태를 명시한다.
- 예외 집계의 횟수·최초/최근 발생 정보, 원인 코드, 기존 상세 확인·복사·내보내기 동작을 유지한다. 기존 수집기를 재사용하고 새 영구 진단 저장소를 추가하지 않는다.
- 실제 실행 명령이나 복구 기능은 로그 문구에 섞어 자동 실행하지 않는다. 선택 상세의 명시적 동작 또는 해당 설정 화면 연결로 제공하고 기존 보호 조건을 유지한다.
- 목록의 기본 표시 수를 제한하고 추가 로딩 또는 기존 가상화를 활용한다. 상세는 선택 시 렌더링하며, 숨겨진 진단을 모두 생성하거나 잦은 전체 화면 갱신을 하지 않는다.
- 새 필터/상세/내보내기에서도 기존 민감정보 마스킹을 유지한다. GUI 오류는 화면·함수·오류 종류를 찾을 수 있게 기록한다.

# 35. 추가 요청 구현 순서와 완료 확인

이번 추가 요청의 우선순위는 열람대 복구 → 공통 헤더/현재 상태 버튼 → 작성실·설정실 공간 배분 → 원문 수정 분리/로그 통합 → 화면·기능 회귀 검증이다. 기존 §30의 공통 GPU Gate와 함께 적용하되, 열람대 오류를 시각 조정 완료까지 미루지 않는다.

- [ ] 열람대 ReferenceError 재현 테스트가 수정 전 실패하고 수정 후 통과하며, 원인 주석이 수정 지점에 존재한다.
- [ ] 인물·세계·서사 첫 화면에서 큰 상태 카드가 제거되고 헤더 오른쪽 상태·전체 확인 버튼으로 같은 정보와 설정에 접근한다.
- [ ] 정상/실패/부분 상태가 구별되며, 버튼 조회가 재분석이나 복구를 자동 실행하지 않는다.
- [ ] 작성실 5개 탭과 설정실의 긴 입력/목록에서 실제 본문 높이와 첫 입력 위치를 변경 전후로 측정한다.
- [ ] 기존 `libra_gui_task_layout_browser_test.cjs`, `libra_mobile_settings_scroll_browser_test.cjs`, `libra_gradia_book_workbench_browser_test.cjs`를 활용해 최종 화면을 확인한다. 문자열 검사만으로 화면 개선을 완료 처리하지 않는다.
- [ ] 미저장 입력, 저장/되돌리기, 탭 전환, 닫기/재진입, 채팅 변경, 모바일 키보드·확대 상태를 확인한다.
- [ ] 원문 수정 확인이 독립 메뉴에서 동작하고 일반·진단에 중복 표시되지 않는다.
- [ ] 일반·진단은 하나의 디버그 로그로 정리되고 기존 진단 분류·상세·필수 동작의 대응표를 작성해 누락이 없음을 확인한다.
- [ ] 화면 1–8과 대응하는 변경 후 캡처를 같은 조건으로 보관하고, 아직 확인하지 못한 기기·모드는 명시한다.
- [ ] 제품 수정 후 관련 테스트, GPU Gate, 배포 산출물 검증을 수행하고 manifest를 갱신한다. 문서 추가 자체를 GUI 구현 완료로 집계하지 않는다.
