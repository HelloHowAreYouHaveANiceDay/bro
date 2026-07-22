import type { Page } from 'playwright';
import type { SiteConfig } from './types.ts';
import { authExpired } from './errors.ts';

/**
 * Navigate to the site's authenticated home and confirm we're still logged in.
 * Per-site `authedWhen` (G6): a selector that only exists when authed, and/or a URL we must NOT
 * have landed on (typically the login page). Falls back to "did we get redirected to loginUrl".
 * Throws auth-expired (needsHuman) on failure — never silently proceeds.
 */
export async function authGuard(page: Page, site: SiteConfig): Promise<void> {
  await page.goto(site.homeUrl, { waitUntil: 'domcontentloaded' });

  const rule = site.authedWhen ?? {};
  const finalUrl = page.url();

  // 1. explicit "must not be here" URL (default: the login URL)
  const forbidden = rule.urlNot ?? site.loginUrl;
  if (forbidden && urlMatches(finalUrl, forbidden)) {
    throw authExpired(site.id);
  }

  // 2. an authed-only selector, if configured
  if (rule.selector) {
    const ok = await page
      .locator(rule.selector)
      .first()
      .waitFor({ state: 'attached', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) throw authExpired(site.id);
  }
}

/** loose prefix/substring match so a bare "https://x/login" catches "https://x/login?redirect=..." */
function urlMatches(url: string, needle: string): boolean {
  return url === needle || url.startsWith(needle) || url.includes(needle);
}
