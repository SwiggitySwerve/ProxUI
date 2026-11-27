# Quota history and forecast ownership

This package owns recorded quota history, sample quality, pooled arithmetic and
forecasts. HTTP validates requests and serializes these results. The browser
only selects views, formats values and positions chart geometry. Provider raw
window conversion belongs to `src/domain/quotaWindows`, shared with the original
credential UI. The store owns persistence; the collector uses only public APIs.

- Production membership, origins and per-instance key files come only from the
  validated deployment manifest. `applySources` admits new instance IDs on the
  next read and records the revision. Existing bindings stay pinned, even when
  the next manifest omits them or changes their origin or key file reference.
  Stopping aborts in-flight requests and prevents their subsequent writes.
  Each instance is inventoried once, including all supported Claude/Codex kinds.
  Antigravity is never inventoried or read, even on an instance that declares it. Other kinds
  use a normalized reader only when a fresh provider catalog reports them active
  with a supported reader. Full collections and inventory sync probe the catalog
  on each instance. A 404, failed probe or malformed response preserves the last
  catalog and skips generic account retirement and polling for that read.
- Antigravity (Gemini) quota is never read from Google (removed 26 Nov 2026). Google
  suspended the account while a hub used its Antigravity sign-in, and the terms bar
  third-party tools from it (`docs/PROX-SETUP.md`). No code may name Google's private
  Cloud Code backend; `tests/noGoogleQuotaReads.test.ts` scans for it. The collector skips
  Antigravity in `collectionSource` and again before any usage request, so it never
  sends a request with that credential, a plan read or a hub `quota/fetch`.
  When configured (`PROX_AGY_SNAPSHOT_PATH`, default `/data/agy-usage.json`), the collector
  watches a local JSON snapshot dropped by the host's official signed-in `agy -p "/usage"`
  helper (`deploy/prox-agy-usage.sh`). The ingest (`agySnapshot.ts`) accepts only zero-turn
  `SUCCESS` `/usage` payloads containing both `gemini-5h` and `gemini-weekly` under
  `Gemini Models` (never writing missing-window nulls on schema drift), normalizes unused
  `1970-01-01T00:00:00Z` reset timestamps to `null`, and reuses the single existing
  non-retired Antigravity account for that `instanceId` so stored history and plan history
  stay continuous. After 30 minutes without a fresh snapshot, the collector marks the
  ingested account disabled and removes its live source entry so Gemini reverts to dormant
  history without blocking the combined "All" forecast for Claude and Codex. Circuit-breaker
  state (`agy-usage.stopped`) and sanitized transition events (`agy-events.jsonl`) are
  exposed read-only at authenticated `GET /v1/agy-status`; `deploy/prox-agy-recover.sh`
  (driven by `prox-agy-recover.path` + `prox-agy-recover.timer`) performs at most one
  post-cooldown probe for `transient` failures, escalates a second failure to `hard_stop`,
  never auto-probes `hard_stop` or `version_changed`, and restarts `prox-agy-usage.timer`
  on recovery or unexpected stop. Only the
  "Gemini Models" group feeds the pool (user direction, 21 Nov 2026); the "Claude and GPT
  models" group is its own model-lane window. It has no resets: claims are refused
  before anything is sent, and `/v1/accounts` leaves its accounts out (its cards
  stay hub-direct). Databases from before it are migrated once: `quota_accounts`
  is rebuilt to allow open provider IDs, keeping every row and reference. The
  same migration applies to databases that already allow Antigravity.
- Identity and complete-inventory retirement belong to an instance/provider pair.
  Failed, incomplete or malformed inventories retire nothing in that instance;
  another instance continues independently. Issues carry their owning instance.
  History for an instance removed from the manifest remains visible, but its
  pool is incomplete while that instance is absent from configuration.
