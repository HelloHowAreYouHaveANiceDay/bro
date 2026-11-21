import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from './testWsServer.ts';
import { PageCDP, gotoUrl, clickSelector, type TabInfo } from './page.ts';
import { Human, TYPE_BUDGET_MS, seededRng, type HumanPage } from './human.ts';
import { pageOptsFromParams } from './verbs.ts';

function fakePage() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const exprs: string[] = [];
  const page: HumanPage = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      return {};
    },
    evaluate: async (e) => {
      exprs.push(e);
      return { w: 1000, h: 700 };
    },
  };
  return { page, calls, exprs };
}

describe('type is bounded', () => {
  const total = (sleeps: number[]) => sleeps.reduce((a, b) => a + b, 0);
  for (const n of [5, 21, 60, 300, 20000]) {
    it(`${n} chars: total delay <= ${TYPE_BUDGET_MS} ms`, async () => {
      const sleeps: number[] = [];
      const { page } = fakePage();
      const h = new Human(page, { rng: seededRng(n), sleep: async (ms) => void sleeps.push(ms) });
      await h.type('a1B'.repeat(Math.ceil(n / 3)).slice(0, n), { typos: true });
      expect(total(sleeps)).toBeLessThanOrEqual(TYPE_BUDGET_MS);
    });
  }

  it('short values stay per-key; long values paste in few chunks with exact content', async () => {
    const short = fakePage();
    await new Human(short.page, { rng: seededRng(1), sleep: async () => {} }).type('123456');
    expect(short.calls.some((c) => c.method === 'Input.insertText')).toBe(false);
    expect(short.calls.filter((c) => c.params['type'] === 'keyDown').length).toBe(6);

    const long = fakePage();
    const text = 'lorem ipsum, "dolor" sit amet\n'.repeat(200);
    await new Human(long.page, { rng: seededRng(2), sleep: async () => {} }).type(text);
    const inserts = long.calls.filter((c) => c.method === 'Input.insertText');
    expect(inserts.length).toBeGreaterThan(1);
    expect(inserts.length).toBeLessThanOrEqual(20);
    expect(inserts.map((c) => c.params['text']).join('')).toBe(text);
    expect(long.calls.filter((c) => c.params['type'] === 'keyDown').length).toBe(0);
  });

  it('does not strand its sleep override after typing', async () => {
    const sleeps: number[] = [];
    const { page } = fakePage();
    const h = new Human(page, { rng: seededRng(3), sleep: async (ms) => void sleeps.push(ms) });
    await h.type('x'.repeat(5000));
    sleeps.length = 0;
    await h.press('Enter');
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((s) => s >= 20)).toBe(true);
  });
});

describe('no page global for the cursor', () => {
  it('never evaluates or writes __broCursor in the page', async () => {
    const { page, exprs } = fakePage();
    const h = new Human(page, { rng: seededRng(5), sleep: async () => {} });
    await h.move({ x: 400, y: 300 });
    await h.click({ box: async () => ({ x: 10, y: 20, width: 80, height: 30 }) });
    expect(exprs.some((e) => e.includes('__broCursor'))).toBe(false);
    expect((await h.cursor()).x).toBeGreaterThan(0);
  });
});

