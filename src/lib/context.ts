import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Download, Page } from 'playwright';
import type { DownloadedFile, SiteConfig, WorkflowContext } from './types.ts';
import type { Sink } from './sink.ts';
import type { RunLog } from './log.ts';
import { sanitizeFilename } from './paths.ts';

/**
 * Build the WorkflowContext injected into run(). `sink` is null in dry-run (`bro test`) — files
 * are staged and measured but never shipped (read-only guardrail for authoring in a live account).
 */
export function buildContext(args: {
  page: Page;
  context: BrowserContext;
  site: SiteConfig;
  params: Record<string, string>;
  sink: Sink | null;
  log: RunLog;
  tmpDir: string;
}): WorkflowContext {
  const { page, context, site, params, sink, log, tmpDir } = args;
  fs.mkdirSync(tmpDir, { recursive: true });

  function ensureName(name: string): string {
    const clean = sanitizeFilename(name);
    return /\.[A-Za-z0-9]{2,5}$/.test(clean) ? clean : `${clean}.pdf`;
  }

  async function ship(tempPath: string, name: string, invoiceId?: string): Promise<DownloadedFile> {
    const bytes = fs.statSync(tempPath).size;
    if (!sink) {
      log.line('staged', { name, bytes, invoiceId, dryRun: true });
      return { name, dest: '(dry-run)', bytes, skipped: false, ...(invoiceId ? { invoiceId } : {}) };
    }
    const res = await sink.put(tempPath, name);
    log.line(res.skipped ? 'skipped' : 'saved', { name, dest: res.dest, bytes: res.bytes, invoiceId });
    return { name, dest: res.dest, bytes: res.bytes, skipped: res.skipped, ...(invoiceId ? { invoiceId } : {}) };
  }

  return {
    page,
    context,
    site,
    params,
    log: (msg, extra) => log.line('workflow', { msg, ...(extra ?? {}) }),

    async save(download: Download, name: string, invoiceId?: string): Promise<DownloadedFile> {
      const finalName = ensureName(name);
      const tempPath = path.join(tmpDir, finalName);
      await download.saveAs(tempPath);
      return ship(tempPath, finalName, invoiceId);
    },

    async saveUrl(url: string, name: string, invoiceId?: string): Promise<DownloadedFile> {
      const finalName = ensureName(name);
      const resp = await context.request.get(url);
      if (!resp.ok()) {
        throw new Error(`saveUrl: GET ${url} -> HTTP ${resp.status()}`);
      }
      const body = await resp.body();
      const tempPath = path.join(tmpDir, finalName);
      fs.writeFileSync(tempPath, body);
      return ship(tempPath, finalName, invoiceId);
    },
  };
}
