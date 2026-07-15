import fs from "fs";
import path from "path";

const srcDir = path.join(process.cwd(), "src");
const distDir = path.join(process.cwd(), "dist");

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
      fs.copyFileSync(srcPath, distPath);
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
      // Fix relative paths: ../../../src/ -> ../../../ (strip src/ from path for dist/open-sse location)
      content = content.replace(/\.\.\/\.\.\/\.\.\/src\//g, '../../../');
      fs.writeFileSync(destPath, content);
    }
  }
}
copyDirRecursive(path.join(process.cwd(), "open-sse"), path.join(distDir, "open-sse"));

copyFiles(srcDir, distDir);
console.log("Copied all JS files from src/ to dist/ successfully!");
