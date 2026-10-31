import { describe, expect, it } from 'vitest';
import { canonicalMethod, parseCliVerb } from './verbs.ts';

describe('canonicalMethod', () => {
  it.each([
    ['list', {}, 'site.list', {}],
    ['sessions', {}, 'session.list', {}],
    ['session', { op: 'start', site: 'a', detach: true }, 'session.launch', { site: 'a', detach: true }],
    ['session', { op: 'stop', site: 'a' }, 'session.quit', { site: 'a' }],
    ['open', { url: 'https://example.com/' }, 'page.open', { url: 'https://example.com/' }],
    ['page', { site: 's', action: 'text' }, 'page.exec', { site: 's', action: 'text' }],
    ['run', { site: 's', workflow: 'w' }, 'workflow.run', { site: 's', workflow: 'w' }],
    ['test', { site: 's', workflow: 'w' }, 'workflow.run', { site: 's', workflow: 'w', 'dry-run': true }],
    ['run-all', { kind: 'invoices' }, 'workflow.run-all', { kind: 'invoices' }],
    ['auth', { site: 's' }, 'auth.login', { site: 's' }],
    ['session.list', {}, 'session.list', {}],
    ['doctor', {}, 'doctor', {}],
  ] as const)('maps %s', (method, params, expectedMethod, expectedParams) => {
    expect(canonicalMethod(method, params as Record<string, unknown>)).toEqual({ method: expectedMethod, params: expectedParams });
  });

  it('rejects invalid legacy session operations', () => {
    expect(() => canonicalMethod('session', { op: 'bogus', site: 'a' })).toThrow(expect.objectContaining({ kind: 'bad-args' }));
  });
});

describe('parseCliVerb', () => {
  it.each([
    [['site', 'list'], 'site.list', [], false], [['list'], 'site.list', [], false],
    [['sessions'], 'session.list', [], false], [['session', 'list'], 'session.list', [], false],
    [['session', 'start', 'a'], 'session.launch', ['a'], false], [['session', 'launch', 'a'], 'session.launch', ['a'], false],
    [['session', 'stop', 'a'], 'session.quit', ['a'], false], [['open', 'https://example.com/'], 'page.open', ['https://example.com/'], false],
    [['page', 'open', 'https://example.com/'], 'page.open', ['https://example.com/'], false],
    [['page', 'scratch', 'text'], 'page.exec', ['scratch', 'text'], false], [['page', 'exec', 'scratch', 'eval', '1+1'], 'page.exec', ['scratch', 'eval', '1+1'], false],
    [['run', 's', 'w'], 'workflow.run', ['s', 'w'], false], [['workflow', 'run', 's', 'w'], 'workflow.run', ['s', 'w'], false],
    [['test', 's', 'w'], 'workflow.run', ['s', 'w'], true], [['run-all'], 'workflow.run-all', [], false],
    [['workflow', 'run-all'], 'workflow.run-all', [], false], [['auth', 's'], 'auth.login', ['s'], false],
    [['auth', 'login', 's'], 'auth.login', ['s'], false], [['record', 's', 'w'], 'record', ['s', 'w'], false],
    [['describe'], 'describe', [], false], [['session', 'quit', 'a'], 'session.quit', ['a'], false],
    [['session'], 'session', [], false], [['session', 'bogus', 'a'], 'session', ['bogus', 'a'], false],
    [['new', 's', 'w'], 'new', ['s', 'w'], false], [['bogus-verb'], 'bogus-verb', [], false], [[], '', [], false],
  ] as const)('parses %j', (input, verb, rest, dryRun) => {
    expect(parseCliVerb([...input])).toEqual({ verb, rest, dryRun });
  });
});
