import { describe, it, expect } from 'vitest';
import { describeDoc, workflowParams } from './driver.ts';

// bim's dispatcher rejects undeclared --flags unless the verb declares extra_args.
// run/test must declare it so workflow params (`--url`, `--req`, ...) reach the workflow.
describe('run/test pass workflow params through bim', () => {
  const verbs = (describeDoc().verbs as Array<Record<string, unknown>>);
  for (const name of ['run', 'test']) {
    it(`${name} declares extra_args`, () => {
      expect(verbs.find((v) => v.name === name)?.extra_args).toBe(true);
    });
  }
  it('other verbs do not', () => {
    expect(verbs.find((v) => v.name === 'list')?.extra_args).toBeUndefined();
  });
  it('workflowParams stringifies non-string values', () => {
    expect(workflowParams({ site: 'espn', dry: true, n: 3, f: { a: 1 }, x: null })).toEqual({ site: 'espn', dry: 'true', n: '3', f: '{"a":1}' });
  });
});
