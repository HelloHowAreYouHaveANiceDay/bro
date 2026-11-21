import { describe, it, expect } from 'vitest';
import { WebSocketServer } from './testWsServer.ts';
import { PageCDP, clickSelector, typeText, pressKey, gotoUrl, type TabInfo } from './page.ts';
import {
  Human, bezierPath, planMove, clickPoint, keyForChar, keyDelay, thinkDelay, seededRng, moveDuration, humanPause, type HumanPage,
} from './human.ts';

const tab = (url: string): TabInfo => ({ id: 'T', type: 'page', url, title: '' });

describe('path generation', () => {
  it('has exact endpoints, bounded step count and monotone progress along the line', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rng = seededRng(seed);
      const from = { x: 10 + rng() * 300, y: 10 + rng() * 300 };
      const to = { x: 400 + rng() * 800, y: 300 + rng() * 400 };
      const path = bezierPath(from, to, rng);
      expect(path.length).toBeGreaterThanOrEqual(15);
      expect(path.length).toBeLessThanOrEqual(40);
      expect(path[path.length - 1]).toMatchObject({ x: to.x, y: to.y });
      const ux = to.x - from.x;
      const uy = to.y - from.y;
      const len = Math.hypot(ux, uy);
      let prev = 0;
      for (const p of path) {
        const prog = ((p.x - from.x) * ux + (p.y - from.y) * uy) / len;
        expect(prog).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = prog;
      }
      const total = path.reduce((s, p) => s + p.delay, 0);
      expect(total).toBeGreaterThan(120);
      expect(total).toBeLessThan(1100);
    }
  });

  it('long moves can overshoot but always end exactly on target', () => {
    let overshoots = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rng = seededRng(seed);
      const to = { x: 900, y: 500 };
      const path = planMove({ x: 50, y: 50 }, to, rng);
      expect(path[path.length - 1]).toMatchObject(to);
      if (path.some((p) => p.x > to.x)) overshoots++;
    }
    expect(overshoots).toBeGreaterThan(0);
    expect(planMove({ x: 5, y: 5 }, { x: 5, y: 5 }, seededRng(1))).toEqual([]);
  });

  it('duration grows with distance and stays in 200..700ms', () => {
    const r = () => 0.5;
    expect(moveDuration(20, r)).toBeLessThan(moveDuration(1500, r));
    for (const d of [1, 100, 5000]) {
      const v = moveDuration(d, seededRng(d));
      expect(v).toBeGreaterThanOrEqual(200);
      expect(v).toBeLessThanOrEqual(700);
    }
  });

  it('click points stay inside the inner 60% of the box', () => {
    const box = { x: 100, y: 200, width: 80, height: 30 };
    const rng = seededRng(7);
    for (let i = 0; i < 300; i++) {
      const p = clickPoint(box, rng);
      expect(p.x).toBeGreaterThanOrEqual(100 + 80 * 0.2 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(100 + 80 * 0.8 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(200 + 30 * 0.2 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(200 + 30 * 0.8 + 1e-9);
    }
  });
});

describe('key mapping', () => {
  it('maps letters, shift, digits, space and punctuation', () => {
    expect(keyForChar('a')).toEqual({ key: 'a', code: 'KeyA', vk: 65, text: 'a', shift: false });
    expect(keyForChar('A')).toEqual({ key: 'A', code: 'KeyA', vk: 65, text: 'A', shift: true });
    expect(keyForChar('!')).toEqual({ key: '!', code: 'Digit1', vk: 49, text: '!', shift: true });
    expect(keyForChar('7')).toMatchObject({ code: 'Digit7', vk: 55, shift: false });
    expect(keyForChar(' ')).toMatchObject({ code: 'Space', vk: 32, text: ' ' });
    expect(keyForChar('@')).toMatchObject({ code: 'Digit2', shift: true });
    expect(keyForChar('.')).toMatchObject({ code: 'Period', vk: 190, shift: false });
    expect(keyForChar('_')).toMatchObject({ code: 'Minus', shift: true });
    expect(keyForChar('é')).toBeNull();
    expect(keyForChar('日')).toBeNull();
  });
});

describe('timing bounds (seeded rng, no real sleeps)', () => {
  it('inter-key delay averages ~110ms and stays bounded', () => {
    const rng = seededRng(42);
    const ds = Array.from({ length: 4000 }, () => keyDelay(rng));
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    expect(mean).toBeGreaterThan(95);
    expect(mean).toBeLessThan(150);
    expect(Math.min(...ds)).toBeGreaterThanOrEqual(35);
    expect(Math.max(...ds)).toBeLessThanOrEqual(1500);
  });

  it('think pauses fall in their preset ranges; humanPause keeps its signature', async () => {
    const rng = seededRng(3);
    for (let i = 0; i < 100; i++) {
      const g = thinkDelay('glance', rng);
      expect(g).toBeGreaterThanOrEqual(150);
      expect(g).toBeLessThanOrEqual(450);
      const s = thinkDelay('beforeSubmit', rng);
      expect(s).toBeGreaterThanOrEqual(500);
      expect(s).toBeLessThanOrEqual(1600);
    }
    await humanPause(0, 1);
  });
});

function fakePage(opts: { viewport?: { w: number; h: number }; scrollStuck?: boolean } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const page: HumanPage = {
    async send(method, params = {}) {
      calls.push({ method, params });
      return {};
    },
    async evaluate(expr) {
      if (expr.includes('innerWidth')) return opts.viewport ?? { w: 1000, h: 700 };
      return null;
    },
  };
  return { page, calls };
}

describe('Human against a fake page', () => {
  it('click: many mouseMoved, then press, then release; all sleeps are injected', async () => {
    const { page, calls } = fakePage();
    const slept: number[] = [];
    const h = new Human(page, { rng: seededRng(5), sleep: async (ms) => void slept.push(ms) });
    await h.click({ box: async () => ({ x: 600, y: 300, width: 100, height: 40 }) });
    const types = calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params['type']);
    const pressAt = types.indexOf('mousePressed');
    expect(pressAt).toBeGreaterThan(10);
    expect(types.slice(0, pressAt).every((t) => t === 'mouseMoved')).toBe(true);
    expect(types.slice(pressAt)).toEqual(['mousePressed', 'mouseReleased']);
    const press = calls.find((c) => c.params['type'] === 'mousePressed')!.params;
    expect(press['x']).toBeGreaterThanOrEqual(620);
    expect(press['x']).toBeLessThanOrEqual(680);
    // hover 80-250 and hold 50-120 present among the sleeps
    expect(slept.some((s) => s >= 80 && s <= 250)).toBe(true);
    expect(slept.some((s) => s >= 50 && s <= 120)).toBe(true);
  });

  it('remembers the cursor: second move starts where the first ended', async () => {
    const { page, calls } = fakePage();
    const h = new Human(page, { rng: seededRng(9), sleep: async () => {} });
    await h.move({ x: 200, y: 200 });
    const n = calls.length;
    await h.move({ x: 210, y: 205 });
    const first = calls[n]!.params;
    expect(Math.hypot(Number(first['x']) - 200, Number(first['y']) - 200)).toBeLessThan(40);
    expect((await h.cursor())).toEqual({ x: 210, y: 205 });
  });

  it('scroll: wheel chunks of 80-120 until the target is in view; no scrollIntoView needed', async () => {
    const { page, calls } = fakePage();
    let top = 2000;
    let fallback = 0;
    const h = new Human(page, { rng: seededRng(11), sleep: async () => {} });
    const target = {
      box: async () => ({ x: 100, y: top, width: 50, height: 20 }),
      scrollIntoView: async () => void fallback++,
    };
    page.send = async (method, params = {}) => {
      calls.push({ method, params });
      if (params['type'] === 'mouseWheel') top -= Number(params['deltaY']);
      return {};
    };
    const box = await h.scroll(target);
    const wheels = calls.filter((c) => c.params['type'] === 'mouseWheel');
    expect(wheels.length).toBeGreaterThan(10);
    for (const w of wheels) {
      expect(Math.abs(Number(w.params['deltaY']))).toBeGreaterThanOrEqual(80);
      expect(Math.abs(Number(w.params['deltaY']))).toBeLessThanOrEqual(120);
    }
    expect(box!.y).toBeLessThanOrEqual(700 - 60 - 20);
    expect(fallback).toBe(0);
  });

  it('scroll: falls back to scrollIntoView when the wheel makes no progress', async () => {
    const { page } = fakePage();
    let top = 3000;
    const h = new Human(page, { rng: seededRng(2), sleep: async () => {} });
    await h.scroll({ box: async () => ({ x: 1, y: top, width: 10, height: 10 }), scrollIntoView: async () => void (top = 300) });
    expect(top).toBe(300);
  });

  it('type: keyDown(+text)/keyUp pairs with shift handling; non-ASCII uses insertText', async () => {
    const { page, calls } = fakePage();
    const h = new Human(page, { rng: seededRng(4), sleep: async () => {} });
    await h.type('Aé!');
    const seq = calls.map((c) => (c.method === 'Input.insertText' ? `insert:${c.params['text']}` : `${c.params['type']}:${c.params['key']}`));
    expect(seq).toEqual([
      'keyDown:Shift', 'keyDown:A', 'keyUp:A', 'keyUp:Shift',
      'insert:é',
      'keyDown:Shift', 'keyDown:!', 'keyUp:!', 'keyUp:Shift',
    ]);
    const a = calls.find((c) => c.params['key'] === 'A' && c.params['type'] === 'keyDown')!.params;
    expect(a).toMatchObject({ text: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 });
    expect(calls.find((c) => c.params['type'] === 'keyUp' && c.params['key'] === 'A')!.params['text']).toBeUndefined();
  });

  it('typos are off by default and fix themselves with Backspace when on', async () => {
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(10);
    const off = fakePage();
    await new Human(off.page, { rng: seededRng(8), sleep: async () => {} }).type(text, { maxTotalMs: 1e9 });
    expect(off.calls.some((c) => c.params['key'] === 'Backspace')).toBe(false);
    const on = fakePage();
    await new Human(on.page, { rng: seededRng(8), sleep: async () => {} }).type(text, { typos: true, maxTotalMs: 1e9 });
    expect(on.calls.some((c) => c.params['key'] === 'Backspace')).toBe(true);
  });
});

