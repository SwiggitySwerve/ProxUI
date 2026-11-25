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

## Placement and order (decided 2026-11-25)

A review against today's screens, and the owner's answers, settled where each chart goes. New
charts go on Analytics; the Dashboard is not extended (`/` opens Quota).

| Chart | Place | When |
|-------|-------|------|
| Failure bars (10), by provider and by model | Analytics › Overview, replacing the two plain breakdowns | Step 2 (shipped with this note) |
| Tokens per day by provider (2) | Analytics › Tokens & Cache, under the token trend | Step 4 |
| Hour heatmap (3) | Analytics › Overview, full width at the end; date × hour first | Step 3 |
| Model → account (6) | A new Analytics "Routing" tab, as a grid or per-account bars rather than a sankey | Step 5 |
| Peak concurrency (8), per account | Analytics › Performance | Step 6 |
| Big-number header (1) | Nowhere: it would repeat the Overview cards and the Dashboard header | Dropped |

1. **One owner for provider identity.** `src/features/providers/identity.ts` gives every screen
   a provider's name, ink and textured fill (tokens in `src/styles/themes.scss`). Codex is
   hatched and Gemini dotted, because those two hues fail colour-blind separation; failures carry
   their own hatch, because failure red sits close to Claude's orange.
2. **Failure bars.** Each bar is a category's events with its failed events drawn first, on the
   one shared scale. The failed count is a link to Requests filtered to those failures. Counts
   only: a failure rate would be a UI-computed ratio, which `RULES.md` forbids, so a rate waits
   for prox-usage to return one. With an outcome filter set, the bars are plain counts again.
3. **Date × hour heatmap** from the hourly timeline, with no backend change.
4. **prox-usage: `provider` on `models[]` and a timeline split by provider**, with a parity check
   that the split sums to today's totals. Unlocks vendor colour on "By model" (9) and the stacked
   daily bars (2).
5. **prox-usage: per-account breakdown**, then the Routing tab and an Auth Files link that opens
   one account (Auth Files keeps its view in browser storage today, so it has no such link).
6. **Local time.** The owner reads in local time, so the query contract (UTC only today,
   `server/usage/validate.ts`) and the bucketing move to a time zone, with one app-wide UTC/local
   setting. Hour-of-week grouping and per-account peak concurrency follow.

## Acting on what a chart shows

Charts never edit anything. Each one links to the screen that owns the action: a failed count to
Requests, a provider to Quota, a heatmap cell to that hour's requests, a model → account cell to
Models, an account's failures to Auth Files. Account links use the source instance and auth
index, never label text. Concurrency stays read-only: ProxUI has no concurrency-limit setting.

The charts themselves need little management. Tab, range, bucket and filters already live in the
address and in per-browser storage. Two preferences are worth having: **Show emails** becomes one
setting that Quota and Analytics both follow, and the UTC/local setting above. Per-chart hiding,
reordering, pinning to the Dashboard and a hide-provider switch are not planned; a legend click
can set the provider filter instead.

## Not recommended

- 3D towers (4), radial clocks (7) and the treemap (11): each looks good in a video and reads
  worse than a flat alternative ProxUI can draw with the same data.
- The pixel display font for big numbers. It fits the deck's print look, not ProxUI.
