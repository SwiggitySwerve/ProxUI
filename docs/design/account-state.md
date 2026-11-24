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

1. **Each screen worked the state out again, from its own copy and on its own clock.** The sign-in rule was a regex over `status_message`, copied into the Auth Files helpers, the refresh toast and the collector. The hub's own `requires_sign_in` was dropped.
2. **The change signal could not see a state change.** `inventoryVersion` hashed only `[instanceId, provider, accountId, disabled]`, so a sign-in expiry never reached the other tabs or screens.
3. **The server computed read status three times, from different inputs:**
   - `buildAccounts`, in `server/quota/accounts.ts`;
   - `buildPool`, in `server/quota/domain.ts`;
   - `discoveredProviders`, which reads collector memory.
4. **Provider sets were written into code.** `BUILT_IN_POOL_PROVIDERS` and claude/codex literals decide what is read, pooled, served and shown. `buildDashboard` rebuilds a scope for any instance that still has stored rows, and falls back to the hardcoded list. Nothing ever retired the Gemini account, because retirement needs an inventory read from a source that no longer exists.
5. **The rules were written down but not enforced.** Source-contract tests covered a named list of screens, and PoolCard was not on it.

## The rule

> Every fact has exactly one owner, which computes it once. Prox serves it from one read model. The browser holds one copy, and one component turns it into words. Below the point where Prox parses a backend answer, nothing computes the fact again, and no component fetches or forces a refresh of it.

## Owners

| Fact | Owner (computes it) | Served by | Browser copy | Rendered by |
|---|---|---|---|---|
| Credential exists, disabled | Hub credential list (`disabled`) | `/v1/inventory` | `useCredentialInventoryStore` files | each screen's list |
| **Sign-in required** | Hub, through `signInRequired()` in `src/domain/accountState/signIn.ts` | `signInRequired: true` on `/v1/inventory`, `/v1/accounts`, `/v1/pools` (pooled and unpooled) | inventory store files, pool accounts, `sourceQuotaStore` | `AccountStateNotice` |
| Cooldown, rate limit, status text | Hub | hub credential list only | inventory store files | Auth Files card |
| Provider lifecycle (`needs_attention`) | Hub catalog (`provider_catalog.go`) | `/v1/inventory` catalog | inventory store | provider-level UI only, never a per-account notice |
| Read status: `ok`, `stale`, `error`, `disabled`, plus `no-reader` for unpooled | prox-history, `readStatus()` in `server/quota/accountState.ts` | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore(owner)`, pool slot | `AccountStateNotice` |
| Pool-window refinements: `no-limit`, `missing-window` | prox-history `domain.ts`, on top of `readStatus` | `/v1/pools` | pool slot | `PoolCard` |
| No five-hour limit, plan, account label | prox-history `accountState.ts` | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore`, pool slot | provider bodies, `PoolCard` |
| Quota numbers, resets, billing | prox-history for served sources, the hub otherwise (`src/features/quota/RULES.md`) | `/v1/accounts`, `/v1/pools` | `sourceQuotaStore(owner)` | provider bodies, `PoolCard` |
| Provider set (per source: provider, reader, served, pooled) | `providerSet()` in `server/quota/providerSet.ts`, from the effective manifest and each hub's catalog | `/v1/inventory` `sources[]` | inventory store `sources` | chips, skeletons, logos, served routing |
| Which providers can claim resets | prox-history reset support (Claude, Codex) | `/v1/accounts` resets | `sourceQuotaStore` | reset panel |

Every fact on this page needs a row in this table. A fact without a row has no owner yet: add the row before you add code.

## Sign-in required: the hub decides, Prox copies

The hub sends `requires_sign_in` on every v8 credential (`ProxD internal/api/handlers/management/auth_files.go:834`). That flag is held only in hub memory (`types.go:133`, `json:"-"`): it reads false after a hub restart until the next refresh fails. The status message is persisted, and the hub fills it in as `unauthorized (refresh token invalid)` when the flag is set (`auth_files.go:564`). So the one rule is:

```
signInRequired = !disabled && (requires_sign_in || (status is error or unavailable && message matches
                 /refresh token (invalid|expired)|invalid_grant/))
```

- It lives only in `src/domain/accountState/signIn.ts`. The server imports the same file.
- It is called only where a hub answer is parsed:
  - the browser's auth-file normaliser (`src/services/api/authFiles.ts`);
  - the collector's inventory parser.
- The collector writes it to `quota_accounts.signInRequired` in the same upsert as `disabled`, on every inventory read. It does not wait for a failed poll, and it is not kept in collector memory.
- It does not depend on read status. The 15-minute rule decides whether a number is fresh; it never delays telling the user to sign in.
- Disabled wins: `disabled` is the one copy of that fact, and it is never also stored as a sign-in value.

