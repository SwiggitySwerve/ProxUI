import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeSourceManifest, loadSourceManifest } from './config';
import {
  parseInstancesFile,
  resolveEffectiveManifest,
  type HubOutcome,
  type ResolveOptions,
} from './runtime';

/** Where deploy/nginx.conf expects the runtime directory inside the prox container. */
export const RUNTIME_MOUNT = '/etc/nginx/runtime';
export const EFFECTIVE_MANIFEST = 'effective-manifest.json';
export const RUNTIME_ROUTES = 'provider-routes.conf';
export const RUNTIME_DISCOVERY = 'sources.json';

export interface ApplyOptions extends Omit<ResolveOptions, 'previous' | 'discoveryFile'> {
  readonly baseManifestPath: string;
  readonly instancesPath: string;
  /** The directory Nginx and prox-history mount. Its files change only by rename. */
  readonly runtimeDir: string;
  /** `nginx -t` against the staged routes; rejects when they would not load. */
  readonly validate: (stagingDir: string) => Promise<void>;
  /** Makes the running Nginx load the routes; rejects when it did not. */
  readonly reload: () => Promise<void>;
}

export interface ApplyResult {
  readonly changed: boolean;
  readonly revision: string;
  readonly outcomes: readonly HubOutcome[];
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Resolves the effective manifest and publishes it with its routes and discovery. Everything is
 * staged and checked first; discovery is renamed into place last, so a browser never learns of a
 * hub Nginx cannot route to. Any failure leaves the runtime directory as it was.
 */
export async function applyRuntimeSources(options: ApplyOptions): Promise<ApplyResult> {
  const live = (name: string) => join(options.runtimeDir, name);
  const { manifest: base } = loadSourceManifest(options.baseManifestPath);
  // A previous manifest that exists but does not validate is not silently treated as "no hubs".
  const published = await readOptional(live(EFFECTIVE_MANIFEST));
  const previous =
    published === null ? null : describeSourceManifest(JSON.parse(published)).manifest;
  const instances = parseInstancesFile(JSON.parse(await readFile(options.instancesPath, 'utf8')));
  const resolved = await resolveEffectiveManifest(base, instances, {
    ...options,
    previous,
    discoveryFile: `${RUNTIME_MOUNT}/${RUNTIME_DISCOVERY}`,
  });
  const result = { revision: resolved.revision, outcomes: resolved.outcomes };
  const files = [
    [EFFECTIVE_MANIFEST, `${JSON.stringify(resolved.manifest, null, 2)}\n`, 0o600],
    [RUNTIME_ROUTES, resolved.routes, 0o644],
    [RUNTIME_DISCOVERY, `${JSON.stringify(resolved.discovery, null, 2)}\n`, 0o644],
  ] as const;
  const current = await Promise.all(files.map(([name]) => readOptional(live(name))));
  if (files.every(([, content], index) => current[index] === content))
    return { ...result, changed: false };

  const staging = join(options.runtimeDir, '.staging');
  const staged = (name: string) => join(staging, name);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o755 });
  try {
    for (const [name, content, mode] of files) {
      await writeFile(staged(name), content, { mode });
      // The creation mode is cut by the umask.
      await chmod(staged(name), mode);
    }
    await options.validate(staging);
    const previousRoutes = current[1];
    await rename(staged(RUNTIME_ROUTES), live(RUNTIME_ROUTES));
    try {
      await options.reload();
    } catch (error) {
      // Nginx is still serving its old configuration; put back the file that matches it.
      if (previousRoutes === null) await rm(live(RUNTIME_ROUTES), { force: true });
      else {
        await writeFile(staged(RUNTIME_ROUTES), previousRoutes, { mode: 0o644 });
        await rename(staged(RUNTIME_ROUTES), live(RUNTIME_ROUTES));
      }
      throw error;
    }
    await rename(staged(EFFECTIVE_MANIFEST), live(EFFECTIVE_MANIFEST));
    await rename(staged(RUNTIME_DISCOVERY), live(RUNTIME_DISCOVERY));
    return { ...result, changed: true };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
