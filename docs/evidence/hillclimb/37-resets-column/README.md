# Manual resets column and compact opened rows (g10c)

Captured with `scripts/visual/prox-quota-capture.py` against synthetic fixtures on a pinned clock
(Chromium, UTC, English, dark mode, reduced motion). All 70 capture cases pass every check in
`summary.json`, including the new row-geometry check: equal row heights, and no cell crosses into
the next column. The `real*` states use data shaped like a live hub, with four Ultra accounts, each
holding several kinds of manual resets.

| File | What it shows |
|---|---|
| `real.png`, `real-1100.png` | Wide Accounts table with the Manual resets column ("N usable" over what is held), plan under the name |
| `real-narrow.png` | Phone rows: the two-line reset chip on its own line under the plan |
| `real-open.png` | Opened rows: burn rate as the lead figure, Usage and Billing as aligned lists, Manual resets on the right |
| `wide.png`, `laptop.png`, `narrow.png` | Default fixture at 1920, 1100 and 390px |
| `expanded.png`, `expanded-narrow.png` | Every account opened, wide and phone |
| `partial.png`, `stale.png`, `refresh-error.png` | Degraded data states |
| `reset-confirm-wide-dialog.png` | Codex reset confirmation |
| `loading-narrow.png` | Phone skeleton |

## Review scores

Four independent judges scored 7 screens × 9 aspects from these captures. They used anchored
rescoring against their own previous round.

| Seat | Model | Lens |
|---|---|---|
| 1 | Claude Opus 5.5 | Visual |
| 2 | Claude Fable 5.2 | Information architecture |
| 3 | GPT-6.2 Sol | Interaction and accessibility |
| 4 | GPT-6 Astra | Product design |

The cell value is the median of the four judges. Brackets show the change since g9.

| screen | hier | layout | type | colour | content | controls | consist | resp | group |
|---|---|---|---|---|---|---|---|---|---|
| 1-overview-wide | **9.05** (+0.00) | **9.10** (+0.40) | **9.20** (+0.10) | **9.10** (+0.00) | 8.90 (+0.10) | 8.70 (+0.00) | 8.95 (+0.05) | 8.80 (+0.00) | **9.05** (+0.05) |
| 2-overview-narrow | 8.75 (+0.00) | **9.05** (+0.20) | **9.00** (+0.00) | **9.10** (+0.00) | 8.90 (+0.05) | 8.85 (+0.10) | **9.00** (+0.15) | 8.80 (+0.00) | 8.95 (+0.05) |
| 3-account-details | 8.95 (+0.00) | 8.85 (+0.10) | **9.00** (+0.00) | **9.10** (+0.40) | 8.60 (+0.15) | 8.90 (+0.05) | 8.85 (+0.00) | 8.75 (+0.05) | 8.90 (+0.00) |
| 4-long-roster | 8.85 (+0.00) | **9.15** (+0.25) | **9.15** (+0.15) | **9.10** (+0.40) | 8.85 (+0.30) | 8.85 (+0.00) | 8.90 (+0.15) | 8.80 (+0.25) | 8.80 (+0.00) |
| 5-degraded-data | 8.80 (+0.00) | 8.85 (+0.25) | **9.00** (+0.10) | **9.00** (+0.00) | 8.60 (+0.15) | 8.70 (+0.00) | 8.90 (+0.10) | 8.85 (+0.05) | 8.75 (+0.00) |
| 6-page-states | **9.20** (+0.00) | 8.90 (+0.20) | **9.05** (+0.00) | **9.20** (+0.00) | 8.95 (+0.10) | 8.80 (+0.00) | **9.05** (+0.00) | **9.05** (+0.10) | **9.05** (+0.05) |
| 7-rate-views | 8.85 (+0.00) | **9.15** (+0.15) | **9.05** (+0.00) | **9.10** (+0.00) | 8.60 (+0.05) | 8.95 (+0.00) | **9.00** (+0.00) | 8.80 (+0.05) | 8.85 (+0.00) |

- Passing cells (9.0 or above): 26 of 63. The mean is 8.93 and the lowest cell is 8.60.
- No judge reported a drop against the previous pass.
- Of the 28 screen verdicts, 27 were "better" and 1 was "same".
