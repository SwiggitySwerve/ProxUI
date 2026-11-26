import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

/**
 * Google suspended the AI Ultra account (403 TOS_VIOLATION) while a ProxD hub used its Antigravity
 * sign-in; the Antigravity terms bar third-party tools from it (docs/PROX-SETUP.md). ProxUI and
 * prox-history must never call Google's private Cloud Code backend, whatever a hub offers.
 */
const PRIVATE_GOOGLE_BACKEND = /cloudcode-pa|v1internal/i;

describe('no reads of Google quota', () => {
  test("no source file names Google's private Cloud Code backend", () => {
    const offenders: string[] = [];
    for (const root of ['src', 'server', 'scripts', 'deploy']) {
      for (const path of new Glob(`${root}/**/*.{ts,tsx,js,mjs,sh,json,conf}`).scanSync('.')) {
        if (PRIVATE_GOOGLE_BACKEND.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
