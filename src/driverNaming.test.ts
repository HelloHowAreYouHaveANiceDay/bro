import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeDoc, dispatch } from './driver.ts';

const originalHome = process.env.BRO_HOME;
const originalSites = process.env.BRO_SITES_DIR;
let tempHome = '';
let tempSites = '';

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  if (tempSites) rmSync(tempSites, { recursive: true, force: true });
  tempHome = '';
  tempSites = '';
  if (originalHome === undefined) delete process.env.BRO_HOME; else process.env.BRO_HOME = originalHome;
  if (originalSites === undefined) delete process.env.BRO_SITES_DIR; else process.env.BRO_SITES_DIR = originalSites;
});

describe('driver verb naming', () => {
  it('publishes the canonical ordered names', () => {
    const verbs = (describeDoc().verbs as Array<{ name: string }>).map((v) => v.name);
    expect(verbs).toEqual(['doctor', 'version', 'site list', 'session list', 'session launch', 'session quit', 'page open', 'page exec', 'workflow run', 'workflow run-all', 'auth login']);
    for (const name of verbs) for (const word of name.split(' ')) expect(word).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('supports aliases, spaced hints, and wires every described method', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'bro-naming-home-'));
    tempSites = mkdtempSync(join(tmpdir(), 'bro-naming-sites-'));
    process.env.BRO_HOME = tempHome;
    process.env.BRO_SITES_DIR = tempSites;
    await expect(dispatch('sessions', {})).resolves.toEqual({ sessions: [] });
    await expect(dispatch('session.list', {})).resolves.toEqual({ sessions: [] });
    for (const method of ['auth.login', 'auth']) await expect(dispatch(method, { site: 'x' })).rejects.toMatchObject({ kind: 'bad-args', needsHuman: true, hint: 'bro auth login ...' });
    for (const [method, params] of [['session.quit', { site: 'a' }], ['session', { op: 'stop', site: 'a' }]] as const) {
      await expect(dispatch(method, params)).rejects.toMatchObject({ kind: 'bad-args', hint: 'bro session quit <site>' });
    }
    for (const v of describeDoc().verbs as Array<{ name: string }>) {
      try { await dispatch(v.name.replaceAll(' ', '.'), {}); }
      catch (error) { expect((error as { rpcKind?: string }).rpcKind).not.toBe('unknown-method'); }
    }
  });
});
