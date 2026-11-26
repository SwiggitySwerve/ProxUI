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

> Every fact has exactly one owner, which computes it once. ProxUI serves it from one read model. The browser holds one copy, and one component turns it into words. Below the point where ProxUI parses a backend answer, nothing computes the fact again, and no component fetches or forces a refresh of it.

## Owners

| Fact | Owner (computes it) | Served by | Browser copy | Consumers |
|---|---|---|---|---|
| Source membership (which hubs exist) | the effective manifest (`PROX_SOURCE_MANIFEST` → `/run/prox-sources/effective-manifest.json`, from `deploy/provider-sources.json` + `instances.json`) | `/prox/sources.json` (discovery, polled by the browser registry every 60 s); the collector reads the same file | `useProviderSources` registry | every screen that lists sources: Auth Files, `/quota/accounts`, `/quota`, Models, OAuth |
| Local `agy` snapshot source (Gemini pool only; never a ProxD hub or credential) | `server/quota/agySnapshot.ts` reading `PROX_AGY_SNAPSHOT_PATH` (`/data/agy-usage.json`, dropped by the host's official `agy -p "/usage"` helper); auto-disables after 30 min without a fresh snapshot | `/v1/pools` only (never `/prox/sources.json`, `/v1/inventory`, or `/v1/accounts`) | pool slot | `PoolCard` (`/quota`) |
| Provider membership within a source | the union of live credentials' runtime provider ids and the eligible Connect entries (see below), with no hardcoded fallback | `/v1/inventory` `sources[]` | inventory store `sources` | quota chips, pools, served routing |
| Credential exists, disabled | Hub credential list | hub `/credentials`, `/v1/inventory` | `useCredentialInventoryStore` files | all credential screens |
| **Sign-in required** | Hub: `requires_sign_in`, persisted in the credential file (migration step 0) | hub credential list; `signInRequired` on `/v1/inventory`, `/v1/accounts`, `/v1/pools` (pooled and unpooled), copied by the collector | inventory store files; pool accounts; `sourceQuotaStore` | `AccountStateNotice`, `credentialHealth` |
| Credential health: active, problem, disabled | `credentialHealth()` (`src/features/authFiles/credentialFacts.ts`), from hub `disabled`, `requires_sign_in` and status text | n/a | derived on read; never stored | Auth Files filters, Dashboard counts, Models matrix |
| Cooldown, rate limit, status text | Hub | hub credential list only | inventory store files | Auth Files card |
| Provider lifecycle (`needs_attention`) | Hub catalog | `/v1/inventory` catalog | inventory store | provider-level UI only, never a per-account notice |
| Read status, with refinements `no-reader`, `no-limit`, `missing-window` in one precedence order | `readStatus()` in `server/quota/accountState.ts` | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore(owner)`, pool slot | `AccountStateNotice` |
| Pool-window refinements: `no-limit`, `missing-window`, stale selected window | `accountState.ts` (the same precedence function); `domain.ts` only supplies the selected window's sample | `/v1/pools` | pool slot | `PoolCard` |
| No five-hour limit, plan, account label | `accountState.ts` | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore`, pool slot | provider bodies, `PoolCard` |
| Quota numbers, resets, billing | prox-history for served sources, the hub otherwise (`src/features/quota/RULES.md`) | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore(owner)` | provider bodies, `PoolCard` |
| Which providers can claim resets | prox-history reset support (Claude and Codex, `store.ts` CHECK, `claims.ts`) | `/v1/accounts` resets | `sourceQuotaStore` | reset panel |

Every fact on this page needs a row in this table. A fact without a row has no owner yet: add the row before you add code.

## Sign-in required: the hub keeps it, ProxUI copies it

### What the hub forgets today

- `requires_sign_in` is sent on every v8 credential (`ProxD auth_files.go:834`), but it lives only in hub memory (`types.go:133`, `json:"-"`). On a terminal grant rejection the hub also sets `Status=error`, `Unavailable=true` and `unauthorized (refresh token invalid)` (`conductor_refresh.go:1607-1620`). None of this is written to the credential file.
- After a hub restart a file-backed credential loads as `active` unless it is disabled (`internal/watcher/synthesizer/file.go:263`). It looks healthy until its next refresh fails, which can be hours away.
- No persisted field reliably marks recovery. `last_refresh` is runtime `LastRefreshedAt`, which file loading leaves unset and a file replacement can carry over (`auth_files.go:751`, `conductor_lifecycle.go:494`). After a same-file sign-in on 2026-11-24 the hub still reported the old `last_refresh`.

Guessing around that in ProxUI (a regex over messages, or a latch with an unreliable clear signal) is how the drift started. The owner has to stop forgetting.

### The rule (migration step 0, in ProxD)

The hub already decides sign-in correctly while it runs, including the per-grant rules: a Codex credential can refresh one grant successfully while another stays rejected (`conductor_unauthorized_refresh_test.go:1488`). Step 0 only makes that decision survive a restart. It does not change it.

- **Persist the inputs.** The hub writes the sanitized renewal state that its in-memory rule depends on into the credential's metadata, and saves the file the same way it persists `disabled` (`sdk/cliproxy/auth/codex_persist.go`). That state is:
  - the sign-in flag;
  - the per-grant rejection markers;
  - the terminal refresh error code, so a later transient failure cannot replace it;
  - the access-token rejection markers that make the hub skip an unexpired token that already returned 401 (`types.go:1365`).

  It never persists token values or raw upstream bodies.
- **Restore exactly that.** File synthesis restores `RequiresSignIn` and that state.
  - It does not restore an error status or `Unavailable`. Whether the credential can serve stays the hub's existing access-token eligibility rule: a credential whose refresh was rejected but whose access token still works keeps serving after a restart, as it does today (`conductor_unauthorized_refresh_test.go:894`).
- **Clear on the hub's own recovery rule.** The flag is cleared, and the file saved, only when the hub's existing logic clears it in memory: the rejected grant refreshes, or there is a new sign-in.
- The hub's `requires_sign_in` output then means the same thing before and after a restart.

### In ProxUI

- **ProxUI copies `requires_sign_in`; it never infers sign-in from status text.**
  - The collector stores it as `quota_accounts.signInRequired` in the same upsert as `disabled`, on every inventory read. It does not wait for a failed poll, and it does not keep it in memory.
  - The browser reads the same field from the hub list it already holds, in the auth-file normaliser (`src/services/api/authFiles.ts`), as `file.signInRequired`.
  - Both copies come from one owner through one field.
- **Disabled wins.** A disabled credential is never shown as needing sign-in.
- **Sign-in does not depend on read status.** The 15-minute freshness rule never delays telling the user to sign in.
- **The manual-refresh toast reports that one operation.** After a failed refresh the store re-reads the hub list. If the refreshed file has `signInRequired`, the toast says to sign in again; otherwise it shows the hub's error. It is not account state and does not use `AccountStateNotice`.

## The change signal

`GET /v1/inventory` returns sources, the provider set, catalog metadata (display name, logo, reader, lifecycle, availability), and accounts (`disabled`, `signInRequired`). Its version is computed once and reused by `/v1/pools` (`inventoryVersion` in its body):

- **From step 1:** the version tuple is `[instanceId, provider, accountId, disabled, signInRequired]`. A sign-in set or cleared changes it; a hub restart does not, because the hub no longer forgets.
- **From step 4:** the version is a truncated sha256 of the whole served body, minus timestamps that change on every read, the way `accountsVersion` hashes `/v1/accounts`. Any field the browser uses then changes it, and a metadata-only change cannot return 304.
- The body never includes names or emails.

There are three kinds of change, and each has one path:

- **Inventory changes** (a credential added, removed, disabled or needing sign-in; a provider added or removed within a source) reach every screen through the `/v1/inventory` version. The browser polls it every 5 seconds and re-reads the hub lists, the pool and the served accounts in one commit. An action in ProxUI (add, remove, edit) also calls `notifyAuthFilesChanged`, which runs `commitChange`.
- **Source membership changes** (a hub added to or dropped from the manifest) reach the browser through `/prox/sources.json`, which the registry polls every 60 seconds. Every screen follows the registry; see below.
- **Quota-reading updates** (numbers, read status, resets, billing) reach screens through the served-accounts store and the pool resource. An action (refresh, reset, claim) calls `src/features/quotaPool/accountSync.ts`: `refreshPoolAccountAfterReset` until step 6, `refreshAccountEverywhere` after it. Collection cycles reach screens through those stores' own polls.

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

`accountState.ts` also owns the refinements: one function takes the core inputs plus, for pools, the selected window's newest sample, and returns the final status. `domain.ts` and the unpooled builder pass inputs; they decide nothing. The precedence:

1. `disabled` always wins.
2. `no-reader` (unpooled only): prox-history has no reader for the provider.
3. The core `error`.
4. Pool only, for the selected window:
   - **The pool profile deliberately leaves the window unmapped** (a plugin profile with no mapping for it): `no-limit`, and the account is not eligible for pool totals, as today (`domain.ts:390-393`). `domain.ts` passes the mapping state in.
   - **No row at all** gives `missing-window`.
   - **A row whose value is null** gives `no-limit` when the account's no-five-hour-limit rule covers that window, and `missing-window` otherwise. The collector writes such a row whenever an answer omitted the window (`collector.ts:388-398`).
   - **A row with a value but expired** gives `stale`, even if another window is fresh.
5. The core `stale`.
6. `ok`.

So a disabled account without a reader is `disabled`, and an expired selected window is `stale`, never `missing-window`.

Unpooled cards need a stored reading to apply this. From step 3 the collector stores the latest successful unpooled reading per account (one row, replaced on each read), kept out of pool history and totals.

The browser keeps `error` and `stale` apart for every provider, Codex included.

## Sources and providers are discovered

### Source membership: the effective manifest

- prox-history reads the effective manifest directly. The browser registry is its only client copy, through `/prox/sources.json`. No other list of sources may exist.
- **A source the manifest drops:**
  - It disappears from every server read model on the next validated revision, without a restart. The collector stops reading it and aborts in-flight polls.
  - nginx removes its `/prox/` routes.
  - The browser registry drops it on its next discovery poll. From step 5 every screen follows the registry and clears that source's cached state.
- A manifest that fails validation changes nothing.
- **Dropping the source the browser logged in through.**
  - Today the registry rejects that whole discovery revision (`src/services/providerSources/registry.ts:119`), and its routes are gone anyway (`server/providerSources/routing.ts:23`).
  - From step 5 the registry accepts the revision. It ends that session with a message naming the removed source, and the user signs in through a live source.
  - A dropped source's history is not reachable through its own routes; it is hidden until the source returns.

### Provider membership within a live source

Provider membership is the union of:

- the runtime provider id of every live credential the hub lists, even when the hub's catalog omits that provider or stops advertising its reader;
- the catalog entries that Auth Files also shows as waiting and that can be signed in to: the Connect card (`sourceCatalogEntries`, `server/quota/collector.ts:130-145`).

Its `reader` is what the catalog advertises, limited to readers prox-history actually runs:

- a `plugin` reader (the hub's `quota/fetch`) as advertised;
- a `builtin` reader only if prox-history ships it (Claude and Codex);
- otherwise, or when the catalog omits the provider, `none`.

So the hub's `builtin` Antigravity reader becomes `none` in ProxUI. This is decided in `providerSet` (step 4), and the collector reads quota only for entries whose reader is not `none`. A catalogued provider keeps its reader once its first credential arrives and it leaves the waiting set.

### A reader is an attribute, not a membership test

`reader: builtin | plugin | none` says whether prox-history can read quota for that entry. The built-in reader list names only the readers prox-history ships, Claude and Codex. Reading Google's quota is barred (`docs/PROX-SETUP.md`), so the Antigravity reader and the hub-direct Antigravity card are deleted.

### History of a dropped source

- Its accounts stay unretired.
- While the source is dropped, `prune()` skips their samples.
- When the source returns, its accounts rejoin the normal 30-day retention like every live source. Samples within a chart's queried range show again: the default chart starts 3 days before today (`domain.ts:569`), and earlier days are reached by moving the range back.

## Rendering

`AccountStateNotice` (`src/components/accountState/AccountStateNotice.tsx`) is the only component that turns `signInRequired` and read status into words, and the only user of the `account_state.*` i18n keys. Every screen that shows an account uses it:

- `AuthFileCard`;
- `AuthFileQuotaSection`;
- `QuotaCard` (`/quota/accounts`);
- `PoolCard`;
- `DiscoveredQuota`;
- `PoolAccountResets`.

For sign-in it shows the "Sign in again" link to `oauthPath(instanceId)`, and the reset panel shows the notice instead of a reset. Credential health counts sign-in as a problem, so filters and Dashboard agree with the notice.

## How we work on account state

These steps apply to every change that touches an account, a credential, a source or a provider.

1. **Find every surface first.** Grep the UI for the fact's words and field names (for example `Sign-in`, `Refresh failed`, `unavailable`, the provider or source id) and list every screen and endpoint that shows it. If you find more than one place that computes it, the first commit moves it to its owner.
2. **Change the owner, not a screen.** A fix that touches only one component is wrong by construction unless the fact is genuinely screen-local.
3. **Ask what the backend forgets.** Hub state that lives only in memory (here `requires_sign_in`, `Status`, `StatusMessage`) resets on restart. Make the owner persist what must survive; do not rebuild it downstream from guesses.
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
| ProxD: `requires_sign_in` persistence | 0 | The existing regression tests pass unchanged and again with a restart inserted at each step, including their `RefreshError` assertions: a partial Codex refresh keeps the flag (`conductor_unauthorized_refresh_test.go:1488`, `:1529`), and a rejected refresh with a working access token keeps serving (`:894`, `:904`). A new test: an unexpired access token that already returned 401 is still skipped after a restart, while `Status` and `Unavailable` are not persisted. A terminal rejection writes the metadata; a restart restores the flag and markers but no error status. The hub's own recovery clears it. A same-file OAuth sign-in clears it, and stays cleared after a restart. |
| Collector, store and HTTP behaviour (`tests/proxCollector.test.ts`, `tests/proxQuotaDashboard.test.ts`) | 1 | An inventory read with `requires_sign_in` stores `signInRequired` with no failed poll; a read without it clears it; disabled wins. The inventory version (and the pool's `inventoryVersion`) changes on set and on clear, and not on an identical re-read. `/v1/accounts`, `/v1/pools` and unpooled cards show `signInRequired` beside status `ok`. |
| `tests/accountStateContract.test.ts` | 1 (server scope), then extended in 2 and 3 | **1:** no sign-in text pattern (`refresh token`, `invalid_grant`) anywhere in `server/`; no `errorReason` or `lastErrorReason`. **2:** the same over `src/`. **3:** `.lastErrorAtMs` read only in `accountState.ts` and `store.ts`. |
| `tests/accountStateScreens.test.ts` | 2 | Scans all of `src/features/**` and `src/components/**`: no raw hub field names, `account_state.` only in `AccountStateNotice`. Renders `AuthFileCard`, `AuthFileQuotaSection`, `QuotaCard`, `PoolCard` and `PoolAccountResets` from one fixture and checks the same sentence and the `oauthPath` link. `credentialHealth` counts sign-in as a problem. The refresh toast says to sign in again when the re-read file has `signInRequired`. |
| `tests/accountReadStatus.test.ts` | 3 | An unmapped profile window gives `no-limit` and leaves the eligible count unchanged. A `readStatus` table test: no sample with and without a failure; a failure at the same instant as the sample; a failure older than a fresh sample; an old inventory sighting. The precedence overlaps: disabled with no reader; an expired selected window beside a fresh other window; no sample at all for the selected window. An agreement test: `/v1/accounts`, `/v1/pools` and unpooled agree on the core status from one store fixture. Unpooled collection with no pool profile stores the latest reading, which survives a restart and never enters pool totals. |
| `tests/proxProviderSet.test.ts` | 4 | A source missing from the manifest shows on no pool, combined band, inventory source or account list. After a long absence (the clock advanced more than 30 days, then `prune()`), its samples still exist. After a short absence (re-added within the chart range, then one collection cycle), a sample from before the drop that falls in the queried range shows on the chart. Dropping a source takes effect without a restart. An invalid revision changes nothing. A runtime provider the catalog omits stays in `/v1/inventory` with `reader: none`. A catalogued provider keeps its advertised reader after its first credential arrives. An Antigravity credential, advertised `builtin` by the hub, gets `reader: none` and triggers no quota read. A Connect entry still appears for a hub with no credentials. It replaces the PR #129 tests in `tests/proxGeminiPool.test.ts`. |
| Inventory version (`tests/proxInventoryLifecycle.test.ts`) | 4 | A change to only display name, logo, reader, lifecycle or availability changes the version (no 304). |
| `tests/providerLiterals.test.ts` | 4 (server read models), then 5 (`src/features/quotaPool`, `src/stores`, quota API modules) | No `'claude'`, `'codex'` or `'antigravity'` literals outside a file-to-reason allow-list: readers, plans, reset claims and presentation. A docs check: every provider named as live in `server/quota/RULES.md` and `README.md` is in the manifest. |
| Source membership in the browser | 5 | With a real discovery and routing update: dropping a source removes it from Auth Files, `/quota/accounts`, `/quota`, Models and OAuth and clears its cached state. Dropping the login binding ends that session with the message. Standalone hub access is unchanged. |
| `tests/accountPropagation.test.ts` | 6 | One commit reaches file lists, pool and served accounts once. Refresh, reset and claim go through `accountSync`. There is one timer per store. No component calls a store's `refresh()` from an effect, except an allow-list with reasons (`QuotaPage`, `useAuthFilesData`, `useModelAccessInventory`, `MainLayout`), reconciled with `tests/credentialInventoryScreens.test.ts`. |

## Migration

Seven steps, each its own PR: step 0 in ProxD, the rest in ProxUI. Each PR is verified before deploy, deployed only with operator approval (`AUTO-DISCOVERY-ROADMAP.md` deploy gate; "full send" is that approval for its PR), and verified live before the next step starts.


| # | Step | Replaces |
|---|---|---|
| 0 | **ProxD persists the sign-in decision's inputs** (the flag and per-grant markers) in credential metadata. File synthesis restores them, with no error status. The hub's existing recovery rule clears them. Rolled with `roll-all.sh`. | A sign-in state that the hub forgets on restart. |
| 1 | **Sign-in on the server and on the wire.** The collector copies `requires_sign_in` into the `quota_accounts.signInRequired` column. The column needs a guarded `ALTER`, plus `QUOTA_ACCOUNT_COLUMNS` and `quotaAccountsTableSql`, so the widening rebuild keeps it. `signInRequired` goes on `/v1/inventory`, `/v1/accounts` and `/v1/pools`, and into the version tuple. PoolCard reads it. Take a `VACUUM INTO` backup before deploying. | The undeployed `lastErrorReason` / `errorReason` work, the collector's memory set, and the regex in `src/domain/quotaPool/errorReason.ts`. |
| 2 | **One notice on every screen.** The normaliser sets `file.signInRequired`. `AccountStateNotice` is used on the six screens. `credentialHealth` counts sign-in. The toast reads the re-read file. The `account_state.*` keys replace `auth_files.status_signin_expired`, `quota_pool.signin_expired*` and `quota_pool.signin_again`. | The regex in `constants.ts` and the screen-specific sentences. |
| 3 | **One read-status rule.** `server/quota/accountState.ts`. Unpooled cards read stored samples. The client keeps `error` distinct from `stale`, Codex included. | Three status derivations and three no-five-hour-limit rules. |
| 4 | **Sources and providers on the server.** Scopes come only from the manifest. Provider membership is the union rule. A dropped source leaves at once, and its rows are kept with samples exempt from pruning while it is dropped. The inventory version covers the whole body. The Antigravity reader is deleted (done early, 2026-11-26: the collector and plan reads, with the browser card's quota read and `antigravitySubscription.ts`; the card's display code stays until step 5). `server/quota/RULES.md`, `README.md`, `docs/PROX-SETUP.md` and `AUTO-DISCOVERY-ROADMAP.md` are updated. | Stored-account scopes, the `QUOTA_PROVIDERS` fallback, constant combined keys, and the PR #129 rule that kept removed sources visible. |
| 5 | **Sources and providers in the browser.** `readVersion` returns the body. Served routing, chips, skeletons and logos read it. Every screen follows the registry, with cache cleanup. Dropping the login binding ends that session with a message. The hub-direct Antigravity card and `antigravitySubscription.ts` are deleted. The AGENTS.md served-routing rule is rewritten. | Claude/Codex literals in stores, quota APIs and `viewState`. |
| 6 | **One propagation path.** The served-accounts store follows inventory commits, with one app-wide timer. `refreshAccountEverywhere` replaces `refreshPoolAccountAfterReset`. `AGENTS.md` and `src/features/quota/RULES.md` are updated. | Per-holder timers and the duplicate `/prox/refresh` wrapper. |
