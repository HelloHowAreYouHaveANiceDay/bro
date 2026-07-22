import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SiteConfig, Workflow } from './types.ts';
import { sitesDir, siteDir } from './paths.ts';
import { noSuchSite, noSuchWorkflow, BroError } from './errors.ts';

/** dirs under sites/ that have a site.json (the "_example" template is included). */
export function listSites(): string[] {
  const root = sitesDir();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'site.json')))
    .map((d) => d.name)
    .sort();
}

export function loadSite(id: string): SiteConfig {
  const file = path.join(siteDir(id), 'site.json');
  if (!fs.existsSync(file)) throw noSuchSite(id, listSites());
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SiteConfig>;
  for (const k of ['name', 'loginUrl', 'homeUrl', 'source'] as const) {
    if (!raw[k]) throw new BroError('bad-args', `site "${id}" is missing "${k}" in site.json`);
  }
  return { ...(raw as SiteConfig), id };
}

export function listWorkflows(id: string): string[] {
  const dir = path.join(siteDir(id), 'workflows');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

export async function loadWorkflow(id: string, name: string): Promise<Workflow> {
  const file = path.join(siteDir(id), 'workflows', `${name}.ts`);
  if (!fs.existsSync(file)) throw noSuchWorkflow(id, name, listWorkflows(id));
  // absolute Windows path must be a file:// URL for dynamic import (ERR_UNSUPPORTED_ESM_URL_SCHEME otherwise)
  const mod = (await import(pathToFileURL(file).href)) as { default?: Workflow };
  const wf = mod.default;
  if (!wf || typeof wf.run !== 'function') {
    throw new BroError('bad-args', `workflow "${name}" for "${id}" has no default export implementing Workflow`);
  }
  return wf;
}
