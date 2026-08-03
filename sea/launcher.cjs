// bim-bro.exe launcher (Node SEA). Self-contained .exe that runs the bro JSON-RPC driver
// (src/driver.ts) via Node in the bro checkout -- which holds the sites, node_modules
// (Playwright), and the workflow code. Playwright's browser binaries are a CLI-managed
// dependency (bim-bro doctor detects them; `npx playwright install chromium` provisions).
//
// stdin/stdout/stderr are passed straight through so the JSON-RPC framing is byte-exact.
// Resolve the bro checkout via BRO_HOME (else the install-time default below).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const broHome = process.env.BRO_HOME || __BRO_HOME_DEFAULT__;
const driver = path.join(broHome, 'src', 'driver.ts');

function frameError(message, hint) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message, data: { kind: 'internal', hint } }, id: 0 }) + '\n',
  );
  process.exit(1);
}

if (!fs.existsSync(driver)) {
  frameError(`bro checkout not found at ${broHome}`, 'set BRO_HOME to your bro repo, or reinstall bim-bro');
}

const node = process.env.BRO_NODE || 'node';
const r = spawnSync(node, ['--import', 'tsx', 'src/driver.ts'], { cwd: broHome, stdio: 'inherit' });
if (r.error) {
  frameError(`failed to launch node: ${r.error.message}`, 'ensure Node >= 22 is on PATH (or set BRO_NODE)');
}
process.exit(r.status ?? 1);
