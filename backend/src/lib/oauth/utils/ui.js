/**
 * UI Helper Functions
 *
 * These are CLI-only cosmetic helpers. They must NEVER break server-side
 * token refresh, so `chalk`/`ora` are loaded lazily and degrade to plain
 * `console.log` when the dev dependencies are not installed in production.
 */

function lazyChalk() {
  try {
    return require("chalk");
  } catch {
    return null;
  }
}

function lazyOra() {
  try {
    return require("ora");
  } catch {
    return null;
  }
}

// Resolve a chalk color fn, falling back to identity string passthrough.
function colorFn(name) {
  return (msg) => {
    const chalk = lazyChalk();
    if (chalk && typeof chalk[name] === "function") {
      return chalk[name](msg);
    }
    return msg;
  };
}

const green = colorFn("green");
const red = colorFn("red");
const blue = colorFn("blue");
const yellow = colorFn("yellow");
const grayFn = colorFn("gray");

export function success(message) {
  console.log(green(`\n✓ ${message}\n`));
}

export function error(message) {
  console.log(red(`\n✗ ${message}\n`));
}

export function info(message) {
  console.log(blue(`\n${message}\n`));
}

export function warn(message) {
  console.log(yellow(`\n⚠ ${message}\n`));
}

export function gray(message) {
  console.log(grayFn(message));
}

export function spinner(text) {
  const ora = lazyOra();
  if (ora) return ora(text);
  // Minimal no-op spinner fallback for non-interactive/server use.
  return {
    text,
    start() { return this; },
    stop() { return this; },
    succeed() { return this; },
    fail() { return this; },
    warn() { return this; },
    info() { return this; },
  };
}

export function printSection(title) {
  console.log(blue(`\n${title}\n`));
}

export function printKeyValue(key, value, isSuccess = false) {
  const color = isSuccess ? green : grayFn;
  console.log(color(`  ${key}: ${value}`));
}

export function printList(items, isSuccess = false) {
  const symbol = isSuccess ? "✓" : "✗";
  const color = isSuccess ? green : grayFn;
  items.forEach((item) => {
    console.log(color(`  ${symbol} ${item}`));
  });
}
