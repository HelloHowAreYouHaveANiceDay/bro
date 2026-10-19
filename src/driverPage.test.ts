import { describe, it, expect } from 'vitest';
import { describeDoc } from './driver.ts';
import { pageAction, PAGE_ACTIONS } from './lib/pageActions.ts';

describe('driver describe: page verbs', () => {
  const verbs = (describeDoc().verbs as Array<{ name: string; args: Array<{ name: string }> }>);
  const byName = Object.fromEntries(verbs.map((v) => [v.name, v]));

  it('exposes open and page so `bim bro open|page` route to the driver', () => {
    expect(byName['open']!.args.map((a) => a.name)).toEqual(['url', 'site']);
    expect(byName['page']!.args.map((a) => a.name)).toEqual(['site', 'action', 'arg', 'tab', 'wait', 'max', 'reload', 'full', 'out']);
  });

  it('session takes --detach', () => {
    expect(byName['session']!.args.map((a) => a.name)).toContain('detach');
  });

  it('reports the bumped version', () => {
    expect(describeDoc().version).toBe('0.3.0');
  });
});

describe('pageAction arg validation', () => {
  it('rejects unknown actions before touching any session', async () => {
    await expect(pageAction('scratch', 'explode', undefined)).rejects.toMatchObject({ kind: 'bad-args' });
    expect(PAGE_ACTIONS).toContain('capture');
  });
  it('requires site and action', async () => {
    await expect(pageAction('', '', undefined)).rejects.toMatchObject({ kind: 'bad-args' });
  });
});
