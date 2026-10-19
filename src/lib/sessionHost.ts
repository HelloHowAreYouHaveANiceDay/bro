import type { SiteConfig } from './types.ts';
import { startPersistentSession, runLiveSession, guardSessionHost, pickLoginPage } from './session.ts';
import { awaitInteractiveLogin, DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS } from './authGuard.ts';
import { setSession, removeSession } from './sessions.ts';
import { loadSite } from './registry.ts';
import { loadConfig } from './config.ts';

/**
 * The long-lived `session start <site>` host: launch the persistent browser, register it, wait for
 * login (skipped for public sites), and keep the process alive until stopped. Used by the CLI and by
 * the SEA's detached-host entry. Imports playwright only lazily (via session.ts -> loadPlaywright), so
 * it works inside bim-bro.exe, whose bundle cannot `require('playwright')` statically.
 */
export async function hostSession(site: SiteConfig, channel: string, emitLive: (port: number) => void): Promise<void> {
  guardSessionHost(process, (m) => process.stderr.write(m), (err) => {
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  });
  const { context, port } = await startPersistentSession(site, { channel });
  // Reuse a restored tab already on the site instead of opening a duplicate of it.
  const page = pickLoginPage(context.pages(), site) ?? (await context.newPage());
  await runLiveSession({
    site,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    detectionTimeoutMs: DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS,
    setSession,
    removeSession,
    emitLive: () => emitLive(port),
    detectLogin: () =>
      site.public
        ? Promise.resolve(true) // no login to detect; don't navigate the human's tabs
        : awaitInteractiveLogin(page, site, () => {}, { timeoutMs: DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS, fatal: false }),
    keepAlive: () => new Promise<void>(() => {}),
    closeContext: () => context.close(),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    onContextClose: (handler) => {
      context.on('close', handler);
    },
    writeStderr: (msg) => {
      process.stderr.write(msg);
    },
    exit: (code) => {
      process.exit(code);
    },
  });
}

/** SEA entry for a detached host: `bim-bro.exe session start <site>` with BRO_DETACHED_HOST set. */
export async function hostSessionMain(siteId: string): Promise<void> {
  const site = loadSite(siteId);
  await hostSession(site, loadConfig().browserChannel, (port) => {
    process.stderr.write(`\n[bro] session for ${siteId} is LIVE on CDP port ${port} (detached host).\n`);
  });
}
