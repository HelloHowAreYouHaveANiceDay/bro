import { describe, it, expect } from 'vitest';
import { resolveMonth, sanitizeFilename, accountingRelPath } from './paths.ts';

describe('resolveMonth', () => {
  it('parses an explicit YYYY-MM', () => {
    expect(resolveMonth('2026-06', new Date('2026-07-21T00:00:00Z'))).toEqual({
      year: '2026',
      month: '06',
      ym: '2026-06',
    });
  });

  it('defaults to the previous month', () => {
    expect(resolveMonth(undefined, new Date('2026-07-21T00:00:00Z')).ym).toBe('2026-06');
  });

  it('rolls the year back across January', () => {
    expect(resolveMonth(undefined, new Date('2026-01-05T00:00:00Z')).ym).toBe('2025-12');
  });

  it('rejects malformed month', () => {
    expect(() => resolveMonth('2026/06', new Date())).toThrow();
    expect(() => resolveMonth('2026-13', new Date())).toThrow();
  });
});

describe('sanitizeFilename', () => {
  it('strips unsafe chars and collapses whitespace', () => {
    expect(sanitizeFilename('inv 01/02:03*?.pdf')).toBe('inv-01-02-03-.pdf');
  });
  it('keeps a clean name intact', () => {
    expect(sanitizeFilename('cloudflare-INV123.pdf')).toBe('cloudflare-INV123.pdf');
  });
});

describe('accountingRelPath', () => {
  it('builds {year}/{month}/{source}', () => {
    expect(accountingRelPath('cloudflare', '2026', '06').replace(/\\/g, '/')).toBe('2026/06/cloudflare');
  });
});
