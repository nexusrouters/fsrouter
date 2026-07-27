import fs from "fs";
import path from "path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");

function transformNamedImports(importStr) {
  return importStr
    .split(",")
    .map(part => {
      const p = part.trim();
      if (!p) return "";
      if (p.includes(" as ")) {
        const [orig, alias] = p.split(/\s+as\s+/);
        return `${orig.trim()}: ${alias.trim()}`;
      }
      return p;
    })
    .filter(Boolean)
    .join(", ");
}

function fixDistImports(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const fileDir = path.dirname(filePath);
  const relFromDist = path.relative(distDir, fileDir).replace(/\\/g, "/");
  
  let toDistRoot = ".";
  if (relFromDist && relFromDist !== ".") {
    const depth = relFromDist.split("/").length;
    toDistRoot = Array(depth).fill("..").join("/");
  }

  let updated = content;
  let needsRequireShim = false;

  const CJS_PACKAGES = ["bcryptjs", "better-sqlite3", "node-machine-id", "node-forge", "confbox", "uuid", "jose", "undici"];

  for (const pkgName of CJS_PACKAGES) {
    const regexDefault = new RegExp(`import\\s+([a-zA-Z0-9_$]+)\\s+from\\s+['"]${pkgName}['"];?`, 'g');
    const regexNamed = new RegExp(`import\\s+\\{\\s*([^}]+)\\s*\\}\\s+from\\s+['"]${pkgName}['"];?`, 'g');
    const regexCjsDefault = new RegExp(`const\\s+([a-zA-Z0-9_$]+)\\s*=\\s*(?:__require|require)\\(['"]${pkgName}['"]\\);?`, 'g');
    const regexCjsNamed = new RegExp(`const\\s+\\{\\s*([^}]+)\\s*\\}\\s*=\\s*(?:__require|require)\\(['"]${pkgName}['"]\\);?`, 'g');

    const varPkg = `__pkg_${pkgName.replace(/[^a-zA-Z0-9]/g, '_')}`;

    if (regexDefault.test(updated)) {
      needsRequireShim = true;
      updated = updated.replace(regexDefault, (m, varName) => `let ${varName} = null; try { ${varName} = __require("${pkgName}"); } catch(_) {};`);
    }
    if (regexNamed.test(updated)) {
      needsRequireShim = true;
      updated = updated.replace(regexNamed, (m, names) => `let ${varPkg} = {}; try { ${varPkg} = __require("${pkgName}"); } catch(_) {}; const { ${transformNamedImports(names)} } = ${varPkg} || {};`);
    }
    if (regexCjsDefault.test(updated)) {
      needsRequireShim = true;
      updated = updated.replace(regexCjsDefault, (m, varName) => `let ${varName} = null; try { ${varName} = __require("${pkgName}"); } catch(_) {};`);
    }
    if (regexCjsNamed.test(updated)) {
      needsRequireShim = true;
      updated = updated.replace(regexCjsNamed, (m, names) => `let ${varPkg} = {}; try { ${varPkg} = __require("${pkgName}"); } catch(_) {}; const { ${transformNamedImports(names)} } = ${varPkg} || {};`);
    }
  }

  // Fail-open for pattern: const { ... } = nodeMachineId;
  updated = updated.replace(/const\s+\{\s*([^}]+)\s*\}\s*=\s*nodeMachineId;?/g, (m, names) => {
    return `const { ${transformNamedImports(names)} } = nodeMachineId || {};`;
  });

  if (needsRequireShim && !updated.includes("const __require =")) {
    const shim = `import { createRequire as __cr } from "module"; const __require = __cr(import.meta.url);\n`;
    updated = shim + updated;
  }

  // 1. Replace @/ aliases
  updated = updated.replace(/from\s+['"]@\/lib\/([^'"]+)['"]/g, (m, p) => `from '${toDistRoot}/lib/${p.endsWith('.js')?p:p+'.js'}'`);
  updated = updated.replace(/from\s+['"]@\/shared\/([^'"]+)['"]/g, (m, p) => `from '${toDistRoot}/shared/${p.endsWith('.js')?p:p+'.js'}'`);
  updated = updated.replace(/from\s+['"]@\/open-sse\/([^'"]+)['"]/g, (m, p) => `from '${toDistRoot}/open-sse/${p.endsWith('.js')?p:p+'.js'}'`);

  // 2. Fix escaping imports
  const relDepth = relFromDist === "." ? 0 : relFromDist.split("/").length;
  
  updated = updated.replace(/(['"])((?:\.\.\/)+)(src\/|dist\/)([^'"]+)(['"])/g, (m, q1, dots, prefix, sub, q2) => {
    const upCount = (dots.match(/\.\.\//g) || []).length;
    if (upCount > relDepth) {
      let cleanPrefix = 'lib';
      const parts = sub.split('/');
      if (['lib', 'shared', 'open-sse', 'routes'].includes(parts[0])) {
        cleanPrefix = parts[0];
        sub = parts.slice(1).join('/');
      }
      let ext = (sub.endsWith('.js') || sub.endsWith('.json') || sub.endsWith('.ts')) ? '' : '.js';
      return `${q1}${toDistRoot}/${cleanPrefix}/${sub}${ext}${q1}`;
    }
    return m;
  });

  updated = updated.replace(/(['"])(?:\.\.\/)+open-sse\/index(?:\.js)?(['"])/g, `$1${toDistRoot}/open-sse/index.js$2`);

  if (updated !== content) {
    fs.writeFileSync(filePath, updated, "utf8");
  }
}

function processDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      processDirectory(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))) {
      fixDistImports(fullPath);
    }
  }
}

processDirectory(distDir);
console.log("Successfully fixed CJS interop and imports in dist/!");
