import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Playwright defaults chromiumSandbox to false, which launches Chromium with --no-sandbox: a renderer
// exploit on any visited page then runs with the full rights of the bro user (profiles, auth.json).
// Every launch site must opt back in.
describe('chromium sandbox', () => {
  it('every chromium.launch* call sets chromiumSandbox: true', () => {
    const dir = join(__dirname);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      const calls = src.match(/chromium\.launch(PersistentContext)?\([^{]*\{[^}]*/g) ?? [];
      for (const c of calls) expect(c, `${f}: ${c.slice(0, 60)}`).toContain('chromiumSandbox: true');
    }
  });
});
