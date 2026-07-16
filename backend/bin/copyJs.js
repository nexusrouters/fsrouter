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

  // Rel to root points to package root. open-sse is at package root.
  const relToPkgRoot = relToRoot;
  
  updated = updated.replace(/from\s+['"]open-sse\/([^'"]+)['"]/g, (m, impPath) => {
    return `from '${relToPkgRoot}/open-sse/${impPath}'`;
  });
  updated = updated.replace(/from\s+['"]open-sse['"]/g, (m) => {
    return `from '${relToPkgRoot}/open-sse/index.js'`;
  });
  updated = updated.replace(/import\s+['"]open-sse\/([^'"]+)['"]/g, (m, impPath) => {
    return `import '${relToPkgRoot}/open-sse/${impPath}'`;
  });
  updated = updated.replace(/import\s+['"]open-sse['"]/g, (m) => {
    return `import '${relToPkgRoot}/open-sse/index.js'`;
  });

  // 3. Fix local relative imports that mistakenly double dist
  updated = updated.replace(/\.\.\/\.\.\/\.\.\/src\//g, '../../../');
  updated = updated.replace(/\.\.\/\.\.\/src\//g, '../../');
  
  // 4. Fix open-sse files referencing ../../../src/lib/* or ../../../dist/lib/*
  //    (from dist/open-sse/services/tokenRefresh/providers.js, ../../../ = dist/open-sse/services/,
  //     so ../../../dist/lib/ becomes dist/open-sse/services/dist/lib/ → DOUBLE dist)
  //    The correct path is ../../../../dist/lib/ = package_root/dist/lib/
  //    Match both src/lib and dist/lib source patterns (rewriteSseImports may have written either)
  const fixSrcLib = (m, imp) => {
    const resolved = imp.endsWith('.js') ? imp : imp + '.js';
    return `'../../../../dist/lib/${resolved}'`;
  };
  const fixImportSrcLib = (m, imp) => {
    const resolved = imp.endsWith('.js') ? imp : imp + '.js';
    return `import('../../../../dist/lib/${resolved}')`;
  };
  updated = updated.replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/([^'"]+)['"]/g, fixSrcLib);
  updated = updated.replace(/import\(\s*['"]\.\.\/\.\.\/\.\.\/src\/lib\/([^'"]+)['"]\s*\)/g, fixImportSrcLib);
  updated = updated.replace(/['"]\.\.\/\.\.\/\.\.\/dist\/lib\/([^'"]+)['"]/g, fixSrcLib);
  updated = updated.replace(/import\(\s*['"]\.\.\/\.\.\/\.\.\/dist\/lib\/([^'"]+)['"]\s*\)/g, fixImportSrcLib);
  // ../../src/lib/ → ../../dist/lib/ (files at dist/open-sse/ level)
  updated = updated.replace(/['"]\.\.\/\.\.\/src\/lib\/([^'"]+)['"]/g, (m, imp) => {
    const resolved = imp.endsWith('.js') ? imp : imp + '.js';
    return `'../../dist/lib/${resolved}'`;
  });
  updated = updated.replace(/import\(\s*['"]\.\.\/\.\.\/src\/lib\/([^'"]+)['"]\s*\)/g, (m, imp) => {
    const resolved = imp.endsWith('.js') ? imp : imp + '.js';
    return `import('../../dist/lib/${resolved}')`;
  });
  // ../../dist/lib/ (double dist at depth=2) → ../../../dist/lib/
  updated = updated.replace(/['"]\.\.\/\.\.\/dist\/lib\/([^'"]+)['"]/g, (m, imp) => {
    const resolved = imp.endsWith('.js') ? imp : imp + '.js';
    return `'../../../dist/lib/${resolved}'`;
  });
  updated = updated.replace(/import\(\s*['"]\.\.\/\.\.\/dist\/lib\/([^'"]+)['"]\s*\)/g, (m, imp) => {
    const resolved = imp.endsWith('.js') ? imp : imp + '.js';
    return `import('../../../dist/lib/${resolved}')`;
  });
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
