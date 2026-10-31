import { BroError } from './errors.ts';

export function canonicalMethod(method: string, params: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const aliases: Record<string, string> = {
    list: 'site.list', sessions: 'session.list', open: 'page.open', page: 'page.exec',
    run: 'workflow.run', test: 'workflow.run', 'run-all': 'workflow.run-all', auth: 'auth.login',
  };
  if (method === 'session') {
    const { op, ...rest } = params;
    if (op === 'start') return { method: 'session.launch', params: rest };
    if (op === 'stop') return { method: 'session.quit', params: rest };
    throw new BroError('bad-args', 'session op must be start|stop', { hint: 'bro session launch <site> --detach | bro session quit <site>' });
  }
  if (method === 'test') return { method: 'workflow.run', params: { ...params, 'dry-run': true } };
  return { method: aliases[method] ?? method, params };
}

export function parseCliVerb(positionals: string[]): { verb: string; rest: string[]; dryRun: boolean } {
  const [first, second] = positionals;
  const twoWord: Record<string, string[]> = {
    site: ['list'], session: ['list', 'launch', 'quit', 'start', 'stop'],
    page: ['open', 'exec'], workflow: ['run', 'run-all'], auth: ['login'],
  };
  if (first && twoWord[first]?.includes(second ?? '')) {
    const aliases: Record<string, string> = { start: 'launch', stop: 'quit' };
    const action = aliases[second!] ?? second!;
    return { verb: `${first}.${action}`, rest: positionals.slice(2), dryRun: false };
  }
  if (first === 'page') return { verb: 'page.exec', rest: positionals.slice(1), dryRun: false };
  if (first === 'auth') return { verb: 'auth.login', rest: positionals.slice(1), dryRun: false };
  const oneWord: Record<string, string> = {
    list: 'site.list', sessions: 'session.list', open: 'page.open', page: 'page.exec',
    run: 'workflow.run', test: 'workflow.run', 'run-all': 'workflow.run-all', auth: 'auth.login',
  };
  return { verb: oneWord[first ?? ''] ?? first ?? '', rest: positionals.slice(1), dryRun: first === 'test' };
}
