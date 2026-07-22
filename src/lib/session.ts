import fs from 'node:fs';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { SiteConfig } from './types.ts';
import { authPath, authMetaPath } from './paths.ts';
import { authExpired } from './errors.ts';

export interface Session {
  browser: Browser;
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
  const statePath = authPath(site.id);
  if (!fs.existsSync(statePath)) throw authExpired(site.id);

  const browser = await chromium.launch({
    channel: opts.channel,
    headless: !(opts.headed || site.headed),
  });
  const context = await browser.newContext({
    storageState: statePath,
    acceptDownloads: true,
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
