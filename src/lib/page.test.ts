import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from './testWsServer.ts';
import { pickTab, resolveLive, pidAlive, PageCDP, listTabs, captureResponses, type TabInfo } from './page.ts';
import { detachedArgv, startDetached, DETACHED_ENV } from './detach.ts';
import { pickLoginPage } from './session.ts';
import { loadSite, listSites } from './registry.ts';
import { BroError } from './errors.ts';

const tab = (id: string, url: string): TabInfo => ({ id, type: 'page', url, title: '' });

describe('pickTab', () => {
  const tabs = [tab('AAA111', 'https://login.portal.example/login'), tab('BBB222', 'https://www.example.org/'), tab('CCC333', 'https://news.example.net/a')];

  it('picks by id, id prefix, or unique URL substring', () => {
    expect(pickTab(tabs, 'BBB222').id).toBe('BBB222');
    expect(pickTab(tabs, 'CCC').id).toBe('CCC333');
    expect(pickTab(tabs, 'portal.example').id).toBe('AAA111');
  });

  it("defaults to the single tab on the site's own domain (subdomains tie together)", () => {
    expect(pickTab(tabs, undefined, ['https://members.portal.example/']).id).toBe('AAA111');
  });

  it('refuses to guess between several candidates and lists them', () => {
    const two = [...tabs, tab('DDD444', 'https://members.portal.example/directory')];
    expect(() => pickTab(two, undefined, ['https://members.portal.example/'])).toThrow(/2 tabs/);
    expect(() => pickTab(two, 'portal.example')).toThrow(/matches 2 tabs/);
    expect(() => pickTab(tabs, undefined, ['about:blank'])).toThrow(/3 tabs open/);
    try {
      pickTab(tabs, 'nope');
    } catch (e) {
      expect((e as BroError).detail?.['tabs']).toHaveLength(3);
    }
  });

  it('uses the only tab when there is one', () => {
    expect(pickTab([tabs[1]!], undefined, ['about:blank']).id).toBe('BBB222');
  });
});

describe('resolveLive', () => {
  const sess = { site: 'x', port: 9333, pid: 4242, startedAt: '' };

  it('returns a session whose host pid is alive and port answers', async () => {
    const live = await resolveLive('x', { get: () => sess, alive: () => true, probe: async () => 'ws://x' });
    expect(live.port).toBe(9333);
  });

  it('treats a dead host pid as no session even if the port answers (another browser took it)', async () => {
    await expect(resolveLive('x', { get: () => sess, alive: () => false, probe: async () => 'ws://x' })).rejects.toMatchObject({
      kind: 'no-session',
      hint: 'bro session start x --detach',
    });
  });

  it('treats a closed port or a missing row as no session', async () => {
    await expect(resolveLive('x', { get: () => sess, alive: () => true, probe: async () => null })).rejects.toMatchObject({ kind: 'no-session' });
    await expect(resolveLive('x', { get: () => undefined })).rejects.toMatchObject({ kind: 'no-session' });
  });
});

describe('pidAlive', () => {
  it('is true for this process and false for nonsense pids', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-5)).toBe(false);
  });
});

describe('detachedArgv', () => {
  it('always launches `session start <site>`, never the caller\'s verb (no recursive bro open)', () => {
    expect(detachedArgv('scratch', ['node', '/x/bin/bro.mjs', 'open', 'https://e.test/', '--json'], ['--no-warnings'], false)).toEqual([
      '--no-warnings',
      '/x/bin/bro.mjs',
      'session',
      'start',
      'scratch',
    ]);
  });

  it('passes only the subcommand in SEA mode', () => {
    expect(detachedArgv('a', ['bim-bro.exe', 'bim-bro.exe', 'session', 'start', 'a', '--detach'], [], true)).toEqual(['session', 'start', 'a']);
  });

  it('refuses to detach again from inside a detached host', async () => {
    process.env[DETACHED_ENV] = '1';
    try {
      await expect(startDetached('scratch')).rejects.toThrow(/recurse/);
    } finally {
      delete process.env[DETACHED_ENV];
    }
  });
});

describe('pickLoginPage', () => {
  const p = (url: string) => ({ url: () => url });
  it("reuses a restored tab on the site's domain instead of the first tab", () => {
    const pages = [p('https://other.example.com/'), p('https://login.portal.example/login')];
    expect(pickLoginPage(pages, { homeUrl: 'https://members.portal.example/', loginUrl: 'https://members.portal.example/' })!.url()).toContain('login.portal.example');
  });
  it('falls back to the first tab, or none', () => {
    expect(pickLoginPage([p('https://a.test/')], { homeUrl: 'https://b.test/', loginUrl: 'https://b.test/' })!.url()).toBe('https://a.test/');
    expect(pickLoginPage([], { homeUrl: 'https://b.test/', loginUrl: 'https://b.test/' })).toBeUndefined();
  });
});

describe('built-in scratch site', () => {
  it('loads without a site.json and is listed', () => {
    const s = loadSite('scratch');
    expect(s).toMatchObject({ id: 'scratch', public: true, browser: 'persistent', headed: true });
    expect(listSites({ builtins: true })).toContain('scratch');
    expect(listSites()).not.toContain('scratch');
  });
});

describe('PageCDP against a fake CDP target', () => {
  it('evaluates, surfaces page exceptions, and captures matching response bodies', async () => {
    const srv = await WebSocketServer.start((msg, send) => {
      const { id, method, params } = msg as { id: number; method: string; params: Record<string, unknown> };
      if (method === 'Runtime.evaluate') {
        if (String(params['expression']).includes('throw'))
          return send({ id, result: { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } } });
        return send({ id, result: { result: { value: 42 } } });
      }
      if (method === 'Network.enable') {
        send({ id, result: {} });
        send({ method: 'Network.responseReceived', params: { requestId: 'r1', response: { url: 'https://x.test/api/v1/dir?a=1', status: 200, mimeType: 'application/json' } } });
        send({ method: 'Network.responseReceived', params: { requestId: 'r2', response: { url: 'https://x.test/other', status: 200, mimeType: 'text/html' } } });
        send({ method: 'Network.loadingFinished', params: { requestId: 'r1' } });
        send({ method: 'Network.loadingFinished', params: { requestId: 'r2' } });
        return;
      }
      if (method === 'Network.getResponseBody') return send({ id, result: { body: '[{"name":"A"}]', base64Encoded: false } });
      send({ id, result: {} });
    });
    try {
      const cdp = await PageCDP.connect({ ...tab('T', 'https://x.test/'), webSocketDebuggerUrl: srv.url });
      expect(await cdp.evaluate('6*7')).toBe(42);
      await expect(cdp.evaluate('throw 1')).rejects.toMatchObject({ kind: 'page-error', message: 'Error: boom' });
      const rows = await captureResponses(cdp, '/api/v1/dir', { reload: false, waitMs: 300 });
      expect(rows).toEqual([{ url: 'https://x.test/api/v1/dir?a=1', status: 200, mimeType: 'application/json', body: [{ name: 'A' }] }]);
      cdp.close();
    } finally {
      await srv.stop();
    }
  });

  it('listTabs keeps only page targets', async () => {
    const server = http.createServer((req, res) => {
      res.end(JSON.stringify([tab('1', 'https://a.test/'), { id: '2', type: 'service_worker', url: 'x', title: '' }]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect((await listTabs(port)).map((t) => t.id)).toEqual(['1']);
    } finally {
      server.close();
    }
  });
});
