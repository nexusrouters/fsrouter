#!/usr/bin/env node

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const __dirname = new URL(".", import.meta.url).pathname;

// Postinstall: warm-up SQLite deps into ~/.9router/runtime so the first
// `9router` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime } = require("./sqliteRuntime.cjs");
const { ensureTrayRuntime } = require("./trayRuntime.cjs");
const fs = require("fs");
const path = require("path");

// Fix ESM bare import for open-sse
try {
  const pkgRoot = path.resolve(__dirname, "../..");
  const nodeModules = path.join(pkgRoot, "node_modules");
  const openSseDir = path.join(pkgRoot, "open-sse");
  const target = path.join(nodeModules, "open-sse");
  
  if (fs.existsSync(openSseDir) && fs.existsSync(nodeModules)) {
    if (!fs.existsSync(target)) {
      fs.symlinkSync("../open-sse", target, "junction");
      console.log("[9router] created symlink open-sse -> node_modules");
    }
  }
} catch (e) {
  console.warn(`[9router] failed to create open-sse symlink: ${e.message}`);
}

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[9router] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[9router] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[9router] tray runtime skipped: ${e.message}`);
}

process.exit(0);
