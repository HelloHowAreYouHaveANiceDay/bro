import type { Browser, BrowserContext } from 'playwright';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from './types.ts';

const mockState = vi.hoisted(() => {
  const liveContext = {
    close: vi.fn(async () => {}),
  };
  const liveBrowser = {
    close: vi.fn(async () => {}),
    contexts: vi.fn(() => [liveContext as unknown as BrowserContext]),
    newContext: vi.fn(async () => liveContext as unknown as BrowserContext),
  };
  const launchedContext = {
    addInitScript: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const launchedBrowser = {
    close: vi.fn(async () => {}),
    newContext: vi.fn(async () => launchedContext as unknown as BrowserContext),
  };
  const persistentContext = {
    close: vi.fn(async () => {}),
  };

  return {
    currentSession: undefined as
      | { site: string; port: number; pid: number; startedAt: string }
      | undefined,
    cdpReachable: true,
    liveBrowser,
    liveContext,
    launchedBrowser,
    launchedContext,
    persistentContext,
    connectOverCDP: vi.fn(async () => liveBrowser as unknown as Browser),
    launch: vi.fn(async () => launchedBrowser as unknown as Browser),
    launchPersistentContext: vi.fn(async () => persistentContext as unknown as BrowserContext),
    getSession: vi.fn<(siteId: string) => { site: string; port: number; pid: number; startedAt: string } | undefined>(),
    probeCDP: vi.fn<(port: number) => Promise<string | null>>(),
  };
});

vi.mock('./playwright.ts', () => ({
  loadPlaywright: () => ({
    chromium: {
      connectOverCDP: mockState.connectOverCDP,
      launch: mockState.launch,
      launchPersistentContext: mockState.launchPersistentContext,
    },
  }),
}));

vi.mock('./sessions.ts', () => ({
  getSession: (siteId: string) => mockState.getSession(siteId),
  pickPort: vi.fn(),
  probeCDP: (port: number) => mockState.probeCDP(port),
}));

vi.mock('./paths.ts', () => ({
  authMetaPath: vi.fn(() => 'C:/tmp/auth.meta.json'),
  authPath: vi.fn(() => 'C:/tmp/auth.json'),
  profileDir: vi.fn(() => 'C:/tmp/profile'),
}));

import { openSession, runLiveSession } from './session.ts';

function makeSite(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id: 'geico',
    name: 'GEICO',
    loginUrl: 'https://example.com/login',
    homeUrl: 'https://example.com/home',
    source: 'geico',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.currentSession = undefined;
  mockState.cdpReachable = true;
  mockState.getSession.mockImplementation(() => mockState.currentSession);
  mockState.probeCDP.mockImplementation(async (port: number) =>
    mockState.cdpReachable ? `http://127.0.0.1:${port}` : null,
  );
});

describe('openSession', () => {
  it('refuses browser.close on a live CDP session and logs a warning', async () => {
    mockState.currentSession = {
      site: 'geico',
      port: 9333,
      pid: 4242,
      startedAt: '2026-08-31T00:00:00.000Z',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const session = await openSession(makeSite({ browser: 'persistent', interactive: true }), { channel: 'chrome' });

      await session.browser?.close();

      expect(mockState.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9333');
      expect(mockState.liveBrowser.close).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        '[bro] refusing browser.close() on a live CDP session -- connection will drop on exit',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('closes owned launch browsers during teardown', async () => {
    const session = await openSession(makeSite({ public: true }), { channel: 'chrome' });

    await session.close();

    expect(mockState.launchedContext.close).toHaveBeenCalledTimes(1);
    expect(mockState.launchedBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('closes persistent contexts during teardown', async () => {
    const session = await openSession(makeSite({ browser: 'persistent' }), { channel: 'chrome' });

    await session.close();

    expect(mockState.persistentContext.close).toHaveBeenCalledTimes(1);
  });
});

describe('runLiveSession', () => {
  it('registers the session before login detection settles and keeps it alive on non-confirmation', async () => {
    const events: string[] = [];
    let resolveDetect: ((confirmed: boolean) => void) | undefined;
    const keepAlive = vi.fn(async () => {
      events.push('keepAlive');
    });
    const writeStderr = vi.fn((msg: string) => {
      events.push(`stderr:${msg.trim()}`);
    });

    const run = runLiveSession({
      site: { id: 'linkedin', name: 'LinkedIn' },
      port: 9333,
      pid: 4242,
      startedAt: '2026-07-29T00:00:00.000Z',
      detectionTimeoutMs: 50,
      setSession: () => {
        events.push('setSession');
      },
      removeSession: vi.fn(),
      emitLive: () => {
        events.push('emitLive');
      },
      detectLogin: () =>
        new Promise<boolean>((resolve) => {
          events.push('detectLogin');
          resolveDetect = resolve;
        }),
      keepAlive,
      closeContext: vi.fn(async () => {}),
      onSignal: vi.fn(),
      onContextClose: vi.fn(),
      writeStderr,
      exit: vi.fn(),
    });

    await Promise.resolve();
    expect(events.slice(0, 3)).toEqual(['setSession', 'emitLive', 'detectLogin']);

    resolveDetect?.(false);
    await run;

    expect(keepAlive).toHaveBeenCalledTimes(1);
    expect(writeStderr).toHaveBeenCalledWith(
      expect.stringContaining("couldn't auto-confirm login within 1s -- assuming co-present, session stays live"),
    );
  });

  it('does not close the browser when login detection rejects', async () => {
    const keepAlive = vi.fn(async () => {});
    const closeContext = vi.fn(async () => {});

    await runLiveSession({
      site: { id: 'linkedin', name: 'LinkedIn' },
      port: 9333,
      pid: 4242,
      startedAt: '2026-07-29T00:00:00.000Z',
      detectionTimeoutMs: 50,
      setSession: vi.fn(),
      removeSession: vi.fn(),
      emitLive: vi.fn(),
      detectLogin: async () => {
        throw new Error('detection failed');
      },
      keepAlive,
      closeContext,
      onSignal: vi.fn(),
      onContextClose: vi.fn(),
      writeStderr: vi.fn(),
      exit: vi.fn(),
    });

    expect(closeContext).not.toHaveBeenCalled();
    expect(keepAlive).toHaveBeenCalledTimes(1);
  });
});
