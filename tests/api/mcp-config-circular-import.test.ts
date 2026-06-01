// QA adversarial — the dev's FLAGGED deviation: a deliberate CIRCULAR IMPORT.
//   mcp-config.ts        imports { APP_FACTORY_DIR, CALLBACK_ENV_KEYS } from app-factory.ts
//   app-factory.ts       imports { buildClaudeMcpConfig }              from mcp-config.ts
//
// The dev claims it is ESM-safe because app-factory's values are referenced only
// at CALL time (inside buildClaudeMcpConfigObject), not at mcp-config module-init.
// If that claim is wrong, then importing mcp-config FIRST (before app-factory has
// finished initializing) would see `APP_FACTORY_DIR` / `CALLBACK_ENV_KEYS` as
// undefined → the resolved path would be wrong (resolve(undefined,...) throws) or
// the env block keys would be undefined.
//
// THIS FILE'S ONLY @clowder TOP-LEVEL IMPORT IS mcp-config — so under vitest's
// hoisted ESM evaluation, mcp-config is the entry of this import graph and pulls
// app-factory in transitively. Calling the builder at the TOP of the first test
// (before any app-factory symbol is touched in user code) exercises the dangerous
// "mcp-config evaluated first" order. We then ALSO dynamic-import app-factory and
// re-verify, covering the reverse order within the same process.
//
// Authored by a QA instance that did NOT write the product code (CLAUDE.md §0.5.3).

import { describe, expect, it } from 'vitest';
import { isAbsolute } from 'node:path';
// IMPORTANT: mcp-config is the ONLY @clowder import here, intentionally pulling
// app-factory in only as a transitive dependency of the circular edge.
import {
  buildClaudeMcpConfigObject,
  type ClaudeMcpConfigObject,
} from '@clowder/api/providers/mcp-config';

const CALLBACK_OPTS = {
  apiBaseUrl: 'http://127.0.0.1:3100',
  invocationId: 'inv-circular-9a8b7c',
  callbackToken: 'tok-circular-d4e5f6-secret',
} as const;

describe('mcp-config circular-import safety (dev deviation)', () => {
  it('(adversarial) building the config with mcp-config imported FIRST does not throw / no undefined', () => {
    // This call happens before any app-factory symbol is referenced in test code.
    // If APP_FACTORY_DIR were undefined at this point, resolve(undefined, ...) would
    // throw a TypeError; if CALLBACK_ENV_KEYS were undefined, the env block keys would
    // be `undefined` (Object key coercion) or the access would throw.
    let cfg: ClaudeMcpConfigObject | undefined;
    expect(() => {
      cfg = buildClaudeMcpConfigObject(CALLBACK_OPTS);
    }).not.toThrow();

    const server = cfg?.mcpServers['clowder'];
    expect(server).toBeDefined();

    // args resolved from APP_FACTORY_DIR — must be defined + absolute (not "undefined/..").
    const [tsxCli, entry] = server?.args ?? [];
    expect(tsxCli).toBeDefined();
    expect(entry).toBeDefined();
    expect(String(tsxCli)).not.toContain('undefined');
    expect(String(entry)).not.toContain('undefined');
    expect(isAbsolute(tsxCli as string)).toBe(true);
    expect(isAbsolute(entry as string)).toBe(true);

    // env keys come from CALLBACK_ENV_KEYS — they must be the canonical names, not
    // `undefined` (which is what a not-yet-initialized const would coerce to).
    const env = server?.env ?? {};
    expect(Object.keys(env).sort()).toEqual([
      'CLOWDER_API_URL',
      'CLOWDER_CALLBACK_TOKEN',
      'CLOWDER_INVOCATION_ID',
    ]);
    expect(env['CLOWDER_INVOCATION_ID']).toBe(CALLBACK_OPTS.invocationId);
  });

  it('(adversarial) the app-factory side of the cycle initializes consistently (reverse order)', async () => {
    // Now pull app-factory explicitly (it was already loaded transitively, but this
    // asserts its exported circular-edge symbols are sound regardless of order).
    const { APP_FACTORY_DIR, CALLBACK_ENV_KEYS } = await import('@clowder/api/app-factory');

    expect(typeof APP_FACTORY_DIR).toBe('string');
    expect(APP_FACTORY_DIR.length).toBeGreaterThan(0);
    expect(isAbsolute(APP_FACTORY_DIR)).toBe(true);

    expect(CALLBACK_ENV_KEYS).toEqual({
      apiUrl: 'CLOWDER_API_URL',
      invocationId: 'CLOWDER_INVOCATION_ID',
      callbackToken: 'CLOWDER_CALLBACK_TOKEN',
    });

    // The builder's resolved entry path lives under the SAME repo root APP_FACTORY_DIR
    // resolves from (packages/api/src → three up → packages/mcp-server/src/index.ts):
    // i.e. the circular dep produced a coherent absolute path, not a desynced one.
    const entry = buildClaudeMcpConfigObject(CALLBACK_OPTS).mcpServers['clowder']?.args[1];
    expect(entry?.replace(/\\/g, '/')).toMatch(/packages\/mcp-server\/src\/index\.ts$/);
  });
});
