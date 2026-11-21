import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real scripts/deploy-homelab.sh in a throwaway HOME and repository copy. Every command
// that would build, touch Podman or systemd, or reach a service is a stub that records its call.
const repoRoot = join(import.meta.dir, '..');
const STUBS = ['node', 'npm', 'git', 'podman', 'systemctl', 'curl', 'bun'];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deploy(options: { seeded?: boolean; applyFails?: boolean; routesMissing?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prox-deploy-'));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts/deploy-homelab.sh'), join(repo, 'scripts/deploy-homelab.sh'));
  cpSync(join(repoRoot, 'deploy'), join(repo, 'deploy'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.3' }));
  const built = [
    'dist/usage/usage.js',
    'dist/usage-jobs/usage-parity.js',
    'dist/usage-jobs/usage-restore-check.js',
    'dist/usage-jobs/usage-nightly.js',
    'dist/sources-apply/prox-sources-apply.js',
  ];
  for (const file of built) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), `// ${file}\n`);
  }
  mkdirSync(join(home, '.config/proxd'), { recursive: true });
  writeFileSync(join(home, '.config/proxd/management-key'), 'test-key\n');
  if (options.seeded) {
    mkdirSync(join(home, '.local/share/prox/sources'), { recursive: true });
    writeFileSync(join(home, '.local/share/prox/sources/effective-manifest.json'), '{}\n');
  }
  // The deploy puts ~/.local/bin first on PATH, so stubs there shadow the real commands.
  const bin = join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  for (const name of STUBS) {
    const extra =
      name === 'node'
        ? 'echo bun@1.4.3'
        : name === 'bun'
          ? 'case "$*" in *--seed*) echo "umask $(umask)" >> "$HOME/calls";; esac'
          : name === 'systemctl'
            ? 'if [[ -n "${APPLY_FAILS:-}" && "$*" == "--user start prox-sources-apply.service" ]]; then exit 1; fi'
            : name === 'curl'
              ? 'if [[ -n "${ROUTES_MISSING:-}" && "$*" == *routes-revision* ]]; then exit 22; fi'
              : '';
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\necho "${name} $*" >> "$HOME/calls"\n${extra}\nexit 0\n`
    );
    chmodSync(join(bin, name), 0o755);
  }
  const result = Bun.spawnSync(['/bin/bash', join(repo, 'scripts/deploy-homelab.sh')], {
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(options.applyFails ? { APPLY_FAILS: '1' } : {}),
      ...(options.routesMissing ? { ROUTES_MISSING: '1' } : {}),
    },
  });
  const calls = readFileSync(join(home, 'calls'), 'utf8').trim().split('\n');
  const at = (call: string) => {
    const index = calls.indexOf(call);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };
  return { home, repo, result, calls, at };
}

const SOURCES_APPLY = '.local/share/prox/sources-apply';
const SEED_CALL = (home: string) =>
  `bun ${home}/${SOURCES_APPLY}/prox-sources-apply.js --seed --base ${home}/${SOURCES_APPLY}/provider-sources.json`;

describe('deploy-homelab.sh runtime hub discovery', () => {
  test('installs the apply bundle, the baked manifest, both units and the mounting Quadlets', () => {
    const { home, repo, result } = deploy();
    expect(result.exitCode).toBe(0);
    const installed = (path: string, from: string) =>
      expect(readFileSync(join(home, path), 'utf8')).toBe(readFileSync(join(repo, from), 'utf8'));
    installed(`${SOURCES_APPLY}/prox-sources-apply.js`, 'dist/sources-apply/prox-sources-apply.js');
    installed(`${SOURCES_APPLY}/provider-sources.json`, 'deploy/provider-sources.json');
    for (const unit of ['prox-sources-apply.service', 'prox-sources.path'])
      installed(`.config/systemd/user/${unit}`, `deploy/${unit}`);
    for (const quadlet of ['prox.container', 'prox-history.container'])
      installed(`.config/containers/systemd/${quadlet}`, `deploy/${quadlet}`);
    expect(readFileSync(join(home, '.config/containers/systemd/prox.container'), 'utf8')).toContain(
      'Volume=/dev/null:/etc/nginx/provider-routes.conf:ro'
    );
    // Nothing half-written is left beside the installed files.
    expect([...new Bun.Glob('.*').scanSync({ cwd: join(home, SOURCES_APPLY), dot: true })]).toEqual(
      []
    );
  });

  test('the first deploy seeds before prox restarts, then applies, then restarts history', () => {
    const { home, result, calls, at } = deploy();
    expect(result.exitCode).toBe(0);
    const seed = at(SEED_CALL(home));
    // The seed runs with the umask Nginx's worker needs to read the directory.
    expect(calls[seed + 1]).toBe('umask 0022');
    const reload = at('systemctl --user daemon-reload');
    const prox = at('systemctl --user restart prox.service');
    const apply = at('systemctl --user start prox-sources-apply.service');
    const history = at('systemctl --user restart prox-history.service');
    const path = at('systemctl --user enable --now prox-sources.path');
    // The seed checks its routes in the image this deploy just built.
    expect(
      at(
        'podman build -f deploy/Dockerfile --label org.opencontainers.image.revision= -t localhost/prox:dev .'
      )
    ).toBeLessThan(seed);
    expect(seed).toBeLessThan(prox);
    expect(reload).toBeLessThan(prox);
    expect(prox).toBeLessThan(apply);
    const routed = calls.findIndex((call) => call.endsWith('/prox/routes-revision'));
    expect(apply).toBeLessThan(routed);
    expect(routed).toBeLessThan(history);
    expect(history).toBeLessThan(path);
  });

  test('a later deploy keeps the published set and only applies', () => {
    const { result, calls, at } = deploy({ seeded: true });
    expect(result.exitCode).toBe(0);
    expect(calls.filter((call) => call.includes('--seed'))).toEqual([]);
    expect(at('systemctl --user restart prox.service')).toBeLessThan(
      at('systemctl --user start prox-sources-apply.service')
    );
  });

  test('a failed apply finishes the deploy and then fails it', () => {
    const { home, result, calls, at } = deploy({ applyFails: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('prox-sources-apply failed');
    expect(at('systemctl --user start prox-sources-apply.service')).toBeLessThan(
      at('systemctl --user restart prox-history.service')
    );
    expect(calls.at(-1)).toBe('systemctl --user enable --now prox-sources.path');
    expect(existsSync(join(home, '.config/systemd/user/prox-sources.path'))).toBe(true);
  });

  test('Nginx without published routes fails the deploy even though /healthz answers', () => {
    const { result, calls } = deploy({ routesMissing: true });
    expect(result.exitCode).not.toBe(0);
    expect(calls).toContain('systemctl --user start prox-sources-apply.service');
    expect(calls).not.toContain('systemctl --user restart prox-history.service');
  });
});
