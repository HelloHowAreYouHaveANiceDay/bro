/**
 * Typed error taxonomy — agents branch on `kind`/`needsHuman`, they never parse stack traces.
 */
export type BroErrorKind =
  | 'auth-expired'
  | 'no-such-site'
  | 'no-such-workflow'
  | 'no-downloads'
  | 'bot-blocked'
  | 'sink-unavailable'
  | 'bad-args'
  | 'internal';

export class BroError extends Error {
  readonly kind: BroErrorKind;
  readonly retriable: boolean;
  readonly needsHuman: boolean;
  readonly hint?: string;
  readonly detail?: Record<string, unknown>;

  constructor(
    kind: BroErrorKind,
    message: string,
    opts: { retriable?: boolean; needsHuman?: boolean; hint?: string; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'BroError';
    this.kind = kind;
    this.retriable = opts.retriable ?? false;
    this.needsHuman = opts.needsHuman ?? false;
    this.hint = opts.hint;
    this.detail = opts.detail;
  }

  toEnvelope(): Record<string, unknown> {
    return {
      kind: this.kind,
      message: this.message,
      retriable: this.retriable,
      needsHuman: this.needsHuman,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export function authExpired(siteId: string): BroError {
  return new BroError('auth-expired', `auth for "${siteId}" is expired or missing`, {
    needsHuman: true,
    hint: `run: bro auth ${siteId}`,
    detail: { site: siteId },
  });
}

export function noSuchSite(siteId: string, available: string[]): BroError {
  return new BroError('no-such-site', `no site "${siteId}"`, {
    hint: available.length ? `available sites: ${available.join(', ')}` : 'no sites defined yet',
    detail: { requested: siteId, available },
  });
}

export function noSuchWorkflow(siteId: string, wf: string, available: string[]): BroError {
  return new BroError('no-such-workflow', `no workflow "${wf}" for site "${siteId}"`, {
    hint: available.length ? `available: ${available.join(', ')}` : 'no workflows defined for this site',
    detail: { site: siteId, requested: wf, available },
  });
}

export function noDownloads(siteId: string, wf: string, got: number, expected: number): BroError {
  return new BroError('no-downloads', `workflow "${wf}" produced ${got} file(s), expected >= ${expected}`, {
    hint: 'the vendor UI may have changed and broken the selectors; inspect the failure screenshot/console',
    detail: { site: siteId, workflow: wf, got, expected },
  });
}
