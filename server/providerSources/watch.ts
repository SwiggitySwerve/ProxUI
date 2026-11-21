import { statSync } from 'node:fs';
import type { SourceManifest } from '../../src/domain/providerSources/types';
import { loadSourceManifest } from './config';

/**
 * Returns a check to run on a timer. It reports a manifest revision that lists sources this
 * process does not have yet, and nothing else: a removed or edited source waits for a restart, and
 * a manifest that fails validation is logged once and ignored.
 */
export function createManifestWatcher(
  path: string,
  loaded: { readonly manifest: SourceManifest; readonly revision: string },
  onAdded: (manifest: SourceManifest, revision: string) => void,
  warn: (message: string) => void = console.warn
): () => void {
  const known = new Set(loaded.manifest.sources.map((source) => source.instanceId));
  let revision = loaded.revision;
  // Unknown at first: the file may have changed between the caller's load and this call.
  let seenMtimeMs: number | null = null;
  return () => {
    try {
      const { mtimeMs } = statSync(path);
      if (mtimeMs === seenMtimeMs) return;
      seenMtimeMs = mtimeMs;
      const next = loadSourceManifest(path);
      if (next.revision === revision) return;
      revision = next.revision;
      const added = next.manifest.sources.filter((source) => !known.has(source.instanceId));
      if (!added.length) return;
      onAdded(next.manifest, next.revision);
      for (const source of added) known.add(source.instanceId);
    } catch (error) {
      warn(`Source manifest change ignored: ${error instanceof Error ? error.message : error}`);
    }
  };
}