describe('page verbs over CDP (fake target)', () => {
  async function withServer(
    handler: (method: string, params: Record<string, unknown>) => unknown,
    fn: (cdp: PageCDP, log: Array<{ method: string; params: Record<string, unknown> }>) => Promise<void>,
  ) {
    const log: Array<{ method: string; params: Record<string, unknown> }> = [];
    const srv = await WebSocketServer.start((msg, send) => {
      const { id, method, params } = msg as { id: number; method: string; params: Record<string, unknown> };
      log.push({ method, params });
      send({ id, result: handler(method, params) ?? {} });
    });
    const cdp = await PageCDP.connect({ ...tab('https://x.test/'), webSocketDebuggerUrl: srv.url });
    try {
      await fn(cdp, log);
    } finally {
      cdp.close();
      await srv.stop();
    }
  }
  const evalResult = (v: unknown) => ({ result: { value: v } });
  const BOX = { x: 300, y: 200, width: 120, height: 36 };
  const handler = (method: string, params: Record<string, unknown>) => {
    if (method !== 'Runtime.evaluate') return {};
    const e = String(params['expression']);
    if (e.includes('innerWidth')) return evalResult({ w: 1000, h: 700 });
    if (e.includes('getBoundingClientRect')) return evalResult(BOX);
    return evalResult(null);
  };

  it('click emits >10 mouseMoved before press; --yolo keeps the 3-event teleport', async () => {
    await withServer(handler, async (cdp, log) => {
      await clickSelector(cdp, 'a', { rng: seededRng(1), sleep: async () => {} });
      const types = log.filter((l) => l.method === 'Input.dispatchMouseEvent').map((l) => l.params['type']);
      expect(types.indexOf('mousePressed')).toBeGreaterThan(10);
      expect(types.filter((t) => t === 'mouseMoved').length).toBeGreaterThan(10);
      expect(types.slice(-2)).toEqual(['mousePressed', 'mouseReleased']);
    });
    await withServer(handler, async (cdp, log) => {
      await clickSelector(cdp, 'a', { yolo: true });
      expect(log.filter((l) => l.method === 'Input.dispatchMouseEvent').map((l) => l.params['type'])).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    });
  });

  it('type emits keyDown/keyUp pairs, not insertText; --yolo still uses insertText', async () => {
    await withServer(handler, async (cdp, log) => {
      await typeText(cdp, 'Hi 5', { rng: seededRng(2), sleep: async () => {} });
      const kinds = log.map((l) => l.method);
      expect(kinds).not.toContain('Input.insertText');
      const downs = log.filter((l) => l.params['type'] === 'keyDown' && l.params['key'] !== 'Shift').map((l) => l.params['key']);
      const ups = log.filter((l) => l.params['type'] === 'keyUp' && l.params['key'] !== 'Shift').map((l) => l.params['key']);
      expect(downs).toEqual(['H', 'i', ' ', '5']);
      expect(ups).toEqual(downs);
    });
    await withServer(handler, async (cdp, log) => {
      await typeText(cdp, 'Hi', { yolo: true });
      expect(log.map((l) => l.method)).toEqual(['Input.insertText']);
    });
  });

  it('key presses Enter as a down/up pair either way', async () => {
    await withServer(handler, async (cdp, log) => {
      await pressKey(cdp, 'Enter', { rng: seededRng(3), sleep: async () => {} });
      expect(log.map((l) => l.params['type'])).toEqual(['keyDown', 'keyUp']);
      expect(log[0]!.params['text']).toBe('\r');
    });
  });

  it('goto reports via: click when a same-origin link exists, navigate otherwise or with --yolo', async () => {
    const mk = (linkBox: unknown, here0 = 'https://x.test/') => {
      let here = here0;
      return (method: string, params: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mouseReleased') here = 'https://x.test/docs';
      if (method !== 'Runtime.evaluate') return {};
      const e = String(params['expression']);
      if (e === 'location.href') return evalResult(here);
      if (e.includes('innerWidth')) return evalResult({ w: 1000, h: 700 });
      if (e.includes("a[href]") && e.includes('return {x:')) return evalResult(linkBox);
      return evalResult(null);
      };
    };
    await withServer(mk(BOX), async (cdp, log) => {
      const r = await gotoUrl(cdp, 'https://x.test/docs', 50, { rng: seededRng(1), sleep: async () => {} });
      expect(r.via).toBe('click');
      expect(log.some((l) => l.params['type'] === 'mousePressed')).toBe(true);
      expect(log.some((l) => l.method === 'Page.navigate')).toBe(false);
    });
    await withServer(mk(null), async (cdp, log) => {
      const r = await gotoUrl(cdp, 'https://x.test/docs', 50, { rng: seededRng(1), sleep: async () => {} });
      expect(r.via).toBe('navigate');
      expect(log.some((l) => l.method === 'Page.navigate')).toBe(true);
    });
    await withServer(mk(BOX), async (cdp, log) => {
      expect((await gotoUrl(cdp, 'https://x.test/docs', 50, { yolo: true })).via).toBe('navigate');
      expect(log.some((l) => l.params['type'] === 'mousePressed')).toBe(false);
    });
    await withServer(mk(BOX), async (cdp) => {
      expect((await gotoUrl(cdp, 'https://other.test/docs', 50, {})).via).toBe('navigate');
    });
  });
});
