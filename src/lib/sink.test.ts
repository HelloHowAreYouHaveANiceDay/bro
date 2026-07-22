import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSink } from './sink.ts';
import type { BroConfig } from './config.ts';

let root: string;
let tempFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-sink-'));
  tempFile = path.join(root, 'staged.pdf');
  fs.writeFileSync(tempFile, 'PDFDATA');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function cfg(): BroConfig {
  return { sink: 'local', localRoot: path.join(root, 'out'), driveRawFolder: '', browserChannel: 'msedge' };
}

describe('LocalSink', () => {
  it('writes into {year}/{month}/{source} and reports not-skipped', async () => {
    const sink = createSink(cfg(), 'cloudflare', '2026', '06');
    const res = await sink.put(tempFile, 'cloudflare-INV1.pdf');
    expect(res.skipped).toBe(false);
    expect(res.bytes).toBe(7);
    expect(res.dest.replace(/\\/g, '/')).toContain('out/2026/06/cloudflare/cloudflare-INV1.pdf');
    expect(fs.existsSync(res.dest)).toBe(true);
  });

  it('is idempotent — a second put of the same name skips (no overwrite)', async () => {
    const sink = createSink(cfg(), 'cloudflare', '2026', '06');
    await sink.put(tempFile, 'cloudflare-INV1.pdf');
    // change the staged content; a skip must NOT overwrite
    fs.writeFileSync(tempFile, 'DIFFERENT-LONGER');
    const res2 = await sink.put(tempFile, 'cloudflare-INV1.pdf');
    expect(res2.skipped).toBe(true);
    expect(fs.readFileSync(res2.dest, 'utf8')).toBe('PDFDATA');
  });
});
