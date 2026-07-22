import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { REPO_ROOT } from './paths.ts';

/**
 * Long-lived browser sessions. A `bro session start <site>` process launches the real browser with
 * a CDP port and stays alive holding it open (logged in); separate `bro run` invocations attach over
 * CDP and drive it without closing. The registry maps siteId -> { port, pid } so runs can find them.
 */
export interface LiveSession {
  site: string;
  port: number;
  pid: number;
  startedAt: string;
}

function sessionsFile(): string {
  return path.join(REPO_ROOT, '.bro', 'sessions.json');
}

export function readSessions(): Record<string, LiveSession> {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')) as Record<string, LiveSession>;
  } catch {
    return {};
  }
}

function writeSessions(all: Record<string, LiveSession>): void {
  fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true });
  fs.writeFileSync(sessionsFile(), JSON.stringify(all, null, 2) + '\n');
}

export function setSession(sess: LiveSession): void {
  const all = readSessions();
  all[sess.site] = sess;
  writeSessions(all);
}

export function removeSession(site: string): void {
  const all = readSessions();
  delete all[site];
  writeSessions(all);
}

export function getSession(site: string): LiveSession | undefined {
  return readSessions()[site];
}

/** Probe a CDP endpoint; resolves the ws debugger URL if alive, else null. */
export function probeCDP(port: number, timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve((JSON.parse(body).webSocketDebuggerUrl as string) || `http://127.0.0.1:${port}`);
        } catch {
          resolve(`http://127.0.0.1:${port}`);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** First free CDP port at/above `base` (one browser per port). */
export async function pickPort(base = 9222): Promise<number> {
  for (let p = base; p < base + 60; p++) {
    if (!(await probeCDP(p, 400))) return p;
  }
  return base;
}
