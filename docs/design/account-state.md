# Account state: one owner per fact

**Status:** accepted 2026-11-24. The migration is in progress; see [Migration](#migration). This design extends [credential-inventory.md](credential-inventory.md), which defines one versioned inventory read model and one client store, and [AUTO-DISCOVERY-ROADMAP.md](../AUTO-DISCOVERY-ROADMAP.md), under which the hub catalog declares providers. Where they disagree with this document, this one wins.

## Why

The same change to an account kept reaching one screen and missing the others.

**A credential whose refresh token the provider rejected:**
- Auth Files said "Sign-in expired" at once.
- The quota row said it 15–20 minutes later, and only because one component fetched the hub list itself (PR #131).
- The per-credential quota panel on Auth Files and `/quota/accounts` never said it. It kept showing "Refresh failed".

**Gemini** stayed on Quota Management after its hub was removed.

An audit on 2026-11-24 found these causes:

1. **Each screen worked the state out again, from its own copy and on its own clock.** The sign-in rule was a regex over `status_message`, copied into the Auth Files helpers, the refresh toast and the collector.
2. **The change signal could not see a state change.** `inventoryVersion` hashed only `[instanceId, provider, accountId, disabled]`.
3. **The server computed read status three times, from different inputs:** `buildAccounts`, `buildPool`, and `discoveredProviders` (which reads collector memory).
4. **Provider and source sets were hardcoded or rebuilt from stored rows.** `buildDashboard` rebuilds a scope for any instance that still has stored accounts, falls back to the hardcoded `QUOTA_PROVIDERS`, and nothing ever retires an account whose source is gone.
5. **The rules were written down but not enforced.** Source-contract tests covered a named list of screens, and PoolCard was not on it.

## The rule

> Every fact has exactly one owner, which computes it once. Prox serves it from one read model. The browser holds one copy, and one component turns it into words. Below the point where Prox parses a backend answer, nothing computes the fact again, and no component fetches or forces a refresh of it.

## Owners

| Fact | Owner (computes it) | Served by | Browser copy | Consumers |
|---|---|---|---|---|
| Source membership (which hubs exist) | the effective manifest (`PROX_SOURCE_MANIFEST` → `/run/prox-sources/effective-manifest.json`, from `deploy/provider-sources.json` + `instances.json`) | nginx `/prox/sources` discovery (browser); the collector reads the same file | `useProviderSources` registry | every screen that lists sources: Auth Files, `/quota/accounts`, `/quota`, Models, OAuth |
| Provider membership within a source | the existing collector contract (`sourceCatalogEntries`, `server/quota/collector.ts`), with no hardcoded fallback | `/v1/inventory` `sources[]` | inventory store `sources` | quota chips, pools, served routing |
| Credential exists, disabled | Hub credential list | hub `/credentials`, `/v1/inventory` | `useCredentialInventoryStore` files | all credential screens |
| **Sign-in required** (latched) | prox-history collector, from hub evidence (see below) | `signInRequired` on `/v1/inventory`, `/v1/accounts`, `/v1/pools` (pooled and unpooled) | inventory store, joined to files by `sourceAccountId`; pool accounts; `sourceQuotaStore` | `AccountStateNotice`, `credentialHealth` |
| Credential health: active, problem, disabled | `credentialHealth()` (`src/features/authFiles/credentialFacts.ts`), from hub `disabled` and status text plus the latched `signInRequired` | n/a | derived on read; never stored | Auth Files filters, Dashboard counts, Models matrix |
| Cooldown, rate limit, status text | Hub | hub credential list only | inventory store files | Auth Files card |
| Provider lifecycle (`needs_attention`) | Hub catalog | `/v1/inventory` catalog | inventory store | provider-level UI only, never a per-account notice |
| Read status: `ok`, `stale`, `error`, `disabled`, plus `no-reader` for unpooled | `readStatus()` in `server/quota/accountState.ts` | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore(owner)`, pool slot | `AccountStateNotice` |
| Pool-window refinements: `no-limit`, `missing-window` | `domain.ts`, on top of `readStatus` | `/v1/pools` | pool slot | `PoolCard` |
| No five-hour limit, plan, account label | `accountState.ts` | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore`, pool slot | provider bodies, `PoolCard` |
| Quota numbers, resets, billing | prox-history for served sources, the hub otherwise (`src/features/quota/RULES.md`) | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore(owner)` | provider bodies, `PoolCard` |
| Which providers can claim resets | prox-history reset support (Claude and Codex, `store.ts` CHECK, `claims.ts`) | `/v1/accounts` resets | `sourceQuotaStore` | reset panel |

Every fact on this page needs a row in this table. A fact without a row has no owner yet: add the row before you add code.

## Sign-in required: latched by prox-history

### What the hub tells us, and what it forgets

- `requires_sign_in` is sent on every v8 credential (`ProxD auth_files.go:834`), but it lives only in hub memory (`types.go:133`, `json:"-"`).
- On a terminal grant rejection the hub sets `Status=error`, `Unavailable=true` and the status message `unauthorized (refresh token invalid)` (`conductor_refresh.go:1607-1620`). None of these is written to the credential file.
- After a hub restart, a file-backed credential loads as `active` unless it is disabled (`internal/watcher/synthesizer/file.go:263`). The hub then reports it healthy until its next refresh attempt fails again, which can be hours away.
- `last_refresh` is written to the credential file on every successful refresh and on a new sign-in. It survives restarts.

### The rule

`signIn.ts` (`src/domain/accountState/signIn.ts`, imported by the server) holds two pure functions:

- `hubReportsSignIn(entry)`: `!disabled && (requires_sign_in || (status is error or unavailable && message matches /refresh token (invalid|expired)|invalid_grant/))`. This is the only copy of the pattern.
- `nextSignInLatch(previousLatchAtMs, entry, nowMs)` returns the new latch time, or null when the latch is cleared:
  - When the hub reports sign-in, it keeps the previous latch time, or uses `nowMs` if there was none.
  - When the hub does not report sign-in, it keeps the latch unless the entry's `last_refresh` is later than the latch time. That is a confirmed recovery: a successful refresh or a new sign-in.
  - A disabled credential clears the latch. `disabled` stays the one copy of that fact.

The collector calls `nextSignInLatch` for every account on every inventory read. It stores the result in `quota_accounts.signInRequiredAtMs`, in the same upsert as `disabled`.

**Why a successful quota read does not clear it:** an access token keeps working for hours after its refresh token is rejected. In the 2026-11-24 incident, reads succeeded from 04:49 to 08:49 UTC while the sign-in was already dead.

The latch does not depend on read status. The 15-minute freshness rule never delays telling the user to sign in.

### Who reads it

- **The browser does not compute sign-in.** It reads `signInRequired` from `/v1/inventory` and joins it to hub files by `sourceAccountId`.
- **Standalone hubs** (a hub with no prox-history source) are the one exception: their files have no server latch, so the browser falls back to `hubReportsSignIn` on the hub entry, through the same function.
- **The manual-refresh toast** reports the result of that one refresh. It may use `hubReportsSignIn`'s message check, imported from `signIn.ts`, to say "sign in again" instead of raw JSON. It is not account state and does not use `AccountStateNotice`.

## The change signal

`GET /v1/inventory` returns one body: sources, the provider set, catalog metadata (display name, logo, reader, lifecycle, availability), and accounts (`disabled`, `signInRequired`).

- Its version is a truncated sha256 of that whole body, minus timestamps that change on every read, the way `accountsVersion` hashes `/v1/accounts`. Any field the browser uses therefore changes the version. A metadata-only change cannot return 304.
- The body never includes names or emails.

The browser polls `/v1/inventory` every 5 seconds. On a new version it re-reads the hub lists, the pool and the served accounts in one commit.

**Inventory changes and quota-reading updates take different paths:**

- **Inventory changes** (a credential added, removed, disabled or needing sign-in; a source or provider added or removed) reach every screen through the version. An action in Prox (add, remove, edit) also calls `notifyAuthFilesChanged`, which runs `commitChange`, so it does not wait for the poll.
- **Quota-reading updates** (numbers, read status, resets, billing) reach screens through the served-accounts store and the pool resource.
  - An action (refresh, reset, claim) calls `src/features/quotaPool/accountSync.ts`. Until step 6 that is `refreshPoolAccountAfterReset`; after step 6 it is `refreshAccountEverywhere`.
  - Collection cycles reach screens through those stores' own polls.

## Read status: one rule on the server

`readStatus(account, newestSample, nowMs)` in `server/quota/accountState.ts` keeps today's `/v1/accounts` rule (`accounts.ts:112-122`), written once. In order:

1. `disabled` when the account is disabled.
2. `error` when `lastErrorAtMs` is set and either:
   - there is no sample; or
   - `lastErrorAtMs >= newestSample.observedAtMs` and that sample is more than 15 minutes old. An error at the same instant as the sample counts as newer.
3. `stale` when:
   - there is no sample and no error (the first read is still pending); or
   - the newest sample is more than 15 minutes old; or
   - the inventory last saw the account (`lastSeenAtMs`) more than 15 minutes ago.
4. `ok` otherwise.

`newestSample` is the newest stored sample across windows, never collector memory, so a restart changes nothing.

Pools apply refinements for the selected window on top, in `domain.ts`:

- `no-limit` when the provider reports no such limit;
- `missing-window` when the selected window has no usable sample, even if another window is fresh;
- `stale` when the selected window's sample has expired.

Unpooled cards add `no-reader`.

The browser keeps `error` and `stale` apart for every provider, Codex included.

## Sources and providers are discovered

- **Source membership is the effective manifest.**
  - Prox-history reads it directly.
  - The browser registry is the browser's copy, through `/prox/sources`. No other list of sources may exist.
  - A source the manifest drops disappears from every server read model on the next validated revision, without a restart. The collector stops reading it and aborts in-flight polls.
  - The browser registry drops it on its next discovery poll. Step 5 makes every screen follow the registry and clears that source's cached state.
  - A manifest that fails validation changes nothing.
- **If the source the browser logged in through is dropped,** the registry keeps that session's binding until the user logs in again, as it does today (`src/services/providerSources/registry.ts`). Other screens stop listing the source. Step 5 adds a banner that says so.
- **Provider membership within a source follows the existing collector contract** (`sourceCatalogEntries`, `collector.ts:130-145`):
  - every provider that has a credential, under its runtime provider id, even when the hub stops advertising a reader for it;
  - plus a waiting provider that Auth Files also shows and that can be signed in to (the Connect card).

  Removing the hardcoded fallback does not narrow this. `tests/proxOpenProviders.test.ts:396` and `:549` keep passing.
- **A reader is an attribute, not a membership test.** `reader: builtin | plugin | none` says whether prox-history can read quota for that entry. The built-in reader list names only the readers prox-history ships, Claude and Codex. Reading Google's quota is barred (`docs/PROX-SETUP.md`), so the Antigravity reader and the hub-direct Antigravity card are deleted.
- **History of a dropped source is kept.**
  - Its accounts stay unretired.
  - `prune()` skips the samples of accounts whose source is not in the current manifest; the 30-day prune applies only to live sources.
  - Re-adding the source shows its history again.

## Rendering

`AccountStateNotice` (`src/components/accountState/AccountStateNotice.tsx`) is the only component that turns `signInRequired` and read status into words, and the only user of the `account_state.*` i18n keys. Every screen that shows an account uses it:

- `AuthFileCard`;
- `AuthFileQuotaSection`;
- `QuotaCard` (`/quota/accounts`);
- `PoolCard`;
- `DiscoveredQuota`;
- `PoolAccountResets`.

For sign-in it shows the "Sign in again" link to `oauthPath(instanceId)`, and the reset panel shows the notice instead of a reset. Credential health counts a latched sign-in as a problem, so filters and Dashboard agree with the notice.

## How we work on account state

These steps apply to every change that touches an account, a credential, a source or a provider.

1. **Find every surface first.** Grep the UI for the fact's words and field names (for example `Sign-in`, `Refresh failed`, `unavailable`, the provider or source id) and list every screen and endpoint that shows it. If you find more than one place that computes it, the first commit moves it to its owner.
2. **Change the owner, not a screen.** A fix that touches only one component is wrong by construction unless the fact is genuinely screen-local.
3. **Ask what the backend forgets.** Hub state that lives only in memory (here `requires_sign_in`, `Status`, `StatusMessage`) resets on restart. Say what survives and latch or persist what must.
4. **Make the rule executable.** Add a behaviour test at the owner. Extend the scans below rather than adding to an allow-list. Any allow-list entry carries a one-line reason.
5. **Verify before deploy, then on the deploy.**
   - In the PR: tests and a build served against the live hubs, on every surface that shows the fact.
   - After the operator approves the deploy (a "full send" request is that approval for its PR): Auth Files, `/quota/accounts` and `/quota` show the same account state within one poll.
   - For server changes, read the SQLite row with `?mode=ro`. Never print keys or auth file contents.
6. **Change docs in the same PR.** When a rule, a source or a provider changes, update `AGENTS.md`, `server/quota/RULES.md`, `src/features/quota/RULES.md`, `README.md` and `docs/PROX-SETUP.md` together.

The checklist in `AGENTS.md` (§ Account State and Providers) is the short form.

## Enforcement

Each test lands with the migration step that makes it pass. None lands red.

| Test | Lands in | Checks |
|---|---|---|
| `tests/accountSignIn.test.ts` | 1 | `hubReportsSignIn` table test: the flag with message "disabled"; the flag with a blank message; no flag but the hub's error message; disabled wins; a cooldown is not sign-in. `nextSignInLatch`: set; kept after the hub forgets (restart: active, no message); kept after a successful quota read; cleared when `last_refresh` passes the latch; cleared by disable. |
| Collector, store and HTTP behaviour (`tests/proxCollector.test.ts`, `tests/proxQuotaDashboard.test.ts`) | 1 | An inventory read with the flag sets `signInRequiredAtMs` with no failed poll. A restarted hub (active, empty message, same `last_refresh`) keeps it. A newer `last_refresh` clears it. The inventory version changes on each. `/v1/accounts` and `/v1/pools` show `signInRequired` with a 1-minute-old sample. |
| `tests/accountStateContract.test.ts` | 1 (server scope), then extended in 2 and 3 | **1:** the pattern only in `signIn.ts`; `nextSignInLatch(` only in the collector; no `errorReason` or `lastErrorReason`. **2:** the same over `src/` (the toast may import `hubReportsSignIn`). **3:** `.lastErrorAtMs` read only in `accountState.ts` and `store.ts`. |
| `tests/accountStateScreens.test.ts` | 2 | Scans all of `src/features/**` and `src/components/**`: no raw hub field names, `account_state.` only in `AccountStateNotice`. Renders `AuthFileCard`, `AuthFileQuotaSection`, `QuotaCard`, `PoolCard` and `PoolAccountResets` from one fixture and checks the same sentence and the `oauthPath` link. `credentialHealth` counts a latched sign-in as a problem. |
| `tests/accountReadStatus.test.ts` | 3 | `readStatus` table test: no sample with and without a failure; a failure at the same instant as the sample; a failure older than a fresh sample; old inventory sighting. Pool refinement: an expired selected window beside a fresh sample in another window. An agreement test: `/v1/accounts`, `/v1/pools` and unpooled agree on core status and no-five-hour-limit from one store fixture. Unpooled reads stored samples after a simulated restart. |
| `tests/proxProviderSet.test.ts` | 4 | A source missing from the manifest shows on no pool, combined band, inventory source or account list, while its samples remain. After advancing the clock past 30 days and running `prune()`, its samples still exist, and re-adding the source shows them. Dropping a source takes effect without a restart. An invalid revision changes nothing. `tests/proxOpenProviders.test.ts:396` and `:549` still pass. It replaces the PR #129 tests in `tests/proxGeminiPool.test.ts`. |
| Inventory version (`tests/proxInventoryLifecycle.test.ts`) | 4 | A change to only display name, logo, reader, lifecycle or availability changes the version (no 304). |
| `tests/providerLiterals.test.ts` | 4 (server read models), then 5 (`src/features/quotaPool`, `src/stores`, quota API modules) | No `'claude'`, `'codex'` or `'antigravity'` literals outside a file-to-reason allow-list: readers, plans, reset claims and presentation. A docs check: every provider named as live in `server/quota/RULES.md` and `README.md` is in the manifest. |
| Source membership in the browser | 5 | Dropping a source from discovery removes it from Auth Files, `/quota/accounts`, `/quota`, Models and OAuth and clears its cached state. Dropping the login binding keeps the session, hides the source elsewhere and shows the banner. Standalone hub access is unchanged. |
| `tests/accountPropagation.test.ts` | 6 | One commit reaches file lists, pool and served accounts once. Refresh, reset and claim go through `accountSync`. There is one timer per store. No component calls a store's `refresh()` from an effect, except an allow-list with reasons (`QuotaPage`, `useAuthFilesData`, `useModelAccessInventory`, `MainLayout`), reconciled with `tests/credentialInventoryScreens.test.ts`. |

## Migration

Six steps, each its own PR. Each PR is verified before deploy, deployed only with operator approval (`AUTO-DISCOVERY-ROADMAP.md` deploy gate; "full send" is that approval for its PR), and verified live before the next step starts.

| # | Step | Replaces |
|---|---|---|
| 1 | **Sign-in latch on the server and on the wire.** `signIn.ts` and the `quota_accounts.signInRequiredAtMs` column. The column needs a guarded `ALTER`, plus `QUOTA_ACCOUNT_COLUMNS` and `quotaAccountsTableSql`, so the widening rebuild keeps it. The collector latch; `signInRequired` on `/v1/inventory`, `/v1/accounts` and `/v1/pools`; PoolCard reads it. Take a `VACUUM INTO` backup before deploying. | The undeployed `lastErrorReason` / `errorReason` work and the collector's memory set. |
| 2 | **The browser reads the latch; one notice.** The inventory store joins `signInRequired` to files. `AccountStateNotice` is used on the six screens. `credentialHealth` counts the latch. The toast uses `hubReportsSignIn`. The `account_state.*` keys replace `auth_files.status_signin_expired`, `quota_pool.signin_expired*` and `quota_pool.signin_again`. | The regex in `constants.ts`, the screen-specific sentences, and the hub-direct sign-in check for served sources. |
| 3 | **One read-status rule.** `server/quota/accountState.ts`. Unpooled cards read stored samples. The client keeps `error` distinct from `stale`, Codex included. | Three status derivations and three no-five-hour-limit rules. |
| 4 | **Sources and providers on the server.** Scopes come only from the manifest. A dropped source leaves at once, and its rows and samples are kept and exempt from pruning. The inventory version covers the whole body. The Antigravity reader is deleted. `server/quota/RULES.md`, `README.md`, `docs/PROX-SETUP.md` and `AUTO-DISCOVERY-ROADMAP.md` are updated. | Stored-account scopes, the `QUOTA_PROVIDERS` fallback, constant combined keys, and the PR #129 rule that kept removed sources visible. |
| 5 | **Sources and providers in the browser.** `readVersion` returns the body. Served routing, chips, skeletons and logos read it. Every screen follows the registry, with cache cleanup and the login-binding banner. The hub-direct Antigravity card and `antigravitySubscription.ts` are deleted. The AGENTS.md served-routing rule is rewritten. | Claude/Codex literals in stores, quota APIs and `viewState`. |
| 6 | **One propagation path.** The served-accounts store follows inventory commits, with one app-wide timer. `refreshAccountEverywhere` replaces `refreshPoolAccountAfterReset`. `AGENTS.md` and `src/features/quota/RULES.md` are updated. | Per-holder timers and the duplicate `/prox/refresh` wrapper. |
