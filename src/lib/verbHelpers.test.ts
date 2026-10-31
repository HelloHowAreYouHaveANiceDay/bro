import { describe, expect, it } from 'vitest';
import { pageOptsFromParams, resolveDateStamp } from './verbs.ts';

describe('workflow date stamp compatibility', () => {
  const now = new Date(2026, 0, 15);

  it.each([
    [{ 'date-stamp': '2026-08-31' }, '2026-08-31'],
    [{ dateStamp: '2026-08-31' }, '2026-08-31'],
    [{ 'date-stamp': true }, '2026-01-15'],
    [{ dateStamp: true }, '2026-01-15'],
    [{ 'date-stamp': '2026-02-01', dateStamp: '2026-03-01' }, '2026-02-01'],
    [{}, undefined],
  ])('resolves %j', (params, expected) => {
    expect(resolveDateStamp(params, now)).toBe(expected);
  });
});

describe('page exec option coercion', () => {
  it.each([
    [{ wait: '500', max: '100' }, { tab: undefined, wait: 500, max: 100, reload: false, full: false, out: undefined }],
    [{ wait: 500, max: 100 }, { tab: undefined, wait: 500, max: 100, reload: false, full: false, out: undefined }],
    [{ tab: 'abc', reload: true, full: 'true', out: 'C:/x/r.json' }, { tab: 'abc', wait: undefined, max: undefined, reload: true, full: true, out: 'C:/x/r.json' }],
    [{ wait: '' }, { tab: undefined, wait: undefined, max: undefined, reload: false, full: false, out: undefined }],
  ])('maps %j', (params, expected) => {
    expect(pageOptsFromParams(params)).toEqual(expected);
  });
});
