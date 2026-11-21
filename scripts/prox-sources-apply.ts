// Host oneshot: admit the hubs ProxD's instances.json lists and publish their Nginx routes.
// Usage and enablement: docs/PROX-SETUP.md, "Runtime hub discovery".
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { applyRuntimeSources, RUNTIME_MOUNT } from '../server/providerSources/apply';

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

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      instances: { type: 'string' },
      'runtime-dir': { type: 'string' },
      'history-key-file': { type: 'string' },
      'key-root': { type: 'string' },
      'key-mount': { type: 'string' },
    },
  });
  const home = homedir();
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
      historyKeyFile:
        values['history-key-file'] ??
        process.env.PROX_SOURCES_HISTORY_KEY_FILE ??
        join(home, '.config/proxd/management-key'),
      keyRoot:
        values['key-root'] ??
        process.env.PROX_SOURCES_KEY_ROOT ??
        join(home, '.config/proxd/hub-keys'),
      keyMount:
        values['key-mount'] ?? process.env.PROX_SOURCES_KEY_MOUNT ?? '/run/secrets/hub-keys',
      validate: validateStaged,
      reload: reloadNginx,
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
