import fs from 'node:fs';
import type { Browser, BrowserContext } from 'playwright';
import type { SiteConfig } from './types.ts';
import { loadPlaywright } from './playwright.ts';
import { authPath, authMetaPath, profileDir } from './paths.ts';

// See context.ts: load via createRequire (runtime-dir-pinned in the SEA), not a static import.
const { chromium } = loadPlaywright();
import { authExpired } from './errors.ts';
import { getSession, probeCDP, pickPort } from './sessions.ts';
import type { LiveSession } from './sessions.ts';
import { DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS } from './authGuard.ts';

/** A randomized, non-maximized window size (avoids a fixed fingerprint + doesn't hog the screen). */
function randomWindowSizeArg(): string {
  const width = 1100 + Math.floor(Math.random() * 300); // 1100-1400
  const height = 780 + Math.floor(Math.random() * 220); // 780-1000
  return `--window-size=${width},${height}`;
}

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
      args: ['--disable-blink-features=AutomationControlled', randomWindowSizeArg()],
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
      randomWindowSizeArg(),
    ],
  });
  return { context, port };
}

export interface RunLiveSessionOptions {
  site: Pick<SiteConfig, 'id' | 'name'>;
  port: number;
  pid: number;
  startedAt: string;
  detectionTimeoutMs?: number;
  setSession: (session: LiveSession) => void;
  removeSession: (siteId: string) => void;
  emitLive: () => void;
  detectLogin: () => Promise<boolean>;
  keepAlive: () => Promise<void>;
  closeContext: () => Promise<void>;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  onContextClose: (handler: () => void) => void;
  writeStderr: (msg: string) => void;
  exit: (code: number) => void;
}

export async function runLiveSession(opts: RunLiveSessionOptions): Promise<void> {
  opts.setSession({
    site: opts.site.id,
    port: opts.port,
    pid: opts.pid,
    startedAt: opts.startedAt,
  });
  opts.emitLive();

  const shutdown = async () => {
    opts.removeSession(opts.site.id);
    await opts.closeContext().catch(() => {});
    opts.exit(0);
  };
  opts.onSignal('SIGINT', () => {
    void shutdown();
  });
  opts.onSignal('SIGTERM', () => {
    void shutdown();
  });
  opts.onContextClose(() => {
    opts.removeSession(opts.site.id);
    opts.exit(0);
  });

  const detectionTimeoutMs = opts.detectionTimeoutMs ?? DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS;
  let confirmed = false;
  try {
    confirmed = await opts.detectLogin();
  } catch {
    confirmed = false;
  }

  if (confirmed) {
    opts.writeStderr('[bro] login confirmed.\n');
  } else {
    const timeoutSeconds = Math.max(1, Math.round(detectionTimeoutMs / 1000));
    opts.writeStderr(
      `[bro] couldn't auto-confirm login within ${timeoutSeconds}s -- assuming co-present, session stays live.\n`,
    );
  }

  await opts.keepAlive();
}
