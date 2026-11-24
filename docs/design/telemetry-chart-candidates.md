# Chart candidates from the "T3 Code Telemetry" deck

Source: a public 81-second video posted on X (status 2125340306317127741, 2026-11-24). It shows a
12-slide deck of one user's T3 Code telemetry (95,789 events, Sep 4 to Nov 24 2026). This note
reviews each chart as a possible ProxUI component. No frames from the video are stored in this
repo.

## What every slide has in common

Each slide uses the same anatomy, and that anatomy is worth more to ProxUI than any single chart:

1. **Eyebrow with the headline count**, in the accent colour: "16,409 provider requests".
2. **Plain title**: "What started each request".
3. **Data line** at top right naming the event the chart reads: `DATA: provider.request.completed`.
4. **Reading key** at the bottom: "Each bar is one day, stacked by agent provider", "Bar = all
   calls to that tool. Orange part = calls that returned an error".

ProxUI already promises "honest numbers" and shows coverage limitations. A data line and a
reading key on every chart is the same promise in a smaller space, and it costs only copy.

The deck also puts a texture (dither, hatching, dots) on each series as well as a colour. That
second channel keeps series apart for colour-blind readers and in greyscale. ProxUI's usage
trend already does this for lines (solid, dashed and dotted strokes); textures extend the same
idea to filled series such as bars.

The cream paper and pixel-font look does not carry over: ProxUI has one dark theme
(`src/styles/themes.scss`). Keep the anatomy and the textures; keep ProxUI's palette and type.

## Constraint that decides cost

`src/features/analytics/RULES.md`: prox-usage owns token accounting, cost and aggregates, and the
UI "must not calculate prices, token relationships, ratios or aggregate metrics from request
pages". ProxUI draws its charts as hand-written SVG (`TrendChart.tsx`, `PoolChart.tsx`), so no
chart library is needed. A chart is cheap when today's `AnalyticsResponse` already carries its
numbers (`summary`, `timeline`, `providers`, `models`) and costs a prox-usage change when it
needs a new grouping.

## The twelve charts

| # | Slide | Chart form | ProxUI equivalent | Data today | Verdict |
|---|-------|-----------|-------------------|-----------|---------|
| 1 | Total tokens processed | One hero number, five supporting facts, a small daily bar strip | Dashboard header: tokens, calls, cost, failure rate for the range | `summary` + `timeline` | **Adopt** (layout only) |
| 2 | Tokens per day, by provider | Stacked daily bars, one colour and texture per provider | Analytics trend split by provider (Claude, Codex, Gemini, Antigravity) | Needs `timeline` per provider | **Adopt**, needs prox-usage |
| 3 | Prompts by hour and weekday | 7 × 24 heatmap, darker cell = more | Requests (or tokens) by hour of week, in UTC | Needs an hour-of-week grouping; local time also needs the query contract to accept zones other than UTC | **Adopt**, needs prox-usage |
| 4 | Agent turns per day, in 3D | Isometric towers, weeks × weekdays | Same data as a flat calendar heatmap | Daily `timeline` | **Skip the 3D**; towers hide each other and cannot be read precisely. A flat calendar gives the same answer |
| 5 | What started each request | Donut, share in the centre, legend with counts | Share by outcome, by hub, or by client (Claude Code, Codex CLI, T3) | Outcome: `summary`. Hub: needs a grouping on `instance_id` with an unattributed bucket. Client: needs a grouping on `user_agent` | **Maybe**; only for 2 to 4 parts, otherwise use bars |
| 6 | Which model delegated to which | Sankey: sender model on the left, executing model on the right, band width = tasks | Requested model → served model (alias routing), or model → account that served it | Needs pair counts (`requested_model`, `resolved_model`, `account_label`) | **Adopt later**; the most useful new view for routing and account spread |
| 7 | User prompts vs agent turns | Two 24-hour radial bar clocks | Requests vs failures by hour | Hourly `timeline` | **Skip**; radial bars exaggerate outer values. Chart 3 answers the question better |
| 8 | Agents running at the same time | Spiky line of peak concurrency per hour | Peak in-flight requests per hour, per hub or per account | Needs start time + duration per event, peak computed in prox-usage | **Adopt later**; shows when accounts hit concurrency or rate limits |
| 9 | Agent turns by model | Ranked horizontal bars, colour by vendor, value at the end | Analytics "By model", which already draws ranked bars | Ranking: `models`. Vendor colour: needs a model → vendor mapping or a joint model × provider breakdown, because `models` and `providers` are separate | **Adopt** the vendor colour once that data exists |
| 10 | Tool calls and error rate | Bars where the orange part is the failed share; calls and error % columns | Calls and failures per model, provider, and later per account | `models[].failure_calls`, `providers[].failure_calls` | **Adopt now**; the highest value for the least work |
| 11 | App features used | Treemap, area = uses | Cost or tokens by model | `models` | **Skip**; areas are hard to compare and bars already do this |
| 12 | Devices and operating systems | Two waffles, each square = 1 % | Share of requests per hub or per account | Hub: needs a grouping on `instance_id` with an unattributed bucket (`source_attribution` is only a coverage flag). Account: needs a grouping | **Maybe**; bars read faster. Use only where "share of 100 %" is the point |

## Recommended order

1. **Failure-share bars (10).** Reads only `models` and `providers`, which every Analytics
   response already has. Draw the failed calls as the coloured part of each existing bar and put
   calls and failure % in tabular columns. UI-only change. Vendor colour on "By model" (9) waits
   for a model → vendor mapping.
2. **Data line and reading key on every Analytics and Quota chart.** Copy and a small shared chart
   frame component. UI-only change.
3. **Stacked daily bars by provider (2).** prox-usage returns `timeline` split by provider
   (one more grouping in the query worker). Sits beside the Overview usage trend.
4. **Hour-of-week heatmap (3).** prox-usage groups by weekday and hour, in UTC first: the query
   contract accepts only `time_zone: "UTC"` today (`server/usage/validate.ts`). Local time needs
   that contract and the bucketing changed. Answers "when do we burn quota", which also helps
   plan resets.
5. **Requested → served sankey (6)** and **peak concurrency (8).** Both need new prox-usage
   aggregates. Do them after 1 to 4 have shipped and been used.

Each step that changes prox-usage needs its own parity check against the existing totals: the sum
of the split timeline must equal today's `timeline` for the same query.

## Not recommended

- 3D towers (4), radial clocks (7) and the treemap (11): each looks good in a video and reads
  worse than a flat alternative ProxUI can draw with the same data.
- The pixel display font for big numbers. It fits the deck's print look, not ProxUI.
