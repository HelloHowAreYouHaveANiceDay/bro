/**
 * Human input layer: the single place that decides how bro's pointer, keyboard and wheel behave.
 * Shared by `bro page click|type|key` (raw CDP via PageCDP) and the workflow ctx (Playwright page +
 * CDPSession). Everything random goes through an injectable RNG and everything timed through an
 * injectable sleep, so tests are deterministic and never really wait.
 */

export type Rng = () => number;
export interface Point {
  x: number;
  y: number;
}
/** Element box in VIEWPORT coordinates (what getBoundingClientRect returns). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface HumanPage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
}
/** Something the human layer can aim at: how to measure it, and a last-resort scroll. */
export interface HumanTarget {
  box(): Promise<Box | null>;
  scrollIntoView?(): Promise<void>;
}
export interface HumanOpts {
  rng?: Rng;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Back-compat flat pause (unchanged signature). */
export async function humanPause(minMs = 120, maxMs = 320): Promise<void> {
  const floor = Math.max(0, Math.floor(minMs));
  const ceiling = Math.max(floor, Math.floor(maxMs));
  const span = ceiling - floor;
  const delay = floor + Math.floor(Math.random() * (span + 1));
  await realSleep(delay);
}

export type ThinkKind = 'glance' | 'read' | 'beforeSubmit';
const THINK_RANGES: Record<ThinkKind, [number, number]> = {
  glance: [150, 450],
  read: [700, 2200],
  beforeSubmit: [500, 1600],
};
/** Delay (ms) for a think-pause preset; exported separately so it is testable without sleeping. */
export function thinkDelay(kind: ThinkKind, rng: Rng = Math.random): number {
  const [lo, hi] = THINK_RANGES[kind];
  return Math.floor(lo + rng() * (hi - lo + 1));
}
export async function thinkPause(kind: ThinkKind, opts: HumanOpts = {}): Promise<void> {
  await (opts.sleep ?? realSleep)(thinkDelay(kind, opts.rng ?? Math.random));
}

// ---------- pointer paths ----------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (u: number) => u * u * (3 - 2 * u);

/** standard normal via Box-Muller */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface PathStep extends Point {
  /** ms to wait BEFORE emitting this step */
  delay: number;
}

/** Fitts-ish total duration: grows with log of distance, 200..700ms, +-10% jitter (re-clamped). */
export function moveDuration(dist: number, rng: Rng): number {
  const base = 150 + 110 * Math.log2(1 + dist / 40);
  return clamp(base * (0.9 + 0.2 * rng()), 200, 700);
}

/**
 * Cubic Bezier from `from` to `to`. Control points sit at 20-40% / 60-80% of the way along the
 * line (so progress along the line is monotone) with a random perpendicular bow. Samples are eased
 * (smoothstep) and the LAST sample is exactly `to`.
 */
export function bezierPath(from: Point, to: Point, rng: Rng, opts: { steps?: number; durationMs?: number } = {}): PathStep[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = opts.steps ?? clamp(Math.round(8 + dist / 25), 15, 40);
  const total = opts.durationMs ?? moveDuration(dist, rng);
  const nx = dist > 0 ? -dy / dist : 0;
  const ny = dist > 0 ? dx / dist : 0;
  const bow = () => (rng() - 0.5) * 2 * Math.min(120, dist * 0.18);
  const a = 0.2 + rng() * 0.2;
  const b = 0.6 + rng() * 0.2;
  const o1 = bow();
  const o2 = bow();
  const c1 = { x: from.x + dx * a + nx * o1, y: from.y + dy * a + ny * o1 };
  const c2 = { x: from.x + dx * b + nx * o2, y: from.y + dy * b + ny * o2 };
  const out: PathStep[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = smoothstep(i / steps);
    const m = 1 - t;
    const isLast = i === steps;
    const x = isLast ? to.x : m * m * m * from.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * to.x;
    const y = isLast ? to.y : m * m * m * from.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * to.y;
    const delay = Math.max(1, Math.round((total / steps) * (0.7 + 0.6 * rng())));
    out.push({ x, y, delay });
  }
  return out;
}

/** Full move plan: main arc (15-40 steps) plus, on long moves, an overshoot and a short correction. */
export function planMove(from: Point, to: Point, rng: Rng): PathStep[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [];
  if (dist > 300 && rng() < 0.5) {
    const k = 1.02 + rng() * 0.04;
    const over = { x: from.x + dx * k, y: from.y + dy * k };
    const main = bezierPath(from, over, rng);
    const fix = bezierPath(over, to, rng, { steps: 6 + Math.floor(rng() * 4), durationMs: 90 + rng() * 120 });
    return [...main, ...fix];
  }
  return bezierPath(from, to, rng);
}

/** Random point inside the box: gaussian around center, clamped to the inner 60%. */
export function clickPoint(box: Box, rng: Rng): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const mx = box.width * 0.3;
  const my = box.height * 0.3;
  return {
    x: clamp(cx + gaussian(rng) * box.width * 0.15, cx - mx, cx + mx),
    y: clamp(cy + gaussian(rng) * box.height * 0.15, cy - my, cy + my),
  };
}

