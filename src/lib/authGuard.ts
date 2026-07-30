import type { Page } from 'playwright';
import type { SiteConfig } from './types.ts';
import { authExpired } from './errors.ts';

export const DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS = 8 * 60 * 1000;

export interface AwaitInteractiveLoginOptions {
  timeoutMs?: number;
  fatal?: boolean;
}

/**
 * Is the current page an authenticated session for this site? Per-site `authedWhen` (G6):
 * - urlNot: we must NOT be on this URL (typically the login page)
 * - selector: an element present only when authed (more reliable for SPA banks whose URL does
 *   not change between logged-out and logged-in)
 * With neither set, falls back to "not on the login URL".
 */
export async function isAuthed(page: Page, site: SiteConfig, selectorTimeoutMs = 3000): Promise<boolean> {
  const rule = site.authedWhen ?? {};
  const forbidden = rule.urlNot ?? site.loginUrl;
  if (forbidden && urlMatches(page.url(), forbidden)) return false;
  if (rule.selector) {
    return page
      .locator(rule.selector)
      .first()
      .waitFor({ state: 'attached', timeout: selectorTimeoutMs })
      .then(() => true)
      .catch(() => false);
  }
  return true;
}

/**
 * Navigate to the authenticated home and confirm we're still logged in.
 * Throws auth-expired (needsHuman) on failure -- never silently proceeds.
 */
export async function authGuard(page: Page, site: SiteConfig): Promise<void> {
  await page.goto(site.homeUrl, { waitUntil: 'domcontentloaded' });
  if (!(await isAuthed(page, site, 8000))) throw authExpired(site.id);
}

/**
 * Interactive login (site.interactive === true): open the authenticated home; if not already
 * logged in, prompt the human and POLL until they reach the dashboard, then return so the workflow
 * runs in the SAME live session. For sites (banks) whose sessions cannot be stored for unattended
 * runs. Throws auth-expired only if the human does not log in within `timeoutMs`.
 */
export async function awaitInteractiveLogin(
  page: Page,
  site: SiteConfig,
  log: (msg: string, extra?: Record<string, unknown>) => void,
  opts: AwaitInteractiveLoginOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS;
  const fatal = opts.fatal ?? true;
  await page.goto(site.homeUrl, { waitUntil: 'domcontentloaded' });
  if (await isAuthed(page, site, 5000)) {
    log('authed (session still live -- no login needed)');
    return true;
  }
  process.stderr.write(
    `\n[bro] Log in to ${site.name} in the opened window (username, password, MFA).\n` +
      `      I'll continue automatically the moment you reach the dashboard.\n\n`,
  );
  log('waiting for interactive login');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    if (await isAuthed(page, site, 1500)) {
      log('interactive login detected');
      return true;
    }
  }
  if (!fatal) return false;
  throw authExpired(site.id);
}

/** loose prefix/substring match so a bare "https://x/login" catches "https://x/login?redirect=..." */
function urlMatches(url: string, needle: string): boolean {
  return url === needle || url.startsWith(needle) || url.includes(needle);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
