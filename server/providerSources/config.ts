import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  publicSourceDiscovery,
  validateSourceManifest,
} from '../../src/domain/providerSources/manifest';

/** Validation rebuilds every object in a fixed key order, so the hash depends on content alone. */
export function describeSourceManifest(input: unknown) {
  const manifest = validateSourceManifest(input);
  const revision = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { manifest, revision, discovery: publicSourceDiscovery(manifest, revision) };
}

export function loadSourceManifest(path: string) {
  return describeSourceManifest(JSON.parse(readFileSync(path, 'utf8')));
}
