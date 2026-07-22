import path from 'node:path';
import type { DownloadedFile } from './types.ts';
import { loadConfig } from './config.ts';
import { loadSite, loadWorkflow } from './registry.ts';
import { openSession, persistState } from './session.ts';
import { authGuard } from './authGuard.ts';
import { buildContext } from './context.ts';
import { createSink } from './sink.ts';
import { RunLog, runId } from './log.ts';
import { resolveMonth, REPO_ROOT } from './paths.ts';
import { noDownloads, BroError } from './errors.ts';

export interface RunManifest {
  site: string;
  workflow: string;
  kind: string;
  month: string;
  sink: string;
  location: string;
  files: DownloadedFile[];
  count: number;
  runLog: string;
}

export interface RunOptions {
  siteId: string;
  workflowName: string;
  cliParams: Record<string, string>;
  month?: string;
  headed?: boolean;
  dryRun?: boolean;
  /** ISO stamp supplied by the CLI (Date is created at the process entrypoint, not in lib) */
  stampIso: string;
  now: Date;
  mirror: boolean;
}

export async function runWorkflow(opts: RunOptions): Promise<RunManifest> {
  const site = loadSite(opts.siteId);
  const wf = await loadWorkflow(opts.siteId, opts.workflowName);
  const cfg = loadConfig();
  const { year, month, ym } = resolveMonth(opts.month, opts.now);

  // assemble params: injected month fields + declared defaults + CLI overrides
  const params: Record<string, string> = { year, month, ym, ...opts.cliParams };
  for (const p of wf.params ?? []) {
    if (params[p.name] === undefined && p.default !== undefined) params[p.name] = p.default;
    if (p.required && params[p.name] === undefined) {
      throw new BroError('bad-args', `workflow "${opts.workflowName}" requires --${p.name}`, {
        detail: { param: p.name },
      });
    }
  }

  const log = new RunLog(runId(opts.stampIso, opts.siteId, opts.workflowName), { mirror: opts.mirror });
  log.line('start', { site: opts.siteId, workflow: opts.workflowName, kind: wf.kind, month: ym, dryRun: !!opts.dryRun });

  const sink = opts.dryRun ? null : createSink(cfg, site.source, year, month);
  const session = await openSession(site, { channel: cfg.browserChannel, headed: opts.headed });
  const page = session.context.pages()[0] ?? (await session.context.newPage());
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  try {
    await authGuard(page, site);
    log.line('authed', { url: page.url() });

    const tmpDir = path.join(REPO_ROOT, '.bro', 'tmp', runId(opts.stampIso, opts.siteId, opts.workflowName));
    const ctx = buildContext({ page, context: session.context, site, params, sink, log, tmpDir });
    const files = await wf.run(ctx);

    const minExpected = wf.minExpected ?? 1;
    if (files.length < minExpected) {
      throw noDownloads(opts.siteId, opts.workflowName, files.length, minExpected);
    }

    if (!opts.dryRun) await persistState(site, session.context, opts.stampIso);
    log.line('done', { count: files.length });

    return {
      site: opts.siteId,
      workflow: opts.workflowName,
      kind: wf.kind,
      month: ym,
      sink: sink ? sink.kind : 'none(dry-run)',
      location: sink ? sink.location() : '(dry-run — nothing shipped)',
      files,
      count: files.length,
      runLog: log.file,
    };
  } catch (err) {
    // capture failure artifacts so an agent can diagnose without a human
    try {
      await page.screenshot({ path: log.artifact('failure.png'), fullPage: true });
    } catch {
      /* page may be gone */
    }
    if (consoleErrors.length) log.line('console-errors', { errors: consoleErrors.slice(0, 20) });
    log.line('error', { message: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    await session.close();
  }
}
