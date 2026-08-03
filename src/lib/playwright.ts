import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

/**
 * Load the playwright package through CJS require, so in the standalone SEA it is subject to the
 * `_resolveFilename` pin installed by sea-entry.ts (which forces resolution from the managed runtime
 * dir, never a checkout that happens to sit at the SEA's build-time path). In dev/tsx this resolves
 * from the checkout's node_modules as usual. Use this instead of `import('playwright')` anywhere the
 * package is loaded lazily (e.g. `doctor`), so ESM dynamic-import resolution — which ignores the pin —
 * is never used for playwright.
 *
 * The require base differs by mode: inside the SEA, `import.meta.url` is undefined, so use the exe
 * path (the pin makes the base irrelevant anyway); in dev/tsx, use this module's own URL so the
 * checkout's node_modules resolves.
 */
export function loadPlaywright(): typeof import('playwright') {
  const base = seaMode() ? process.execPath : fileURLToPath(import.meta.url);
  return createRequire(base)('playwright') as typeof import('playwright');
}

function seaMode(): boolean {
  try {
    return isSea();
  } catch {
    return false;
  }
}