- Legacy attribution uses the explicit prior-deployment mapping in `identity.ts`.
  Additive ownership and alias tables retain the original account IDs and every
  sample tuple/foreign key; migration never prunes or changes account metadata.
  All supplied mappings commit together or roll back. Conflicting mappings,
  unknown destinations and alias collisions fail. Unmapped history stays retained
  and unresolved; scoped dashboards expose its count without assigning its quota.
  New occurrences cannot claim an old ID without its persisted ownership alias.
  The original 30-day collection retention rule remains separate from migration.
- The credential inventory is one read model, versioned by a hash of the active
  `[instanceId, provider, accountId, disabled]` tuples (no names or emails), served at
  `/v1/inventory` (ETag) and echoed on `/v1/pools`. `syncInventory()` re-reads only the
  credential lists: single flight, one-second floor, outside the manual-refresh limit, never a
  usage API. Only `<name>.json` entries count. A read that fails or is malformed changes nothing.
  Reads are numbered per source, and a result older than one already applied is dropped.
- Retiring an account clears its email, replaces its name and stamps `retiredAtMs` in the same
  transaction; coming back restores them. A credential the user deleted by name (delete sync)
  that a fresh validated inventory confirms gone is purged at once, children first. Any other
  retired account is purged 24 hours after `retiredAtMs`: absence alone (an unmounted auth
  directory looks the same) is not proof of intent. The collector forgets a retired account's
  in-memory readings, aborts its polls and persists nothing for an account that is no longer live.
  A delete sync with an `instanceId` matches deleted names only on that hub, including when
  multiple syncs are queued together. Callers that omit it retain the old all-source behavior.
- Dashboard arithmetic runs separately for each instance/provider using the same
  source-local rules below. Equal emails, filenames or auth indices do not merge
  occurrences. Multiple same-provider sources expose unavailable combined values
  with `cross-source-combination-unverified`, never summed capacity or histories.
  No allowance identity or duplicate relationship is inferred from inventory.

- Each enabled account contributes 100 quota points per base-plan unit of its
  subscription (`plans.ts`): one unit is the provider's $20 plan (Claude Pro,
  ChatGPT Plus), and plans count as the providers' published multiples (Claude
  Max 5x/20x; ChatGPT Pro 10x, Pro 500 25x). Google AI Ultra (`g1-ultra-tier`)
  counts 20 units, like Claude Ultra, and the lower Google AI Ultra Lite (`g1-ultra-lite-tier`)
  5, like Claude Max (user direction, 21 Nov 2026). A window's remaining percent times
  that weight gives pool points; resets restore each account to its own capacity.
  An unknown plan counts as one unit and is shown as unknown. Points are not tokens.
- Plans come from provider responses only: Codex's usage `plan_type` and Claude's
  OAuth profile tier. Antigravity's stored plan (from `loadCodeAssist` before 23 Nov
  2026) is kept and never read again. Claude's is a separate read, asked at most every
  30 minutes. A
  targeted refresh, or a poll whose windows suggest a plan change
  (`planChangeSuspected`: a window in use restarted before its reset, or moved 20+
  points within one cycle), asks again when the last ask is at least 5 minutes old,
  so an upgrade or downgrade reweights the pool at the poll that shows it. A failed plan read
  changes nothing else.
- A plan change applies from when it is first seen (`quota_plan_history`). Each sample
  keeps the weight of the plan in force when it was recorded (`planAt`), so an upgrade
  never rescales earlier history, and a rate interval across a change is not burn. A
  plan known before the history existed, and an account's first plan, hold from the start.
- An account with no five-hour limit is `no-limit` in the five-hour pool, not `missing-window`:
  outside its capacity and eligible count, and it never withholds the pool or combined five-hour
  total. Claude is decided by plan (Ultra answered with limits but no five-hour one). Codex is
  decided by the provider's own answer, never the plan: the newest successful reading has a weekly
  balance and an explicit missing five-hour sample at the same instant (`weeklyOnlyAccountIds`,
  `values.ts`; e.g. Pro with only `primary_window` of 604800 s and `secondary_window: null`). A
  failed poll writes no sample, so it stays errored or stale; a reading with no weekly window
  either stays `missing-window`; a later five-hour reading supersedes it. `/v1/pools` is built from
  one window's samples, so `app.ts` passes the set from `store.latestSamples()`. Pools flag the
  account `noFiveHourLimit` in both windows, and `/v1/accounts` serves the same flag so cards say
  "No 5-hour limit" like Quota Management.
