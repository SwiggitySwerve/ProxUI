# ProxD ↔ ProxUI Auto-Discovery & Expansion Roadmap

Council-approved architecture (2026-11-21; unanimous across Proposer, Adversary, and Codebase Explorer).
**Deploy gate:** All workstreams below are built and verified on feature branches / PRs only. **Do not deploy or restart live services until explicit operator approval.**

## Unanimous Council Decisions

| # | Decision | Choice | Non-Negotiable Invariants |
|---|---|---|---|
| 1 | Quota readers | **Hybrid** | Keep Claude, Codex, and Antigravity readers in `prox-history`. Promote `GET /v8/management/quota/providers` and `POST /v8/management/quota/fetch` on ProxD for new/plugin providers. Revalidate plugin binding server-side at fetch time; exclude declarative `quota_probe` from automatic collection; bound payload size, concurrency, and timeouts. Extend `QuotaBucket` with optional `id`, `periodSeconds`, and `scope` (`account` \| `model`). |
| 2 | Hub admission | **Pull from host config** | Pull from operator-owned `~/.config/cli-proxy/instances.json` (never network push, never mDNS/port scanning). Loopback origins auto-admit only after an authenticated `GET /v8/management/providers` probe confirms `instance_id` matches the claimed ID. Remote origins require an explicit entry with their own key file and `authScope`. Reject HTTP redirects; preserve last-known-good membership on errors (an outage never retires accounts). |
| 3 | Reverse-proxy data path | **Nginx stays the only data path** | Keep Nginx for management traffic (20 MiB uploads, streaming, OAuth callbacks, degraded mode when `prox-history` is down). A host oneshot (`prox-sources-apply`) writes routes + discovery into a mounted directory, validates with `nginx -t`, reloads Nginx, probes live routes, and atomically publishes `/prox/sources.json`. |
| 4 | Provider ownership | **Hub-declared `accepted_providers`, server-enforced** | ProxD accepts an optional `accepted-providers` / `CLIPROXY_ACCEPTED_PROVIDERS` allowlist and rejects `/oauth/auth-url`, `/oauth/import`, and `POST /credentials` for unaccepted providers with `409 provider_not_accepted` (unset = legacy accept-all). Pin OAuth start/poll/callback/cancel to the starting hub + generation; scope delete sync per hub. |
| 5 | Pooling newly discovered providers | **Cards-only until operator opt-in** | New providers auto-appear in `awaiting_auth` on Auth Files, OAuth, and Quota Management. Completing auth on an Auth Card activates the live Auth File card and a Quota Management `unpooled` card. Promotion into a pooled forecast requires explicit operator opt-in (`quota_pool_profiles`: weekly window ID, five-hour window ID or none, plan units). Unknown plans stay 1 unit (`100` pts) marked unknown and never inflate `combined.all` silently. |

## Wire Contracts (Phase 0)

1. **`GET /v8/management/providers`** (ProxD v8, ETag):
   Returns `ProviderCatalog` (`src/domain/providerCatalog/types.ts`, golden fixture in `tests/fixtures/providerCatalog/catalog.golden.json`).
   - Built-in entries are driven from the `StartOAuthV8` dispatch table (enforced by unit test) and merged with enabled plugins.
   - Lifecycle per provider is derived once in ProxD: `awaiting_auth` (0 credentials), `disabled` (all disabled or plugin disabled), `needs_attention` (any credential requires sign-in or has error status), `active` (otherwise).
2. **`GET /v8/management/quota/providers`** and **`POST /v8/management/quota/fetch {auth_index}`** (ProxD v8):
   Server-side plugin resolution (ignores untrusted caller `plugin_id` overrides for non-matching credentials; never runs declarative `quota_probe` on auto-collection). Returns normalized `QuotaFetchResponse` with optional `id`, `periodSeconds`, and `scope` on buckets.
3. **`effective-manifest.json`** (`~/.local/share/prox/sources/effective-manifest.json`):
   Standard `SourceManifest` merged from baked `deploy/provider-sources.json` (which wins conflicts) + probed host `instances.json`.
4. **Additive `QuotaCollector.applySources(sources, revision)`**:
   Hot-adds newly admitted sources to `prox-history` without retiring existing sources or accounts.

## Parallel Workstreams & File Ownership

- **Phase 0 (`feat/provider-catalog-contracts`, ProxUI):** Shared wire types, validator, golden fixture, i18n keys across all 6 locales, and this roadmap.
- **Workstream A (`feat/provider-auto-discovery`, ProxD):** `GET /v8/management/providers`, v8 quota routes + bucket fields, and `accepted_providers` enforcement.
- **Workstream B (`feat/oauth-catalog-cards`, ProxUI):** `src/services/api/providerCatalog.ts`, `src/stores/useProviderCatalogStore.ts`, `src/features/oauth/**`, `src/features/authFiles/**`, `src/services/api/oauth.ts`, `src/features/quota/providers/plugin/**`.
- **Workstream C (`feat/quota-open-providers`, ProxUI):** `server/quota/**`, `server/app.ts`, `src/domain/quotaPool/**`, `src/domain/quotaWindows/**`, `src/features/quotaPool/**`, `src/services/api/quotaPool.ts`.
- **Workstream D (`feat/runtime-hub-sources`, ProxUI):** `deploy/**`, `scripts/**`, `server/providerSources/**`, `server/main.ts`, `server/usage/main.ts`, `src/domain/providerSources/**`, `src/services/providerSources/**`, `docs/PROX-SETUP.md`.
