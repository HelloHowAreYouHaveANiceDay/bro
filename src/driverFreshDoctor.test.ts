// Fresh-install doctor: playwright/chromium are optional until the bro runtime has been set up.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const pwState = vi.hoisted(() => ({ pw: null as unknown }));
vi.mock('./lib/playwright.ts', () => ({
  loadPlaywright: () => { if (!pwState.pw) throw new Error('absent'); return pwState.pw; },
}));
import { doctor } from './driver.ts';

type Check = { name: string; ok: boolean; optional?: boolean; hint?: string; fix_cmd?: string };

describe('doctor playwright/chromium vs runtime dir', () => {
  let home: string;
  let rt: string;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { BRO_HOME: process.env.BRO_HOME, BRO_RUNTIME: process.env.BRO_RUNTIME };
    home = mkdtempSync(join(tmpdir(), 'bro-fd-'));
    rt = join(home, 'runtime');
    process.env.BRO_HOME = home;
    process.env.BRO_RUNTIME = rt;
    pwState.pw = null;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });
  const get = async (n: string) => ((await doctor()) as { checks: Check[] }).checks.find((c) => c.name === n)!;

  it('runtime never set up: both checks optional with the setup command', async () => {
    const p = await get('dep:playwright');
    const b = await get('browser:chromium');
    expect(p.ok).toBe(false);
    expect(p.optional).toBe(true);
    expect(b.optional).toBe(true);
    expect(p.hint).toContain('playwright');
    expect(p.fix_cmd).toContain('npm i --prefix');
    expect(b.fix_cmd).toContain('install chromium');
  });

  it('runtime exists but playwright missing: stays required', async () => {
    mkdirSync(rt, { recursive: true });
    expect((await get('dep:playwright')).optional).toBe(false);
    expect((await get('browser:chromium')).optional).toBe(false);
  });

  it('playwright present but chromium missing: chromium stays required', async () => {
    mkdirSync(rt, { recursive: true });
    pwState.pw = { chromium: { executablePath: () => join(home, 'nope.exe') } };
    expect((await get('dep:playwright')).ok).toBe(true);
    const b = await get('browser:chromium');
    expect(b.ok).toBe(false);
    expect(b.optional).toBe(false);
  });
});
