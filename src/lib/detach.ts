import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { BroError } from './errors.ts';
import { dataRoot } from './paths.ts';
import { getSession, probeCDP, type LiveSession } from './sessions.ts';
import { pidAlive } from './page.ts';

/**
 * `bro session start <site> --detach`: run the session host as its own detached process and return
 * once it is LIVE. The host is no longer a child of whatever launched bro (an agent's terminal, a
 * chat gateway), so restarting or killing that caller's process tree leaves the browser and its
 * login running. Idempotent: an already-LIVE session returns `already-running`.
 */

function seaMode(): boolean {
  try {
    return isSea();
  } catch {
    return false;
  }
}

/**
 * argv for the detached host: ALWAYS an explicit `session start <site>` (never the caller's argv --
 * re-running e.g. `bro open` would make every child spawn another child). `argv[0..1]` only supply
 * the launcher: node + script in checkout mode, the exe alone in SEA mode (argv[1] repeats it).
 */
export function detachedArgv(site: string, argv: string[], execArgv: string[], sea: boolean, cmd: string[] = ['session', 'start', site]): string[] {
  return sea ? cmd : [...execArgv, argv[1]!, ...cmd];
}

/**
 * Route a DETACHED child (spawned by startDetached / startDetachedLogin with DETACHED_ENV set) to its
 * long-lived job. Returns the job's promise, or null when this process is not a detached child (a
 * normal one-shot driver call). Shared by the SEA entry and the checkout-mode driver, so both modes
 * can detach (the checkout driver used to read stdin and die with a parse error).
 */
export function runDetachedChild(argv: string[], env: NodeJS.ProcessEnv): Promise<void> | null {
  if (!env[DETACHED_ENV]) return null;
  const [a, b, site] = argv.slice(2);
  if (!site) return null;
  if (a === 'session' && b === 'start') return import('./sessionHost.ts').then((m) => m.hostSessionMain(site));
  if (a === 'auth' && b === 'login') return loginHostMain(site);
  return null;
}

export function loginLogPath(site: string): string {
  return path.join(dataRoot(), 'logs', `auth-${site}.log`);
}

function loginPidPath(site: string): string {
  return path.join(dataRoot(), 'logs', `auth-${site}.pid`);
}

/** Detached child body for `auth login <site>`: open the headed login window and save auth when done. */
async function loginHostMain(siteId: string): Promise<void> {
  const [{ loadSite }, { loadConfig }, { authCapture }] = await Promise.all([
    import('./registry.ts'), import('./config.ts'), import('./auth.ts'),
  ]);
  const site = loadSite(siteId);
  const pidFile = loginPidPath(siteId);
  fs.writeFileSync(pidFile, String(process.pid));
  try {
    // authCapture prints "[bro] Log in to ..." once the login page has loaded; startDetachedLogin
    // waits for that line in the log before returning to the agent.
    await authCapture(site, loadConfig().browserChannel, new Date().toISOString());
    process.stderr.write(`[bro] saved auth for ${siteId}.\n`);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
  process.exit(0);
}

/**
 * `auth login <site>` for agents (the driver has no terminal): spawn a detached child that opens the
 * HEADED login window for the human, and return as soon as the window is up -- not when the human
 * finishes. The child auto-detects the login (or the human closes the window) and writes auth.json;
 * the agent polls `site list` (auth.capturedAt) to see when it landed. Idempotent per site.
 */
export async function startDetachedLogin(
  site: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ site: string; pid: number; status: 'waiting-for-human' | 'already-waiting'; log: string; next: string }> {
  if (process.env[DETACHED_ENV]) {
    throw new BroError('internal', 'refusing to detach from inside a detached host (would recurse)');
  }
  const log = loginLogPath(site);
  const next = `ask the human to log in in the opened browser window, then poll \`bim bro site list\` until ${site}'s auth.capturedAt updates`;
  const pidFile = loginPidPath(site);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid && pidAlive(pid)) return { site, pid, status: 'already-waiting', log, next };
    fs.rmSync(pidFile, { force: true });
  }

  const fd = fs.openSync(log, 'a');
  const startOffset = fs.fstatSync(fd).size;
  fs.writeSync(fd, `\n--- ${new Date().toISOString()} detached auth login ${site}\n`);
  const child = spawn(process.execPath, detachedArgv(site, process.argv, process.execArgv, seaMode(), ['auth', 'login', site]), {
    detached: true,
    windowsHide: false, // the whole point is a window the human can see
    stdio: ['ignore', fd, fd],
    cwd: process.cwd(),
    env: { ...process.env, [DETACHED_ENV]: '1' },
  });
  child.unref();
  fs.closeSync(fd);

  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const tail = readFrom(log, startOffset);
    // Ready once the login page has been navigated (authCapture's prompt) -- the window is up.
    if (/\[bro\] Log in to /.test(tail)) return { site, pid: child.pid!, status: 'waiting-for-human', log, next };
    if (child.pid && !pidAlive(child.pid)) {
      throw new BroError('internal', `login window for "${site}" exited before it opened`, {
        retriable: true, hint: `see ${log}`, detail: { pid: child.pid, log, tail: tail.slice(-2000) },
      });
    }
  }
  throw new BroError('internal', `login window for "${site}" did not open within ${Math.round((opts.timeoutMs ?? 90_000) / 1000)}s`, {
    retriable: true, hint: `see ${log}`, detail: { pid: child.pid ?? null, log },
  });
}

function readFrom(file: string, offset: number): string {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(offset).toString('utf8');
  } catch {
    return '';
  }
}

/** Set in the detached host's env; a host that somehow reaches startDetached again refuses. */
export const DETACHED_ENV = 'BRO_DETACHED_HOST';

export function sessionLogPath(site: string): string {
  return path.join(dataRoot(), 'logs', `session-${site}.log`);
}

export async function liveSession(site: string): Promise<LiveSession | null> {
  const live = getSession(site);
  if (!live || !pidAlive(live.pid)) return null;
  return (await probeCDP(live.port)) ? live : null;
}

export async function startDetached(
  site: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ site: string; port: number; pid: number; status: 'started' | 'already-running'; log: string }> {
  if (process.env[DETACHED_ENV]) {
    throw new BroError('internal', 'refusing to detach from inside a detached session host (would recurse)');
  }
  const log = sessionLogPath(site);
  const existing = await liveSession(site);
  if (existing) return { site, port: existing.port, pid: existing.pid, status: 'already-running', log };

  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, `\n--- ${new Date().toISOString()} detached session start ${site}\n`);
  const child = spawn(process.execPath, detachedArgv(site, process.argv, process.execArgv, seaMode()), {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    cwd: process.cwd(),
    env: { ...process.env, [DETACHED_ENV]: '1' },
  });
  child.unref();
  fs.closeSync(fd);

  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const live = await liveSession(site);
    if (live && live.pid === child.pid) return { site, port: live.port, pid: live.pid, status: 'started', log };
    if (child.pid && !pidAlive(child.pid)) break;
  }
  throw new BroError('internal', `detached session for "${site}" did not come up`, {
    retriable: true,
    hint: `see ${log}`,
    detail: { pid: child.pid ?? null, log },
  });
}
