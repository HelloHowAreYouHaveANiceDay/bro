import fs from 'node:fs';
import { chromium } from 'playwright';
import type { SiteConfig } from './types.ts';
import { authPath, authMetaPath, profileDir } from './paths.ts';

/**
 * Flow A — interactive login capture. Opens a HEADED browser with the automation signals
 * suppressed (many sites, esp. Cloudflare, disable the login form when navigator.webdriver is
 * set), lets the human log in + clear MFA, then saves the storageState.
 *
 * Completion is auto-detected: we poll until the page leaves the login URL (or the site's
 * authedWhen.selector appears). The human can also just close the window when done.
 */
export async function authCapture(site: SiteConfig, channel: string, stampIso: string): Promise<void> {
  if (site.browser === 'persistent') return authCapturePersistent(site, channel, stampIso);

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

  // Persist the storage state on every poll, so the session is captured even when URL/selector
  // auto-detection never fires — e.g. single-page-app banks (Chase) that stay on the same origin
  // after login. This makes "just close the window when you're logged in" reliable: the last
  // poll before close has already written the authed state to disk.
  const persist = async (): Promise<boolean> => {
    try {
      await context.storageState({ path: authPath(site.id) });
      return true;
    } catch {
      return false; // context already closing
    }
  };

  while (Date.now() - start < deadlineMs && !closedByUser) {
    await sleep(1500);
    let url = '';
    try {
      url = page.url();
    } catch {
      break; // page/context gone
    }
    await persist();
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

  // Final save if the context is still open (detection fired or deadline hit).
  if (!closedByUser) await persist();
  await browser.close().catch(() => {});

  if (fs.existsSync(authPath(site.id))) {
    fs.writeFileSync(
      authMetaPath(site.id),
      JSON.stringify({ capturedAt: stampIso, loginUrl: site.loginUrl, loggedIn }, null, 2) + '\n',
    );
  } else {
    throw new Error('no session captured — run `bro auth` again, log in, then close the window when the dashboard shows');
  }
}

/**
 * Persistent-profile login capture (site.browser === 'persistent'): open the REAL installed browser
 * on a per-site profile, let the human log in; cookies persist to the profile dir on disk
 * automatically (no storageState export). The real device fingerprint is reused on every later run.
 */
async function authCapturePersistent(site: SiteConfig, channel: string, stampIso: string): Promise<void> {
  const dir = profileDir(site.id);
  fs.mkdirSync(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, {
    channel,
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  let closedByUser = false;
  context.on('close', () => (closedByUser = true));
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  process.stderr.write(
    `\n[bro] Log in to ${site.name} in the opened REAL browser window (email, password, MFA).\n` +
      `      This is a persistent profile -- the login is saved in the profile automatically.\n` +
      `      Close the window when you're done.\n\n`,
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
      break;
    }
    if (url && !url.includes(loginNeedle)) {
      loggedIn = true;
      break;
    }
    if (site.authedWhen?.selector) {
      const present = await page.locator(site.authedWhen.selector).first().isVisible().catch(() => false);
      if (present) {
        loggedIn = true;
        break;
      }
    }
  }
  // cookies already persisted to the profile dir; just close.
  await context.close().catch(() => {});
  fs.writeFileSync(
    authMetaPath(site.id),
    JSON.stringify({ capturedAt: stampIso, loginUrl: site.loginUrl, mode: 'persistent', loggedIn }, null, 2) + '\n',
  );
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
