import { describe, it, expect } from 'vitest';
import { describeDoc, remediationFor } from './driver.ts';
import { detachedArgv, runDetachedChild, DETACHED_ENV } from './lib/detach.ts';

// Feedback 2026-11-23: an agent driving bim-bro could not open a browser for the user to log in --
// `auth login` and attached `session launch` were refused with "use the bro CLI", which bim installs
// don't ship, and auth_required pointed back at the failed verb.
describe('driver: agent-driven login', () => {
  const verbs = Object.fromEntries((describeDoc().verbs as Array<Record<string, any>>).filter((v) => !v.is_alias).map((v) => [v.name, v]));

  it('describes auth login as served by the driver, not refused', () => {
    expect(verbs['auth login']!.description).toMatch(/waiting-for-human/);
    expect(verbs['auth login']!.notes).not.toMatch(/refuses/);
  });

  it('session launch is no longer interactive-only', () => {
    expect(verbs['session launch']!.interactive).toBeUndefined();
    expect(verbs['session launch']!.args.map((a: { name: string }) => a.name)).toContain('detach');
  });

  it('auth_required points at `bim bro auth login <site>`', () => {
    const r = remediationFor('auth_required', 'workflow.run', { site: 'chase', workflow: 'statements' }, { needsHuman: true, detail: { site: 'chase' } });
    expect(r.remediation).toEqual({ verb: 'bim bro auth login chase', interactive: true });
    expect(r.hint).toMatch(/bim bro auth login chase/);
  });

  it('other needs-human errors name the bim verb, not a bro CLI', () => {
    expect(remediationFor('bad-args', 'record', {}, { needsHuman: true }).remediation?.verb).toBe('bim bro record');
    expect(remediationFor('runtime', 'page.exec', {}, {})).toEqual({});
  });

  it('detached children: argv per mode, and only routed when the env marker is set', () => {
    expect(detachedArgv('s', ['node', '/x/driver.ts'], ['--import', 'tsx'], false, ['auth', 'login', 's'])).toEqual(['--import', 'tsx', '/x/driver.ts', 'auth', 'login', 's']);
    expect(detachedArgv('s', ['bim-bro.exe', 'bim-bro.exe'], [], true)).toEqual(['session', 'start', 's']);
    expect(runDetachedChild(['node', 'x', 'auth', 'login', 's'], {})).toBeNull();
    expect(runDetachedChild(['node', 'x', 'auth', 'login'], { [DETACHED_ENV]: '1' })).toBeNull();
    expect(runDetachedChild(['node', 'x', 'page', 'open', 'u'], { [DETACHED_ENV]: '1' })).toBeNull();
  });
});
