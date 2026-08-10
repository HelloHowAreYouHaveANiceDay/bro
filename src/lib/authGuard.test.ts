import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { authGuard, awaitInteractiveLogin } from './authGuard.ts';
import type { SiteConfig } from './types.ts';

function neverAuthedPage(): Page {
  let currentUrl = '';
  return {
    goto: async (url: string) => {
      currentUrl = url;
      return null as never;
    },
    url: () => currentUrl,
    locator: () => ({
      first: () => ({
        waitFor: async () => {
          throw new Error('selector never matched');
        },
      }),
    }),
  } as unknown as Page;
}

function authedPage(homeUrl: string): Page {
  return {
    goto: async () => null as never,
    url: () => homeUrl,
    locator: () => ({
      first: () => ({
        waitFor: async () => {},
      }),
    }),
  } as unknown as Page;
}

function abortingPage(homeUrl: string): Page {
  let landed = false;
  return {
    goto: async (_url: string, opts?: { waitUntil?: string }) => {
      if (opts?.waitUntil === 'commit') {
        landed = true;
        return null as never;
      }
      throw new Error('net::ERR_ABORTED at https://example.com');
    },
    url: () => (landed ? homeUrl : ''),
    locator: () => ({
      first: () => ({
        waitFor: async () => {},
      }),
    }),
  } as unknown as Page;
}

const interactiveSite: SiteConfig = {
  id: 'linkedin',
  name: 'LinkedIn',
  loginUrl: 'https://www.linkedin.com/login',
  homeUrl: 'https://www.linkedin.com/feed/',
  source: 'linkedin',
  browser: 'persistent',
  interactive: true,
  authedWhen: { selector: '#app-shell' },
};

const publicSite: SiteConfig = {
  id: 'elegislation',
  name: 'e-Legislation',
  loginUrl: '',
  homeUrl: 'https://www.elegislation.gov.hk/',
  source: 'elegislation',
  public: true,
};

const publicSiteWithReadiness: SiteConfig = {
  ...publicSite,
  authedWhen: { selector: '.legislation-content' },
};

describe('awaitInteractiveLogin', () => {
  it('resolves false instead of throwing when login auto-detection is non-fatal', async () => {
    await expect(
      awaitInteractiveLogin(neverAuthedPage(), interactiveSite, () => {}, { fatal: false, timeoutMs: 50 }),
    ).resolves.toBe(false);
  });

  it('preserves the fatal auth-expired path by default', async () => {
    await expect(awaitInteractiveLogin(neverAuthedPage(), interactiveSite, () => {}, { timeoutMs: 50 })).rejects.toMatchObject({
      kind: 'auth-expired',
      needsHuman: true,
    });
  });
});

describe('authGuard -- public sites', () => {
  it('succeeds for a public site with no readiness predicate (no auth.json needed)', async () => {
    const page = authedPage(publicSite.homeUrl);
    await expect(authGuard(page, publicSite)).resolves.toBeUndefined();
  });

  it('succeeds for a public site when the readiness selector is present', async () => {
    const page = authedPage(publicSiteWithReadiness.homeUrl);
    await expect(authGuard(page, publicSiteWithReadiness)).resolves.toBeUndefined();
  });

  it('throws not-ready (not auth-expired) when the readiness selector is missing on a public site', async () => {
    await expect(authGuard(neverAuthedPage(), publicSiteWithReadiness)).rejects.toMatchObject({
      kind: 'not-ready',
      needsHuman: false,
    });
  });

  it('handles ERR_ABORTED navigation for public sites by continuing with commit waitUntil', async () => {
    const page = abortingPage(publicSite.homeUrl);
    await expect(authGuard(page, publicSite)).resolves.toBeUndefined();
  });

  it('non-public site still throws auth-expired when not authed', async () => {
    const privateSite: SiteConfig = {
      id: 'acme',
      name: 'Acme',
      loginUrl: 'https://acme.com/login',
      homeUrl: 'https://acme.com/dashboard',
      source: 'acme',
      authedWhen: { selector: '#dashboard' },
    };
    await expect(authGuard(neverAuthedPage(), privateSite)).rejects.toMatchObject({
      kind: 'auth-expired',
      needsHuman: true,
    });
  });
});
