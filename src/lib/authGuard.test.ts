import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { awaitInteractiveLogin } from './authGuard.ts';
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

const site: SiteConfig = {
  id: 'linkedin',
  name: 'LinkedIn',
  loginUrl: 'https://www.linkedin.com/login',
  homeUrl: 'https://www.linkedin.com/feed/',
  source: 'linkedin',
  browser: 'persistent',
  interactive: true,
  authedWhen: { selector: '#app-shell' },
};

describe('awaitInteractiveLogin', () => {
  it('resolves false instead of throwing when login auto-detection is non-fatal', async () => {
    await expect(
      awaitInteractiveLogin(neverAuthedPage(), site, () => {}, { fatal: false, timeoutMs: 50 }),
    ).resolves.toBe(false);
  });

  it('preserves the fatal auth-expired path by default', async () => {
    await expect(awaitInteractiveLogin(neverAuthedPage(), site, () => {}, { timeoutMs: 50 })).rejects.toMatchObject({
      kind: 'auth-expired',
      needsHuman: true,
    });
  });
});
