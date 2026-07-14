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
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      fs.copyFileSync(srcPath, distPath);
    }
  }
}

copyFiles(srcDir, distDir);
console.log("Copied all JS files from src/ to dist/ successfully!");
