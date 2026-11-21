import { statSync } from 'node:fs';
import type { SourceManifest } from '../../src/domain/providerSources/types';
import { loadSourceManifest } from './config';

/**
 * Returns a check to run on a timer. Each validated manifest revision it has not delivered yet is
 * handed to `onChange`, which owns what to do with it (the quota collector only ever adds). A
 * revision counts as delivered only once `onChange` returns, so a failed call is retried on the
 * next tick; a manifest that fails validation is logged once and ignored until the file changes.
 */
export function createManifestWatcher(
  path: string,
  loaded: { readonly manifest: SourceManifest; readonly revision: string },
  onChange: (manifest: SourceManifest, revision: string) => void,
  warn: (message: string) => void = console.warn
): () => void {
  let revision = loaded.revision;
  // Unknown at first: the file may have changed between the caller's load and this call.
  let seenMtimeMs: number | null = null;
  return () => {
    let next: ReturnType<typeof loadSourceManifest>;
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(path).mtimeMs;
      if (mtimeMs === seenMtimeMs) return;
      next = loadSourceManifest(path);
    } catch (error) {
      // An invalid edit is reported once; the next change to the file is read again.
      seenMtimeMs = mtimeMs;
      warn(`Source manifest change ignored: ${error instanceof Error ? error.message : error}`);
      return;
    }
    try {
      if (next.revision !== revision) onChange(next.manifest, next.revision);
      revision = next.revision;
      seenMtimeMs = mtimeMs;
    } catch (error) {
      warn(`Source manifest not applied yet: ${error instanceof Error ? error.message : error}`);
    }
  };
}
