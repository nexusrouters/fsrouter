import fs from "fs";
import path from "path";

const srcDir = path.join(process.cwd(), "src");
const distDir = path.join(process.cwd(), "dist");

function rewriteImports(content, filePath, isJsCopy = false) {
  const dir = path.dirname(filePath);
  const relToRoot = path.relative(dir, process.cwd()).replace(/\\/g, '/') || '.';
  const relToDist = path.relative(dir, distDir).replace(/\\/g, '/') || '.';

  let updated = content;

  // 1. Fix @/ shared/lib/store/etc -> relative imports
  // If we are copying JS/TS files to dist, they need to resolve relative to dist root
  updated = updated.replace(/from\s+['"]@\/lib\/([^'"]+)['"]/g, (m, impPath) => {
    let resolved = impPath;
    if (!resolved.endsWith('.js') && !resolved.endsWith('.ts') && !resolved.endsWith('.json')) {
      resolved += '.js';
    }
    return `from '${relToDist}/lib/${resolved}'`;
  });
  updated = updated.replace(/from\s+['"]@\/lib['"]/g, `from '${relToDist}/lib'`);
  updated = updated.replace(/require\(['"]@\/lib\/([^'"]+)['"]\)/g, (m, impPath) => `require('${relToDist}/lib/${impPath}')`);
  updated = updated.replace(/require\(['"]@\/lib['"]\)/g, `require('${relToDist}/lib')`);

  updated = updated.replace(/from\s+['"]@\/shared\/([^'"]+)['"]/g, (m, impPath) => {
    let resolved = impPath;
    if (!resolved.endsWith('.js') && !resolved.endsWith('.ts') && !resolved.endsWith('.json')) {
      resolved += '.js';
    }
    return `from '${relToDist}/shared/${resolved}'`;
  });
  updated = updated.replace(/require\(['"]@\/shared\/([^'"]+)['"]\)/g, (m, impPath) => `require('${relToDist}/shared/${impPath}')`);

  updated = updated.replace(/from\s+['"]@\/store\/([^'"]+)['"]/g, (m, impPath) => `from '${relToDist}/store/${impPath}'`);
  updated = updated.replace(/require\(['"]@\/store\/([^'"]+)['"]\)/g, (m, impPath) => `require('${relToDist}/store/${impPath}')`);

  updated = updated.replace(/from\s+['"]@\/services\/([^'"]+)['"]/g, (m, impPath) => `from '${relToDist}/services/${impPath}'`);
  updated = updated.replace(/require\(['"]@\/services\/([^'"]+)['"]\)/g, (m, impPath) => `require('${relToDist}/services/${impPath}')`);

  updated = updated.replace(/from\s+['"]@\/utils\/([^'"]+)['"]/g, (m, impPath) => `from '${relToDist}/utils/${impPath}'`);
  updated = updated.replace(/require\(['"]@\/utils\/([^'"]+)['"]\)/g, (m, impPath) => `require('${relToDist}/utils/${impPath}')`);

  // 2. Fix open-sse bare imports to use relative imports from package root
  // Rel to root points to package root. open-sse is at package root.
  // Wait, if files are under dist/ (e.g. dist/lib/mcp/stdioSseBridge.js), the package root is relToRoot/.. because processed dir is inside dist.
  // Wait, copyFiles writes directly to dist. So path.relative(dir, distDir) will resolve back to dist.
  // Package root is parent of dist. So we can use:
  const relToPkgRoot = isJsCopy ? path.relative(dir, process.cwd()).replace(/\\/g, '/') : relToRoot;
  
  updated = updated.replace(/from\s+['"]open-sse\/([^'"]+)['"]/g, (m, impPath) => `from '${relToPkgRoot}/open-sse/${impPath}'`);
  updated = updated.replace(/from\s+['"]open-sse['"]/g, `from '${relToPkgRoot}/open-sse/index.js'`);
  updated = updated.replace(/import\s+['"]open-sse\/([^'"]+)['"]/g, (m, impPath) => `import '${relToPkgRoot}/open-sse/${impPath}'`);
  updated = updated.replace(/import\s+['"]open-sse['"]/g, `import '${relToPkgRoot}/open-sse/index.js'`);

  // 3. Fix local relative imports that mistakenly double dist
  updated = updated.replace(/\.\.\/\.\.\/\.\.\/src\//g, '../../../');
  updated = updated.replace(/\.\.\/\.\.\/src\//g, '../../');
  
  // Specific fix for tokenRefresh/providers
  if (filePath.includes('tokenRefresh')) {
    updated = updated.replace(/\.\.\/\.\.\/\.\.\/dist\/lib\/oauth\/kiroExternalIdp.js/g, '../../../dist/lib/oauth/kiroExternalIdp.js');
  }

  return updated;
}

function copyFiles(src, dist) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dist)) {
    fs.mkdirSync(dist, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const distPath = path.join(dist, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      copyFiles(srcPath, distPath);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".json"))) {
      let content = fs.readFileSync(srcPath, 'utf8');
      content = rewriteImports(content, distPath, true);
      fs.writeFileSync(distPath, content);
    }
  }
}

// Copy open-sse directory recursively to dist
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      let content = fs.readFileSync(srcPath, 'utf8');
      content = rewriteImports(content, destPath, false);
      fs.writeFileSync(destPath, content);
    }
  }
}
copyDirRecursive(path.join(process.cwd(), "open-sse"), path.join(distDir, "open-sse"));

copyFiles(srcDir, distDir);
console.log("Copied all JS files from src/ to dist/ with resolved path imports successfully!");
