import { describe, it, expect } from 'vitest';
import { isInsideDir } from './paths.ts';

describe('isInsideDir', () => {
  it('accepts paths under the dir, rejects siblings, parents and the dir itself', () => {
    expect(isInsideDir('/rt/node_modules/playwright/index.js', '/rt')).toBe(true);
    expect(isInsideDir('/home/u/node_modules/playwright/index.js', '/rt')).toBe(false);
    expect(isInsideDir('/rt2/x.js', '/rt')).toBe(false);
    expect(isInsideDir('/rt', '/rt')).toBe(false);
  });
});
