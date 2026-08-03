// A minimal TypeScript require hook for loading workflow `.ts` files when running as the standalone
// SEA (where there is no tsx loader). Registers a `.ts` extension on the CommonJS Module machinery
// that sucrase-transpiles each file on require, so a workflow's relative sibling imports
// (e.g. schwab/workflows/transactions.ts -> ./positions.ts) resolve recursively for free.
//
// Workflows import only TYPES from bro's own src (erased by the typescript transform) and receive
// all runtime capability via the injected ctx, so no bundling of bro internals into the workflow
// module graph is needed — the transpiled file is self-contained CJS.
import fs from 'node:fs';
import { Module, createRequire } from 'node:module';
import { transform } from 'sucrase';

let registered = false;

function registerTsRequire(): void {
  if (registered) return;
  registered = true;
  const ext = Module as unknown as { _extensions: Record<string, (m: NodeModule, f: string) => void> };
  ext._extensions['.ts'] = (module, filename) => {
    const src = fs.readFileSync(filename, 'utf8');
    const { code } = transform(src, { transforms: ['typescript', 'imports'], filePath: filename });
    (module as unknown as { _compile: (c: string, f: string) => void })._compile(code, filename);
  };
}

/** Require a workflow `.ts` file (absolute path) with sibling `.ts` imports resolving recursively. */
export function requireTs(file: string): unknown {
  registerTsRequire();
  return createRequire(file)(file);
}
