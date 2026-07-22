import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SiteConfig } from './types.ts';
import { authPath, authMetaPath, siteDir } from './paths.ts';

/** Flow A: human logs in; Playwright saves storageState. The one irreducibly-human step. */
export function authFlow(site: SiteConfig, channel: string, stampIso: string): void {
  const out = authPath(site.id);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(
    'npx',
    ['playwright', 'codegen', '--channel', channel, `--save-storage=${out}`, site.loginUrl],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (r.status !== 0) throw new Error(`codegen exited ${r.status}`);
  fs.writeFileSync(
    authMetaPath(site.id),
    JSON.stringify({ capturedAt: stampIso, loginUrl: site.loginUrl }, null, 2) + '\n',
  );
}

/** Flow B (optional): human demonstrates a task on the already-authed session; transcript -> file. */
export function recordFlow(site: SiteConfig, workflowName: string, channel: string): string {
  const outFile = path.join(siteDir(site.id), 'workflows', `${workflowName}.recorded.ts`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const r = spawnSync(
    'npx',
    [
      'playwright',
      'codegen',
      '--channel',
      channel,
      `--load-storage=${authPath(site.id)}`,
      '-o',
      outFile,
      site.homeUrl,
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (r.status !== 0) throw new Error(`codegen exited ${r.status}`);
  return outFile;
}
