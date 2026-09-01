import fs from 'node:fs';
import path from 'node:path';
import { siteDir } from './paths.ts';
import { BroError } from './errors.ts';

/** Emit a typed Workflow skeleton for an agent to fill in (`bro new`). */
export function scaffoldWorkflow(siteId: string, name: string, kind: string): string {
  const dir = path.join(siteDir(siteId), 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.ts`);
  if (fs.existsSync(file)) throw new BroError('bad-args', `workflow "${name}" already exists for "${siteId}"`);

  const rel = '../../../src/lib/types.ts';
  fs.writeFileSync(
    file,
    `import type { Workflow, WorkflowContext, DownloadedFile } from '${rel}';

/**
 * ${kind} for ${siteId}.
 *
 * The page passed in is ALREADY authenticated. Author by exploring the live session
 * (playwright-cli snapshot) and filling in the navigate -> list -> download loop below.
 * RULE: navigation + read-only + download controls ONLY. Never click pay/cancel/delete/change.
 */
const workflow: Workflow = {
  kind: '${kind}',
  describe: '${kind} for ${siteId}',
  params: [{ name: 'month', default: undefined, required: false }],
  minExpected: 1,

  async run(ctx: WorkflowContext): Promise<DownloadedFile[]> {
    const files: DownloadedFile[] = [];
    await ctx.reach({ url: ctx.site.homeUrl });

    // TODO: prefer ctx.reach({ text: /Statements/i }) for in-app routes; bare goto can log out token-in-URL SPAs.
    // TODO: enumerate rows for ctx.params.ym and download each. Two capture modes:
    //   (a) real download:  const dl = await ctx.page.waitForEvent('download', () => row.click());
    //                       files.push(await ctx.save(dl, \`\${ctx.site.source}-\${id}.pdf\`, id));
    //   (b) inline PDF url:  files.push(await ctx.saveUrl(pdfUrl, \`\${ctx.site.source}-\${id}.pdf\`, id));

    return files;
  },
};

export default workflow;
`,
  );
  return file;
}
