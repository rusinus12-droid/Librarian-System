# Flashback GUI check against real data (2026-10-18)

**Goal.** Check that the data Flashback writes shows up correctly in its GUI, and that it is presented cleanly. Flashback never calls a generation model. Its data comes from deterministic capture plus embeddings, so the check uses a real embedding provider.

## Method

1. **Data generation.** `tools/rag_eval/flashback_gui_embed_check.cjs` runs one chat (10 turns) through the real plugin and its registered hooks. Embeddings come from a real provider (`voyage-4-large`, OpenAI-compatible endpoint).

| Step | Path | Result |
|---|---|---|
| T1–T6 | Existing chat history → `ingestLiveChatColdStart` (import of an existing chat) | 6 response records |
| T7–T10 | Live turns → beforeRequest / afterRequest / chat output capture | 4 response records |
| Embedding | Pending queue, then `runMemoryMaintenance('sync')` and a final queue pass | 10/10 records with vectors, 16 provider calls |
| Manual edit | `deleteManualEditorRecords` on the T4 record | T4 removed |
| Recall | "유나가 처음에 추천한 숙소는 어디였지?" ("Where did Yuna first recommend I stay?") | Recalls 등대 여관 (the lighthouse inn); 607-character block, 7 memories |

   The saved host state redacts the synced credential. The renderer supplies the key on the Node side only, so the key never enters the page.

2. **Rendering.** `tools/rag_eval/flashback_gui_browser_render.cjs` loads the saved stores into an ephemeral RisuAI host in Chromium. The host runs on an https origin, as RisuAI does.
   - It runs the real plugin and performs one real recall; the query embedding goes through Node.
   - It opens the GUI and captures each data view at desktop (1440) and mobile (390) widths, as a viewport capture and as a full-length capture:
     - recall lab
     - stored responses and record detail
     - worldline
     - scope list
     - memory care
     - embedding connection
     - session log
     - settings
   - It also records the embedding work state, the recall result and header overflow.

## What was wrong, and the fix

| # | Problem | Fix |
|---|---|---|
| 1 | **The startup log reported "기존 retired 보관소에서 … 기억을 복구했습니다" ("restored memories from the retired store") with `stored: 9` on every fresh session.** Nothing had been retired. `synchronizeFlashbackTurnWorldline` returned `restoredRecords` as the count of *all* matched responses, not of records brought back from the retired pool. | `restoredRecords` counts only records from restored retired groups. The false startup entry is gone. The message is now in plain Korean ("보관된 이전 기억 중 … 다시 연결했습니다", "reconnected matching earlier memories"). |
| 2 | Records were titled by the string fixed at capture time. Live captures read "RisuAI 커밋 응답 리비전 10/18/2026, 2:21:18 PM" ("RisuAI committed response revision" plus a US-format date, no turn). Imports read "채팅 응답: 항구 마을 이야기 #3" ("chat response: <chat> #3"). This affected the vault list and the recall-lab frames. | Titles are derived from the record: "T7 · 실시간 캡처" (live capture), "T3 · 기존 대화 가져오기" (imported from existing chat), "T2 · 이전 채팅" (previous chat). An episode index shows its turn range. The stored title stays in the record metadata. |
| 3 | Bodies were shown as one run-on line: "User: … --- Assistant: …" | Shown as two lines, "사용자 · …" (user) and "응답 · …" (response), in the vault, the lab frames and the frame detail. |
| 4 | Lab frames showed the raw type `response` | Shown as "응답 턴" (response turn). |
| 5 | **The session log said "8개의 기억을 선택했습니다" ("selected 8 memories") while the lab showed 선택 7 (7 selected).** The log counted prepared candidates, not the budgeted selection. | Both log entries use the selection plan, so the log, the lab and the injected block agree on 7. |
| 6 | **The worldline marked T4 as "현재 대화에 연결됨" ("connected to the current chat") after its memory was deleted.** Nothing showed that the turn had no memory. | The worldline reads the live records read-only. A node without a stored response shows "저장된 기억 없음" ("no stored memory"), and a summary line lists those turns ("기억이 없는 턴: T4", "turns without memory"). |
| 7 | The worldline's five status counters sat in a four-column grid, leaving a large grey empty cell. The fields underneath touched the grid. | The grid fits its counters, and the fields are spaced below it. Node rows align the turn, node id and badges. |
| 8 | The worldline reason was the raw code `no_native_branch_marker` | Shown in Korean with the code kept, e.g. "독립 채팅 · RisuAI 분기 표식 없음 (no_native_branch_marker)" ("independent chat · no RisuAI branch marker"). |
| 9 | Costs read "$0 known" for an unpriced provider, and "N/A" for the last query embedding even though its 96 tokens were known. "마지막 벡터화 작업" ("last vectorization job") ran into "아직 없음" ("none yet") with no spacing. | Unpriced costs read "단가 미설정" (no unit price set), or "$x + 단가 미설정분" ($x plus the unpriced part). The empty row uses the same layout as the other rows. |
| 10 | Dates and times used the host locale (US format) in the vault metadata, scope list, session log and lab. Log levels showed `success` / `info`. The scope list showed the placeholder persona "Selected Persona" and the headers `chunks`, `shards / archive`. | Korean date and time format (2026. 10. 18. 오후 02:37). Log levels read 완료 (done), 정보 (info), 경고 (warning) and 오류 (error). The placeholder persona is hidden; it is still used for storage identity. Headers read 기억 청크 (memory chunks) and 샤드 / 보관 (shards / archive). |
| 11 | In the vault search box the decorative icon sat below the placeholder, and below the field on mobile. It duplicated the search button. | The decorative icon is removed. The search button remains. |

**Harness issue, not a product defect.** In the first render, T10's embedding failed with `INVALID_RESPONSE / EMBEDDING_CHECKPOINT_CRYPTO_UNAVAILABLE`. The page was `about:blank`, which has no `crypto.subtle`. The renderer now serves the page from an https origin, and the embedding state is 9/9 ready. Separately, `runMemoryMaintenance('sync')` can re-commit a live turn as a new pending revision. The generator therefore ends with a final queue pass, as the automatic start would.

## Verification

**After the fixes (real run)**
- The vault lists 9 responses, T1–T3 and T5–T10, each with its turn and capture path. These match the stored records; T4 was deleted.
- The lab shows the 7 recalled frames, with T2 (등대 여관) first at 0.846.
- The worldline shows 10 nodes, with T4 marked "저장된 기억 없음".
- The embedding panel shows 9 ready and 0 failed.
- No page errors. Header overflow is 0 on desktop and mobile.

**Tests**
- `tests/flashback_raw_cow_append_runtime_test.cjs`: a startup lifecycle repair reports `restoredRecords` 0, and an exact retired restore reports 1. Both were 9 before the fix.
- `tests/flashback_gui_record_display_test.cjs`: record titles, turn text, cost summary, Korean dates and lineage reason labels.

**Note.** The recall lab and the session log hold the current session's in-memory state, so a GUI opened in a fresh session starts empty until the first recall.
