import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BroConfig } from './config.ts';
import { BroError } from './errors.ts';
import { accountingRelPath } from './paths.ts';

export interface PutResult {
  dest: string;
  bytes: number;
  skipped: boolean;
}

/** A destination for produced files, scoped to one (source, year, month). */
export interface Sink {
  readonly kind: string;
  /** human/agent-readable description of where files land */
  location(): string;
  /** move a staged temp file to its final home. Skips (no overwrite) if the name already exists. */
  put(tempPath: string, name: string): Promise<PutResult>;
}

class LocalSink implements Sink {
  readonly kind = 'local';
  private destDir: string;
  constructor(root: string, source: string, year: string, month: string) {
    this.destDir = path.join(root, accountingRelPath(source, year, month));
  }
  location(): string {
    return this.destDir;
  }
  async put(tempPath: string, name: string): Promise<PutResult> {
    fs.mkdirSync(this.destDir, { recursive: true });
    const dest = path.join(this.destDir, name);
    if (fs.existsSync(dest)) {
      return { dest, bytes: fs.statSync(dest).size, skipped: true };
    }
    fs.copyFileSync(tempPath, dest);
    return { dest, bytes: fs.statSync(dest).size, skipped: false };
  }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function bimBin(): string {
  return process.env.BRO_BIM_BIN || (process.platform === 'win32' ? 'bim.exe' : 'bim');
}

/** Run a bim google command, returning stdout. Throws sink-unavailable on failure. */
function bim(args: string[]): string {
  try {
    return execFileSync(bimBin(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BroError('sink-unavailable', `bim ${args.join(' ')} failed`, {
      needsHuman: /auth|login|scope|denied|403|401/i.test(msg),
      hint: 'ensure `bim google login` has been run with full Drive scope',
      detail: { stderr: msg.slice(0, 400) },
    });
  }
}

/** Parse a single-object bim response, unwrapping the {ok,result} envelope if present. */
function bimObj(out: string): Record<string, unknown> {
  const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop() ?? '{}';
  const o = JSON.parse(line) as Record<string, unknown>;
  if (o['ok'] === false) throw new BroError('sink-unavailable', 'bim returned an error', { detail: { error: o['error'] } });
  return (o['result'] as Record<string, unknown>) ?? o;
}

interface DriveEntry { id: string; name: string; mime_type?: string }

/** `bim google drive list --parent <id>` → entries (defensive to raw NDJSON or wrapped output). */
function driveList(parentId: string): DriveEntry[] {
  const out = bim(['google', 'drive', 'list', '--parent', parentId]);
  const entries: DriveEntry[] = [];
  for (const raw of out.split('\n')) {
    const s = raw.trim();
    if (!s.startsWith('{')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    const rec = (o['result'] as Record<string, unknown>) ?? o;
    if (typeof rec['id'] === 'string' && typeof rec['name'] === 'string') {
      entries.push({ id: rec['id'], name: rec['name'], mime_type: rec['mime_type'] as string | undefined });
    }
  }
  return entries;
}

/** Find a folder named `name` under `parentId`, creating it if absent. Returns its id. */
function driveEnsureFolder(parentId: string, name: string): string {
  const found = driveList(parentId).find((e) => e.name === name && e.mime_type === FOLDER_MIME);
  if (found) return found.id;
  const res = bimObj(bim(['google', 'drive', 'mkdir', '--name', name, '--parent', parentId]));
  const id = res['file_id'] ?? res['id'];
  if (typeof id !== 'string') throw new BroError('sink-unavailable', `drive mkdir "${name}" returned no id`, { detail: { res } });
  return id;
}

/**
 * Drive raw/ sink. Resolves (creating as needed) raw/{YYYY}/{MM}/{source}/, dedups by filename,
 * and uploads via `bim google drive upload --parent`. Requires the v0.4.0 driver + full Drive scope.
 */
class DriveRawSink implements Sink {
  readonly kind = 'drive-raw';
  private _leaf?: string;
  constructor(
    private rootFolder: string,
    private source: string,
    private year: string,
    private month: string,
  ) {}
  location(): string {
    return `Drive raw/${this.year}/${this.month}/${this.source}/ (under folder ${this.rootFolder})`;
  }
  private leaf(): string {
    if (this._leaf) return this._leaf;
    let cur = this.rootFolder;
    for (const seg of [this.year, this.month, this.source]) cur = driveEnsureFolder(cur, seg);
    this._leaf = cur;
    return cur;
  }
  async put(tempPath: string, name: string): Promise<PutResult> {
    const parent = this.leaf();
    const existing = driveList(parent).find((e) => e.name === name);
    const bytes = fs.statSync(tempPath).size;
    if (existing) {
      return { dest: `drive:${existing.id}`, bytes, skipped: true };
    }
    const res = bimObj(bim(['google', 'drive', 'upload', '--parent', parent, '--input', tempPath, '--name', name, '--mime-type', 'application/pdf']));
    const id = (res['file_id'] ?? res['id'] ?? '') as string;
    return { dest: `drive:${id}`, bytes, skipped: false };
  }
}

export function createSink(cfg: BroConfig, source: string, year: string, month: string): Sink {
  switch (cfg.sink) {
    case 'local':
      return new LocalSink(cfg.localRoot, source, year, month);
    case 'drive-raw':
      return new DriveRawSink(cfg.driveRawFolder, source, year, month);
    default:
      throw new BroError('bad-args', `unknown sink "${cfg.sink}"`, { hint: 'set BRO_SINK=local|drive-raw' });
  }
}
