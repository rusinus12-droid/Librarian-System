# LIBRA 2.3.66 — Librarian response mode default

LIBRA now uses **사서 모드** (`classic`) when no response mode has been saved. The response-mode cards list 사서 모드 before 플래너 모드 so the primary path is visible first in the settings panel.

An explicitly saved mode remains authoritative. Existing users who selected 플래너 모드 continue to use it; the new default applies only when the setting is absent or invalid. GRADIA remains a separate response family and is not changed by this default.

사서 모드는 정본 리콜 발췌를 최종 응답 모델에 직접 전달하며 Planner 생성 호출을 추가하지 않습니다. Planner remains available as an explicit choice and keeps its existing settings and prompt contract.

## Validation boundaries

Static checks verify the plugin syntax, default normalization, mode order, manifest/checksum coherence, and the existing LIBRA runtime regression set. Real RisuAI GUI rendering and provider behavior still require a live host check.
