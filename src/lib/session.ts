import fs from 'node:fs';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { SiteConfig } from './types.ts';
import { authPath, authMetaPath, profileDir } from './paths.ts';
import { authExpired } from './errors.ts';
import { getSession, probeCDP, pickPort } from './sessions.ts';

export interface Session {
  /** absent in persistent mode (launchPersistentContext owns its own browser) */
  browser?: Browser;
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * Launch a browser and open a context pre-loaded with the site's saved storageState.
 * Throws auth-expired if no auth.json exists yet.
 */
export async function openSession(
  site: SiteConfig,
  opts: { channel: string; headed?: boolean },
): Promise<Session> {
  // 1. Live session (from `bro session start`): attach over CDP and REUSE the logged-in context.
  //    Never close the externally-owned browser -- the session stays alive for the next run.
  const live = getSession(site.id);
  if (live && (await probeCDP(live.port))) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${live.port}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return {
      browser,
      context,
      close: async () => {
        /* keep the live session alive; our CDP connection drops when this process exits */
      },
    };
  }

  // Persistent mode: drive the REAL installed browser (Chrome/Edge) on a per-site profile, inheriting
  // a genuine device fingerprint + the profile's own login cookies. No auth.json/storageState -- the
  // profile carries the session. For hardened fingerprinting sites that block a fresh context.
  if (site.browser === 'persistent') {
    const dir = profileDir(site.id);
    fs.mkdirSync(dir, { recursive: true });
    const context = await chromium.launchPersistentContext(dir, {
      channel: opts.channel,
      headless: false, // persistent + headless defeats the purpose and is itself detectable
      acceptDownloads: true,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    });
    return { context, close: async () => { await context.close(); } };
  }

  const statePath = authPath(site.id);
  if (!fs.existsSync(statePath)) throw authExpired(site.id);

  const browser = await chromium.launch({
    channel: opts.channel,
    headless: !(opts.headed || site.headed),
    // suppress the loudest automation signal so bot-detection (e.g. Cloudflare) doesn't challenge/block
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: statePath,
    acceptDownloads: true,
    viewport: null,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return {
    browser,
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Persist the (possibly refreshed) storageState back to auth.json after a successful run,
 * so rotating-cookie sessions live longer (G9). Re-stamps auth.meta.json's refreshedAt.
 */
export async function persistState(site: SiteConfig, context: BrowserContext, stampIso: string): Promise<void> {
  await context.storageState({ path: authPath(site.id) });
  const metaPath = authMetaPath(site.id);
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* first write */
  }
  meta['refreshedAt'] = stampIso;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
}

/**
 * Launch a long-lived persistent session with a CDP debug port. The caller (`bro session start`)
 * keeps its process alive holding this open; `openSession` attaches to it over the port. Returns the
 * live context + the chosen CDP port.
 */
export async function startPersistentSession(
  site: SiteConfig,
  opts: { channel: string },
): Promise<{ context: BrowserContext; port: number }> {
  const dir = profileDir(site.id);
  fs.mkdirSync(dir, { recursive: true });
  const port = await pickPort();
  const context = await chromium.launchPersistentContext(dir, {
    channel: opts.channel,
    headless: false,
    acceptDownloads: true,
    viewport: null,
    args: [
      `--remote-debugging-port=${port}`,
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  });
  return { context, port };
}
