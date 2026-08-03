// Entry point bundled into bim-bro.exe (the standalone SEA). It pins the managed runtime deps
// (the playwright package, installed under <runtimeDir>/node_modules) so a `require('playwright')`
// from inside the blob ALWAYS resolves from the runtime dir — never from a checkout that merely
// happens to sit at the SEA's build-time path. Then it hands off to the JSON-RPC driver.
//
// Everything ELSE (bro's own src + sucrase) is bundled into the blob by esbuild, so there is no
// dependency on a bro checkout, on tsx, or on a `node` on PATH. Only playwright + its browsers
// remain external — a managed dependency provisioned once into the runtime dir (see `bim bro doctor`).
import path from 'node:path';
import { Module } from 'node:module';
import { runtimeDir } from './lib/paths.ts';

// The `paths` option below is a resolution START dir — Node appends `node_modules` to it — so pass
// the runtime dir itself, NOT <runtimeDir>/node_modules (which would search a doubled node_modules).
const rtBase = runtimeDir();

// Force playwright (and its internal playwright-core) to resolve ONLY from the runtime dir. Without
// this, Node resolves the bare specifier by walking up from the SEA's baked main path — which on the
// build machine lands in the checkout's node_modules, shadowing the managed runtime dir. Pinning it
// makes the exe behave identically on any machine: present iff provisioned into the runtime dir.
type ResolveFn = (request: string, parent: unknown, isMain: boolean, options?: { paths?: string[] }) => string;
const mod = Module as unknown as { _resolveFilename: ResolveFn };
const originalResolve = mod._resolveFilename;
mod._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'playwright' || request === 'playwright-core' ||
      request.startsWith('playwright/') || request.startsWith('playwright-core/')) {
    return originalResolve.call(this, request, parent, isMain, { ...(options ?? {}), paths: [rtBase] });
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

// Importing the driver runs its top-level main() (reads one JSON-RPC request on stdin).
// Dynamic import (not top-level await — unsupported in the CJS SEA bundle) so the resolver is pinned first.
void import('./driver.ts');
