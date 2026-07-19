import fs from "fs";
import path from "path";

// Rewrite @/bare references in open-sse/ source files so they work in the
// published npm package where Node cannot resolve the `imports` field for
// bare specifiers starting with `@/`.

const root = process.cwd();
const sseDir = path.join(root, "open-sse");

function rewrite(file) {
  let content = fs.readFileSync(file, "utf8");
  const orig = content;

  // Count directory depth from root: open-sse/handlers/chatCore.js → depth=2
  // Need ../../dist/lib/ → prefix = "../".repeat(depth) + "dist/"
  const rel = path.relative(root, path.dirname(file));
  const depth = rel ? rel.split(path.sep).length : 0;
  const prefix = "../".repeat(depth) + "dist/";

  // Rewrite bare `open-sse/...` specifiers (side-effect or from) to depth-correct
  // relative paths pointing to dist/open-sse so the compiled code resolves correctly.
  const ssePrefix = "../".repeat(depth) + "dist/open-sse/";
  content = content
    .replace(/from\s+['"]open-sse\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `from '${ssePrefix}${resolved}'`;
    })
    .replace(/import\s+['"]open-sse\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `import '${ssePrefix}${resolved}'`;
    })
    .replace(/import\(\s*['"]open-sse\/([^'"]+)['"]\s*\)/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `import('${ssePrefix}${resolved}')`;
    });

  content = content
    .replace(/from\s+['"]@\/lib\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `from '${prefix}lib/${resolved}'`;
    })
    .replace(/from\s+['"]@\/shared\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `from '${prefix}shared/${resolved}'`;
    })
    .replace(/from\s+['"]@\/store\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `from '${prefix}store/${resolved}'`;
    })
    .replace(/from\s+['"]@\/utils\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `from '${prefix}utils/${resolved}'`;
    })
    .replace(/from\s+['"]@\/services\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `from '${prefix}services/${resolved}'`;
    })
    .replace(/import\s+['"]@\/lib\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `import '${prefix}lib/${resolved}'`;
    })
    .replace(/import\(\s*['"]@\/lib\/([^'"]+)['"]\s*\)/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `import('${prefix}lib/${resolved}')`;
    })
    // Fix relative imports pointing to ../../../src/lib → dist/lib (depth-aware)
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `'${prefix}lib/${resolved}'`;
    })
    .replace(/import\(\s*['"]\.\.\/\.\.\/\.\.\/src\/lib\/([^'"]+)['"]\s*\)/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `import('${prefix}lib/${resolved}')`;
    })
    // Normalize any ../-chain pointing at dist/lib to the depth-correct prefix
    .replace(/['"](?:\.\.\/)+dist\/lib\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `'${prefix}lib/${resolved}'`;
    })
    .replace(/import\(\s*['"](?:\.\.\/)+dist\/lib\/([^'"]+)['"]\s*\)/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `import('${prefix}lib/${resolved}')`;
    })
    .replace(/['"]\.\.\/\.\.\/src\/shared\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `'${prefix}shared/${resolved}'`;
    })
    .replace(/['"]\.\.\/\.\.\/src\/utils\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `'${prefix}utils/${resolved}'`;
    })
    .replace(/['"]\.\.\/\.\.\/src\/services\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `'${prefix}services/${resolved}'`;
    })
    .replace(/['"]\.\.\/\.\.\/src\/store\/([^'"]+)['"]/g, (m, imp) => {
      const resolved = imp.endsWith(".js") ? imp : imp + ".js";
      return `'${prefix}store/${resolved}'`;
    });

  if (content !== orig) {
    fs.writeFileSync(file, content);
    console.log(`  [rewrite] ${path.relative(root, file)}`);
  }
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js") || e.name.endsWith(".ts")) rewrite(p);
  }
}

console.log("[rewriteSseImports] Rewriting @/ + src/ + bare open-sse imports...");
walk(sseDir);
const routesDir = path.join(root, "src", "routes");
if (fs.existsSync(routesDir)) walk(routesDir);
console.log("[rewriteSseImports] Done.");
