import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeploymentSource } from '../../src/domain/providerSources/types';
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
  /**
   * Resolves once the running Nginx routes each run-time hub to the instance it was admitted as
   * (a reload is acknowledged before the workers switch); rejects when it does not in time.
   */
  readonly verify: (admitted: readonly DeploymentSource[]) => Promise<void>;
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
 * staged and checked first; the routes go live, the running Nginx is confirmed to route every hub,
 * and only then are the manifest and discovery renamed into place, so a browser never learns of a
 * hub Nginx cannot route to. Any failure puts the previous routes and manifest back and reloads.
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
    const [previousManifest, previousRoutes] = current;
    /** Puts a live file back as it was before this run (absent stays absent). */
    const restore = async (name: string, content: string | null, mode: number) => {
      if (content === null) return rm(live(name), { force: true });
      await writeFile(staged(`${name}.restore`), content, { mode });
      await rename(staged(`${name}.restore`), live(name));
    };
    await rename(staged(RUNTIME_ROUTES), live(RUNTIME_ROUTES));
    let reloaded = false;
    try {
      await options.reload();
      reloaded = true;
      const baked = new Set(base.sources.map((source) => source.instanceId));
      await options.verify(
        resolved.manifest.sources.filter((source) => !baked.has(source.instanceId))
      );
      // prox-history follows the manifest and browsers follow discovery, so discovery goes last.
      await rename(staged(EFFECTIVE_MANIFEST), live(EFFECTIVE_MANIFEST));
      await rename(staged(RUNTIME_DISCOVERY), live(RUNTIME_DISCOVERY));
    } catch (error) {
      // Return to the previous set: routes, the manifest if it was already renamed, and Nginx.
      await restore(RUNTIME_ROUTES, previousRoutes, 0o644);
      await restore(EFFECTIVE_MANIFEST, previousManifest, 0o600);
      if (reloaded) await options.reload();
      throw error;
    }
    return { ...result, changed: true };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
