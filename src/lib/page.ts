import http from 'node:http';
import fs from 'node:fs';
import { BroError } from './errors.ts';
import { getSession, probeCDP, type LiveSession } from './sessions.ts';

/**
 * Page-level CDP verbs for a LIVE session (`bro page <site> ...`, `bro open <url>`).
 *
 * Agents address a session by SITE ID, never by port: the port changes on every session restart and
 * several sites share the 9222+ range, so a hand-carried port lands on the wrong browser. Everything
 * here talks raw CDP over loopback (Node >= 22 global WebSocket) -- no Playwright attach, so a
 * page verb can never close or take over the human's live session.
 */

export interface TabInfo {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/** true when `pid` is a running process (signal 0 = existence probe; EPERM still means alive). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The LIVE session for `site`, or a `no-session` error with the command that fixes it. A registry row
 * whose host pid is gone, or whose port no longer answers CDP, is stale and treated as absent.
 */
export async function resolveLive(
  site: string,
  deps: { get?: (s: string) => LiveSession | undefined; alive?: (pid: number) => boolean; probe?: (port: number) => Promise<string | null> } = {},
): Promise<LiveSession> {
  const get = deps.get ?? getSession;
  const alive = deps.alive ?? pidAlive;
  const probe = deps.probe ?? ((p: number) => probeCDP(p));
  const live = get(site);
  if (!live || !alive(live.pid) || !(await probe(live.port))) {
    throw new BroError('no-session', `no LIVE session for "${site}"`, {
      hint: `bro session start ${site} --detach`,
      retriable: true,
    });
  }
  return live;
}

function httpJson(port: number, path: string, method = 'GET', timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`CDP ${path} timed out`));
    });
    req.end();
  });
}

