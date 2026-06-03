// WorkspaceTrustStore + applyWorkspaceTrustEnv — the VSCode-style workspace-trust
// CORE (persistence + the env flag a granted trust enables). The interactive
// prompt (scripts/ensure-trust.ts) is a thin terminal script outside the gate;
// the substance — "trust persists per path, normalizes, fails open, and a grant
// is what sets gemini's trust env" — is unit-tested here. Real workspace paths.

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WorkspaceTrustStore,
  applyWorkspaceTrustEnv,
  resolveTrustStorePath,
  isTrustFlagSet,
  GEMINI_TRUST_ENV_KEY,
  TRUST_STORE_ENV,
} from '@choco/api/runtime/workspace-trust';

let dir: string;
let storeFile: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'choco-trust-'));
  storeFile = join(dir, 'trusted-workspaces.json');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const WORKSPACE = 'D:/proj/my-real-project';

describe('WorkspaceTrustStore — persistence (happy)', () => {
  it('an untrusted workspace is not trusted; trusting it persists and reads back', () => {
    const store = new WorkspaceTrustStore(storeFile);
    expect(store.isTrusted(WORKSPACE)).toBe(false);

    store.trust(WORKSPACE);
    expect(store.isTrusted(WORKSPACE)).toBe(true);

    // A FRESH store over the same file sees the persisted grant (survives restart).
    expect(new WorkspaceTrustStore(storeFile).isTrusted(WORKSPACE)).toBe(true);
    // The file is real JSON with the trusted list.
    const parsed = JSON.parse(readFileSync(storeFile, 'utf-8')) as { trusted: string[] };
    expect(parsed.trusted.length).toBe(1);
  });

  it('trust is idempotent — trusting twice does not duplicate the entry', () => {
    const store = new WorkspaceTrustStore(storeFile);
    store.trust(WORKSPACE);
    store.trust(WORKSPACE);
    const parsed = JSON.parse(readFileSync(storeFile, 'utf-8')) as { trusted: string[] };
    expect(parsed.trusted).toHaveLength(1);
  });

  it('distinct workspaces are trusted independently (per-folder, like VSCode)', () => {
    const store = new WorkspaceTrustStore(storeFile);
    store.trust(WORKSPACE);
    expect(store.isTrusted(WORKSPACE)).toBe(true);
    expect(store.isTrusted('D:/proj/some-other-project')).toBe(false);
  });
});

describe('WorkspaceTrustStore — edge', () => {
  it('normalizes relative vs absolute + trailing separators to the same path', () => {
    const store = new WorkspaceTrustStore(storeFile);
    store.trust(dir);
    // The same directory expressed with a trailing slash + a `.` segment is trusted.
    expect(store.isTrusted(join(dir, 'sub', '..'))).toBe(true);
    expect(store.isTrusted(`${dir}/`)).toBe(true);
  });

  it('on win32 trust is case-insensitive (Windows paths are); elsewhere case matters', () => {
    const store = new WorkspaceTrustStore(storeFile);
    store.trust('D:/Proj/Case');
    const expected = process.platform === 'win32';
    expect(store.isTrusted('d:/proj/case')).toBe(expected);
  });

  it('fails open: a missing store file → nothing trusted, no throw', () => {
    const store = new WorkspaceTrustStore(join(dir, 'does-not-exist.json'));
    expect(() => store.isTrusted(WORKSPACE)).not.toThrow();
    expect(store.isTrusted(WORKSPACE)).toBe(false);
  });

  it('fails open: a corrupt store file → nothing trusted, no throw', () => {
    writeFileSync(storeFile, '{ this is not json', 'utf-8');
    const store = new WorkspaceTrustStore(storeFile);
    expect(store.isTrusted(WORKSPACE)).toBe(false);
    // And a subsequent trust repairs the file (overwrites the garbage).
    store.trust(WORKSPACE);
    expect(new WorkspaceTrustStore(storeFile).isTrusted(WORKSPACE)).toBe(true);
  });

  it('trust() creates the data dir if it does not exist yet', () => {
    const nested = join(dir, 'data', 'nested', 'trusted-workspaces.json');
    expect(existsSync(nested)).toBe(false);
    new WorkspaceTrustStore(nested).trust(WORKSPACE);
    expect(existsSync(nested)).toBe(true);
  });
});

describe('applyWorkspaceTrustEnv + helpers', () => {
  it('a granted trust sets gemini’s trust env flag (what unblocks headless auto-approve)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(env[GEMINI_TRUST_ENV_KEY]).toBeUndefined();
    applyWorkspaceTrustEnv(env);
    expect(env[GEMINI_TRUST_ENV_KEY]).toBe('true');
  });

  it('isTrustFlagSet accepts only 1/true (not arbitrary values)', () => {
    expect(isTrustFlagSet('1')).toBe(true);
    expect(isTrustFlagSet('true')).toBe(true);
    expect(isTrustFlagSet('0')).toBe(false);
    expect(isTrustFlagSet('yes')).toBe(false);
    expect(isTrustFlagSet(undefined)).toBe(false);
  });

  it('resolveTrustStorePath honors CHOCO_TRUST_STORE, else the data/ default (absolute)', () => {
    const custom = resolveTrustStorePath({ [TRUST_STORE_ENV]: 'D:/x/trust.json' }, 'D:/cwd');
    expect(custom.replace(/\\/g, '/')).toBe('D:/x/trust.json');
    const fallback = resolveTrustStorePath({}, 'D:/cwd');
    expect(fallback.replace(/\\/g, '/')).toBe('D:/cwd/data/trusted-workspaces.json');
  });
});
