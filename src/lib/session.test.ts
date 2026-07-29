import { describe, expect, it, vi } from 'vitest';
import { runLiveSession } from './session.ts';

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
