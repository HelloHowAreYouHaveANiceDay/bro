import fs from 'node:fs';
import { chromium } from 'playwright';
import type { SiteConfig } from './types.ts';
import { authPath, authMetaPath } from './paths.ts';

/**
 * Flow A — interactive login capture. Opens a HEADED browser with the automation signals
 * suppressed (many sites, esp. Cloudflare, disable the login form when navigator.webdriver is
 * set), lets the human log in + clear MFA, then saves the storageState.
 *
 * Completion is auto-detected: we poll until the page leaves the login URL (or the site's
 * authedWhen.selector appears). The human can also just close the window when done.
 */
export async function authCapture(site: SiteConfig, channel: string, stampIso: string): Promise<void> {
  const browser = await chromium.launch({
    channel,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const context = await browser.newContext({ viewport: null });
  // hide the two loudest automation tells before any page script runs
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = await context.newPage();

  let closedByUser = false;
  context.on('close', () => (closedByUser = true));
  page.on('close', () => (closedByUser = true));

  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' });
  process.stderr.write(
    `\n[bro] Log in to ${site.name} in the opened window (email, password, MFA).\n` +
      `      I'll detect when you reach the dashboard and save the session automatically.\n` +
      `      (Or just close the window when you're logged in.)\n\n`,
  );

  const loginNeedle = loginMarker(site.loginUrl);
  const deadlineMs = 15 * 60 * 1000;
  const start = Date.now();
  let loggedIn = false;

  while (Date.now() - start < deadlineMs && !closedByUser) {
    await sleep(1500);
    let url = '';
    try {
      url = page.url();
    } catch {
      break; // page/context gone
    }
    // primary signal: navigated away from the login page
    if (url && !url.includes(loginNeedle)) {
      loggedIn = true;
      break;
    }
    // secondary signal: an authed-only selector became present
    if (site.authedWhen?.selector) {
      const present = await page
        .locator(site.authedWhen.selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (present) {
        loggedIn = true;
        break;
      }
    }
  }

  // Save whatever session we have (unless the user closed the window before we could).
  if (!closedByUser) {
    await context.storageState({ path: authPath(site.id) });
    fs.writeFileSync(
      authMetaPath(site.id),
      JSON.stringify({ capturedAt: stampIso, loginUrl: site.loginUrl, loggedIn }, null, 2) + '\n',
    );
  }
  await browser.close().catch(() => {});

  if (closedByUser && !fs.existsSync(authPath(site.id))) {
    throw new Error('window closed before the session could be saved — run `bro auth` again and let it detect login');
  }
}

/** the path segment that identifies the login page, e.g. "/login" from ".../login" */
function loginMarker(loginUrl: string): string {
  try {
    const u = new URL(loginUrl);
    return u.pathname && u.pathname !== '/' ? u.pathname : loginUrl;
  } catch {
    return 'login';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
