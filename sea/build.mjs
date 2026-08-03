// Build bim-bro.exe from sea/launcher.cjs via Node 22 SEA (Single Executable Applications).
// Usage: node sea/build.mjs   (from the bro repo root)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seaDir = path.join(root, 'sea');
const outExe = path.join(root, 'bim-bro.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// 1. bake BRO_HOME default into the launcher.
const launcher = fs.readFileSync(path.join(seaDir, 'launcher.cjs'), 'utf8')
  .replace('__BRO_HOME_DEFAULT__', JSON.stringify(root.replace(/\\/g, '/')));
const built = path.join(seaDir, 'launcher.build.cjs');
fs.writeFileSync(built, launcher);

// 2. SEA config -> blob.
const cfg = path.join(seaDir, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({
  main: built.replace(/\\/g, '/'),
  output: path.join(seaDir, 'sea-prep.blob').replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });

// 3. copy the node runtime, inject the blob.
fs.copyFileSync(process.execPath, outExe);
execFileSync('npx', ['--yes', 'postject', outExe, 'NODE_SEA_BLOB', path.join(seaDir, 'sea-prep.blob'),
  '--sentinel-fuse', FUSE], { stdio: 'inherit', shell: true });

console.error(`\nbuilt ${outExe} (${(fs.statSync(outExe).size / 1e6).toFixed(1)} MB)`);