- Weekly and five-hour windows are separate. Model-scoped, monthly, dollar and
  reset-credit balances are not added to those pools.
- `GET /v1/pools` shows providers with no credentials as `awaitingAuth` and generic
  credential accounts as `unpooled` until an operator enables a profile on that
  instance. Neither section contributes to combined totals. The collector sends
  only the auth index to the hub's normalized quota endpoint. Latest generic
  windows stay in memory. Only selected account-wide buckets enter pooled history.
  Each sample keeps its bucket ID so changing the mapping preserves the old rows
  without mixing two limits. A lane left unset has no contribution. Plan weights
  use the operator's per-plan overrides, with `*` reserved for a missing plan ID.
  Without an override the reading counts as 100 points at full capacity and the
  dashboard flags the plan as unknown. `PUT /v1/pool-profiles` accepts validated
  account-wide window IDs. `GET` lists the profiles and `DELETE` removes one by
  its `instanceId` and `provider` query parameters. All three require management
  authentication.
- Each account is its own stream and totals aggregate what the streams know (user direction,
  16 Nov 2026: per-stream collection, fault-tolerant aggregation). An account whose sample is
  older than 15 minutes, or whose poll failed, is `stale`/`error` and never 0: in the pool total
  its last reading stands in (100% once its window has reset since), counted in `estimatedCount`,
  and the forecast stays off until every stream is fresh. An account with no reading, an explicit
  missing window or a failed inventory still leaves the total unknown.
  A successful response without a general window records an explicit missing
  observation, immediately superseding that window's previous balance.
  A failed poll marks an account errored only once its latest sample is older than
  15 minutes (or it has none); one failed poll never hides a still-fresh sample.
  Recorded charts hold the last balance flat across a stretch with no reports at
  all (the point 1 ms before the next report; rates stay unknown). An account
  silent while others report (e.g. disabled for a while) never blanks the pool's recorded
  history: across a gap it later reports after, its share is estimated from its own readings —
  the straight line between them when both share a reset cycle (reset times within 1 minute) and
  the balance did not rise; otherwise its last reading held; or 100% once its cycle reset during
  the silence. An explicit missing observation, no reading yet, and the stretch after its last
  reading stay unknown. Current balances, rates and forecasts never use an estimate.
  Full collections are at least 4 minutes apart: Anthropic's usage endpoint returns 429
  to bursts. After a confirmed reset attempt, a targeted refresh may read only the
  affected account, at most once per 20 seconds with per-account single flight. The account
  is named by its stored id or by its source-qualified id (`<instance>:<provider>:<sha256>`),
  which a browser can build from a source and an auth index; both are one account, one flight.
  It uses the same validated source inventory without recording membership or
  retiring accounts, and serializes with full collection. Each failed poll logs
  status, retry-after seconds and header names.
  Disabled/retired accounts are excluded. A failed inventory cannot look like
  an empty healthy provider. History describes the current eligible membership;
  an account joins it at its first stored sample, so adding an account never
  turns the pool's earlier history unknown.
- Burn is measured depletion per hour within matching reset cycles, excluding
  increasing balances and intervals longer than 15 minutes. At least ten
  minutes of eligible observations within the selected lookback are required.
  Drain is signed net depletion, including observed replenishment.