describe('goto click guard', () => {
  const tab: TabInfo = { id: 'T', type: 'page', url: 'https://x.test/', title: '' };
  const BOX = { x: 300, y: 200, width: 120, height: 36 };
  const ev = (v: unknown) => ({ result: { value: v } });
  async function run(
    opts: { onClickHref?: string; linkBox?: unknown },
    fn: (cdp: PageCDP, log: Array<{ method: string; params: Record<string, unknown> }>) => Promise<void>,
  ) {
    const log: Array<{ method: string; params: Record<string, unknown> }> = [];
    let href = 'https://x.test/';
    const srv = await WebSocketServer.start((msg, send) => {
      const { id, method, params } = msg as { id: number; method: string; params: Record<string, unknown> };
      log.push({ method, params });
      let result: unknown = {};
      if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mouseReleased' && opts.onClickHref) href = opts.onClickHref;
      if (method === 'Page.navigate') href = String(params['url']);
      if (method === 'Runtime.evaluate') {
        const e = String(params['expression']);
        if (e === 'location.href') result = ev(href);
        else if (e.includes('innerWidth')) result = ev({ w: 1000, h: 700 });
        else if (e.includes('return {x:')) result = ev(opts.linkBox === undefined ? BOX : opts.linkBox);
        else result = ev(null);
      }
      send({ id, result });
    });
    const cdp = await PageCDP.connect({ ...tab, webSocketDebuggerUrl: srv.url });
    try {
      await fn(cdp, log);
    } finally {
      cdp.close();
      await srv.stop();
    }
  }
  const quiet = { rng: seededRng(1), sleep: async () => {} };

  it('the link finder only matches exact-href, handler-free, same-origin anchors', async () => {
    await run({ onClickHref: 'https://x.test/docs' }, async (cdp, log) => {
      await gotoUrl(cdp, 'https://x.test/docs', 1000, { ...quiet, clickWaitMs: 200 });
      const js = String(
        log.find((l) => l.params['expression'] && String(l.params['expression']).includes('return {x:'))!.params['expression'],
      );
      expect(js).toContain('a.href === want.href');
      expect(js).toContain("hasAttribute('onclick')");
      expect(js).toContain("typeof a.onclick !== 'function'");
      expect(js).toContain("closest('form')");
      expect(js).toContain('want.origin !== location.origin');
      expect(js).not.toContain('.hash = ');
    });
  });

  it('clicks when a link matches and the URL changes (SPA route, no load event)', async () => {
    await run({ onClickHref: 'https://x.test/docs' }, async (cdp, log) => {
      const t0 = Date.now();
      const r = await gotoUrl(cdp, 'https://x.test/docs', 15000, { ...quiet, clickWaitMs: 2000 });
      expect(r).toEqual({ url: 'https://x.test/docs', via: 'click' });
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(log.some((l) => l.method === 'Page.navigate')).toBe(false);
    });
  });

  it('falls back to direct navigation after the short bound when the click does nothing (no 15s wait)', async () => {
    await run({}, async (cdp, log) => {
      const t0 = Date.now();
      const r = await gotoUrl(cdp, 'https://x.test/docs', 1000, { ...quiet, clickWaitMs: 150 });
      expect(r.via).toBe('navigate');
      expect(log.some((l) => l.method === 'Page.navigate')).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2500);
    });
  });

  it('navigates directly when no safe link exists', async () => {
    await run({ linkBox: null }, async (cdp, log) => {
      const r = await gotoUrl(cdp, 'https://x.test/docs', 100, { ...quiet });
      expect(r.via).toBe('navigate');
      expect(log.some((l) => l.params['type'] === 'mousePressed')).toBe(false);
    });
  });

  it('click with yolo is the 3-event teleport (what upload --click now passes through)', async () => {
    await run({}, async (cdp, log) => {
      await clickSelector(cdp, '#b', { yolo: true });
      const types = log.filter((l) => l.method === 'Input.dispatchMouseEvent').map((l) => l.params['type']);
      expect(types).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    });
  });
});

describe('--yolo and deprecated --raw', () => {
  it('pageOptsFromParams maps yolo and raw to yolo', () => {
    expect(pageOptsFromParams({ yolo: true })).toMatchObject({ yolo: true });
    expect(pageOptsFromParams({ yolo: 'true' })).toMatchObject({ yolo: true });
    expect(pageOptsFromParams({ raw: true })).toMatchObject({ yolo: true });
    expect(pageOptsFromParams({})).not.toHaveProperty('yolo');
    expect(pageOptsFromParams({})).not.toHaveProperty('raw');
  });

  const home = mkdtempSync(join(tmpdir(), 'bro-yolo-home-'));
  const sites = mkdtempSync(join(tmpdir(), 'bro-yolo-sites-'));
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30000, env: { ...process.env, BRO_HOME: home, BRO_SITES_DIR: sites },
    });
  const WARN = '--raw is deprecated, use --yolo';

  it('--yolo is accepted silently', () => {
    const r = cli(['page', 'exec', 'nosuchsite', 'tabs', '--yolo', '--json']);
    expect(r.stderr).not.toContain(WARN);
    expect(r.stdout).toContain('no-such-site');
  });

  it('--raw still works and warns exactly once on stderr', () => {
    const r = cli(['page', 'exec', 'nosuchsite', 'tabs', '--raw', '--raw', '--json']);
    expect(r.stderr.split(WARN).length - 1).toBe(1);
    expect(r.stdout).toContain('no-such-site');
  });
});
