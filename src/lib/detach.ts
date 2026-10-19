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
export function detachedArgv(site: string, argv: string[], execArgv: string[], sea: boolean): string[] {
  const cmd = ['session', 'start', site];
  return sea ? cmd : [...execArgv, argv[1]!, ...cmd];
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
