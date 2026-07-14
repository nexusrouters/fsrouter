import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execAsync = promisify(exec);

export async function POST(req: any, res: any) {
  try {
    const rootDir = "/root/AMRouter";
    
    // Check if it's a git repository
    if (!fs.existsSync(path.join(rootDir, ".git"))) {
      return res.status(400).json({
        success: false,
        message: "Git repository not found in " + rootDir
      });
    }

    // Return response immediately so the client knows update is starting
    res.json({
      success: true,
      message: "Update process started. Pulling latest code and rebuilding..."
    });

    // Run the update process in the background
    (async () => {
      try {
        console.log("[Updater] Starting git pull...");
        await execAsync("git pull", { cwd: rootDir });
        
        console.log("[Updater] Running npm install...");
        await execAsync("npm install", { cwd: rootDir });
        
        console.log("[Updater] Building backend...");
        await execAsync("npm run build --workspace=backend", { cwd: rootDir });

        console.log("[Updater] Transpiling codebuddy route & server...");
        await execAsync("npx esbuild src/routes/automation/codebuddy/route.ts --outfile=dist/routes/automation/codebuddy/route.js --platform=node --format=esm --target=node20", { cwd: path.join(rootDir, "backend") });
        await execAsync("npx esbuild src/routes/version/route.ts --outfile=dist/routes/version/route.js --platform=node --format=esm --target=node20", { cwd: path.join(rootDir, "backend") });
        await execAsync("npx esbuild src/server.ts --outfile=dist/server.js --platform=node --format=esm --target=node20", { cwd: path.join(rootDir, "backend") });
        
        console.log("[Updater] Building frontend...");
        await execAsync("npm run build --workspace=frontend", { cwd: rootDir });
        await execAsync("cp -r frontend/dist/* backend/public/", { cwd: rootDir });
        
        console.log("[Updater] Restarting PM2 processes...");
        // Use full path to pm2 or reload
        await execAsync("/root/.nvm/versions/node/v20.20.2/bin/pm2 restart all");
        console.log("[Updater] Update completed successfully!");
      } catch (err: any) {
        console.error("[Updater] Error during background update:", err);
      }
    })();

  } catch (error: any) {
    console.error("Error starting update:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
