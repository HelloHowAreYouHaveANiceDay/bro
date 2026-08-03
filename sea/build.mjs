// Build bim-bro.exe as a TRUE STANDALONE Node SEA (Single Executable Application).
//
// Pipeline: esbuild-bundle src/sea-entry.ts (which pulls in the whole bro driver + sucrase) into one
// CJS file, embedding everything EXCEPT `playwright`/`playwright-core` (marked external — resolved at
// runtime from the managed runtime dir via NODE_PATH; see src/sea-entry.ts). Then bake that bundle
// into the blob and inject it into a copy of the Node runtime.
//
// Result depends on NOTHING from the bro checkout at runtime: no src/, no tsx, no `node` on PATH.
// Only the managed deps stay external — the playwright package + its Chromium browser — provisioned
// once into <dataRoot>/runtime (see `bim bro doctor`), exactly like bim-blender/Blender.
//
// Usage: node sea/build.mjs   (from the bro repo root)
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seaDir = path.join(root, 'sea');
const bundle = path.join(seaDir, 'driver.bundle.cjs');
const outExe = path.join(root, 'bim-bro.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// 1. Bundle the entry + all of bro's src + sucrase into one CJS file. playwright stays external.
await build({
  entryPoints: [path.join(root, 'src', 'sea-entry.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['playwright', 'playwright-core'],
  // Node SEA has no fetch of source maps; keep the blob lean.
  sourcemap: false,
  logLevel: 'info',
});
console.error(`bundled ${bundle} (${(fs.statSync(bundle).size / 1e6).toFixed(2)} MB)`);

// 2. SEA config -> blob.
const cfg = path.join(seaDir, 'sea-config.json');
fs.writeFileSync(
  cfg,
  JSON.stringify(
    {
      main: bundle.replace(/\\/g, '/'),
      output: path.join(seaDir, 'sea-prep.blob').replace(/\\/g, '/'),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });

// 3. Copy the node runtime, inject the blob.
fs.copyFileSync(process.execPath, outExe);
execFileSync(
  'npx',
  ['--yes', 'postject', outExe, 'NODE_SEA_BLOB', path.join(seaDir, 'sea-prep.blob'), '--sentinel-fuse', FUSE],
  { stdio: 'inherit', shell: true },
);

console.error(`\nbuilt ${outExe} (${(fs.statSync(outExe).size / 1e6).toFixed(1)} MB) — standalone (playwright provisioned separately)`);