## The change signal

`inventoryVersion` is a truncated sha256 over:

- the sorted `[instanceId, provider, accountId, disabled, signInRequired]` tuples of the accounts in the provider set;
- the provider-set entries `[instanceId, provider, served, pooled]`.

It never includes names or emails.

A sign-in expiry, a fresh sign-in, a disable, or a source added or removed changes the version. The browser polls `/v1/inventory` every 5 seconds. On a change, it re-reads the hub lists, the pool and the served accounts in one commit.

Actions taken in Prox don't wait for the poll:

- **Adding, removing or editing a credential** calls `notifyAuthFilesChanged`, which runs `commitChange`.
- **A refresh, a reset or a claim** calls `refreshAccountEverywhere` in `src/features/quotaPool/accountSync.ts`.

## Read status: one rule on the server

`readStatus(account, newestStoredSample, nowMs)` in `server/quota/accountState.ts` decides:

- `disabled`, then
- `error` when a failed poll is newer than a sample that is over 15 minutes old, or when there is no sample, then
- `stale`, then
- `ok`.

It reads stored samples, not collector memory, so a restart changes nothing.

All three callers use it: `/v1/accounts`, `/v1/pools`, and the unpooled cards. The unpooled cards add `no-reader`, and pools add `no-limit` and `missing-window` on top. The browser keeps `error` and `stale` apart for every provider, Codex included.

## Providers are discovered

`providerSet()` returns one entry per source and provider: `displayName`, `logo`, `reader` (`builtin`, `plugin` or `none`), `served` and `pooled`.

- **Membership is exactly what the current validated effective manifest declares.** The manifest is `PROX_SOURCE_MANIFEST`, which resolves to `/run/prox-sources/effective-manifest.json` (built from `deploy/provider-sources.json` plus `instances.json`). It is intersected with that hub's catalog. A source that declares nothing gets the catalog providers that hold credentials.
- **The set drives everything downstream:**
  - what the collector reads;
  - which pools and combined bands exist;
  - which accounts `/v1/accounts` serves;
  - the browser's chips, skeletons, logos and served routing.
- **The built-in reader list names only the readers prox-history ships.** It never decides what is shown.
- **A source the manifest drops disappears from every read model at once, without a restart.** The collector stops reading it and aborts in-flight polls. Its rows and samples stay in SQLite, and unretired rows from a dropped source are never purged. Adding the source back brings its history back. A manifest that fails validation changes nothing.
- **Reading Google's quota endpoints is barred** (`docs/PROX-SETUP.md`), so the Antigravity reader and the hub-direct Antigravity card are deleted, not hidden.

## Rendering

`AccountStateNotice` (`src/components/accountState/AccountStateNotice.tsx`) is the only component that turns `signInRequired` and read status into words, and the only user of the `account_state.*` i18n keys. Every screen that shows an account uses it:

- `AuthFileCard`;
- `AuthFileQuotaSection`;
- `QuotaCard` (`/quota/accounts`);
- `PoolCard`;
- `DiscoveredQuota`;
- `PoolAccountResets`.

For sign-in it shows the "Sign in again" link to `oauthPath(instanceId)`, and the reset panel shows the notice instead of a reset.

## How we work on account state

These steps apply to every change that touches an account, a credential or a provider.

1. **Find every surface first.** Grep the UI for the fact's words and field names (for example `Sign-in`, `Refresh failed`, `unavailable`, the provider id) and list every screen and endpoint that shows it. If you find more than one place that computes it, the first commit moves it to its owner.
2. **Change the owner, not a screen.** A fix that touches only one component is wrong by construction unless the fact is genuinely screen-local.
3. **Make the rule executable.** Add a behaviour test at the owner. Extend the scans below rather than adding to an allow-list. Any allow-list entry carries a one-line reason.
4. **Prove it on every surface, on the deploy.** Open Auth Files, `/quota/accounts` and `/quota` and check the same account shows the same state within one poll. For server changes, read the SQLite row with `?mode=ro`. Never print keys or auth file contents.
5. **Change docs in the same PR.** When a rule or a provider changes, update `AGENTS.md`, `server/quota/RULES.md`, `src/features/quota/RULES.md`, `README.md` and `docs/PROX-SETUP.md` together.

The checklist in `AGENTS.md` (§ Account state and providers) is the short form.

## Enforcement

Each test lands with the migration step that makes it pass. None lands red.