- Forecasts require current samples, rates and future reset timestamps for
  every eligible account. The pool forecast models fill-first routing: the sum of
  the accounts' recent burn rates, scaled by the selected scenario, is drawn from
  one account at a time, the one with quota whose window resets soonest, moving
  on when it drains. Per-account "predicted empty" still uses that account's own
  rate. Resets repeat on the reported period, restoring 100 points per plan
  unit. No future activity spike is inferred. Actual providers can change
  windows and limits; these are scenarios.
- Recorded lines break across collection gaps. No history is backfilled or
  fabricated. Refresh does not consume usage queues, mutate auth or reset limits.
- Only authenticated requests receive results. Account names/emails are omitted
  unless explicitly requested; default labels and opaque IDs are sufficient.

Regression coverage lives in `tests/proxPoolDomain.test.ts` and the collector,
store and HTTP tests; `tests/proxQuotaSources.test.ts` covers source isolation and
transactional migration with synthetic data. Samples are private local data;
never log credentials, upstream bodies or account identifiers.

The combined chart shows one constant-height plot with a neutral combined Total line on a shared
0–100% capacity scale (paired with exact Total points on desktop) alongside a synchronized grid of
live provider capacity cards underneath. In Smart background mode, up to 4 providers also render as
quiet normalized background curves while 5+ providers condense into a translucent min–max spread
envelope; Ghost lines mode keeps quiet background lines at any provider count (persisted per
browser). Hovering or pinning any provider card spotlights its independent trace and reset ticks on
the shared scale without moving unrelated providers. Total recorded values reuse the account
history, plan weighting, expiry and gap rules above on a shared observation timeline. Forecast
totals add the independent piecewise-linear provider projections at every event, preserving both
sides of reset jumps. They never transfer demand between providers or extrapolate beyond a
provider's trace. Missing constituent values break only the Total line; healthy provider traces keep
drawing. A provider with no limit in the selected window (weekly-only Codex in the 5-hour view) adds
nothing and is left out of the total. Multiple eligible sources for the same provider still withhold
the total until allowance identity is proven and render independent source-qualified cards and
traces; disabled, retired and unresolved accounts add no capacity.

The server also exposes each provider's contribution and scheduled resets on the total's
exact history and forecast event timeline. Those layer traces contain no account metadata.
The browser renders these results without quota arithmetic: each provider plots its original
server-owned balance (normalized against its own capacity) or signed rate directly, and dormant
history-only layers stop at their recorded history without plotting forecast alignment zeros and are
excluded from projected spread bands. Signed drain plots Total and provider traces directly across
an explicit zero baseline in points/h.

Minimize controls shrink the plot only; the account roster is unchanged (a
behaviour change, user-approved 2026-11-05). Completion polling reads dashboard status every second
while collection is running, without requesting additional collections.

- Reset claims (`POST /v1/resets/claim`, `claims.ts`) are the server's source of truth for
  spending a Claude grant or a Codex credit. The server performs a claim only on an explicit
  authenticated user request, never on its own: no collection, refresh, sync or retry loop ever
  claims. Refresh itself still does not consume usage queues, mutate auth or reset limits; claims
  are the only write to providers. After a spent claim (Claude or Codex) the server also clears
  that credential's cooldown on its hub (`POST routing/cooldown/reset` with its auth index), so the
  proxy routes to it at once instead of waiting for its own probe; a still-limited account then
  costs the hub one 429, which restores the cooldown. `cooldownCleared` on the event records it.
  Each claim is recorded in `quota_reset_events` (opaque account id, provider,
  kind, grant/credit id, the client's request id, outcome, requested/settled times, and the
  readings just before and after: every usage window the collector held, Fable's
  `seven-day-fable` included, plus reset counts). Events are history: no pruning, no names, and an
  account purge leaves them. `GET /v1/resets/events` returns them without names or emails unless
  `reveal=true`, like `/v1/pools`.