// ---------- keyboard ----------

export interface KeySpec {
  key: string;
  code: string;
  vk: number;
  /** char to insert; omitted for non-printing keys */
  text?: string;
  shift: boolean;
}

const SHIFT_DIGITS = ')!@#$%^&*(';
// [unshifted, shifted, code, vk]
const PUNCT: Array<[string, string, string, number]> = [
  [';', ':', 'Semicolon', 186],
  ['=', '+', 'Equal', 187],
  [',', '<', 'Comma', 188],
  ['-', '_', 'Minus', 189],
  ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192],
  ['[', '{', 'BracketLeft', 219],
  ['\\', '|', 'Backslash', 220],
  [']', '}', 'BracketRight', 221],
  ["'", '"', 'Quote', 222],
];

/** CDP key-event fields for one US-layout ASCII char, or null when it has no mapping (caller inserts text). */
export function keyForChar(ch: string): KeySpec | null {
  if (ch.length !== 1) return null;
  const c = ch.charCodeAt(0);
  if (ch >= 'a' && ch <= 'z') return { key: ch, code: `Key${ch.toUpperCase()}`, vk: c - 32, text: ch, shift: false };
  if (ch >= 'A' && ch <= 'Z') return { key: ch, code: `Key${ch}`, vk: c, text: ch, shift: true };
  if (ch >= '0' && ch <= '9') return { key: ch, code: `Digit${ch}`, vk: c, text: ch, shift: false };
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, text: ' ', shift: false };
  const si = SHIFT_DIGITS.indexOf(ch);
  if (si >= 0) return { key: ch, code: `Digit${si}`, vk: 48 + si, text: ch, shift: true };
  for (const [plain, shifted, code, vk] of PUNCT) {
    if (ch === plain) return { key: ch, code, vk, text: ch, shift: false };
    if (ch === shifted) return { key: ch, code, vk, text: ch, shift: true };
  }
  return null;
}

/** Non-printing keys for `bro page key`. */
export const NAMED_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
};

