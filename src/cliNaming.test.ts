import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'bro-cli-naming-home-'));
const sites = mkdtempSync(join(tmpdir(), 'bro-cli-naming-sites-'));
afterAll(() => { rmSync(home, { recursive: true, force: true }); rmSync(sites, { recursive: true, force: true }); });

function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, BRO_HOME: home, BRO_SITES_DIR: sites },
  });
}

describe('CLI verb naming', () => {
  it.each([['session', 'list', '--json'], ['sessions', '--json']])('lists sessions with %j', (...args) => {
    const result = cli(args);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, result: { sessions: [] } });
  });
  it.each([
    ['workflow', 'run', 'nosite', 'wf', '--dry-run', '--json'],
    ['run', 'nosite', 'wf', '--json'],
    ['test', 'nosite', 'wf', '--json'],
  ])('routes workflow aliases %j', (...args) => {
    const result = cli(args);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.split('\n')[0]!).error.kind).toBe('no-such-site');
  });
  it('returns structured bad-args for unknown verbs', () => {
    const result = cli(['bogus-verb', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.split('\n')[0]!).error.kind).toBe('bad-args');
  });
});
