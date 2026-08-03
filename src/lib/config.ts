import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, dataRoot } from './paths.ts';

/**
 * Loads .env (KEY=VALUE lines) into process.env without a dotenv dependency. Checks the checkout
 * root (dev) then the OS data dir (standalone `<dataRoot>/.env`); real env vars always win.
 */
function loadDotEnv(): void {
  const candidates = [path.join(REPO_ROOT, '.env'), path.join(dataRoot(), '.env')];
  const envPath = candidates.find((p) => fs.existsSync(p));
  if (!envPath) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

export type SinkKind = 'local' | 'drive-raw';

export interface BroConfig {
  /** which sink `run` ships files through */
  sink: SinkKind;
  /** local sink root — the accounting cache tree */
  localRoot: string;
  /** Drive folder id that raw/{YYYY}/{MM}/{source} lives under (drive-raw sink) */
  driveRawFolder: string;
  /** Playwright browser channel; msedge locally, chrome/chromium for OSS users */
  browserChannel: string;
}

export function loadConfig(): BroConfig {
  return {
    sink: (process.env.BRO_SINK as SinkKind) || 'local',
    localRoot:
      process.env.BRO_LOCAL_ROOT || 'H:/working/assistant/shared_accounting_data',
    driveRawFolder: process.env.ASSIST_RAW_DRIVE_FOLDER || '1XfX3erYCdbwNUqnFBhIeUUNjNvhGFAAj',
    browserChannel: process.env.BRO_BROWSER_CHANNEL || 'msedge',
  };
}
