import fs from 'node:fs';
import { BroError } from './errors.ts';
import { loadSite } from './registry.ts';
import { startDetached, liveSession } from './detach.ts';
import {
  resolveLive, listTabs, pickTab, PageCDP, clickSelector, typeText, pressKey, gotoUrl, screenshot,
  captureResponses, openTab, closeTab,
} from './page.ts';

/**
 * The `open` and `page` verbs, shared by the CLI (src/cli.ts) and the bim driver (src/driver.ts)
 * so `bro page ...` and `bim bro page ...` behave identically. Pure: returns a result object, prints
 * nothing.
 */

export const PAGE_ACTIONS = ['tabs', 'text', 'eval', 'goto', 'click', 'type', 'key', 'shot', 'capture', 'close'] as const;

export const PAGE_USAGE =
  'usage: bro page <site> tabs | text [--max N] | eval <js> | goto <url> [--wait ms] | click <css> | type <text> | key <Key> | shot <out.png> [--full] | capture <url-substr> [--reload] [--wait ms] [--out file] | close  [--tab <id|url-substr>]';

export interface PageOpts {
  tab?: string;
  wait?: number;
  max?: number;
  reload?: boolean;
  full?: boolean;
  out?: string;
}

export async function openUrl(url: string, siteId = 'scratch'): Promise<Record<string, unknown>> {
  if (!url) throw new BroError('bad-args', 'usage: bro open <url> [--site <id>]');
  loadSite(siteId);
  let live = await liveSession(siteId);
  let started = false;
  if (!live) {
    if (siteId !== 'scratch')
      throw new BroError('no-session', `no LIVE session for "${siteId}"`, { retriable: true, hint: `bro session start ${siteId} --detach` });
    await startDetached(siteId);
    live = await liveSession(siteId);
    started = true;
    if (!live) throw new BroError('internal', 'scratch session did not come up');
  }
  const tab = await openTab(live.port, url);
  return { site: siteId, port: live.port, tab: tab.id, url, startedSession: started };
}

export async function pageAction(siteId: string, action: string, arg: string | undefined, opts: PageOpts = {}): Promise<Record<string, unknown>> {
  if (!siteId || !action) throw new BroError('bad-args', PAGE_USAGE);
  if (!(PAGE_ACTIONS as readonly string[]).includes(action)) throw new BroError('bad-args', `unknown page action "${action}"`, { hint: PAGE_USAGE });
  const site = loadSite(siteId);
  const live = await resolveLive(siteId);
  const tabs = await listTabs(live.port);
  if (action === 'tabs') return { site: siteId, port: live.port, tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })) };
  const tab = pickTab(tabs, opts.tab, [site.homeUrl, site.loginUrl]);
  if (action === 'close') {
    await closeTab(live.port, tab.id);
    return { site: siteId, tab: tab.id, status: 'closed' };
  }
  const need = (what: string) => {
    if (arg === undefined || arg === '') throw new BroError('bad-args', `usage: bro page <site> ${action} <${what}>`);
    return arg;
  };
  const wait = opts.wait ?? 0;
  const cdp = await PageCDP.connect(tab);
  try {
    let result: Record<string, unknown>;
    switch (action) {
      case 'text': {
        const text = String((await cdp.evaluate('document.body ? document.body.innerText : ""')) ?? '');
        result = { url: await cdp.evaluate('location.href'), length: text.length, text: text.slice(0, opts.max ?? 20000) };
        break;
      }
      case 'eval':
        result = { value: await cdp.evaluate(need('js expression')) };
        break;
      case 'goto':
        result = { url: await gotoUrl(cdp, need('url'), wait || 15000) };
        break;
      case 'click': {
        const sel = need('css selector');
        await clickSelector(cdp, sel);
        if (wait) await new Promise((r) => setTimeout(r, wait));
        result = { clicked: sel, url: await cdp.evaluate('location.href') };
        break;
      }
      case 'type': {
        if (arg === undefined) throw new BroError('bad-args', 'usage: bro page <site> type <text>  (types into the focused element; click it first)');
        await typeText(cdp, arg);
        result = { typed: arg.length };
        break;
      }
      case 'key': {
        const k = need('Enter|Tab|Escape|...');
        await pressKey(cdp, k);
        result = { key: k };
        break;
      }
      case 'shot':
        result = await screenshot(cdp, need('out.png'), !!opts.full);
        break;
      case 'capture': {
        const match = need('url-substr');
        const rows = await captureResponses(cdp, match, { reload: !!opts.reload, waitMs: wait || 15000 });
        if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(rows));
        result = { match, count: rows.length, ...(opts.out ? { out: opts.out } : { responses: rows }) };
        break;
      }
      default:
        throw new BroError('bad-args', `unknown page action "${action}"`, { hint: PAGE_USAGE });
    }
    return { site: siteId, tab: tab.id, ...result };
  } finally {
    cdp.close();
  }
}
