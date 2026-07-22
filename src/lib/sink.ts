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

/**
 * Drive raw/ sink. Uploads to raw/{YYYY}/{MM}/{source}/ via `bim google drive`.
 * BLOCKED until the bim-cli enhancement (G1) lands: `drive upload` has no --parent and runs under
 * drive.file scope, so it can't target the existing raw/ tree. Until then this sink surfaces a
 * typed `sink-unavailable` error (agent-actionable), rather than silently uploading to the wrong place.
 */
class DriveRawSink implements Sink {
  readonly kind = 'drive-raw';
  constructor(
    private rootFolder: string,
    private source: string,
    private year: string,
    private month: string,
  ) {}
  location(): string {
    return `Drive raw/${this.year}/${this.month}/${this.source}/ (folder ${this.rootFolder})`;
  }
  async put(_tempPath: string, _name: string): Promise<PutResult> {
    // Capability probe: does this bim support `drive upload --parent`?
    if (!driveUploadSupportsParent()) {
      throw new BroError('sink-unavailable', 'drive-raw sink needs `bim google drive upload --parent` (G1)', {
        needsHuman: true,
        hint: 'the bim-cli enhancement (drive scope + --parent + folder-ensure) is not deployed yet; use BRO_SINK=local meanwhile',
        detail: { rootFolder: this.rootFolder, source: this.source },
      });
    }
    // Intended implementation once available:
    //   const parent = ensureDriveFolderPath(this.rootFolder, [this.year, this.month, this.source]);
    //   if (driveChildExists(parent, name)) return { dest: `${parent}/${name}`, bytes, skipped: true };
    //   bim google drive upload --parent <parent> --input <tempPath> --name <name> --mime-type application/pdf
    throw new BroError('sink-unavailable', 'drive-raw upload path not yet implemented', { needsHuman: true });
  }
}

/** True once bim exposes `--parent` on `drive upload`. Cached per process. */
let _parentSupport: boolean | undefined;
function driveUploadSupportsParent(): boolean {
  if (_parentSupport !== undefined) return _parentSupport;
  try {
    const out = execFileSync('bim', ['google', 'describe'], { encoding: 'utf8' });
    _parentSupport = /"drive upload"[\s\S]*?--parent/.test(out);
  } catch {
    _parentSupport = false;
  }
  return _parentSupport;
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