/** Inter-key delay: lognormal with mean ~110ms (sigma .45), clamped 35..650; ~4% get a longer pause. */
export function keyDelay(rng: Rng): number {
  const sigma = 0.45;
  const mu = Math.log(110) - (sigma * sigma) / 2;
  let d = Math.exp(mu + sigma * gaussian(rng));
  d = clamp(d, 35, 650);
  if (rng() < 0.04) d += 250 + rng() * 650;
  return Math.round(d);
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function neighborKey(ch: string, rng: Rng): string | null {
  const lower = ch.toLowerCase();
  for (const row of ROWS) {
    const i = row.indexOf(lower);
    if (i < 0) continue;
    const j = i === 0 ? 1 : i === row.length - 1 ? i - 1 : rng() < 0.5 ? i - 1 : i + 1;
    const n = row[j]!;
    return ch === lower ? n : n.toUpperCase();
  }
  return null;
}

const MOD_SHIFT = 8;

/** Max total sleep for one `type` call (about 1.5 s per field, however long the value). */
export const TYPE_BUDGET_MS = 1500;
/** Typical wall time per key (inter-key gap + press). */
const TYPE_MS_PER_CHAR = 190;
/** Below this speed-up factor (~28 ms/key) per-key typing is pointless: paste in chunks instead. */
const TYPE_MIN_SCALE = 0.15;
const TYPE_CHUNK_MIN = 40;
const TYPE_MAX_CHUNKS = 20;

// ---------- the actor ----------

const cursors = new WeakMap<object, Point>();

export class Human {
  readonly rng: Rng;
  private sleep: (ms: number) => Promise<void>;

  constructor(private page: HumanPage, opts: HumanOpts = {}) {
    this.rng = opts.rng ?? Math.random;
    this.sleep = opts.sleep ?? realSleep;
  }

  private async viewport(): Promise<{ w: number; h: number }> {
    const v = (await this.page.evaluate('({w: innerWidth, h: innerHeight})').catch(() => null)) as { w?: number; h?: number } | null;
    return { w: Number(v?.w) > 0 ? Number(v!.w) : 1280, h: Number(v?.h) > 0 ? Number(v!.h) : 720 };
  }

  /** Last pointer position for this page; first use picks a plausible in-viewport point . */
  async cursor(): Promise<Point> {
    const known = cursors.get(this.page);
    if (known) return known;
    const vp = await this.viewport();
    const p: Point = { x: vp.w * (0.3 + this.rng() * 0.4), y: vp.h * (0.3 + this.rng() * 0.4) };
    cursors.set(this.page, p);
    return p;
  }

  /** Pointer position lives only in this process (WeakMap); nothing is written into the page. */
  private async remember(p: Point): Promise<void> {
    cursors.set(this.page, p);
  }

  private mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel', p: Point, extra: Record<string, unknown> = {}) {
    return this.page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
  }

  async move(to: Point): Promise<void> {
    const from = await this.cursor();
    for (const step of planMove(from, to, this.rng)) {
      await this.sleep(step.delay);
      await this.mouse('mouseMoved', step, { button: 'none', buttons: 0 });
    }
    await this.remember(to);
  }

  /** Stepped mouseWheel until the target box is comfortably inside the viewport; scrollIntoView only if the wheel makes no progress. */
  async scroll(target: HumanTarget): Promise<Box | null> {
    const vp = await this.viewport();
    const margin = Math.min(60, vp.h * 0.1);
    const inView = (b: Box) => b.y >= margin && b.y + b.height <= vp.h - margin;
    let box = await target.box();
    let stalls = 0;
    for (let i = 0; box && !inView(box) && i < 80; i++) {
      const center = box.y + box.height / 2;
      const dir = center < vp.h / 2 ? -1 : 1;
      const cur = await this.cursor();
      const at = { x: clamp(cur.x, 1, vp.w - 1), y: clamp(cur.y, 1, vp.h - 1) };
      const delta = dir * Math.round(80 + this.rng() * 40);
      await this.mouse('mouseWheel', at, { deltaX: 0, deltaY: delta });
      await this.sleep(Math.round(15 + this.rng() * 55));
      const next = await target.box();
      if (!next) return null;
      stalls = Math.abs(next.y - box.y) < 1 ? stalls + 1 : 0;
      box = next;
      if (stalls >= 2) {
        if (target.scrollIntoView) {
          await target.scrollIntoView();
          box = await target.box();
        }
        break;
      }
    }
    return box;
  }

  async click(target: HumanTarget): Promise<Point> {
    const box = await this.scroll(target);
    if (!box) throw new Error('human.click: target is not visible');
    const pt = clickPoint(box, this.rng);
    await this.move(pt);
    await this.sleep(Math.round(80 + this.rng() * 170));
    await this.mouse('mousePressed', pt, { button: 'left', buttons: 1, clickCount: 1 });
    await this.sleep(Math.round(50 + this.rng() * 70));
    await this.mouse('mouseReleased', pt, { button: 'left', buttons: 0, clickCount: 1 });
    return pt;
  }

  private async key(type: 'keyDown' | 'keyUp', k: { key: string; code: string; vk: number; text?: string }, shift: boolean) {
    await this.page.send('Input.dispatchKeyEvent', {
      type,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      modifiers: shift ? MOD_SHIFT : 0,
      ...(type === 'keyDown' && k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });
  }

  private async tap(k: KeySpec): Promise<void> {
    const shiftKey = { key: 'Shift', code: 'ShiftLeft', vk: 16 };
    if (k.shift) {
      await this.key('keyDown', shiftKey, true);
      await this.sleep(Math.round(20 + this.rng() * 40));
    }
    await this.key('keyDown', k, k.shift);
    await this.sleep(Math.round(30 + this.rng() * 60));
    await this.key('keyUp', k, k.shift);
    if (k.shift) {
      await this.sleep(Math.round(10 + this.rng() * 30));
      await this.key('keyUp', shiftKey, false);
    }
  }

  /** Type into the focused element. `typos` (default off; never for passwords) adds rare wrong-key + Backspace fixes. */
  async type(text: string, opts: { typos?: boolean; maxTotalMs?: number } = {}): Promise<void> {
    const chars = [...text];
    const budget = opts.maxTotalMs ?? TYPE_BUDGET_MS;
    // Bounded: total sleep per call never exceeds `budget`. Short values keep full human timing,
    // longer ones are sped up proportionally, and values too long for per-key typing are pasted in chunks.
    const scale = Math.min(1, budget / Math.max(1, chars.length * TYPE_MS_PER_CHAR));
    const realSleepFn = this.sleep;
    let spent = 0;
    const pace = (ms: number) => {
      const d = Math.min(Math.round(ms * scale), Math.max(0, budget - spent));
      spent += d;
      return d > 0 ? realSleepFn(d) : Promise.resolve();
    };
    const saved = this.sleep;
    this.sleep = pace;
    try {
      if (scale < TYPE_MIN_SCALE) {
        const chunk = Math.max(TYPE_CHUNK_MIN, Math.ceil(chars.length / TYPE_MAX_CHUNKS));
        for (let i = 0; i < chars.length; i += chunk) {
          if (i > 0) await this.sleep(Math.round(40 + this.rng() * 80) / scale);
          await this.page.send('Input.insertText', { text: chars.slice(i, i + chunk).join('') });
        }
        return;
      }
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]!;
        if (i > 0) await this.sleep(keyDelay(this.rng));
        if (opts.typos && /[a-zA-Z]/.test(ch) && this.rng() < 0.03) {
          const wrong = neighborKey(ch, this.rng);
          const wk = wrong ? keyForChar(wrong) : null;
          if (wk) {
            await this.tap(wk);
            await this.sleep(Math.round(150 + this.rng() * 350));
            await this.tap({ key: 'Backspace', code: 'Backspace', vk: 8, shift: false });
            await this.sleep(keyDelay(this.rng));
          }
        }
        const k = keyForChar(ch);
        if (k) await this.tap(k);
        else await this.page.send('Input.insertText', { text: ch });
      }
    } finally {
      this.sleep = saved;
    }
  }

  /** One named key (Enter, Tab, ...) with a human-length press. */
  async press(name: string): Promise<void> {
    const k = NAMED_KEYS[name];
    if (!k) throw new Error(`unsupported key "${name}"`);
    await this.tap({ key: name, code: k.code, vk: k.vk, ...(k.text ? { text: k.text } : {}), shift: false });
  }
}

/** Seeded RNG (mulberry32) for tests and reproducible runs. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rawWarned = false;
/** `--raw` was renamed `--yolo`; the old spelling still works but warns once on stderr. */
export function warnRawDeprecated(): void {
  if (rawWarned) return;
  rawWarned = true;
  process.stderr.write('bro: --raw is deprecated, use --yolo (same behaviour: skip the human input layer)\n');
}
