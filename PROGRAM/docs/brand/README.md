# Librarian Suite CI (Corporate Identity) v1.1

<img src="librarian-system.svg" width="72" alt="Librarian System">

**근거가 있는 기억만, 지금의 이야기에.**

Librarian System은 RisuAI를 위한 로컬 기억 인프라입니다. 하나의 서고 안에서 여섯 개의 플러그인이 각자의 역할을 맡습니다. CI는 같은 골격 위에 서로 다른 색과 기호를 얹어, 한 시스템이면서도 한눈에 구분되도록 만들었습니다.

디자인 캔버스(로고, 색, 타이포그래피, 적용 예)는 이 문서의 원본 시안입니다. 저장소에서는 이 폴더의 SVG와 아래 값이 기준입니다.

## 플러그인

| 심볼 | 이름 | 역할 | 주색 | 틴트 | 어두운 바탕용 | 심볼의 뜻 |
| --- | --- | --- | --- | --- | --- | --- |
| <img src="libra.svg" width="32"> | LIBRA | 장기 서사 기억 | Archive Indigo `#2F3F8F` | `#E6E9F7` | `#A9B6F2` | 저울: 근거와 기억의 균형 |
| <img src="flashback.svg" width="32"> | FLASHBACK | 에피소드 회상 | Recall Amber `#A3530A` | `#F8EADB` | `#F2B46A` | 되감는 원 안의 섬광 |
| <img src="hayaku.svg" width="32"> | HAYAKU | 시공간 연속성 | Locator Teal `#126457` | `#DDF0EA` | `#7FD3C1` | 시간선 위에 꽂힌 위치 핀 |
| <img src="lia.svg" width="32"> | LIA | 페르소나 링커 | Persona Rose `#A3365A` | `#F7E3EA` | `#F0A3BD` | 인물과 그를 잇는 고리 |
| <img src="retrace.svg" width="32"> | RE:TRACE | 인계와 보관 | Relay Slate `#3E5566` | `#E1E8ED` | `#A9C1D1` | 굽이쳐 거슬러 오르는 경로 |
| <img src="gradia.svg" width="32"> | GRADIA | 서사 보조 | Gradation Plum `#6B3FA0` | `#EFE7F8` | `#C9A8F0` | 점점 짙어지는 네 계단 |

시스템 심볼은 선반 위 여섯 권의 책입니다. 각 책의 색이 곧 플러그인의 색이고, 기울어진 마지막 책은 아직 쓰이고 있는 초안(GRADIA)입니다.

모든 주색은 종이 바탕(`#FAF8F2`) 위 글자로 써도, 흰 글자를 얹어도 4.5:1 이상입니다. 어두운 바탕에서는 같은 계열의 밝은 톤으로 바꿉니다.

## 심볼 규칙

- 48 단위 그리드. 둥근 끝과 둥근 모서리의 3.2 굵기 선을 씁니다(GRADIA는 면).
- 타일 모서리 반경은 타일 한 변의 25%이고, 심볼은 타일 안에서 사방 1/8씩 여백을 둡니다.
- 심볼 주변 여백은 타일 한 변의 1/4 이상 비웁니다.
- 작은 크기에서는 획을 덜어 냅니다. 32px은 굵은 획과 단순화한 형태로, 16px은 형태 하나만 남긴 실루엣으로 그립니다.

## 공통 중성색

| 이름 | 값 | 쓰임 |
| --- | --- | --- |
| Paper | `#FAF8F2` | 바탕 |
| Shelf | `#F1EDE4` | 면 구분 |
| Rule | `#D6D0C4` | 선 |
| Margin | `#71685D` | 보조 글 (5.2:1) |
| Ink | `#2C2D2B` | 본문 (13:1), 어두운 바탕 |
| Vellum | `#EFE7D9` | 어두운 바탕 위 글 |

## 타이포그래피

| 역할 | 글꼴 | 쓰임 |
| --- | --- | --- |
| 워드마크·로마자 제목 | Space Grotesk 700, 대문자, 자간 +8% | 플러그인 이름 |
| 한글 제목과 본문 | IBM Plex Sans KR 400 / 600 / 700, 본문 행간 1.6 | 화면의 모든 한글 |
| 데이터와 근거 | IBM Plex Mono 400 / 500 | 턴 번호, 리비전, 해시, 버전, 토큰 수 |

크기 단계: Display 40/700, Title 24/700, Heading 17/600, Body 15/400/1.6, Caption 13/400, Data 13/Mono 500.

## 플러그인 GUI에 적용한 방식

- 각 플러그인 GUI는 지금의 테마(LIBRA 서고, HAYAKU 관제실, Flashback 현상실, GRADIA 계조, LIA 포켓, RE:TRACE 인계소)를 그대로 유지합니다. 여섯 화면을 한 가족으로 묶는 서명은 로고 타일과 글꼴입니다.
- 상단바의 브랜드 칸(`.brand__mark`)은 그 플러그인의 주색 타일에 흰 심볼을 얹고, 브랜드 이름(`.brand__name`)은 Space Grotesk 대문자 워드마크로 씁니다.
- 글꼴은 외부 서버에서 불러오지 않습니다. 라틴 글자만 담은 Space Grotesk 700과 IBM Plex Mono 400/500은 GUI 스타일시트에 내장하고, 한글 본문은 IBM Plex Sans KR을 1순위로 지정합니다. 이 글꼴이 설치되지 않은 기기에서는 지금처럼 Pretendard, Noto Sans KR, 시스템 글꼴 순으로 표시됩니다.

## 라이선스

- Space Grotesk: Copyright 2020 The Space Grotesk Project Authors. SIL Open Font License 1.1.
- IBM Plex Mono, IBM Plex Sans KR: Copyright © 2017 IBM Corp. SIL Open Font License 1.1.

라이선스 전문은 `PROGRAM/docs/gui-redesign/assets/fonts/`에 있습니다.
