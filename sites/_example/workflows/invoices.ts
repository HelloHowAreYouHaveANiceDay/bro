import type { Workflow, WorkflowContext, DownloadedFile } from '../../../src/lib/types.ts';

/**
 * Example "invoices" workflow — a template to copy per real site.
 * The page is ALREADY authenticated when run() is called.
 * RULE: navigation + read-only + download controls ONLY. Never click pay/cancel/delete/change-plan.
 */
const workflow: Workflow = {
  kind: 'invoices',
  describe: 'download invoice PDFs for a given month',
  params: [{ name: 'month', required: false }],
  minExpected: 1,

  async run(ctx: WorkflowContext): Promise<DownloadedFile[]> {
    const files: DownloadedFile[] = [];
    await ctx.page.goto(ctx.site.homeUrl, { waitUntil: 'domcontentloaded' });
    ctx.log(`looking for invoices for ${ctx.params.ym}`);

    // Pseudo-flow — replace with the real selectors discovered while authoring:
    //
    // const rows = ctx.page.locator('table.invoices tbody tr');
    // for (const row of await rows.all()) {
    //   const id = (await row.getAttribute('data-invoice-id')) ?? '';
    //   // (a) real download event:
    //   const dl = await Promise.all([
    //     ctx.page.waitForEvent('download'),
    //     row.getByRole('button', { name: 'Download' }).click(),
    //   ]).then(([d]) => d);
    //   files.push(await ctx.save(dl, `${ctx.site.source}-${id}.pdf`, id));
    //   // (b) OR inline PDF URL:
    //   // const url = await row.getByRole('link', { name: 'PDF' }).getAttribute('href');
    //   // files.push(await ctx.saveUrl(url!, `${ctx.site.source}-${id}.pdf`, id));
    // }

    return files;
  },
};

export default workflow;