| Test | Lands in | Checks |
|---|---|---|
| `tests/accountSignIn.test.ts` | 1 | A table test of `signInRequired`: flag with message "disabled", flag with a blank message, no flag but a persisted message, disabled wins, a cooldown is not sign-in. |
| `tests/accountStateContract.test.ts` | 1, then extended in 3 | The sign-in pattern appears only in `signIn.ts`. `signInRequired(` is called only by the two parsers. There is no `errorReason` or `lastErrorReason`. The version tuple includes `signInRequired`. From step 3: `.lastErrorAtMs` is read only in `accountState.ts` and `store.ts`. |
| Collector, store and HTTP behaviour | 1 | An inventory read with the flag writes `signInRequired` with no failed poll. A later read without it clears the flag. The version changes. With a 1-minute-old sample, `/v1/accounts`, `/v1/pools` and the unpooled cards show `signInRequired` and status `ok`. |
| `tests/accountStateScreens.test.ts` | 2 | Scans all of `src/features/**` and `src/components/**`: no raw hub field names, and `account_state.` only in `AccountStateNotice`. It also renders `AuthFileCard`, `AuthFileQuotaSection`, `QuotaCard`, `PoolCard` and `PoolAccountResets` from one fixture and checks each shows the same sentence and the `oauthPath` link. |
| `tests/accountReadStatus.test.ts` | 3 | A `readStatus` table test, plus an agreement test: from one store fixture, `/v1/accounts` and `/v1/pools` agree on the core status and on no-five-hour-limit. |
| `tests/proxProviderSet.test.ts` | 4 | A stored account on a source missing from the manifest shows on no pool, combined band, inventory source or account list, while its samples remain. Dropping a source takes effect without a restart. An invalid revision changes nothing. It replaces the PR #129 tests in `tests/proxGeminiPool.test.ts`. |
| `tests/providerLiterals.test.ts` | 4 (server read models), then 5 (`src/features/quotaPool`, `src/stores`, quota API modules) | No `'claude'`, `'codex'` or `'antigravity'` literals outside a file-to-reason allow-list: readers, plans, reset claims and presentation. A docs check: every provider named as live in `server/quota/RULES.md` and `README.md` is in the manifest. |
| `tests/accountPropagation.test.ts` | 6 | One commit reaches file lists, pool and served accounts once. Refresh, reset and claim go through `accountSync`. There is one timer per store. No component calls a store's `refresh()` from an effect, except an allow-list with reasons (`QuotaPage`, `useAuthFilesData`, `useModelAccessInventory`, `MainLayout`), which `tests/credentialInventoryScreens.test.ts` already reconciles. |

## Migration

Six steps, each its own PR, shipped and verified live before the next starts.

| # | Step | Replaces |
|---|---|---|
| 1 | **Sign-in fact on the server and on the wire.** `signIn.ts`; the `quota_accounts.signInRequired` column (a guarded `ALTER`, plus `QUOTA_ACCOUNT_COLUMNS` and `quotaAccountsTableSql`, so the widening rebuild keeps it); the inventory parser; the version tuple; `signInRequired` on all three read models; PoolCard reads it. | The undeployed `lastErrorReason` / `errorReason` work and the collector's memory set. |
| 2 | **One notice on every screen.** The normaliser sets `file.signInRequired`. `AccountStateNotice` is used on the six screens. The `account_state.*` keys replace `auth_files.status_signin_expired`, `quota_pool.signin_expired*` and `quota_pool.signin_again`. | The regex in `constants.ts` and in the refresh toast, and the screen-specific sentences. |
| 3 | **One read-status rule.** `server/quota/accountState.ts`; unpooled cards read stored samples; the client keeps `error` distinct from `stale`, Codex included. | Three status derivations and three no-five-hour-limit rules. |
| 4 | **Provider set on the server.** `providerSet.ts`; scopes only from the set; a dropped source leaves at once, rows kept; the Antigravity reader is deleted; `server/quota/RULES.md`, `README.md`, `docs/PROX-SETUP.md` and `AUTO-DISCOVERY-ROADMAP.md` are updated. | Stored-account scopes, the `QUOTA_PROVIDERS` fallback, constant combined keys, and the PR #129 rule that kept removed sources visible. |
| 5 | **Provider set in the browser.** `readVersion` returns `sources`. Served routing, chips, skeletons and logos read it. The hub-direct Antigravity card and `antigravitySubscription.ts` are deleted. | Claude/Codex literals in stores, quota APIs and `viewState`. |
| 6 | **One propagation path.** The served-accounts store follows inventory commits, with one app-wide timer. `refreshAccountEverywhere` replaces `refreshPoolAccountAfterReset`. `AGENTS.md` and `src/features/quota/RULES.md` are updated. | Per-holder timers and the duplicate `/prox/refresh` wrapper. |
