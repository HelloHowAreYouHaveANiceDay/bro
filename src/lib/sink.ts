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

/** Upload MIME from a filename extension. Statements are PDF; transaction exports are CSV/OFX/QFX. */
function mimeFromName(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'csv': return 'text/csv';
    case 'qfx':
    case 'ofx': return 'application/x-ofx';
    case 'json': return 'application/json';
    case 'xml': return 'application/xml';
    case 'zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

/**
 * Drive I/O goes through finlib's Drive CLI (the ONE Financial-OS Google token), NOT the
 * headless-broken `bim-google.exe drive` (DIM-949). Invocation is
 *   uv run --project <accountant> python <finlib/drive_cli.py> <sub> ...
 * overridable via env: BRO_UV_BIN, FINOS_ACCOUNTANT_DIR, BRO_FINLIB_DRIVE_CLI.
 */
function finlibAccountantDir(): string {
  return process.env.FINOS_ACCOUNTANT_DIR || 'H:/working/wiki/finos/accountant';
}
function finlibDriveCli(): string {
  // default: sibling of the accountant dir -> <finos>/finlib/drive_cli.py
  return process.env.BRO_FINLIB_DRIVE_CLI || path.join(finlibAccountantDir(), '..', 'finlib', 'drive_cli.py');
}

/** Run a finlib drive subcommand; return its parsed `result`. Throws sink-unavailable on failure. */
function finlibDrive(sub: string, args: string[]): Record<string, unknown> {
  const uv = process.env.BRO_UV_BIN || 'uv';
  const argv = ['run', '--project', finlibAccountantDir(), 'python', finlibDriveCli(), sub, ...args];
  let out: string;
  try {
    out = execFileSync(uv, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // the CLI prints its {ok:false,error} frame to stdout even on a handled error; prefer that
    const stdout = (e as { stdout?: string }).stdout ?? '';
    const parsed = stdout.trim().startsWith('{') ? (JSON.parse(stdout) as Record<string, unknown>) : null;
    throw new BroError('sink-unavailable', `finlib drive ${sub} failed`, {
      needsHuman: /auth|login|scope|denied|403|401|token/i.test(msg + stdout),
      hint: 'finlib Drive token invalid -- refresh via the fin-os Google auth (finlib/auth.py)',
      detail: { error: parsed?.['error'], stderr: msg.slice(0, 400) },
    });
  }
  const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop() ?? '{}';
  const o = JSON.parse(line) as Record<string, unknown>;
  if (o['ok'] === false) {
    throw new BroError('sink-unavailable', `finlib drive ${sub} error`, { detail: { error: o['error'] } });
  }
  return (o['result'] as Record<string, unknown>) ?? {};
}

interface DriveEntry { id: string; name: string; mime_type?: string }

/** finlib `list` -> entries under a folder. */
function driveList(parentId: string): DriveEntry[] {
  const res = finlibDrive('list', ['--parent', parentId]);
  const files = (res['files'] as Array<Record<string, unknown>>) ?? [];
  return files
    .filter((f) => typeof f['id'] === 'string' && typeof f['name'] === 'string')
    .map((f) => ({ id: f['id'] as string, name: f['name'] as string, mime_type: f['mime_type'] as string | undefined }));
}

/** Find (or create) the folder `name` under `parentId`; returns its id. finlib mkdir is idempotent. */
function driveEnsureFolder(parentId: string, name: string): string {
  const res = finlibDrive('mkdir', ['--parent', parentId, '--name', name]);
  const id = res['id'];
  if (typeof id === 'string' && id) return id;
  throw new BroError('sink-unavailable', `drive mkdir "${name}" returned no id`, { detail: { parentId } });
}

/**
 * Drive raw/ sink. Resolves (creating as needed) raw/{YYYY}/{MM}/{source}/, dedups by filename,
 * and uploads via finlib's Drive CLI (the ONE fin-os Google token; no bim-google).
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
    const bytes = fs.statSync(tempPath).size;
    // dedup: skip if a file with this name already exists in the target folder
    const existing = driveList(parent).find((e) => e.name === name);
    if (existing) {
      return { dest: `drive:${existing.id}`, bytes, skipped: true };
    }
    const res = finlibDrive('upload', ['--parent', parent, '--name', name, '--input', tempPath, '--mime', mimeFromName(name)]);
    const id = (res['id'] ?? '') as string;
    if (!id) throw new BroError('sink-unavailable', `drive upload "${name}" returned no id`, { detail: { parent } });
    return { dest: `drive:${id}`, bytes, skipped: res['skipped'] === true };
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
