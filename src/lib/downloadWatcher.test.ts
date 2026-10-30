import { describe, expect, it } from 'vitest';
import { createWatcher, openDownloadWatcher } from './downloadWatcher.ts';

class FakeWs {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  emit(method: string, params: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ method, params }) });
  }
}

const dl = (url: string, name: string) => ({ url: () => url, suggestedFilename: () => name });

describe('download watcher', () => {
  it('enables browser download events for its own client', () => {
    const ws = new FakeWs();
    createWatcher(ws);
    expect(ws.sent[0]).toMatchObject({ method: 'Browser.setDownloadBehavior', params: { behavior: 'default', eventsEnabled: true } });
  });

  it('resolves the real filePath once the matching download completes (behavior reset case)', async () => {
    const ws = new FakeWs();
    const w = createWatcher(ws);
    ws.emit('Browser.downloadWillBegin', { guid: 'g1', url: 'blob:https://x/1', suggestedFilename: 'All-Accounts-Positions.csv' });
    const p = w.pathFor(dl('blob:https://x/1', 'All-Accounts-Positions.csv'), 2000);
    ws.emit('Browser.downloadProgress', { guid: 'g1', state: 'inProgress', receivedBytes: 10 });
    ws.emit('Browser.downloadProgress', { guid: 'g1', state: 'completed', filePath: 'C:\\Users\\me\\Downloads\\All-Accounts-Positions.csv' });
    await expect(p).resolves.toBe('C:\\Users\\me\\Downloads\\All-Accounts-Positions.csv');
  });

  it('returns null for a canceled download or on timeout', async () => {
    const ws = new FakeWs();
    const w = createWatcher(ws);
    ws.emit('Browser.downloadWillBegin', { guid: 'g2', url: 'u', suggestedFilename: 'a.csv' });
    ws.emit('Browser.downloadProgress', { guid: 'g2', state: 'canceled' });
    await expect(w.pathFor(dl('u', 'a.csv'), 500)).resolves.toBeNull();
    await expect(w.pathFor(dl('none', 'none.csv'), 50)).resolves.toBeNull();
  });

  it('claims each download once, newest first, so two same-named exports map to two files', async () => {
    const ws = new FakeWs();
    const w = createWatcher(ws);
    for (const [g, f] of [['a', 'C:/d/x.csv'], ['b', 'C:/d/x (1).csv']]) {
      ws.emit('Browser.downloadWillBegin', { guid: g, url: 'u', suggestedFilename: 'x.csv' });
      ws.emit('Browser.downloadProgress', { guid: g, state: 'completed', filePath: f });
    }
    const first = await w.pathFor(dl('u', 'x.csv'), 200);
    const second = await w.pathFor(dl('u', 'x.csv'), 200);
    expect([first, second]).toEqual(['C:/d/x (1).csv', 'C:/d/x.csv']);
  });

  it('connects to the browser websocket from /json/version', async () => {
    const ws = new FakeWs();
    let asked = '';
    const p = openDownloadWatcher(9333, {
      fetchJson: async (u) => {
        asked = u;
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/abc' };
      },
      makeWs: () => {
        setTimeout(() => ws.onopen?.({}), 0);
        return ws;
      },
    });
    const w = await p;
    expect(asked).toBe('http://127.0.0.1:9333/json/version');
    w.close();
    expect(ws.closed).toBe(true);
  });
});
