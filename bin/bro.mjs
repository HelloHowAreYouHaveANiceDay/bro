#!/usr/bin/env node
// Launcher so `bro` runs the TS CLI via the tsx loader (no build step), from any cwd.
import { register } from 'tsx/esm/api';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

register();
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
await import(pathToFileURL(cli).href);
