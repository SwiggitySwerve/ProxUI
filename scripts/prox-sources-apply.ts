// Host oneshot: admit the hubs ProxD's instances.json lists and publish their Nginx routes.
// Usage and enablement: docs/PROX-SETUP.md, "Runtime hub discovery".
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { applyRuntimeSources, RUNTIME_MOUNT } from '../server/providerSources/apply';
import type { DeploymentSource } from '../src/domain/providerSources/types';
import { MANAGEMENT_API_PREFIX } from '../src/utils/constants';

export { applyRuntimeSources };

const run = promisify(execFile);
// The image and container deploy/prox.container runs.
const IMAGE = 'localhost/prox:dev';
const CONTAINER = 'prox';

/** `nginx -t` in a throwaway container that mounts the staged files where the live one would. */
async function validateStaged(stagingDir: string): Promise<void> {
  await run('podman', [
    'run',
    '--rm',
    '--network=host',
    '--entrypoint=nginx',
    '--volume=/dev/null:/etc/nginx/provider-routes.conf:ro',
    `--volume=${stagingDir}:${RUNTIME_MOUNT}:ro`,
    IMAGE,
    '-t',
  ]);
}

/** `nginx -s reload` reports success even when the new configuration is refused, so test first. */
async function reloadNginx(): Promise<void> {
  await run('podman', ['exec', CONTAINER, 'nginx', '-t']);
  await run('podman', ['exec', CONTAINER, 'nginx', '-s', 'reload']);
}

/** Where deploy/prox.container publishes the prox Nginx on the host. */
const PROX_ORIGIN = 'http://127.0.0.1:18318';
const VERIFY_DEADLINE_MS = 15_000;

/**
 * Waits until the running Nginx serves `revision`, then asks it, through each new binding's public
 * route, who answers there; retries until all match or the deadline passes.
 */
function verifyRoutes(keyFile: string) {
  return async (revision: string, added: readonly DeploymentSource[]): Promise<void> => {
    const key = (await readFile(keyFile, 'utf8')).trim();
    const get = (path: string, auth: boolean) =>
      fetch(`${PROX_ORIGIN}${path}`, {
        headers: auth ? { Authorization: `Bearer ${key}` } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(3_000),
      });
    const serving = async () => {
      try {
        const response = await get('/prox/routes-revision', false);
        return response.ok && (await response.text()).trim() === revision;
      } catch {
        return false;
      }
    };
    const routed = async (source: DeploymentSource) => {
      try {
        const response = await get(
          `${source.publicBasePath}${MANAGEMENT_API_PREFIX}/providers`,
          true
        );
        const body: unknown = response.ok ? await response.json() : null;
        return (
          !!body &&
          typeof body === 'object' &&
          (body as { instance_id?: unknown }).instance_id === source.instanceId
        );
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + VERIFY_DEADLINE_MS;
    let live = false;
    let pending = [...added];
    for (;;) {
      live ||= await serving();
      if (live) {
        const results = await Promise.all(pending.map(routed));
        pending = pending.filter((_, index) => !results[index]);
        if (!pending.length) return;
      }
      if (Date.now() > deadline)
        throw new Error(
          live
            ? `Nginx does not route ${pending.map((s) => s.instanceId).join(', ')}`
            : `Nginx is not serving routes revision ${revision}`
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      instances: { type: 'string' },
      'runtime-dir': { type: 'string' },
      'history-key-file': { type: 'string' },
      seed: { type: 'boolean' },
    },
  });
  const home = homedir();
  const historyKeyFile =
    values['history-key-file'] ??
    process.env.PROX_SOURCES_HISTORY_KEY_FILE ??
    join(home, '.config/proxd/management-key');
  try {
    const result = await applyRuntimeSources({
      baseManifestPath:
        values.base ??
        process.env.PROX_SOURCES_BASE_MANIFEST ??
        fileURLToPath(new URL('../deploy/provider-sources.json', import.meta.url)),
      instancesPath:
        values.instances ??
        process.env.PROX_SOURCES_INSTANCES ??
        join(home, '.config/cli-proxy/instances.json'),
      runtimeDir:
        values['runtime-dir'] ??
        process.env.PROX_SOURCES_DIR ??
        join(home, '.local/share/prox/sources'),
      historyKeyFile,
      validate: validateStaged,
      reload: reloadNginx,
      verify: verifyRoutes(historyKeyFile),
      seed: values.seed ?? false,
    });
    for (const { id, state, reason } of result.outcomes)
      console.log(`${id}: ${state}${reason ? ` (${reason})` : ''}`);
    console.log(`${result.changed ? 'Published' : 'Unchanged'} source revision ${result.revision}`);
  } catch (error) {
    console.error(
      `Sources not applied; the previous routes stay in effect: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}