export async function listTabs(port: number): Promise<TabInfo[]> {
  const rows = (await httpJson(port, '/json/list')) as TabInfo[];
  return (rows || []).filter((t) => t.type === 'page');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** registrable-ish domain: last two labels (enough to tie login.x.com and members.x.com together). */
function baseDomain(host: string): string {
  const parts = host.split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

/**
 * Pick ONE tab. `want` = a tab id (or unique id prefix) or a URL substring. Without `want`, prefer the
 * single tab on the site's own domain (from its home/login URL), else the only tab. Ambiguity is an
 * error that lists the candidates instead of guessing.
 */
export function pickTab(tabs: TabInfo[], want: string | undefined, siteUrls: string[] = []): TabInfo {
  const list = (ts: TabInfo[]) => ts.map((t) => ({ id: t.id, url: t.url }));
  if (want) {
    const byId = tabs.filter((t) => t.id === want || t.id.startsWith(want));
    if (byId.length === 1) return byId[0]!;
    const byUrl = tabs.filter((t) => t.url.includes(want));
    if (byUrl.length === 1) return byUrl[0]!;
    if (byUrl.length > 1)
      throw new BroError('bad-args', `--tab "${want}" matches ${byUrl.length} tabs`, { detail: { tabs: list(byUrl) }, hint: 'pass a tab id from `bro page <site> tabs`' });
    throw new BroError('bad-args', `no tab matches --tab "${want}"`, { detail: { tabs: list(tabs) } });
  }
  const domains = new Set(siteUrls.map((u) => baseDomain(hostOf(u))).filter((d) => d && d !== 'blank'));
  if (domains.size) {
    const own = tabs.filter((t) => domains.has(baseDomain(hostOf(t.url))));
    if (own.length === 1) return own[0]!;
    if (own.length > 1)
      throw new BroError('bad-args', `${own.length} tabs are on the site's domain; pick one with --tab`, { detail: { tabs: list(own) } });
  }
  if (tabs.length === 1) return tabs[0]!;
  throw new BroError('bad-args', tabs.length ? `${tabs.length} tabs open; pick one with --tab` : 'no page tabs open', {
    detail: { tabs: list(tabs) },
  });
}

/** One CDP connection to a page target. */
export class PageCDP {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        if (m.error) p.reject(new BroError('cdp-error', m.error.message || 'CDP error'));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const l of this.listeners) l(m.method, m.params || {});
      }
    };
  }

  static async connect(tab: TabInfo, timeoutMs = 8000): Promise<PageCDP> {
    if (!tab.webSocketDebuggerUrl) throw new BroError('cdp-error', `tab ${tab.id} is already attached by another debugger client`);
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new BroError('cdp-error', 'CDP connect timed out')), timeoutMs);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new BroError('cdp-error', 'CDP connect failed'));
      };
    });
    return new PageCDP(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new BroError('cdp-error', `${method} timed out`, { retriable: true }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(fn: (method: string, params: Record<string, unknown>) => void): void {
    this.listeners.push(fn);
  }

  /** Evaluate an expression in the page (awaits promises); returns the JSON value or throws the page error. */
  async evaluate(expression: string, timeoutMs = 30000): Promise<unknown> {
    const r = await this.send<{ result: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new BroError('page-error', r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page exception');
    }
    return r.result.value ?? r.result.description ?? null;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Center of the first VISIBLE element matching `selector`, scrolled into view; null if none. */
const CENTER_JS = (selector: string) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = els.find(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; });
  if (!el) return null;
  el.scrollIntoView({block: 'center', inline: 'center'});
  const r = el.getBoundingClientRect();
  return {x: r.left + r.width / 2, y: r.top + r.height / 2};
})()`;

export async function clickSelector(cdp: PageCDP, selector: string): Promise<void> {
  const pt = (await cdp.evaluate(CENTER_JS(selector))) as { x: number; y: number } | null;
  if (!pt) throw new BroError('not-found', `no visible element matches ${selector}`);
  await sleep(80);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

export async function typeText(cdp: PageCDP, text: string): Promise<void> {
  await cdp.send('Input.insertText', { text });
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
};

export async function pressKey(cdp: PageCDP, key: string): Promise<void> {
  const k = KEYS[key];
  if (!k) throw new BroError('bad-args', `unsupported key "${key}"`, { hint: `keys: ${Object.keys(KEYS).join(', ')}` });
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text ? { text: k.text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function gotoUrl(cdp: PageCDP, url: string, waitMs: number): Promise<string> {
  await cdp.send('Page.enable');
  const loaded = new Promise<void>((resolve) => {
    cdp.on((method) => {
      if (method === 'Page.loadEventFired') resolve();
    });
  });
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(waitMs)]);
  return String(await cdp.evaluate('location.href'));
}

export async function screenshot(cdp: PageCDP, out: string, fullPage = false): Promise<{ path: string; bytes: number }> {
  const r = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(out, buf);
  return { path: out, bytes: buf.length };
}

/**
 * Capture response bodies whose URL contains `match` (the page's own XHR/fetch calls, made with its
 * own auth headers -- the data an in-page fetch() replay can't get). Optionally reloads the page to
 * trigger them. Returns `{url, status, mimeType, body}` rows; JSON bodies are parsed.
 */
export async function captureResponses(
  cdp: PageCDP,
  match: string,
  opts: { reload: boolean; waitMs: number },
): Promise<Array<{ url: string; status: number; mimeType: string; body: unknown }>> {
  const want = new Map<string, { url: string; status: number; mimeType: string }>();
  const done: Array<Promise<{ url: string; status: number; mimeType: string; body: unknown } | null>> = [];
  cdp.on((method, p) => {
    if (method === 'Network.responseReceived') {
      const resp = p['response'] as { url: string; status: number; mimeType: string };
      if (resp.url.includes(match)) want.set(String(p['requestId']), { url: resp.url, status: resp.status, mimeType: resp.mimeType });
    }
    if (method === 'Network.loadingFinished' && want.has(String(p['requestId']))) {
      const meta = want.get(String(p['requestId']))!;
      done.push(
        cdp
          .send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: p['requestId'] })
          .then((b) => {
            const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {
              /* keep text */
            }
            return { ...meta, body };
          })
          .catch(() => null),
      );
    }
  });
  await cdp.send('Network.enable', { maxResourceBufferSize: 50_000_000, maxTotalBufferSize: 100_000_000 });
  if (opts.reload) await cdp.send('Page.reload', {});
  await sleep(opts.waitMs);
  const rows = (await Promise.all(done)).filter((r): r is NonNullable<typeof r> => !!r);
  return rows;
}

/** Open a new tab on `url` in the browser on `port` (CDP /json/new). */
export async function openTab(port: number, url: string): Promise<TabInfo> {
  // /json/new drops a #fragment; navigate the new tab to the full URL afterwards when there is one.
  const tab = (await httpJson(port, `/json/new?${encodeURI(url.split('#')[0] || 'about:blank')}`, 'PUT')) as TabInfo;
  if (url.includes('#')) {
    const cdp = await PageCDP.connect(tab);
    try {
      await cdp.send('Page.navigate', { url });
    } finally {
      cdp.close();
    }
  }
  return tab;
}

export async function closeTab(port: number, id: string): Promise<void> {
  await httpJson(port, `/json/close/${encodeURIComponent(id)}`);
}
