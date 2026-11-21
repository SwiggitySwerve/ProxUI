import { createHandler } from './app';
import { QuotaStore } from './quota/store';
import { QuotaCollector } from './quota/collector';
import { ResetClaims } from './quota/claims';
import { loadSourceManifest } from './providerSources/config';
import { createManifestWatcher } from './providerSources/watch';
import type { DeploymentSource } from '../src/domain/providerSources/types';
import { LEGACY_SOURCE_MAPPING } from './quota/identity';
import { createAnalyticsHandler } from './analytics/handler';
import { startEventLoopLagProbe } from './eventLoopLag';

const manifestPath =
  process.env.PROX_SOURCE_MANIFEST ??
  new URL('../deploy/provider-sources.json', import.meta.url).pathname;
const { manifest, revision } = loadSourceManifest(manifestPath);
const keyFile = manifest.history.managementKeyFile;
const store = new QuotaStore(process.env.PROX_DB_PATH ?? '/data/quota.sqlite');
const knownIds = manifest.sources.map((source) => source.instanceId);
store.migrateLegacySources(
  LEGACY_SOURCE_MAPPING.filter((mapping) => knownIds.includes(mapping.instanceId)),
  knownIds
);
// Configuration is a process-lifetime snapshot, except that a manifest written at run time
// (prox-sources-apply) may gain hubs: those are handed to the collector, which only ever adds.
// Removing or editing a source still takes a restart.
const collector = new QuotaCollector(store, { sources: manifest.sources, revision });
// applySources arrives with the open-provider quota work; until then a new hub waits for a restart.
type HotAddSources = {
  applySources?(sources: readonly DeploymentSource[], revision: string): void;
};
const manifestWatcher = process.env.PROX_SOURCE_MANIFEST
  ? setInterval(
      createManifestWatcher(manifestPath, { manifest, revision }, (next, nextRevision) =>
        (collector as QuotaCollector & HotAddSources).applySources?.(next.sources, nextRevision)
      ),
      30_000
    )
  : null;
const quotaHandler = createHandler({
  store,
  collector,
  keyFile,
  claims: new ResetClaims({ store, collector }),
});
const analyticsHandler = createAnalyticsHandler(manifest);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18319,
  fetch: (request) =>
    new URL(request.url).pathname === '/v1/analytics'
      ? analyticsHandler(request)
      : quotaHandler(request),
});
collector.start();
startEventLoopLagProbe();
// Keep the default analytics views warm so page loads never wait on slow scans.
void analyticsHandler.warm();
const analyticsWarmer = setInterval(() => void analyticsHandler.warm(), 15_000);
console.log('Prox quota history listening on loopback port 18319');
const shutdown = () => {
  collector.stop();
  clearInterval(analyticsWarmer);
  if (manifestWatcher) clearInterval(manifestWatcher);
  void server.stop(true);
  store.close();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
