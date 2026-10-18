# HAYAKU GUI check against real data (2026-10-18)

This records the 3.0.151 run. In 3.0.152 the retired failure-repair subpanel is removed; diagnostic details move to explicit log access and opt-in bounded retention. See [analysis diagnostics retirement](HAYAKU_ANALYSIS_DIAGNOSTICS_RETIREMENT_20261018.md). The later change was tested with controlled model outputs, without repeating this provider run.

**Goal.** Check that the data HAYAKU writes on each of its four write paths shows up correctly in the GUI, and that it is presented cleanly.

## Method

1. **Data generation.** `tools/rag_eval/hayaku_gui_llm_check.cjs` runs one chat (9 turns) through the real plugin and its registered hooks. It uses a real model (`deepseek-v4.1-flash:cloud`, OpenAI-compatible).

| Turns | Path | Result |
|---|---|---|
| T1–T4 | Cold start over history that has no packets (batch of 5) | 1 call, 4 historical records |
| T5–T7 | Canonical packet: the main model writes the packet with its reply | 3 active records |
| T8 | Automatic repair: a reply with no packet triggers afterRequest auto repair | 1 call, active record |
| T9 | Manual gap repair: a reply with no packet, then a failed auto repair (stub), then `recovery.repairSelected` | 1 call, recovery record |

2. **Rendering.** `tools/rag_eval/hayaku_gui_browser_render.cjs` loads the saved storage, chat and arguments into an ephemeral RisuAI host in Chromium. It runs the real plugin, opens the GUI and captures each view at desktop (1440) and mobile (390) widths:
   - overview
   - packet list and detail (summary and memory axes)
   - worldline
   - recovery: missing turns, failed candidates, cold start
   - logs

## What was wrong, and the fix

| # | Problem | Fix |
|---|---|---|
| 1 | **The worldline merged the 4 cold-start records into one "T0" row**, so only the last record was visible (6 rows in total) | The worldline lists records by their real turn, taken from the packet's `source_turn_range`. It now shows T1–T9. |
| 2 | The packet list showed cold-start records as "과거 #1~#3" ("past #1–#3") instead of their turns, and sorted them last | Labels are T1–T4 (a multi-turn record shows T5–T7). Records are sorted by turn. |
| 3 | The list showed **no write path**. The T8 auto-repaired packet stored exactly the same fields as a canonical packet. | When afterRequest repair writes a packet, the record now keeps `packetAuthor: 'after_request_repair'`. Every record shows a write-path badge: 콜드스타트 (cold start), 정본 패킷 (canonical packet), 자동 복구 (auto repair), 누락 복구 (gap repair), 이전 채팅 (previous chat), 부분 기억 (partial memory). The detail view gives the path and its explanation. |
| 4 | Internal values such as `current_snapshot` and `active` were shown raw. Dates used US format. | Packet types, states and write-status labels are in Korean. Dates use the Korean format (2026. 10. 18. 오후 01:32). |
| 5 | The type filter had no cold-start option. The "감사 사본 표시" (show audit copies) checkbox was misaligned. | Added a cold-start packet filter. The checkbox now sits inline with its label. |
| 6 | **The failed-candidate list still showed T9 as "확인 대기" (awaiting review) after manual repair had filled it** | If the turn now has a live record in the ledger, the entry shows as "이후 복구됨" (repaired later). It is left out of the pending count and the default selection, and its explanation says so. The failure record itself is kept for auditing. |
| 7 | In the failed-candidate list, the title and reason overlapped inside the button | The row is now a grid. Text wraps inside the button. |
| 8 | **The "memory axes" view crushed the value column of the nested key-value grid to nearly zero width**, so values looked empty | Inside an axis card, labels and values stack in one column. People, events and other values are readable again. |
| 9 | On mobile (390 px) the header was too wide and clipped the "…" menu. Selecting a record did not reveal its detail. | At 414 px and below, the job chip shows its icon only (header overflow is 0). On a one-column layout, the detail scrolls into view after a selection. |

## Verification

**After the fixes (3rd real run)**
- All 9 list rows match the stored packet summaries, with the right turn, write path and state.
- The worldline shows T1–T9.
- No page errors. Header overflow is 0 on desktop and on mobile.

**Tests**
- `tests/hayaku_after_request_recovery_journal_runtime_test.cjs`: the auto-repaired packet is captured from the chat output and keeps `packetAuthor`. This holds even when afterRequest runs twice.
- `tests/hayaku_gui_record_origin_test.cjs`: write-path, turn, state and type labels.
- All HAYAKU tests: 149 run, 144 pass, no new failures.

**Note.** The logs view shows the current session's in-memory log, so a GUI opened in a fresh session starts with the startup events only.
