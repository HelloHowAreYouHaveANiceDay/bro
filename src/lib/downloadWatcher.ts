/**
 * Browser-level download watcher for LIVE (attached-over-CDP) sessions.
 *
 * Why: Chromium keeps ONE browser-wide download behavior. Playwright's connectOverCDP sets it to
 * "allowAndName into my artifacts dir", but when ANY other CDP client that set a download behavior
 * detaches (another `bro run`, a second Playwright attach, a tool closing its connection), Chromium
 * resets it to the browser default. The next download then lands in the user's Downloads folder,
 * Playwright still fires its `download` event, and `download.saveAs()` fails with
 * `ENOENT ... copyfile <Temp>/playwright-artifacts-*\/<guid>`.
 *
 * This watcher opens its own raw CDP connection to the browser endpoint BEFORE Playwright attaches and
 * enables download events. Chromium reports `Browser.downloadProgress` (with the real `filePath` on
 * completion) to every client that enabled events, whichever behavior won -- so `pathFor()` can find
 * the file wherever it actually landed. The behavior we set ('default') is immediately overridden by
 * Playwright's attach; we only want the events.
 */
export interface DownloadLike {
  url(): string;
  suggestedFilename(): string;
}

export interface DownloadWatcher {
  /** Resolve the on-disk path of a finished download, or null if it never completes in time. */
  pathFor(download: DownloadLike, timeoutMs?: number): Promise<string | null>;
  close(): void;
}

interface Entry {
  guid: string;
  url: string;
  suggestedFilename: string;
  state: 'inProgress' | 'completed' | 'canceled';
  filePath?: string;
  claimed: boolean;
}

/** Minimal surface of the WebSocket we use (Node >= 22 global WebSocket; a fake in tests). */
interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export async function openDownloadWatcher(
  port: number,
  deps: {
    fetchJson?: (url: string) => Promise<{ webSocketDebuggerUrl?: string }>;
    makeWs?: (url: string) => WsLike;
    timeoutMs?: number;
  } = {},
): Promise<DownloadWatcher> {
  const fetchJson = deps.fetchJson ?? (async (u: string) => (await fetch(u)).json() as Promise<{ webSocketDebuggerUrl?: string }>);
  const makeWs = deps.makeWs ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) throw new Error(`no browser websocket on port ${port}`);
  const ws = makeWs(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('download watcher: CDP connect timed out')), deps.timeoutMs ?? 8000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('download watcher: CDP connect failed'));
    };
  });
  return createWatcher(ws);
}

/** Exported for tests: wire a connected socket into a watcher. */
export function createWatcher(ws: WsLike): DownloadWatcher {
  const entries = new Map<string, Entry>();
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const w of [...waiters]) w();
  };

  ws.onmessage = (ev) => {
    let m: { method?: string; params?: Record<string, unknown> };
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const p = m.params ?? {};
    if (m.method === 'Browser.downloadWillBegin') {
      const guid = String(p.guid);
      entries.set(guid, {
        guid,
        url: String(p.url ?? ''),
        suggestedFilename: String(p.suggestedFilename ?? ''),
        state: 'inProgress',
        claimed: false,
      });
      notify();
    } else if (m.method === 'Browser.downloadProgress') {
      const e = entries.get(String(p.guid));
      if (!e) return;
      const state = String(p.state);
      if (state === 'completed' || state === 'canceled') e.state = state;
      if (typeof p.filePath === 'string') e.filePath = p.filePath;
      notify();
    }
  };
  // Enable download events for THIS client. The behavior itself is overridden by Playwright's attach.
  ws.send(JSON.stringify({ id: 1, method: 'Browser.setDownloadBehavior', params: { behavior: 'default', eventsEnabled: true } }));

  function match(d: DownloadLike): Entry | undefined {
    const url = d.url();
    const name = d.suggestedFilename();
    // newest first: a later download with the same name/url is the one this Download refers to
    const open = [...entries.values()].filter((e) => !e.claimed).reverse();
    return open.find((e) => e.url === url && e.suggestedFilename === name) ?? open.find((e) => e.suggestedFilename === name);
  }

  return {
    pathFor(download, timeoutMs = 30000) {
      return new Promise((resolve) => {
        let done = false;
        const check = () => {
          if (done) return;
          const e = match(download);
          if (!e || e.state === 'inProgress') return;
          finish(e.state === 'completed' && e.filePath ? e : null);
        };
        const finish = (e: Entry | null) => {
          done = true;
          clearTimeout(t);
          waiters.delete(check);
          if (e) e.claimed = true;
          resolve(e?.filePath ?? null);
        };
        const t = setTimeout(() => finish(null), timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
