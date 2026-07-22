import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.ts';

/**
 * Structured JSONL run log — so an agent can diagnose a failed run without a human.
 * One file per run under .bro/runs/. Also mirrors lines to stderr when not in --json mode.
 */
export class RunLog {
  readonly dir: string;
  readonly file: string;
  private mirror: boolean;

  constructor(runId: string, opts: { mirror: boolean }) {
    this.dir = path.join(REPO_ROOT, '.bro', 'runs', runId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'run.jsonl');
    this.mirror = opts.mirror;
  }

  line(event: string, data: Record<string, unknown> = {}): void {
    const rec = { event, ...data };
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    if (this.mirror) process.stderr.write(`  ${event}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`);
  }

  /** path for an on-failure artifact (screenshot / html / console dump) */
  artifact(name: string): string {
    return path.join(this.dir, name);
  }
}

/** ids without Date.now/random (kept deterministic-friendly): caller supplies the stamp. */
export function runId(stamp: string, site: string, workflow: string): string {
  return `${stamp}-${site}-${workflow}`.replace(/[^A-Za-z0-9._-]/g, '-');
}
