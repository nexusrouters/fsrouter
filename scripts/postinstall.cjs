#!/usr/bin/env node
/**
 * Post-install: wire automation symlinks so the signup scripts can find the
 * Python venv, source tree and browser profiles regardless of the process cwd.
 *
 * The automation routes resolve paths relative to process.cwd()
 * (e.g. .venv/bin/python, src/automation/*.py, profiles/<provider>). When the
 * server runs under pm2 the cwd is the installed package directory
 * (/usr/local/lib/node_modules/@fudrouter/fsrouter), NOT /root — so we create
 * the symlinks in BOTH locations to be cwd-independent.
 *
 * Idempotent and non-fatal: never throws (npm install must succeed even if a
 * symlink can't be created).
 */
const fs = require("fs");
const path = require("path");

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[fsrouter:postinstall] ${msg}`);
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function symlinkIfMissing(linkPath, targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      // target missing — remove a dangling link if present, then skip
      if (isSymlink(linkPath)) fs.unlinkSync(linkPath);
      log(`skip ${linkPath} (target ${targetPath} not found)`);
      return;
    }
    if (isSymlink(linkPath)) {
      if (fs.readlinkSync(linkPath) === targetPath) {
        log(`ok ${linkPath} -> ${targetPath}`);
        return;
      }
      fs.unlinkSync(linkPath);
    } else if (fs.existsSync(linkPath)) {
      log(`skip ${linkPath} (exists and is not a symlink — leaving untouched)`);
      return;
    }
    fs.symlinkSync(targetPath, linkPath, "dir");
    log(`linked ${linkPath} -> ${targetPath}`);
  } catch (e) {
    log(`warn: could not link ${linkPath} -> ${targetPath}: ${e.message}`);
  }
}

function main() {
  // Real AMRouter checkout (where the venv + browser profiles live)
  const candidates = ["/root/AMRouter", path.resolve(__dirname, "..", "..")];
  let base = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      base = c;
      break;
    }
  }
  if (!base) {
    log("no AMRouter base found; skipping symlinks");
    return;
  }
  log(`base=${base}`);

  const venvTarget = path.join(base, ".venv");
  const srcTarget = path.join(base, "backend", "src");
  const profilesTarget = path.join(base, "backend", "profiles");

  // Locations to symlink from (cwd-independent coverage)
  const linkBases = ["/root", process.cwd()]; // /root + the dir npm ran install in (global package dir under pm2)

  for (const lb of linkBases) {
    symlinkIfMissing(path.join(lb, ".venv"), venvTarget);
    // src only if it doesn't already exist as a real dir (package ships src/)
    const srcLink = path.join(lb, "src");
    if (!fs.existsSync(srcLink)) symlinkIfMissing(srcLink, srcTarget);
    symlinkIfMissing(path.join(lb, "profiles"), profilesTarget);
  }
}

try {
  main();
} catch (e) {
  log(`unexpected error: ${e.message}`);
}