- A claim resolves the account to its validated source and auth index as the collector does,
  sends through that source's management `/requests/api-call` with the instance key file, and
  reuses the shared `src/` claim and parse helpers (Claude reads the organization first). It is
  single flight per account, starts after a full collection in flight and holds the next one back,
  like a targeted refresh. The row is written as `pending` before anything is sent. The client
  request id is unique: a settled one replays its event and sends nothing. A claim that may have
  been sent and got no answer is `unknown`, never failed; the same request id may be sent again
  for ten minutes, checked again just before the send (providers deduplicate it), and only to the
  organization the first send was addressed to; it settles the one event only on a definite spend.
  A refusal on that retry stays `unknown`. A `pending` row left by a stopped process becomes
  `unknown` at startup. Anything refused before the send (eligibility, organization, status read)
  records no event. After every claim one targeted refresh reads the account, past the 20-second
  floor and never adopting a poll that started before the send, and its reading is the event's `after` (null when the refresh could not read).
- Per-account model-scoped windows (Fable) are exposed beside, never inside, the pool points:
  `/v1/pools` carries each account's latest `windows`. Usage (prox-usage) is not joined to claims.
  A "tokens since last reset" view is a documented follow-up that would come through prox-usage's
  existing `/v1/analytics` keyed by the event times, not through a second usage store here.
- Accounts read model (`GET /v1/accounts`, `accounts.ts`; contract in
  `src/domain/quotaPool/accounts.ts`): prox-history owns every number that feeds a lane or pool
  points for Claude and Codex accounts of the manifest sources, and pages read it instead of the
  hubs. Authenticated like `/v1/pools`; names and emails only with `reveal=true`. One entry per
  non-retired account, keyed by `id` and `sourceAccountId`, with `instanceId`, `provider`,
  `disabled`, `status` (`ok`, `stale` after 15 minutes, `error`, `disabled`), `observedAtMs`,
  `plan {label, known, type}`, `resets` and `billing` as `/v1/pools` has them, and `windows[]`
  (`id`, `lane` from `laneOf`, `labelKey`, `remainingPercent`, `resetAtMs`, `periodHours`): weekly
  is always its own lane, and every other limit (model-scoped, monthly, surface-scoped) its own.
  An entry also carries `noFiveHourLimit: true` when the no-five-hour-limit rule above holds
  (omitted otherwise); a card shows it as "No 5-hour limit".
  Claude entries also carry `extraUsage` and `dollarWindows` from the usage payload the collector
  already parses: memory-only like billing, never persisted, never pooled, never in `/v1/pools`;
  after a restart they are absent until the next reading. Codex entries likewise carry `credits`
  (`{balance, unlimited}`, read from the usage payload's `credits` by the same
  `normalizeCodexAccountCredits` the hub-direct adapter uses): memory-only, never persisted,
  pooled or in `/v1/pools`, absent after a restart until the next reading. After a restart the windows are the last
  stored weekly and five-hour sample until the collector reads again.
  A disabled account has `status: 'disabled'` and its last stored weekly/five-hour sample with that
  sample's time as `observedAtMs` (its age); the collector still never reads it, and a disabled
  account's memory-only readings are not served. The body holds nothing that depends on the
  request time, and the response `ETag` is a hash of the body; a matching `If-None-Match` is a
  304 (the same helper as `/v1/inventory`). The hash, `version`, is also the first field of the
  body (hashed over the rest), so a browser can ask again without access to the header.
- `POST /v1/refresh {accountId}` answers `{refreshed, retryAtMs}`. `retryAtMs` is the time the
  20 s per-account floor lets the next targeted read run, set only when that floor skipped this
  one, otherwise null. The page-wide refresh answers with the existing `nextRefreshAtMs` (the
  4 minute floor).
- Billing readings and ChatGPT account IDs are memory-only. Never persist or log the provider account ID or send it to the browser. Codex subscription attempts are gated per account for six hours, including failures and targeted refreshes. Claude profile attempts (which also carry the plan) are gated per account for 30 minutes, including failures; a targeted refresh re-reads after 5 minutes. Claude reads once after restart even with a fresh stored plan. Billing failures preserve the previous reading.
