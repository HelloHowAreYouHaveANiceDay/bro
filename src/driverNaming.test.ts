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

  it('publishes the canonical typed arguments and effects', () => {
    const verbs = describeDoc().verbs as Array<{ name: string; args: Array<{ name: string; type: string }>; effect: string; supports_dry_run?: boolean }>;
    const byName = Object.fromEntries(verbs.map((verb) => [verb.name, verb]));
    expect(byName['workflow run']?.args.map((arg) => arg.name)).toEqual(['site', 'workflow', 'month', 'date-stamp', 'headed', 'dry-run']);
    expect(byName['workflow run-all']?.args.map((arg) => arg.name)).toEqual(['kind', 'month', 'dry-run']);
    expect(byName['workflow run-all']?.supports_dry_run).toBe(true);
    expect(byName['page exec']?.args.map((arg) => [arg.name, arg.type])).toEqual([
      ['site', 'string'], ['action', 'string'], ['arg', 'string'], ['tab', 'string'], ['wait', 'int'], ['max', 'int'],
      ['reload', 'bool'], ['full', 'bool'], ['out', 'path'],
    ]);
    expect(Object.fromEntries(verbs.map((verb) => [verb.name, verb.effect]))).toEqual({
      doctor: 'read', version: 'read', 'site list': 'read', 'session list': 'read', 'session launch': 'mutate',
      'session quit': 'mutate', 'page open': 'mutate', 'page exec': 'mutate', 'workflow run': 'mutate',
      'workflow run-all': 'mutate', 'auth login': 'mutate',
    });
  });

  it('supports run-all dry runs with canonical and legacy parameter names', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'bro-naming-home-'));
    tempSites = mkdtempSync(join(tmpdir(), 'bro-naming-sites-'));
    process.env.BRO_HOME = tempHome;
    process.env.BRO_SITES_DIR = tempSites;
    await expect(dispatch('workflow.run-all', { kind: 'invoices', 'dry-run': true })).resolves.toEqual({ summary: [], dry_run: true });
    await expect(dispatch('workflow.run-all', { kind: 'invoices', dry_run: true })).resolves.toEqual({ summary: [], dry_run: true });
    await expect(dispatch('workflow.run-all', { kind: 'invoices' })).resolves.toEqual({ summary: [] });
    await expect(dispatch('workflow.run-all', { kind: 'invoices', 'dry-run': false, dryRun: true })).resolves.toEqual({ summary: [] });
    await expect(dispatch('run-all', { kind: 'invoices', 'dry-run': true })).resolves.toEqual({ summary: [], dry_run: true });
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
